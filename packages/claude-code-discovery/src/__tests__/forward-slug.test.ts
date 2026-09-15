/**
 * SB23-1975. The `~/.claude/projects` slug maps `/`, `_` and `.` all to `-`, so
 * the encoded name cannot be inverted. These tests pin the forward direction and
 * the guard that makes a drifted rule loud instead of silent.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import {
	ClaudeCodeDiscovery,
	encodePath,
	naiveDecode,
	type ReadDirFn,
	resolveEncodedName,
	SlugRuleDriftError,
} from "../index";

/** A fake filesystem: absolute directory path -> child directory names. */
function fakeReadDir(tree: Record<string, string[]>): ReadDirFn {
	return (dir) => tree[dir] ?? [];
}

describe("encodePath", () => {
	test("a separator becomes a dash and the leading one is kept", () => {
		expect(encodePath("/Users/foo/Code/bar")).toBe("-Users-foo-Code-bar");
	});

	test("an underscore becomes a dash", () => {
		expect(encodePath("/Users/foo/Code/runpod_workspace")).toBe(
			"-Users-foo-Code-runpod-workspace",
		);
	});

	test("a dot becomes a dash, so a hidden directory doubles it", () => {
		expect(encodePath("/Users/foo/Code/.claude-worktrees")).toBe(
			"-Users-foo-Code--claude-worktrees",
		);
	});

	test("all three in one path", () => {
		expect(encodePath("/Users/foo/Code/.worktrees/a_b.c")).toBe(
			"-Users-foo-Code--worktrees-a-b-c",
		);
	});
});

describe("resolveEncodedName", () => {
	const tree = {
		"/": ["Users"],
		"/Users": ["foo"],
		"/Users/foo": ["Code"],
		"/Users/foo/Code": ["runpod_workspace", ".claude-worktrees", "claude-meta"],
		"/Users/foo/Code/runpod_workspace": [".worktrees"],
		"/Users/foo/Code/runpod_workspace/.worktrees": ["workflow-automation"],
		"/Users/foo/Code/.claude-worktrees": ["sb23_419"],
	};

	test("an underscore path resolves to the real directory", () => {
		expect(
			resolveEncodedName("-Users-foo-Code-runpod-workspace", fakeReadDir(tree)),
		).toBe("/Users/foo/Code/runpod_workspace");
	});

	test("a hyphen in a real directory name is not split", () => {
		expect(
			resolveEncodedName("-Users-foo-Code-claude-meta", fakeReadDir(tree)),
		).toBe("/Users/foo/Code/claude-meta");
	});

	test("a dotted directory with an underscore child resolves", () => {
		expect(
			resolveEncodedName(
				"-Users-foo-Code--claude-worktrees-sb23-419",
				fakeReadDir(tree),
			),
		).toBe("/Users/foo/Code/.claude-worktrees/sb23_419");
	});

	test("a nested dot-worktree resolves", () => {
		expect(
			resolveEncodedName(
				"-Users-foo-Code-runpod-workspace--worktrees-workflow-automation",
				fakeReadDir(tree),
			),
		).toBe("/Users/foo/Code/runpod_workspace/.worktrees/workflow-automation");
	});

	test("a name with no real directory behind it resolves to null", () => {
		expect(
			resolveEncodedName("-Users-foo-Code-deleted-repo", fakeReadDir(tree)),
		).toBeNull();
	});

	test("a genuinely ambiguous name resolves to null rather than guessing", () => {
		const ambiguous = fakeReadDir({
			"/": ["a"],
			"/a": ["b-c", "b_c"],
		});
		expect(resolveEncodedName("-a-b-c", ambiguous)).toBeNull();
	});

	test("a name that does not start with a dash is rejected", () => {
		expect(resolveEncodedName("Users-foo", fakeReadDir(tree))).toBeNull();
	});

	test("naiveDecode still gets these wrong, which is why it is the last resort", () => {
		// The regression this replaces: underscores became invented directories.
		expect(naiveDecode("-Users-foo-Code-runpod-workspace")).toBe(
			"/Users/foo/Code/runpod/workspace",
		);
	});
});

describe("the slug-drift guard", () => {
	/**
	 * Without this, a future drift in encodePath reproduces SB23-1975 exactly:
	 * every entry falls through to naiveDecode, every canonical_path names a
	 * directory that does not exist, and nothing ever fails.
	 */
	/** An empty real tree: nothing encodes to anything, so every entry falls through. */
	const nothingResolves = fakeReadDir({ "/": [] });

	function projectsDirWith(count: number): string {
		const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "btcf1975-"));
		expect(dir.length).toBeGreaterThan(0);
		expect(dir).not.toBe(process.cwd());
		for (let i = 0; i < count; i++) {
			// The encoding of `/Users/foo/Code/p_<i>`; encoded names never hold `_`.
			fs.mkdirSync(nodePath.join(dir, `-Users-foo-Code-p-${i}`));
		}
		return dir;
	}

	test("it throws when nothing at all resolves across a real-sized set", async () => {
		const projectsDir = projectsDirWith(12);
		const discovery = new ClaudeCodeDiscovery({
			projectsDir,
			readDir: nothingResolves,
		});
		await expect(discovery.scan()).rejects.toThrow(SlugRuleDriftError);
		fs.rmSync(projectsDir, { recursive: true, force: true });
	});

	test("it stays quiet below the sample floor, where misses are normal", async () => {
		const projectsDir = projectsDirWith(3);
		const discovery = new ClaudeCodeDiscovery({
			projectsDir,
			readDir: nothingResolves,
		});
		const results = await discovery.scan();
		expect(results).toHaveLength(3);
		expect(results.every((r) => r.ambiguous)).toBe(true);
		fs.rmSync(projectsDir, { recursive: true, force: true });
	});

	test("one success in the set is enough to say the rule still works", async () => {
		const projectsDir = projectsDirWith(12);
		// `-Users-foo-Code-p-0` is the encoding of the real `/Users/foo/Code/p_0`.
		const oneResolves = fakeReadDir({
			"/": ["Users"],
			"/Users": ["foo"],
			"/Users/foo": ["Code"],
			"/Users/foo/Code": ["p_0"],
		});
		const discovery = new ClaudeCodeDiscovery({
			projectsDir,
			readDir: oneResolves,
		});
		const results = await discovery.scan();
		expect(results).toHaveLength(12);
		expect(results.filter((r) => !r.ambiguous)).toHaveLength(1);
		fs.rmSync(projectsDir, { recursive: true, force: true });
	});

	test("SlugRuleDriftError names the directory and the count", () => {
		const err = new SlugRuleDriftError(12, "/fake/projects");
		expect(err.attempted).toBe(12);
		expect(err.projectsDir).toBe("/fake/projects");
		expect(err.message).toContain("/fake/projects");
		expect(err.message).toContain("12");
	});
});
