import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { Logger } from "@better-ccflare/logger";
import { isLikelyWorktreePath, naiveDecode } from "./path-encoding";

const logger = new Logger("discovery");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DiscoveredProject {
	/** Encoded directory name, e.g. "-Users-foo-Code-bar" */
	encodedName: string;
	/**
	 * Resolved canonical path.  Sourced from the JSONL `cwd` field when
	 * available; falls back to a naive hyphen-decode when no JSONL exists.
	 */
	canonicalPath: string;
	/**
	 * True when the canonical path was derived from naive decoding (no JSONL
	 * found or no `cwd` field present).  The UI should surface a warning.
	 */
	ambiguous: boolean;
	/** Number of *.jsonl session files in the project directory. */
	sessionCount: number;
	/** Max mtime (ms epoch) across all *.jsonl files; null when none exist. */
	lastSessionAt: number | null;
	/**
	 * True when the canonical path matches the built-in worktree heuristic
	 * (e.g. path contains `.maestro/worktrees`, `.ralph/worktrees`, etc.).
	 * This seeds `detectedAsWorktree` but does NOT override user-defined rules.
	 */
	detectedAsWorktree: boolean;
}

export interface DiscoveryOptions {
	/**
	 * Override the projects directory.  Defaults to
	 * `CLAUDE_PROJECTS_DIR` env-var → `~/.claude/projects`.
	 */
	projectsDir?: string;
	/**
	 * When true, canonicalPath comparisons are case-insensitive.
	 * Defaults to false; callers decide based on the host filesystem.
	 */
	caseInsensitiveCanonicalize?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const MAX_JSONL_LINES = 10;
const MAX_JSONL_BYTES = 64 * 1024; // 64 KiB

/**
 * Read the first `*.jsonl` file in `dir` (smallest mtime = oldest completed
 * session) and return the `cwd` string from the first JSON object that has
 * one.  Returns null if no JSONL exists, none has a `cwd` field, or all
 * parses fail.
 */
async function readCwdFromJsonl(dir: string): Promise<string | null> {
	let entries: fs.Dirent[];
	try {
		entries = await fsPromises.readdir(dir, { withFileTypes: true });
	} catch (err) {
		logger.warn(`Cannot read directory: ${dir}`, err);
		return null;
	}

	// Collect *.jsonl files with their mtimes.
	const jsonlFiles: Array<{ name: string; mtimeMs: number }> = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		try {
			const stat = await fsPromises.stat(nodePath.join(dir, entry.name));
			jsonlFiles.push({ name: entry.name, mtimeMs: stat.mtimeMs });
		} catch {
			// Unreadable stat — skip.
		}
	}

	if (jsonlFiles.length === 0) return null;

	// Sort ascending by mtime: smallest mtime = oldest session.
	jsonlFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);

	const targetFile = nodePath.join(dir, jsonlFiles[0].name);
	return readCwdFromFile(targetFile);
}

/**
 * Stream a single JSONL file up to MAX_JSONL_LINES / MAX_JSONL_BYTES and
 * return the `cwd` string from the first JSON object that has one.
 */
async function readCwdFromFile(filePath: string): Promise<string | null> {
	let fileHandle: fsPromises.FileHandle | null = null;
	try {
		fileHandle = await fsPromises.open(filePath, "r");
		const buf = Buffer.alloc(MAX_JSONL_BYTES);
		const { bytesRead } = await fileHandle.read(buf, 0, MAX_JSONL_BYTES, 0);
		const raw = buf.subarray(0, bytesRead).toString("utf8");

		const lines = raw.split("\n");
		let linesRead = 0;
		for (const line of lines) {
			if (linesRead >= MAX_JSONL_LINES) break;
			const trimmed = line.trim();
			if (!trimmed) continue;
			linesRead++;
			try {
				const obj = JSON.parse(trimmed);
				if (obj && typeof obj === "object" && typeof obj.cwd === "string") {
					return obj.cwd as string;
				}
			} catch {
				// Corrupt line — log and continue.
				logger.warn(`Corrupt JSONL line in ${filePath}`, { line: trimmed });
			}
		}
	} catch (err) {
		logger.warn(`Cannot read JSONL file: ${filePath}`, err);
	} finally {
		await fileHandle?.close().catch(() => {});
	}
	return null;
}

/**
 * Gather sessionCount and lastSessionAt from *.jsonl files in a project dir.
 */
