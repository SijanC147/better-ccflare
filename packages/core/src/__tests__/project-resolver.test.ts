/**
 * project-resolver.test.ts
 *
 * Tests for ResolverSnapshot and ResolverManager.
 * Uses bun:test. No DB, no FS — pure unit tests.
 */

import { describe, expect, it } from "bun:test";
import {
  ResolverManager,
  ResolverSnapshot,
  type ResolverProjectInput,
  type ResolverRuleInput,
} from "../project-resolver";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProject(
  overrides: Partial<ResolverProjectInput> & { id: string; canonicalPath: string },
): ResolverProjectInput {
  return { enabled: true, ...overrides };
}

function makeRule(
  overrides: Partial<ResolverRuleInput> & {
    id: string;
    kind: "glob" | "regex" | "directory";
    pattern: string;
  },
): ResolverRuleInput {
  return {
    parentProjectId: null,
    priority: 0,
    enabled: true,
    compileError: null,
    ...overrides,
  };
}

/** Build a case-sensitive snapshot (Linux-style). */
function buildCS(
  projects: ResolverProjectInput[],
  rules: ResolverRuleInput[] = [],
): ResolverSnapshot {
  return ResolverSnapshot.build(projects, rules, { caseSensitive: true });
}

/** Build a case-insensitive snapshot (darwin-style). */
function buildCI(
  projects: ResolverProjectInput[],
  rules: ResolverRuleInput[] = [],
): ResolverSnapshot {
  return ResolverSnapshot.build(projects, rules, { caseSensitive: false });
}

// ---------------------------------------------------------------------------
// 1. Empty snapshot
// ---------------------------------------------------------------------------

