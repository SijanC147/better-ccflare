import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const gate = path.join(repoRoot, "scripts", "check-typecheck-coverage.ts");
const changedPaths = path.join(repoRoot, "scripts", "ci-changed-paths");

/**
 * Fixtures own their own directory and remove only what they created. The directory is asserted
 * non-empty and outside the live worktree before anything is written into it, and every git call
 * names it with `-C`, so a path that resolved wrong cannot reach this repository.
 */
const created: string[] = [];
function makeDir(prefix: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	expect(dir.length).toBeGreaterThan(0);
	expect(dir).not.toBe(repoRoot);
	expect(dir.startsWith(repoRoot)).toBe(false);
	created.push(dir);
	return dir;
}

afterEach(() => {
	while (created.length > 0) {
		const dir = created.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function git(dir: string, ...args: string[]) {
	const result = Bun.spawnSync(
		["git", "-C", dir, "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
		{ env: { PATH: process.env.PATH ?? "", HOME: dir } },
	);
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	}
	return result.stdout.toString();
}

function write(dir: string, relative: string, content: string) {
	const file = path.join(dir, relative);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content);
}

/**
 * `noLib` and `types: []` keep each program to the fixture's own files, so a test builds in
 * milliseconds rather than parsing the standard library once per target.
 */
function tsconfig(extra: Record<string, unknown>): string {
	return JSON.stringify({
		compilerOptions: { noEmit: true, noLib: true, types: [], module: "ESNext", moduleResolution: "bundler" },
		...extra,
	});
}

type Fixture = {
	scripts?: Record<string, string>;
	files?: Record<string, string>;
	/** Written to disk and staged. Defaults to every key of `files`. */
	track?: string[];
	allowlist?: unknown;
};

const DEFAULT_SCRIPTS = {
	typecheck: "bunx tsc --noEmit && bun run typecheck:tests",
	"typecheck:tests": "bunx tsc --noEmit -p tests/tsconfig.json",
};

const DEFAULT_FILES = {
	"tsconfig.json": tsconfig({ include: ["src/**/*"] }),
	"tests/tsconfig.json": tsconfig({ include: ["**/*.ts"] }),
	"src/a.ts": "export const a = 1;\n",
	"tests/a.test.ts": "export const t = 1;\n",
};

function makeRepo(fixture: Fixture = {}): string {
	const dir = makeDir("typecheck-coverage-");
	git(dir, "init", "-q");
	const files: Record<string, string> = { ...DEFAULT_FILES, ...fixture.files };
	files["package.json"] = JSON.stringify({ scripts: fixture.scripts ?? DEFAULT_SCRIPTS });
	if (fixture.allowlist !== undefined) {
		files["scripts/typecheck-coverage-allowlist.json"] = JSON.stringify(fixture.allowlist);
	} else if (!("scripts/typecheck-coverage-allowlist.json" in files)) {
		files["scripts/typecheck-coverage-allowlist.json"] = "[]";
	}
	for (const [relative, content] of Object.entries(files)) write(dir, relative, content);
	const track = fixture.track ?? Object.keys(files);
	if (track.length > 0) git(dir, "add", "--", ...track);
	return dir;
}

function runGate(root: string) {
	const result = Bun.spawnSync(["bun", "run", gate, "--root", root], { cwd: repoRoot });
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

/** The summary line without its timing, which varies run to run. */
function summaryOf(output: string): string {
	const line = output.split("\n").find((l) => l.includes(" targets, "));
	return (line ?? "").replace(/, [0-9.]+s$/, "");
}

describe("check-typecheck-coverage", () => {
	test("passes when every tracked TypeScript file is in a chained target", () => {
		const root = makeRepo();
		const result = runGate(root);
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		expect(summaryOf(result.stdout)).toBe(
			"check-typecheck-coverage: ok: 2 targets, 2 tracked, 2 covered, 0 ungated (0 allowlisted)",
		);
	});

	test("fails naming a tracked .ts file that no target lists", () => {
		const root = makeRepo({ files: { "bench/stray.ts": "export const s = 1;\n" } });
		const result = runGate(root);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("UNGATED    bench/stray.ts\n");
		expect(summaryOf(result.stderr)).toBe(
			"check-typecheck-coverage: 2 targets, 3 tracked, 2 covered, 1 ungated (0 allowlisted)",
		);
	});

	test("fails on an ungated .tsx file", () => {
		const root = makeRepo({ files: { "web/view.tsx": "export const v = 1;\n" } });
		const result = runGate(root);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("UNGATED    web/view.tsx\n");
	});

	test("ignores a stray file that is on disk but not tracked", () => {
		// The population is what git tracks, so an untracked scratch file in a checkout must not
		// fail the gate. Without this, the test above could pass by scanning the disk.
		const root = makeRepo({ files: { "bench/stray.ts": "export const s = 1;\n" }, track: [] });
		git(root, "add", "--", ...Object.keys(DEFAULT_FILES), "package.json", "scripts/typecheck-coverage-allowlist.json");
		const result = runGate(root);
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
	});

	test("counts a file reached only by import as covered, the way tsc --listFilesOnly does", () => {
		const root = makeRepo({
			files: {
				"tsconfig.json": tsconfig({ files: ["src/a.ts"] }),
				"src/a.ts": 'import { b } from "./lib/b";\nexport const a = b;\n',
				"src/lib/b.ts": "export const b = 1;\n",
			},
		});
		const result = runGate(root);
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		expect(summaryOf(result.stdout)).toBe(
			"check-typecheck-coverage: ok: 2 targets, 3 tracked, 3 covered, 0 ungated (0 allowlisted)",
		);
	});

	test("resolves -p naming a directory to its tsconfig.json", () => {
		const root = makeRepo({
			scripts: { typecheck: "bunx tsc --noEmit && bunx tsc --noEmit -p tests" },
		});
		const result = runGate(root);
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
	});

	test("passes when the only ungated file is allowlisted with a reason", () => {
		const root = makeRepo({
			files: { "bench/stray.ts": "export const s = 1;\n" },
			allowlist: [{ path: "bench/stray.ts", reason: "fixture exemption" }],
		});
		const result = runGate(root);
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		expect(summaryOf(result.stdout)).toBe(
			"check-typecheck-coverage: ok: 2 targets, 3 tracked, 2 covered, 1 ungated (1 allowlisted)",
		);
	});

	test("fails on an allowlist entry whose file is no longer tracked", () => {
		const root = makeRepo({ allowlist: [{ path: "bench/deleted.ts", reason: "was shadowed" }] });
		const result = runGate(root);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("GONE       bench/deleted.ts\n");
		expect(result.stderr).not.toContain("COVERED");
	});

	test("fails on an allowlist entry that a target now covers, naming the target", () => {
		const root = makeRepo({ allowlist: [{ path: "tests/a.test.ts", reason: "was ungated once" }] });
		const result = runGate(root);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(
			"COVERED    tests/a.test.ts\n           Allowlisted but tests/tsconfig.json now lists it.",
		);
		expect(result.stderr).not.toContain("GONE");
	});

	test("fails on a typecheck script the chain never runs, and does not count its files", () => {
		// SB23-2387's shape: a target defined and correct, invoked by nothing.
		const root = makeRepo({
			scripts: {
				...DEFAULT_SCRIPTS,
				"typecheck:bench": "bunx tsc --noEmit -p bench/tsconfig.json",
			},
			files: {
				"bench/tsconfig.json": tsconfig({ include: ["**/*.ts"] }),
				"bench/run.ts": "export const r = 1;\n",
			},
		});
		const result = runGate(root);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("UNCHAINED  typecheck:bench\n");
		expect(result.stderr).toContain("UNGATED    bench/run.ts\n");
	});

	test("refuses to run on a chain part it does not understand", () => {
		const root = makeRepo({
			scripts: { typecheck: "bunx tsc --noEmit && tsc --noEmit -p tests/tsconfig.json" },
		});
		const result = runGate(root);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain('chain part this check does not understand: "tsc --noEmit -p tests/tsconfig.json"');
	});

	test("refuses to run when the chain names a script that is not defined", () => {
		const root = makeRepo({ scripts: { typecheck: "bunx tsc --noEmit && bun run typecheck:gone" } });
		const result = runGate(root);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain('the chain runs script "typecheck:gone", which is not defined');
	});

	test("refuses to run when a target's tsconfig matches no inputs", () => {
		// A program that cannot build lists nothing, which would otherwise read as zero coverage.
		const root = makeRepo({ files: { "tests/tsconfig.json": tsconfig({ include: ["nothing/**/*"] }) } });
		const result = runGate(root);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("tests/tsconfig.json: TS18003");
	});

	test("refuses to run when a target's tsconfig does not exist", () => {
		const root = makeRepo({
			scripts: { typecheck: "bunx tsc --noEmit && bunx tsc --noEmit -p missing/tsconfig.json" },
		});
		const result = runGate(root);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("runs missing/tsconfig.json, which does not exist");
	});

	test("refuses to run on an allowlist entry without a reason", () => {
		const root = makeRepo({
			files: { "bench/stray.ts": "export const s = 1;\n" },
			allowlist: [{ path: "bench/stray.ts", reason: "  " }],
		});
		const result = runGate(root);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain('(bench/stray.ts) has no "reason"');
	});

	test("refuses to run on a duplicate allowlist entry", () => {
		const root = makeRepo({
			files: { "bench/stray.ts": "export const s = 1;\n" },
			allowlist: [
				{ path: "bench/stray.ts", reason: "one" },
				{ path: "bench/stray.ts", reason: "two" },
			],
		});
		const result = runGate(root);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("repeats bench/stray.ts");
	});

	test("refuses to run without an allowlist file", () => {
		const root = makeRepo();
		rmSync(path.join(root, "scripts", "typecheck-coverage-allowlist.json"));
		const result = runGate(root);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("could not read the allowlist");
	});
});

describe("ci-changed-paths treats TypeScript as relevant wherever it sits", () => {
	/**
	 * The coverage gate reads every tracked `.ts`, so a `.ts` added under a directory the script
	 * otherwise treats as inert would skip the gate on its own PR and fail the next one instead.
	 */
	function changed(job: "quality" | "contract", file: string): string {
		const dir = makeDir("ci-changed-paths-");
		git(dir, "init", "-q");
		write(dir, "README.md", "base\n");
		git(dir, "add", "--", "README.md");
		git(dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base");
		const base = git(dir, "rev-parse", "HEAD").trim();
		write(dir, file, "export const x = 1;\n");
		git(dir, "add", "--", file);
		git(dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "change");
		const head = git(dir, "rev-parse", "HEAD").trim();
		// GITHUB_OUTPUT is deliberately absent, so the result goes to stdout and a run inside CI
		// never appends to the real step's output file.
		const result = Bun.spawnSync(["bash", changedPaths, job], {
			cwd: dir,
			env: { PATH: process.env.PATH ?? "", HOME: dir, BASE_SHA: base, HEAD_SHA: head },
		});
		expect(result.exitCode).toBe(0);
		const line = result.stdout.toString().split("\n").find((l) => l.startsWith("relevant="));
		return line ?? "";
	}

	test.each([
		["quality", "docs/example.ts", "relevant=true"],
		["quality", "docs/example.tsx", "relevant=true"],
		["quality", ".claude/example.ts", "relevant=true"],
		["quality", ".github/scripts/example.ts", "relevant=true"],
		["contract", "docs/example.ts", "relevant=true"],
		["quality", "docs/example.md", "relevant=false"],
		["quality", "packages/x/README.md", "relevant=false"],
		["quality", ".github/ISSUE_TEMPLATE/bug.yml", "relevant=false"],
		["contract", "docs/example.md", "relevant=false"],
	] as const)("%s: %s gives %s", (job, file, expected) => {
		expect(changed(job, file)).toBe(expected);
	});
});

describe("check-typecheck-coverage is wired into CI", () => {
	test("package.json runs the script and ci.yml runs it behind the changed-paths gate", () => {
		const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
		expect(pkg.scripts["check:typecheck-coverage"]).toBe("bun run scripts/check-typecheck-coverage.ts");
		const ci = readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
		expect(ci).toContain(
			"      - name: Check every tracked TypeScript file is in a typecheck target\n" +
				"        if: steps.changes.outputs.relevant != 'false'\n" +
				"        run: bun run check:typecheck-coverage\n",
		);
	});
});
