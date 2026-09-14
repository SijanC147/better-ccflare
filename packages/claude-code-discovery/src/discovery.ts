import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { Logger } from "@better-ccflare/logger";
import {
	isLikelyWorktreePath,
	naiveDecode,
	type ReadDirFn,
	resolveEncodedName,
} from "./path-encoding";

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
	/** Directory lister used by the forward-slug resolver. Injectable for tests. */
	readDir?: ReadDirFn;
}

/**
 * Thrown by `scan()` when the forward-slug rule resolves nothing at all across
 * a realistically sized set of entries that needed it.
 *
 * A drifted slug rule fails silently: every lookup returns an empty result, and
 * empty reads exactly like "this host has no projects". The guard is the point,
 * not the threshold. One or two misses are normal (a deleted directory, a
 * renamed repository); ten with zero successes is a broken rule.
 */
export class SlugRuleDriftError extends Error {
	constructor(
		readonly attempted: number,
		readonly projectsDir: string,
	) {
		super(
			`Forward-slug resolution failed for all ${attempted} entries under ${projectsDir} ` +
				`that carried no JSONL cwd. The slug rule in path-encoding.encodePath has ` +
				`probably drifted from Claude Code's, or ${projectsDir} belongs to another host. ` +
				`Refusing to report paths that were guessed by inverting the slug (SB23-1975).`,
		);
		this.name = "SlugRuleDriftError";
	}
}

/**
 * Entries needing the fallback below this count never trip the guard: a small
 * set can legitimately resolve to nothing when the directories were deleted.
 */
const SLUG_DRIFT_MIN_SAMPLE = 10;

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
	private readonly _readDir: ReadDirFn | undefined;
	/** Entries in the current scan that fell through to forward-slug resolution. */
	private _slugAttempts = 0;
	/** How many of those the forward-slug resolver placed on a real directory. */
	private _slugResolved = 0;

	constructor(opts?: DiscoveryOptions) {
		// Priority: constructor option > env var > default
		this.projectsDir =
			opts?.projectsDir ??
			process.env.CLAUDE_PROJECTS_DIR ??
			nodePath.join(os.homedir(), ".claude", "projects");

		this._caseInsensitive = opts?.caseInsensitiveCanonicalize ?? false;
		this._readDir = opts?.readDir;
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
		this._slugAttempts = 0;
		this._slugResolved = 0;

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

		if (
			this._slugAttempts >= SLUG_DRIFT_MIN_SAMPLE &&
			this._slugResolved === 0
		) {
			throw new SlugRuleDriftError(this._slugAttempts, this.projectsDir);
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
			// No JSONL cwd. Place the entry by encoding real directories forward
			// and comparing, which is the only direction the slug is defined in.
			this._slugAttempts++;
			const resolved = resolveEncodedName(encodedName, this._readDir);
			if (resolved !== null) {
				this._slugResolved++;
				canonicalPath = this._caseInsensitive
					? resolved.toLowerCase()
					: resolved;
				ambiguous = false;
			} else {
				// Nothing on disk encodes to this name. The decoded path is a guess
				// and almost certainly names a directory that does not exist.
				canonicalPath = naiveDecode(encodedName);
				ambiguous = true;
			}
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