describe("empty snapshot", () => {
  it("returns all-nulls for a valid path", () => {
    const snap = buildCS([]);
    const result = snap.resolve("/some/path");
    expect(result.projectId).toBeNull();
    expect(result.worktreePath).toBeNull();
    expect(result.matchedRuleId).toBeNull();
    expect(result.matchedProjectPath).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Null / empty / whitespace input
// ---------------------------------------------------------------------------

describe("null / empty / whitespace input", () => {
  const snap = buildCS([makeProject({ id: "p1", canonicalPath: "/Users/x/foo" })]);

  it("returns all-nulls for null", () => {
    const r = snap.resolve(null);
    expect(r.projectId).toBeNull();
    expect(r.worktreePath).toBeNull();
  });

  it("returns all-nulls for undefined", () => {
    const r = snap.resolve(undefined);
    expect(r.projectId).toBeNull();
  });

  it("returns all-nulls for empty string", () => {
    const r = snap.resolve("");
    expect(r.projectId).toBeNull();
  });

  it("returns all-nulls for whitespace-only string", () => {
    const r = snap.resolve("   ");
    expect(r.projectId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Direct project hit
// ---------------------------------------------------------------------------

describe("direct project hit", () => {
  const snap = buildCS([makeProject({ id: "p1", canonicalPath: "/Users/x/foo" })]);

  it("resolves exact canonical path to that project", () => {
    const r = snap.resolve("/Users/x/foo");
    expect(r.projectId).toBe("p1");
    expect(r.worktreePath).toBeNull();
    expect(r.matchedRuleId).toBeNull();
    expect(r.matchedProjectPath).toBe("/Users/x/foo");
  });

  it("resolves a child path to that project", () => {
    const r = snap.resolve("/Users/x/foo/bar/baz");
    expect(r.projectId).toBe("p1");
    expect(r.worktreePath).toBeNull();
  });

  it("does NOT match a sibling directory", () => {
    const r = snap.resolve("/Users/x/foo-other");
    expect(r.projectId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Trailing slash and double slashes are normalised
// ---------------------------------------------------------------------------

describe("path normalization", () => {
  const snap = buildCS([makeProject({ id: "p1", canonicalPath: "/Users/x/foo" })]);

  it("strips a trailing slash", () => {
    const r = snap.resolve("/Users/x/foo/");
    expect(r.projectId).toBe("p1");
  });

  it("resolves relative-ish doubled slashes via path.resolve", () => {
    // path.resolve cleans up internal double slashes
    const r = snap.resolve("/Users/x//foo");
    expect(r.projectId).toBe("p1");
  });
});

// ---------------------------------------------------------------------------
// 5. Longest-prefix wins
// ---------------------------------------------------------------------------

describe("longest-prefix wins", () => {
  const snap = buildCS([
    makeProject({ id: "parent", canonicalPath: "/a" }),
    makeProject({ id: "child", canonicalPath: "/a/b" }),
  ]);

  it("path /a/b/c resolves to the child project /a/b", () => {
    const r = snap.resolve("/a/b/c");
    expect(r.projectId).toBe("child");
    expect(r.matchedProjectPath).toBe("/a/b");
  });

  it("path /a/c resolves to the parent project /a", () => {
    const r = snap.resolve("/a/c");
    expect(r.projectId).toBe("parent");
    expect(r.matchedProjectPath).toBe("/a");
  });

  it("path /a resolves to the parent (exact match)", () => {
    const r = snap.resolve("/a");
    expect(r.projectId).toBe("parent");
  });
});

// ---------------------------------------------------------------------------
// 6. Disabled project is skipped
// ---------------------------------------------------------------------------

describe("disabled project is skipped", () => {
  const snap = buildCS([
    makeProject({ id: "disabled", canonicalPath: "/Users/x/foo", enabled: false }),
    makeProject({ id: "enabled", canonicalPath: "/Users/x" }),
  ]);

  it("does not match the disabled project", () => {
    const r = snap.resolve("/Users/x/foo/bar");
    // disabled project /Users/x/foo would have been longer prefix — should be skipped
    expect(r.projectId).toBe("enabled");
    expect(r.matchedProjectPath).toBe("/Users/x");
  });
});

// ---------------------------------------------------------------------------
// 7. Worktree directory rule — parentProjectId set
// ---------------------------------------------------------------------------

describe("worktree directory rule with parentProjectId", () => {
  const snap = buildCS(
    [
      makeProject({ id: "main", canonicalPath: "/repos/myapp" }),
      makeProject({ id: "worktree", canonicalPath: "/repos/myapp/.worktrees/feature" }),
    ],
    [
      makeRule({
        id: "r1",
        kind: "directory",
        pattern: "/repos/myapp/.worktrees/feature",
        parentProjectId: "main",
        priority: 10,
      }),
    ],
  );

  it("rolls worktree path up to the explicit parent project", () => {
    const r = snap.resolve("/repos/myapp/.worktrees/feature/src/index.ts");
    expect(r.projectId).toBe("main");
    expect(r.worktreePath).not.toBeNull();
    expect(r.matchedRuleId).toBe("r1");
  });
});

// ---------------------------------------------------------------------------
// 8. Worktree directory rule — no parentProjectId falls back to longest-prefix
// ---------------------------------------------------------------------------

describe("worktree directory rule without parentProjectId", () => {
  const snap = buildCS(
    [makeProject({ id: "parent", canonicalPath: "/repos/myapp" })],
    [
      makeRule({
        id: "r2",
        kind: "directory",
        pattern: "/repos/myapp/.worktrees/feature",
        parentProjectId: null,
        priority: 10,
      }),
    ],
  );

  it("falls back to longest-prefix match for parent project", () => {
    const r = snap.resolve("/repos/myapp/.worktrees/feature/src");
    expect(r.projectId).toBe("parent");
    expect(r.worktreePath).not.toBeNull();
    expect(r.matchedRuleId).toBe("r2");
    expect(r.matchedProjectPath).toBe("/repos/myapp");
  });

  it("returns all-nulls when the directory rule does not match the path", () => {
    // The rule pattern is /repos/myapp/.worktrees/feature — a completely
    // different path should not match and should return all nulls.
    const r = snap.resolve("/completely/different/path/src");
    expect(r.worktreePath).toBeNull();
    expect(r.matchedRuleId).toBeNull();
    expect(r.projectId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9. Worktree regex rule matches and beats direct prefix
// ---------------------------------------------------------------------------

describe("worktree regex rule", () => {
  const snap = buildCS(
    [makeProject({ id: "main", canonicalPath: "/repos/myapp" })],
    [
      makeRule({
        id: "regex-rule",
        kind: "regex",
        pattern: "\\.worktrees\\/",
        parentProjectId: "main",
        priority: 5,
      }),
    ],
  );

  it("matches a worktree path via regex and rolls up", () => {
    const r = snap.resolve("/repos/myapp/.worktrees/fix-branch/src");
    expect(r.projectId).toBe("main");
    expect(r.matchedRuleId).toBe("regex-rule");
    expect(r.worktreePath).not.toBeNull();
  });

  it("does not match a normal (non-worktree) path", () => {
    const r = snap.resolve("/repos/myapp/src/index.ts");
    expect(r.projectId).toBe("main");
    expect(r.matchedRuleId).toBeNull(); // hit via prefix, not rule
    expect(r.worktreePath).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 10. Worktree glob rule with **/.worktrees/* pattern
// ---------------------------------------------------------------------------

describe("worktree glob rule", () => {
  // **/*worktrees/** matches any path containing a segment ending in "worktrees",
  // covering .maestro/worktrees, .claude/worktrees, .omc/worktrees, .worktrees, etc.
  const snap = buildCS(
    [makeProject({ id: "main", canonicalPath: "/repos/myapp" })],
    [
      makeRule({
        id: "glob-rule",
        kind: "glob",
        pattern: "**/*worktrees/**",
        parentProjectId: "main",
        priority: 5,
      }),
    ],
  );

  it("matches .claude/worktrees nested path via glob", () => {
    const r = snap.resolve("/repos/myapp/.claude/worktrees/feature-x/src");
    expect(r.projectId).toBe("main");
    expect(r.matchedRuleId).toBe("glob-rule");
    expect(r.worktreePath).not.toBeNull();
  });

  it("matches .worktrees dot-prefixed segment via glob", () => {
    const r = snap.resolve("/repos/myapp/.worktrees/feature/src");
    expect(r.projectId).toBe("main");
    expect(r.matchedRuleId).toBe("glob-rule");
  });
});

// ---------------------------------------------------------------------------
// 11. Higher priority rule wins over lower priority on the same path
// ---------------------------------------------------------------------------

describe("rule priority", () => {
  const snap = buildCS(
    [
      makeProject({ id: "project-a", canonicalPath: "/repos/app" }),
      makeProject({ id: "project-b", canonicalPath: "/repos/other" }),
    ],
    [
      makeRule({
        id: "low-priority",
        kind: "regex",
        pattern: "\\.worktrees\\/",
        parentProjectId: "project-b",
        priority: 1,
      }),
      makeRule({
        id: "high-priority",
        kind: "regex",
        pattern: "\\.worktrees\\/",
        parentProjectId: "project-a",
        priority: 10,
      }),
    ],
  );

  it("high priority rule wins", () => {
    const r = snap.resolve("/repos/app/.worktrees/branch/file.ts");
    expect(r.matchedRuleId).toBe("high-priority");
    expect(r.projectId).toBe("project-a");
  });
});

// ---------------------------------------------------------------------------
// 12. Rule with non-null compileError is skipped
// ---------------------------------------------------------------------------

describe("rule with compileError is skipped", () => {
  const snap = buildCS(
    [makeProject({ id: "main", canonicalPath: "/repos/myapp" })],
    [
      makeRule({
        id: "bad-rule",
        kind: "regex",
        pattern: ".*",
        parentProjectId: "main",
        priority: 100,
        compileError: "invalid pattern",
      }),
    ],
  );

  it("skips the bad rule and falls through to prefix match", () => {
    const r = snap.resolve("/repos/myapp/src");
    expect(r.matchedRuleId).toBeNull(); // bad rule was skipped
    expect(r.projectId).toBe("main");  // prefix match won
    expect(r.worktreePath).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 13. Rule with invalid runtime pattern is skipped — no exception escapes
// ---------------------------------------------------------------------------

describe("rule with invalid regex pattern at runtime", () => {
  const snap = buildCS(
    [makeProject({ id: "main", canonicalPath: "/repos/myapp" })],
    [
      makeRule({
        id: "invalid-regex",
        kind: "regex",
        // Invalid regex: unbalanced parenthesis
        pattern: "([invalid",
        parentProjectId: "main",
        priority: 100,
        compileError: null, // caller didn't catch it
      }),
    ],
  );

  it("does not throw and falls through to prefix match", () => {
    expect(() => snap.resolve("/repos/myapp/src")).not.toThrow();
    const r = snap.resolve("/repos/myapp/src");
    expect(r.projectId).toBe("main");
    expect(r.matchedRuleId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 14. Case-insensitive mode (darwin default)
// ---------------------------------------------------------------------------

describe("case-insensitive mode", () => {
  // Project stored with lower-cased canonical path (as callers would normalise on darwin)
  const snap = buildCI([
    makeProject({ id: "p1", canonicalPath: "/users/x/foo" }),
  ]);

  it("resolves mixed-case input path to the project", () => {
    const r = snap.resolve("/Users/X/Foo");
    expect(r.projectId).toBe("p1");
  });

  it("resolves child path with mixed case", () => {
    const r = snap.resolve("/Users/X/Foo/Bar/Baz");
    expect(r.projectId).toBe("p1");
  });
});

// ---------------------------------------------------------------------------
// 15. Case-sensitive mode (linux default)
// ---------------------------------------------------------------------------

describe("case-sensitive mode", () => {
  const snap = buildCS([
    makeProject({ id: "p1", canonicalPath: "/users/x/foo" }),
  ]);

  it("does NOT match mixed-case path in case-sensitive mode", () => {
    const r = snap.resolve("/Users/X/Foo");
    expect(r.projectId).toBeNull();
  });

  it("matches exact case", () => {
    const r = snap.resolve("/users/x/foo");
    expect(r.projectId).toBe("p1");
  });
});

// ---------------------------------------------------------------------------
// 16. ResolverManager — rebuild and subscribe
// ---------------------------------------------------------------------------

describe("ResolverManager", () => {
  it("starts with an empty snapshot that returns nulls", () => {
    const mgr = new ResolverManager({ caseSensitive: true });
    const r = mgr.current().resolve("/any/path");
    expect(r.projectId).toBeNull();
  });

  it("rebuild swaps the snapshot atomically", () => {
    const mgr = new ResolverManager({ caseSensitive: true });
    mgr.rebuild(
      [makeProject({ id: "p1", canonicalPath: "/repos/app" })],
      [],
    );
    const r = mgr.current().resolve("/repos/app/main.ts");
    expect(r.projectId).toBe("p1");
  });

  it("subscribe receives the new snapshot on rebuild", () => {
    const mgr = new ResolverManager({ caseSensitive: true });
    let received: unknown = null;
    const unsub = mgr.subscribe((snap) => {
      received = snap;
    });

    mgr.rebuild([makeProject({ id: "p2", canonicalPath: "/x" })], []);
    expect(received).not.toBeNull();
    expect(received).toBe(mgr.current());

    unsub();
    // After unsubscribe, no more calls
    const before = received;
    mgr.rebuild([], []);
    expect(received).toBe(before);
  });

  it("subscriber error does not crash the manager", () => {
    const mgr = new ResolverManager({ caseSensitive: true });
    mgr.subscribe(() => { throw new Error("boom"); });
    expect(() => mgr.rebuild([], [])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 17. Disabled rule is not compiled / executed
// ---------------------------------------------------------------------------

describe("disabled rule is ignored", () => {
  const snap = buildCS(
    [makeProject({ id: "main", canonicalPath: "/repos/myapp" })],
    [
      makeRule({
        id: "disabled-rule",
        kind: "regex",
        pattern: "\\.worktrees\\/",
        parentProjectId: "main",
        priority: 100,
        enabled: false,
      }),
    ],
  );

  it("ignores disabled rule; falls through to prefix", () => {
    const r = snap.resolve("/repos/myapp/.worktrees/feature");
    expect(r.matchedRuleId).toBeNull();
    expect(r.projectId).toBe("main");
    expect(r.worktreePath).toBeNull();
  });
});
