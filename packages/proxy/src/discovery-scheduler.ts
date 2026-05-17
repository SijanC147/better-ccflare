/**
 * discovery-scheduler.ts
 *
 * Periodic scanner that syncs ~/.claude/projects/ into the DB and rebuilds
 * the in-memory resolver snapshot after every scan.
 *
 * Injected into DatabaseOperations via setDiscoveryRunner() to avoid circular
 * imports (DatabaseOperations → ProjectRepository; DiscoveryScheduler →
 * DatabaseOperations).
 */

import * as os from "node:os";
import * as path from "node:path";
import {
	ClaudeCodeDiscovery,
	isLikelyWorktreePath,
} from "@better-ccflare/claude-code-discovery";
import type { DatabaseOperations } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";

const log = new Logger("DiscoveryScheduler");

// ---------------------------------------------------------------------------
// Sentinel-path filters
// ---------------------------------------------------------------------------

/** Root-FS and tmpdir paths that must never be treated as real projects. */
const SENTINEL_PREFIXES = [
	"/private/var/folders/",
	"/var/folders/",
	os.tmpdir(),
];

function isSentinelPath(canonicalPath: string): boolean {
	if (canonicalPath === "/") return true;
	for (const prefix of SENTINEL_PREFIXES) {
		if (canonicalPath.startsWith(prefix)) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ScanResult {
	added: number;
	updated: number;
	unchanged: number;
	total: number;
}

// ---------------------------------------------------------------------------
// DiscoveryScheduler
// ---------------------------------------------------------------------------

export class DiscoveryScheduler {
	private readonly dbOps: DatabaseOperations;
	private readonly intervalMs: number;
	private readonly projectsDir: string | undefined;

	private timer: ReturnType<typeof setTimeout> | null = null;
	private running = false;

	constructor(
		dbOps: DatabaseOperations,
		intervalMs = 60_000,
		projectsDir?: string,
	) {
		this.dbOps = dbOps;
		this.intervalMs = intervalMs;
		this.projectsDir = projectsDir;
	}

	/**
	 * Start the periodic scan loop.
	 * Fires the first scan immediately (async, non-blocking).
	 */
	start(): void {
		if (this.running) return;
		this.running = true;

		// Register this scheduler's runOnce as the discoveryRunner on dbOps so
		// that HTTP handlers can trigger an on-demand scan without importing this
		// module directly.
		this.dbOps.setDiscoveryRunner(() => this.runOnce());

		// First scan fires immediately.
		this._scheduleNext(0);
		log.info(
			`Discovery scheduler started (interval: ${this.intervalMs}ms, dir: ${this.projectsDir ?? "default"})`,
		);
	}

	/**
	 * Stop the scheduler and de-register the discovery runner.
	 */
	stop(): void {
		this.running = false;
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		// Clear the runner so stale references don't fire after shutdown.
		this.dbOps.setDiscoveryRunner(null);
		log.info("Discovery scheduler stopped");
	}

	/**
	 * Execute a single discovery scan synchronously (from the caller's
	 * perspective — it returns a Promise that resolves when the scan is done).
	 *
	 * Flow:
	 *  1. Scan ~/.claude/projects/ via ClaudeCodeDiscovery.
	 *  2. Filter ambiguous sentinel paths.
	 *  3. Upsert clean rows into the DB.
	 *  4. Auto-assign worktree parent for newly-detected worktrees.
	 *  5. Rebuild the resolver snapshot.
	 *
	 * Safe to call concurrently — each call is independent.
	 */
	async runOnce(): Promise<ScanResult> {
		const discovery = new ClaudeCodeDiscovery({
			projectsDir: this.projectsDir,
			caseInsensitiveCanonicalize: this.dbOps.getProjectsCaseSensitive()
				? false
				: true,
		});

		let discovered: Awaited<ReturnType<typeof discovery.scan>>;
		try {
			discovered = await discovery.scan();
		} catch (err) {
			log.error("Discovery scan failed", err);
			return { added: 0, updated: 0, unchanged: 0, total: 0 };
		}

		// Filter out ambiguous sentinel paths (e.g. root-fs, tmp dirs).
		const clean = discovered.filter((d) => {
			if (d.ambiguous && isSentinelPath(d.canonicalPath)) {
				log.debug(
					`Skipping sentinel path: ${d.canonicalPath} (${d.encodedName})`,
				);
				return false;
			}
			return true;
		});

		if (clean.length === 0) {
			log.debug("No usable projects found in scan");
			await this.dbOps.rebuildResolver();
			return { added: 0, updated: 0, unchanged: 0, total: 0 };
		}

		// Upsert into DB.
		let upsertResult: { added: number; updated: number; unchanged: number };
		try {
			upsertResult = await this.dbOps.upsertProjectsFromDiscovery(
				clean.map((d) => ({
					canonicalPath: d.canonicalPath,
					displayName: path.basename(d.canonicalPath) || d.encodedName,
					sessionCount: d.sessionCount,
					lastSessionAt: d.lastSessionAt,
				})),
			);
		} catch (err) {
			log.error("upsertProjectsFromDiscovery failed", err);
			return { added: 0, updated: 0, unchanged: 0, total: clean.length };
		}

		// Auto-assign worktree parents for newly-added worktree rows.
		if (upsertResult.added > 0) {
			await this._assignWorktreeParents();
		}

		// Rebuild resolver after DB is settled.
		try {
			await this.dbOps.rebuildResolver();
		} catch (err) {
			log.error("rebuildResolver failed", err);
		}

		const result: ScanResult = {
			...upsertResult,
			total: clean.length,
		};

		log.info(
			`Scan complete — added:${result.added} updated:${result.updated} unchanged:${result.unchanged} total:${result.total}`,
		);
		return result;
	}

	// -------------------------------------------------------------------------
	// Private
	// -------------------------------------------------------------------------

	private _scheduleNext(delayMs: number): void {
		if (!this.running) return;
		this.timer = setTimeout(async () => {
			if (!this.running) return;
			try {
				await this.runOnce();
			} catch (err) {
				log.error("Unhandled error in discovery scan tick", err);
			}
			this._scheduleNext(this.intervalMs);
		}, delayMs);
	}

	/**
	 * For each project that looks like a worktree path and has no
	 * parent_project_id yet, find the longest-prefix non-worktree project and
	 * assign it as the parent.
	 *
	 * Only touches rows whose parent_project_id is null — manual edits are
	 * never overwritten.
	 */
	private async _assignWorktreeParents(): Promise<void> {
		let projects: Awaited<ReturnType<typeof this.dbOps.listProjects>>;
		try {
			projects = await this.dbOps.listProjects();
		} catch (err) {
			log.error("listProjects failed during worktree parent assignment", err);
			return;
		}

		// Non-worktree projects sorted by canonical_path length DESC (longest first).
		const nonWorktree = projects
			.filter((p) => !isLikelyWorktreePath(p.canonical_path))
			.sort((a, b) => b.canonical_path.length - a.canonical_path.length);

		// Candidate worktrees: path looks like worktree, no parent yet.
		const unparented = projects.filter(
			(p) => isLikelyWorktreePath(p.canonical_path) && p.parent_project_id === null,
		);

		if (unparented.length === 0) return;

		const cs = this.dbOps.getProjectsCaseSensitive();
		const normalise = (p: string) => (cs ? p : p.toLowerCase());

		for (const wt of unparented) {
			const wtNorm = normalise(wt.canonical_path);
			const parent = nonWorktree.find((nw) => {
				const nwNorm = normalise(nw.canonical_path);
				return (
					wtNorm === nwNorm ||
					wtNorm.startsWith(nwNorm + "/")
				);
			});

			if (parent) {
				try {
					await this.dbOps.updateProject(wt.id, {
						parentProjectId: parent.id,
					});
					log.debug(
						`Assigned worktree parent: ${wt.canonical_path} → ${parent.canonical_path}`,
					);
				} catch (err) {
					log.error(
						`Failed to assign parent for worktree ${wt.id}`,
						err,
					);
				}
			}
		}
	}
}
