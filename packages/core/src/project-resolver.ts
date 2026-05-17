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

import path from "node:path";

// ---------------------------------------------------------------------------
// Input DTOs (plain data — no DB dependency)
// ---------------------------------------------------------------------------

export interface ResolverProjectInput {
  id: string;
  /** Already normalized by caller: lowercased on darwin, realpath'd, no trailing slash. */
  canonicalPath: string;
  enabled: boolean;
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
}

// ---------------------------------------------------------------------------
// Internal compiled structures
// ---------------------------------------------------------------------------

interface CompiledProject {
  id: string;
  canonicalPath: string; // already normalised (caller responsibility)
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
      normalized.startsWith(entry.canonicalPath + "/")
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
      p === patternNorm || p.startsWith(patternNorm + "/");
  } else if (rule.kind === "glob") {
    let glob: InstanceType<typeof Bun.Glob>;
    try {
      glob = new Bun.Glob(rule.pattern);
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
    const caseSensitive =
      opts?.caseSensitive ?? process.platform !== "darwin";

    // Build prefix index: only enabled projects, sorted longest path first
    const prefixIndex: CompiledProject[] = projects
      .filter((p) => p.enabled)
      .map((p) => ({
        id: p.id,
        canonicalPath: caseSensitive
          ? p.canonicalPath
          : p.canonicalPath.toLowerCase(),
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
   * Algorithm:
   *  1. Normalize path (resolve, strip trailing slash, case-fold if needed).
   *     Return all-nulls for falsy/blank input.
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

    const normalized = normalizePath(raw, this.caseSensitive);
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
  rebuild(
    projects: ResolverProjectInput[],
    rules: ResolverRuleInput[],
  ): void {
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