async function gatherSessionStats(
	dir: string,
): Promise<{ sessionCount: number; lastSessionAt: number | null }> {
	let entries: fs.Dirent[];
	try {
		entries = await fsPromises.readdir(dir, { withFileTypes: true });
	} catch {
		return { sessionCount: 0, lastSessionAt: null };
	}

	let sessionCount = 0;
	let lastSessionAt: number | null = null;

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		sessionCount++;
		try {
			const stat = await fsPromises.stat(nodePath.join(dir, entry.name));
			if (lastSessionAt === null || stat.mtimeMs > lastSessionAt) {
				lastSessionAt = stat.mtimeMs;
			}
		} catch {
			// Skip unreadable stat.
		}
	}

	return { sessionCount, lastSessionAt };
}

// ---------------------------------------------------------------------------
// ClaudeCodeDiscovery
// ---------------------------------------------------------------------------

export class ClaudeCodeDiscovery {
	private readonly projectsDir: string;
	private readonly _caseInsensitive: boolean;

	constructor(opts?: DiscoveryOptions) {
		// Priority: constructor option > env var > default
		this.projectsDir =
			opts?.projectsDir ??
			process.env.CLAUDE_PROJECTS_DIR ??
			nodePath.join(os.homedir(), ".claude", "projects");

		this._caseInsensitive = opts?.caseInsensitiveCanonicalize ?? false;
	}

	/**
	 * Scan the projects directory and return all discovered projects.
	 * Never throws — individual corrupt entries are logged and skipped.
	 */
	async scan(): Promise<DiscoveredProject[]> {
		let topEntries: fs.Dirent[];
		try {
			topEntries = await fsPromises.readdir(this.projectsDir, {
				withFileTypes: true,
			});
		} catch (err) {
			logger.warn(`Cannot read projects dir: ${this.projectsDir}`, err);
			return [];
		}

		const results: DiscoveredProject[] = [];

		for (const entry of topEntries) {
			// Skip non-directories.
			if (!entry.isDirectory()) continue;

			const name = entry.name;

			// Skip ssh-* remote-session sentinels.
			if (name.startsWith("ssh-")) continue;

			// Skip the literal `-` entry (filesystem-root sentinel).
			if (name === "-") continue;

			try {
				const result = await this._processEntry(name);
				if (result) results.push(result);
			} catch (err) {
				logger.warn(`Error processing project entry: ${name}`, err);
			}
		}

		return results;
	}

	/**
	 * Resolve the true cwd for a single encoded project name by reading its
	 * JSONL files.  Returns null when not resolvable.
	 */
	async resolveCwd(encodedName: string): Promise<string | null> {
		const dir = nodePath.join(this.projectsDir, encodedName);
		return readCwdFromJsonl(dir);
	}

	/**
	 * Start a poll-based watcher.  Calls `onChange` with a fresh snapshot
	 * whenever the scan result differs from the previous snapshot.
	 * Returns an unsubscribe function.
	 *
	 * This is the v1 poll implementation; fs.watch integration is deferred
	 * to v1.2.
	 */
	startPolling(
		intervalMs: number,
		onChange: (snapshot: DiscoveredProject[]) => void,
	): () => void {
		let previous: string = "";
		let stopped = false;

		const tick = async () => {
			if (stopped) return;
			try {
				const snapshot = await this.scan();
				const serialised = JSON.stringify(snapshot);
				if (serialised !== previous) {
					previous = serialised;
					onChange(snapshot);
				}
			} catch (err) {
				logger.warn("Poll tick error", err);
			}
			if (!stopped) {
				setTimeout(tick, intervalMs);
			}
		};

		// Kick off first tick.
		setTimeout(tick, intervalMs);

		return () => {
			stopped = true;
		};
	}

	// -------------------------------------------------------------------------
	// Private
	// -------------------------------------------------------------------------

	private async _processEntry(
		encodedName: string,
	): Promise<DiscoveredProject | null> {
		const dir = nodePath.join(this.projectsDir, encodedName);

		// Resolve cwd from JSONL first.
		const cwdFromJsonl = await readCwdFromJsonl(dir);

		let canonicalPath: string;
		let ambiguous: boolean;

		if (cwdFromJsonl !== null) {
			canonicalPath = this._caseInsensitive
				? cwdFromJsonl.toLowerCase()
				: cwdFromJsonl;
			ambiguous = false;
		} else {
			// Fall back to naive decode.
			canonicalPath = naiveDecode(encodedName);
			ambiguous = true;
		}

		const { sessionCount, lastSessionAt } = await gatherSessionStats(dir);

		const detectedAsWorktree = isLikelyWorktreePath(canonicalPath);

		return {
			encodedName,
			canonicalPath,
			ambiguous,
			sessionCount,
			lastSessionAt,
			detectedAsWorktree,
		};
	}
}
