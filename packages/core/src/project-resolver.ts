/**
 * project-resolver.ts
 *
 * Pure, in-memory path resolver for project + worktree attribution.
 *
 * NO database imports. NO fs imports. Callers supply plain data snapshots;
 * the resolver compiles matchers once at snapshot-build time and then serves
 * resolve() calls off sorted in-memory arrays — O(rules + projects) per call.
 *
 * Designed for the hot path: every proxied request hits resolve() once.
 */

import { homedir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Input DTOs (plain data — no DB dependency)
// ---------------------------------------------------------------------------

export interface ResolverProjectInput {
	id: string;
	/** Already normalized by caller: lowercased on darwin, realpath'd, no trailing slash. */
	canonicalPath: string;
	enabled: boolean;
	/**
	 * If this project is itself a worktree of another project (manual assignment
	 * via UI, or auto-assigned by the discovery scheduler), the parent's id.
	 * When the resolver scores a prefix match against this row, it rolls the
	 * result up to the parent and stamps worktreePath on the request.
	 */
	parentProjectId?: string | null;
}

export interface ResolverRuleInput {
	id: string;
	kind: "glob" | "regex" | "directory";
	pattern: string;
	parentProjectId: string | null;
	priority: number;
	enabled: boolean;
	/** If non-null the rule was already flagged bad upstream — skip it. */
	compileError: string | null;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface ResolveResult {
	projectId: string | null;
	/** Raw normalized path when a worktree rule matched. */
	worktreePath: string | null;
	/** Rule id that triggered the match — for telemetry / debugging. */
	matchedRuleId: string | null;
	/** Canonical path of the project that won — for telemetry / debugging. */
	matchedProjectPath: string | null;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ResolverOptions {
	/** Default: `process.platform !== "darwin"` (darwin FS is case-insensitive). */
	caseSensitive?: boolean;
	/**
	 * The user's home directory. A project row whose canonicalPath is the home
	 * directory itself, or any ancestor of it, is excluded from the prefix index:
	 * it would prefix-match every request and attribute the whole machine to one
	 * project. See `isCatchAllPath`. Pass null to disable the exclusion.
	 */
	homeDir?: string | null;
}

// ---------------------------------------------------------------------------
// Internal compiled structures
// ---------------------------------------------------------------------------

interface CompiledProject {
	id: string;
	canonicalPath: string; // already normalised (caller responsibility)
	parentProjectId: string | null;
}

interface CompiledRule {
	id: string;
	matcher: (p: string) => boolean;
	parentProjectId: string | null;
	priority: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise a raw input path for matching. Returns null for falsy/blank input. */
function normalizePath(
	raw: string | null | undefined,
	caseSensitive: boolean,
): string | null {
	if (!raw || !raw.trim()) return null;
	let p = path.resolve(raw.trim());
	// Strip trailing slash (path.resolve already does this on most inputs, but be explicit)
	if (p.length > 1 && p.endsWith("/")) {
		p = p.slice(0, -1);
	}
	return caseSensitive ? p : p.toLowerCase();
}

/**
 * True when `canonicalPath` is the home directory itself or an ancestor of it
 * (`/`, `/Users`, `/Users/seanbugeja`, `/home`, …).
 *
 * Such a row matches every path a developer ever works in, so once attribution
 * resolves at all it wins by default for anything no longer row covers. That is
 * strictly worse than the null it replaces: a null announces that attribution
 * did not happen, while a uniform home-directory id looks like a real answer and
 * silently makes every per-project figure a whole-machine figure (SB23-1975).
 *
 * The row is left in the database and stays visible and selectable in the UI.
 * Only its ability to win a *prefix* match is removed; an explicit worktree rule
 * naming it as a parent still resolves to it.
 *
 * Both arguments must already be normalized by `normalizePath`.
 */
export function isCatchAllPath(
	canonicalPath: string,
	homeDir: string,
): boolean {
	if (canonicalPath === homeDir) return true;
	return homeDir.startsWith(`${canonicalPath}/`) || canonicalPath === "/";
}

/**
 * Find the longest-prefix matching enabled project for a given normalized path.
 * Projects array must be pre-sorted longest-path-first.
 */
function longestPrefixMatch(
	normalized: string,
	projects: CompiledProject[],
): CompiledProject | null {
	for (const entry of projects) {
		if (
			normalized === entry.canonicalPath ||
			normalized.startsWith(`${entry.canonicalPath}/`)
		) {
			return entry;
		}
	}
	return null;
}

/** Compile a single rule. Returns null when the rule should be skipped. */
function compileRule(
	rule: ResolverRuleInput,
	caseSensitive: boolean,
): CompiledRule | null {
	// Skip rules already marked bad upstream
	if (rule.compileError !== null) return null;

	let matcher: (p: string) => boolean;

	if (rule.kind === "directory") {
		const patternNorm = normalizePath(rule.pattern, caseSensitive);
		if (!patternNorm) return null;
		matcher = (p: string) =>
			p === patternNorm || p.startsWith(`${patternNorm}/`);
	} else if (rule.kind === "glob") {
		let glob: InstanceType<typeof Bun.Glob>;
		try {
			// In case-insensitive mode the candidate path is lowercased before
			// matching, so the glob pattern must be lowercased too — otherwise a
			// user-entered pattern with real casing like /Users/Alice/**/.worktrees/**
			// would never match the normalized /users/alice/... (Codex round 5 P3).
			// Directory rules already normalize their pattern via normalizePath.
			const compiledPattern = caseSensitive
				? rule.pattern
				: rule.pattern.toLowerCase();
			glob = new Bun.Glob(compiledPattern);
		} catch {
			return null; // compilation error — skip rule
		}
		matcher = (p: string) => {
			try {
				return glob.match(p);
			} catch {
				return false;
			}
		};
	} else {
		// regex
		let re: RegExp;
		try {
			re = new RegExp(rule.pattern);
		} catch {
			return null; // compilation error — skip rule
		}
		matcher = (p: string) => {
			try {
				return re.test(p);
			} catch {
				return false;
			}
		};
	}

	return {
		id: rule.id,
		matcher,
		parentProjectId: rule.parentProjectId,
		priority: rule.priority,
	};
}

// ---------------------------------------------------------------------------
// ResolverSnapshot — immutable; built once, read many times
// ---------------------------------------------------------------------------

export class ResolverSnapshot {
	/** Enabled projects sorted by canonicalPath length DESC (longest prefix first). */
	private readonly prefixIndex: CompiledProject[];
	/** Compiled rules sorted by priority DESC, then id for determinism. */
	private readonly rules: CompiledRule[];
	private readonly caseSensitive: boolean;

	private constructor(
		prefixIndex: CompiledProject[],
		rules: CompiledRule[],
		caseSensitive: boolean,
	) {
		this.prefixIndex = prefixIndex;
		this.rules = rules;
		this.caseSensitive = caseSensitive;
	}

	static build(
		projects: ResolverProjectInput[],
		rules: ResolverRuleInput[],
		opts?: ResolverOptions,
	): ResolverSnapshot {
		const caseSensitive = opts?.caseSensitive ?? process.platform !== "darwin";

		// Normalize the home directory the same way paths are normalized, so the
		// comparison in isCatchAllPath is like-for-like.
		const rawHome =
			opts?.homeDir === undefined ? homedir() : (opts?.homeDir ?? null);
		const homeDir =
			rawHome === null ? null : normalizePath(rawHome, caseSensitive);

		// Build prefix index: only enabled projects, excluding catch-all rows at or
		// above the home directory, sorted longest path first
		const prefixIndex: CompiledProject[] = projects
			.filter((p) => p.enabled)
			.filter((p) => {
				if (homeDir === null) return true;
				const normalized = normalizePath(p.canonicalPath, caseSensitive);
				return normalized === null || !isCatchAllPath(normalized, homeDir);
			})
			.map((p) => ({
				id: p.id,
				canonicalPath: caseSensitive
					? p.canonicalPath
					: p.canonicalPath.toLowerCase(),
				parentProjectId: p.parentProjectId ?? null,
			}))
			.sort((a, b) => b.canonicalPath.length - a.canonicalPath.length);

		// Compile rules: skip disabled, skip those with compile errors
		const compiledRules: CompiledRule[] = [];
		for (const rule of rules) {
			if (!rule.enabled) continue;
			const compiled = compileRule(rule, caseSensitive);
			if (compiled !== null) {
				compiledRules.push(compiled);
			}
		}
		// Sort by priority DESC, then id ASC for determinism
		compiledRules.sort(
			(a, b) => b.priority - a.priority || a.id.localeCompare(b.id),
		);

		return new ResolverSnapshot(prefixIndex, compiledRules, caseSensitive);
	}

	/**
	 * Resolve a raw path string to a project/worktree attribution.
	 *
	 * The input is an ABSOLUTE filesystem path by contract. A blank or
	 * non-absolute value returns all-nulls and is never interpreted: see the
	 * guard below for why.
	 *
	 * Algorithm:
	 *  1. Reject blank and non-absolute input with all-nulls.
	 *     Normalize the rest (resolve, strip trailing slash, case-fold if needed).
	 *  2. Walk compiled rules (priority DESC). First match wins.
	 *     → projectId = rule.parentProjectId ?? longestPrefix(normalized).id ?? null
	 *     → worktreePath = normalized
	 *  3. Walk prefixIndex (length DESC). First prefix match wins.
	 *     → worktreePath = null
	 *  4. No match → all nulls.
	 */
	resolve(raw: string | null | undefined): ResolveResult {
		const nullResult: ResolveResult = {
			projectId: null,
			worktreePath: null,
			matchedRuleId: null,
			matchedProjectPath: null,
		};

		// A non-absolute hint is rejected rather than resolved (SB23-2355).
		//
		// normalizePath ends in path.resolve, which completes a relative value
		// against `process.cwd()`. That is the proxy's own working directory,
		// which no client can see and nothing logs, so the attribution a request
		// received became a function of where the operator started the server.
		// Measured 2026-09-19 against a copy of the live database with 787
		// project rows: "~/Code/tab-genius" resolved to null under the Homebrew
		// service's cwd of "/", and to da27e8303a860a36 under a cwd inside a
		// worktree that had a projects row. Non-null, plausible, and wrong.
		//
		// That is the same failure isCatchAllPath exists to prevent, by a
		// different door: a null announces that attribution did not happen,
		// while a uniform id looks like a real answer. It is worse in one
		// respect, because the id is whatever directory the server sits in
		// rather than a recognisable catch-all.
		//
		// `~` is deliberately NOT expanded here. The proxy's home directory is
		// not the client's, so expanding it would turn a null into a confident
		// wrong answer, which is the defect this guard removes. The 19 configs
		// on the maintainer's host that send a tilde (SB23-2268) are repaired
		// client-side, by sending a real absolute cwd.
		const trimmed = raw?.trim();
		if (!trimmed || !path.isAbsolute(trimmed)) return nullResult;

		const normalized = normalizePath(trimmed, this.caseSensitive);
		if (normalized === null) return nullResult;

		// Step 2 — worktree rules (priority DESC)
		for (const rule of this.rules) {
			if (rule.matcher(normalized)) {
				// Resolve parent: explicit parentProjectId on rule takes precedence;
				// fall back to longest-prefix match.
				let projectId: string | null = rule.parentProjectId;
				let matchedProjectPath: string | null = null;

				if (projectId === null) {
					const prefixMatch = longestPrefixMatch(normalized, this.prefixIndex);
					if (prefixMatch !== null) {
						projectId = prefixMatch.id;
						matchedProjectPath = prefixMatch.canonicalPath;
					}
				} else {
					// Find the canonicalPath for the explicitly-set parentProjectId
					const proj = this.prefixIndex.find((p) => p.id === projectId);
					if (proj) matchedProjectPath = proj.canonicalPath;
				}

				return {
					projectId,
					worktreePath: normalized,
					matchedRuleId: rule.id,
					matchedProjectPath,
				};
			}
		}

		// Step 3 — direct prefix match
		const prefixMatch = longestPrefixMatch(normalized, this.prefixIndex);
		if (prefixMatch !== null) {
			// If the matched project is itself a child worktree (parentProjectId
			// set — either via manual UI assignment or by the discovery scheduler),
			// roll up to the parent and stamp the worktree path. This preserves
			// built-in worktree grouping for users who never created an explicit
			// worktree_rule (Codex round 1 P2).
			if (prefixMatch.parentProjectId !== null) {
				const parent =
					this.prefixIndex.find((p) => p.id === prefixMatch.parentProjectId) ??
					null;
				return {
					projectId: prefixMatch.parentProjectId,
					worktreePath: normalized,
					matchedRuleId: null,
					matchedProjectPath: parent ? parent.canonicalPath : null,
				};
			}
			return {
				projectId: prefixMatch.id,
				worktreePath: null,
				matchedRuleId: null,
				matchedProjectPath: prefixMatch.canonicalPath,
			};
		}

		return nullResult;
	}
}

// ---------------------------------------------------------------------------
// ResolverManager — owns the live snapshot; supports subscriptions
// ---------------------------------------------------------------------------

export class ResolverManager {
	private snapshot: ResolverSnapshot;
	private readonly opts: ResolverOptions;
	private readonly subscribers: Set<(snap: ResolverSnapshot) => void> =
		new Set();

	constructor(opts?: ResolverOptions) {
		this.opts = opts ?? {};
		// Start with an empty snapshot so current() is always callable
		this.snapshot = ResolverSnapshot.build([], [], this.opts);
	}

	/** Rebuild the snapshot from fresh DB-sourced data. Atomic ref-swap — no locks. */
	rebuild(projects: ResolverProjectInput[], rules: ResolverRuleInput[]): void {
		const next = ResolverSnapshot.build(projects, rules, this.opts);
		this.snapshot = next;
		for (const cb of this.subscribers) {
			try {
				cb(next);
			} catch {
				// Subscriber errors must never crash the manager
			}
		}
	}

	/** Return the current immutable snapshot. Safe to call from any context. */
	current(): ResolverSnapshot {
		return this.snapshot;
	}

	/**
	 * Subscribe to snapshot rebuilds.
	 * @returns unsubscribe function
	 */
	subscribe(cb: (snap: ResolverSnapshot) => void): () => void {
		this.subscribers.add(cb);
		return () => {
			this.subscribers.delete(cb);
		};
	}
}
