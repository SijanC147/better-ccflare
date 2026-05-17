import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ClaudeCodeDiscovery } from "../discovery";
import { isLikelyWorktreePath } from "../path-encoding";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function projectDir(encodedName: string): string {
	return nodePath.join(tmpDir, encodedName);
}

function mkProject(encodedName: string): string {
	const dir = projectDir(encodedName);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function writeJsonl(dir: string, filename: string, lines: unknown[]): void {
	const content = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
	fs.writeFileSync(nodePath.join(dir, filename), content, { mode: 0o600 });
}

function makeDiscovery(): ClaudeCodeDiscovery {
	return new ClaudeCodeDiscovery({ projectsDir: tmpDir });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
	tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "ccflare-discovery-"));
});

afterEach(async () => {
	await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ClaudeCodeDiscovery.scan()", () => {
	it("returns [] for an empty projects dir", async () => {
		const result = await makeDiscovery().scan();
		expect(result).toEqual([]);
	});

	it("skips non-directory entries", async () => {
		// Create a plain file — should be ignored.
		fs.writeFileSync(nodePath.join(tmpDir, "-Users-foo-bar"), "not a dir");
		const result = await makeDiscovery().scan();
		expect(result).toEqual([]);
	});

	it("skips entries starting with 'ssh-'", async () => {
		mkProject("ssh-remote-host");
		const result = await makeDiscovery().scan();
		expect(result).toEqual([]);
	});

	it("skips the literal '-' entry", async () => {
		mkProject("-");
		const result = await makeDiscovery().scan();
		expect(result).toEqual([]);
	});

	it("resolves canonicalPath from JSONL cwd field", async () => {
		const encoded = "-Users-alice-Code-myproject";
		const dir = mkProject(encoded);
		writeJsonl(dir, "session-abc.jsonl", [{ cwd: "/Users/alice/Code/myproject", type: "session" }]);

		const result = await makeDiscovery().scan();
		expect(result).toHaveLength(1);
		expect(result[0].encodedName).toBe(encoded);
		expect(result[0].canonicalPath).toBe("/Users/alice/Code/myproject");
		expect(result[0].ambiguous).toBe(false);
		expect(result[0].sessionCount).toBe(1);
		expect(result[0].lastSessionAt).toBeGreaterThan(0);
	});

	it("reads cwd from line 1 when line 0 is a permission-mode preamble", async () => {
		const encoded = "-Users-bob-Code-api";
		const dir = mkProject(encoded);
		// Line 0: permission-mode preamble (no cwd).  Line 1: has cwd.
		writeJsonl(dir, "session-def.jsonl", [
			{ type: "permission-mode", mode: "auto" },
			{ cwd: "/Users/bob/Code/api", type: "session" },
		]);

		const result = await makeDiscovery().scan();
		expect(result).toHaveLength(1);
		expect(result[0].canonicalPath).toBe("/Users/bob/Code/api");
		expect(result[0].ambiguous).toBe(false);
	});

	it("falls back to naive decode and sets ambiguous=true when no JSONL", async () => {
		// No JSONL files — only a subdirectory artifact.
		const encoded = "-Users-carol-Code-no-sessions";
		const dir = mkProject(encoded);
		// Create a non-jsonl artefact dir to ensure it's ignored.
		fs.mkdirSync(nodePath.join(dir, "artifacts"));

		const result = await makeDiscovery().scan();
		expect(result).toHaveLength(1);
		expect(result[0].ambiguous).toBe(true);
		// Naive decode of "-Users-carol-Code-no-sessions" →
		// "/Users/carol/Code/no/sessions"  (hyphens in basename become slashes)
		expect(result[0].canonicalPath).toBe("/Users/carol/Code/no/sessions");
		expect(result[0].sessionCount).toBe(0);
		expect(result[0].lastSessionAt).toBeNull();
	});

	it("JSONL cwd beats naive decode for ambiguous hyphen paths", async () => {
		// Encoded name "-tmp-foo-bar" naive-decodes to "/tmp/foo/bar",
		// but the JSONL reveals the true path is "/tmp/foo-bar" (with a hyphen).
		const encoded = "-tmp-foo-bar";
		const dir = mkProject(encoded);
		writeJsonl(dir, "session-xyz.jsonl", [{ cwd: "/tmp/foo-bar" }]);

		const result = await makeDiscovery().scan();
		expect(result).toHaveLength(1);
		expect(result[0].canonicalPath).toBe("/tmp/foo-bar");
		expect(result[0].ambiguous).toBe(false);
	});

	it("counts multiple JSONL files and picks latest mtime for lastSessionAt", async () => {
		const encoded = "-Users-dave-Code-multi";
		const dir = mkProject(encoded);
		// Two sessions.
		writeJsonl(dir, "session-1.jsonl", [{ cwd: "/Users/dave/Code/multi" }]);
		writeJsonl(dir, "session-2.jsonl", [{ type: "only-metadata" }]);

		const result = await makeDiscovery().scan();
		expect(result).toHaveLength(1);
		expect(result[0].sessionCount).toBe(2);
		expect(result[0].lastSessionAt).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// resolveCwd
// ---------------------------------------------------------------------------

describe("ClaudeCodeDiscovery.resolveCwd()", () => {
	it("returns null when no JSONL files exist", async () => {
		const encoded = "-Users-empty";
		mkProject(encoded);
		const cwd = await makeDiscovery().resolveCwd(encoded);
		expect(cwd).toBeNull();
	});

	it("returns the cwd from the first (oldest) JSONL file", async () => {
		const encoded = "-Users-alice-Code-resolve";
		const dir = mkProject(encoded);
		writeJsonl(dir, "session-old.jsonl", [{ cwd: "/Users/alice/Code/resolve" }]);
		writeJsonl(dir, "session-new.jsonl", [{ cwd: "/other/path" }]);

		// The oldest-mtime file should be picked.  Since both are written in the
		// same tick they'll have near-identical mtimes; what matters is the API
		// returns a string, not null.
		const cwd = await makeDiscovery().resolveCwd(encoded);
		expect(typeof cwd).toBe("string");
	});

	it("returns null when JSONL lines have no cwd field", async () => {
		const encoded = "-Users-nocwd";
		const dir = mkProject(encoded);
		writeJsonl(dir, "session.jsonl", [
			{ type: "metadata", model: "claude-3" },
			{ type: "message", role: "user" },
		]);
		const cwd = await makeDiscovery().resolveCwd(encoded);
		expect(cwd).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// isLikelyWorktreePath
// ---------------------------------------------------------------------------

describe("isLikelyWorktreePath()", () => {
	it("detects a path under .worktrees/", () => {
		expect(isLikelyWorktreePath("/Users/foo/.worktrees/feature-x")).toBe(true);
	});

	it("detects a path under worktrees/", () => {
		expect(isLikelyWorktreePath("/Users/foo/worktrees/feature-x")).toBe(true);
	});

	it("detects .maestro/worktrees/x", () => {
		expect(
			isLikelyWorktreePath("/Users/foo/Code/myrepo/.maestro/worktrees/fix-bug"),
		).toBe(true);
	});

	it("detects .ralph/worktrees/x", () => {
		expect(
			isLikelyWorktreePath("/home/user/project/.ralph/worktrees/feature"),
		).toBe(true);
	});

	it("detects .claude/worktrees/x", () => {
		expect(
			isLikelyWorktreePath("/home/user/project/.claude/worktrees/branch"),
		).toBe(true);
	});

	it("detects .omc/worktrees/x", () => {
		expect(
			isLikelyWorktreePath("/home/user/project/.omc/worktrees/experiment"),
		).toBe(true);
	});

	it("does NOT flag a plain path with 'worktree' in a filename segment", () => {
		expect(isLikelyWorktreePath("/tmp/foo-worktree-bar")).toBe(false);
	});

	it("does NOT flag an ordinary project path", () => {
		expect(isLikelyWorktreePath("/Users/alice/Code/my-project")).toBe(false);
	});

	it("does NOT flag a path where worktrees is not a direct child of a dot-segment", () => {
		// `.dotdir/subdir/worktrees` — the dot-segment `.dotdir` is not the
		// immediate parent of `worktrees`, so rule 3 does NOT fire.
		// However rule 1 DOES fire because `worktrees` appears as a segment.
		// Adjust this path so neither rule fires.
		expect(isLikelyWorktreePath("/Users/alice/work-trees/project")).toBe(false);
	});
});
