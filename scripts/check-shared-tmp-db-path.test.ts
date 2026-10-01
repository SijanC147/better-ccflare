import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const gate = path.join(repoRoot, "scripts", "check-shared-tmp-db-path.ts");

/**
 * Fixtures own their own directory and remove only what they created. A helper that returns
 * a bare path and falls back to `os.tmpdir()` is `rm -rf /tmp` on a machine where the
 * fallback fires, so the directory is asserted non-empty, asserted not to be the live
 * worktree, and recorded for teardown before anything is written into it.
 *
 * Never put a standalone string literal in THIS file that starts under a temp root and ends
 * in a database extension: the whole-tree run scans this file too, and would report it.
 * Fixture sources are whole statements, so their string values start with `const` or
 * `import`, and the assertions below match `subject.test.ts:<line>:` instead of a path.
 */
const created: string[] = [];

function makeFixtureDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "shared-tmp-db-path-"));
	expect(dir.length).toBeGreaterThan(0);
	expect(dir).not.toBe(repoRoot);
	expect(dir.startsWith(repoRoot)).toBe(false);
	created.push(dir);
	return dir;
}

/** Writes `source` to `<dir>/<relative>` and returns the directory to scan. */
function makeFixture(source: string, relative = "subject.test.ts"): string {
	const dir = makeFixtureDir();
	const file = path.join(dir, relative);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, source);
	return dir;
}

afterEach(() => {
	while (created.length > 0) {
		const dir = created.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function runGate(...args: string[]) {
	const result = Bun.spawnSync(["bun", "run", gate, ...args], { cwd: repoRoot });
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

const IMPORTS = [
	'import { join } from "node:path";',
	'import * as path from "node:path";',
	'import os, { tmpdir } from "node:os";',
	'import { mkdtempSync } from "node:fs";',
	'import { randomBytes, randomUUID } from "node:crypto";',
	'import { DatabaseFactory, DatabaseOperations } from "@better-ccflare/database";',
];

/** Line numbers below count from 1 at the first import. */
function source(...body: string[]): string {
	return [...IMPORTS, ...body].join("\n");
}
const FIRST_BODY_LINE = IMPORTS.length + 1;

/** Asserts exit 1 and exactly one offence, on the given body line. */
function expectOneOffence(dir: string, bodyLine: number): string {
	const { exitCode, stdout, stderr } = runGate(dir);
	expect(exitCode).toBe(1);
	const line = FIRST_BODY_LINE + bodyLine;
	expect(stderr).toContain(`subject.test.ts:${line}:`);
	expect(stderr.split("subject.test.ts:").length - 1).toBe(1);
	expect(stderr).toContain("append ${process.pid}, or build the path under mkdtempSync");
	expect(stdout).toContain("1 offences");
	return stderr;
}

function expectClean(dir: string): void {
	const { exitCode, stdout, stderr } = runGate(dir);
	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
	expect(stdout).toContain("0 offences");
}

describe("shared-tmp-db-path fixtures", () => {
	describe("reports a fixed database path under a shared temp root", () => {
		test("the PR #290 template shape with ||", () => {
			const dir = makeFixture(source("const TEST_DB_PATH = `${process.env.TMPDIR || \"/tmp\"}/test-x.db`;"));
			expectOneOffence(dir, 0);
		});

		test("the PR #290 template shape with ??", () => {
			const dir = makeFixture(source("const TEST_DB_PATH = `${process.env.TMPDIR ?? \"/tmp\"}/test-x.db`;"));
			expectOneOffence(dir, 0);
		});

		test("join(tmpdir(), ...)", () => {
			const dir = makeFixture(source('const p = join(tmpdir(), "x.db");'));
			expectOneOffence(dir, 0);
		});

		test("path.join(os.tmpdir(), ...) naming a .sqlite file", () => {
			const dir = makeFixture(source('const p = path.join(os.tmpdir(), "x.sqlite");'));
			expectOneOffence(dir, 0);
		});

		test("a literal path under /tmp", () => {
			// Assembled at runtime so this file never holds the literal itself.
			const literal = `"${"/tmp"}/x.db"`;
			const dir = makeFixture(source(`const p = ${literal};`));
			expectOneOffence(dir, 0);
		});

		test("inline inside DatabaseFactory.initialize, with no named constant", () => {
			const dir = makeFixture(source("", 'DatabaseFactory.initialize(join(tmpdir(), "inline.db"));'));
			expectOneOffence(dir, 1);
		});

		test("inline inside new DatabaseOperations, with no named constant", () => {
			const dir = makeFixture(source("const ops = new DatabaseOperations(`${tmpdir()}/inline.db`);"));
			expectOneOffence(dir, 0);
		});

		test("a const file name resolved into join(tmpdir(), NAME), reported once at the join", () => {
			const dir = makeFixture(source('const NAME = "x.db";', "const p = join(tmpdir(), NAME);"));
			expectOneOffence(dir, 1);
		});

		test("a fixed directory constant under the root holding a fixed file", () => {
			const dir = makeFixture(source('const DIR = join(tmpdir(), "fixed");', 'const p = join(DIR, "test.db");'));
			expectOneOffence(dir, 1);
		});

		test("a fixed directory and file in one join", () => {
			const dir = makeFixture(source('const p = join(tmpdir(), "fixed", "test.db");'));
			expectOneOffence(dir, 0);
		});

		test("a const path and its use are one report, at the const", () => {
			const dir = makeFixture(
				source(
					'const TEST_DB = join(tmpdir(), "x.db");',
					"DatabaseFactory.initialize(TEST_DB);",
					"const again = `${TEST_DB}`;",
				),
			);
			expectOneOffence(dir, 0);
		});

		test("a path wrapped in a template around it is one report, not two", () => {
			// The inner join and the template around it evaluate to the same fixed path. Mutant
			// M16 removed the nested-candidate suppression and survived every other test here.
			const dir = makeFixture(source('const p = `${join(tmpdir(), "wrapped.db")}`;'));
			expectOneOffence(dir, 0);
		});

		test("a file in a nested subdirectory is found, so the walker descends", () => {
			const dir = makeFixture(
				source('const p = join(tmpdir(), "nested.db");'),
				path.join("a", "b", "__tests__", "subject.test.ts"),
			);
			const { exitCode, stderr } = runGate(dir);
			expect(exitCode).toBe(1);
			expect(stderr).toContain(`${path.join("a", "b", "__tests__", "subject.test.ts")}:${FIRST_BODY_LINE}:`);
		});
	});

	describe("passes a path that varies or is not a shared database", () => {
		test("a ${process.pid} suffix", () => {
			expectClean(makeFixture(source("const p = `${process.env.TMPDIR || \"/tmp\"}/test-x-${process.pid}.db`;")));
		});

		test("randomBytes(6).toString(hex)", () => {
			expectClean(makeFixture(source('const p = join(tmpdir(), `x-${randomBytes(6).toString("hex")}.db`);')));
		});

		test("randomUUID()", () => {
			expectClean(makeFixture(source("const p = join(tmpdir(), `x-${randomUUID()}.db`);")));
		});

		test("Date.now()", () => {
			expectClean(makeFixture(source("const p = `${tmpdir()}/x-${Date.now()}.db`;")));
		});

		test("a path under mkdtempSync", () => {
			expectClean(
				makeFixture(source('const dir = mkdtempSync(join(tmpdir(), "x-"));', 'const p = join(dir, "test.db");')),
			);
		});

		test("a non-database file under tmp", () => {
			expectClean(makeFixture(source('const p = join(tmpdir(), "x.json");')));
		});

		test("a file name held in a let", () => {
			expectClean(makeFixture(source('let name = "x.db";', "const p = join(tmpdir(), name);")));
		});

		test("a non-test file is not scanned, though it holds a fixed path", () => {
			const dir = makeFixture(source('export const p = join(tmpdir(), "x.db");'), "helper.ts");
			// The scoped run needs a test file to read, or it exits 2 as scanned-nothing.
			writeFileSync(path.join(dir, "empty.test.ts"), "export {};\n");
			expectClean(dir);
		});
	});

	describe("scope and exit codes", () => {
		test("an explicit root prints scoped mode and never whole-tree", () => {
			const { exitCode, stdout } = runGate(makeFixture(source("export {};")));
			expect(exitCode).toBe(0);
			expect(stdout).toContain("scoped mode");
			expect(stdout).not.toContain("whole-tree");
		});

		test("a root holding no test file exits 2, never 0", () => {
			const dir = makeFixtureDir();
			const { exitCode, stderr } = runGate(dir);
			expect(exitCode).toBe(2);
			expect(stderr).toContain("scanned too little");
		});
	});

	/**
	 * The whole-tree invariant is unreachable from a fixture root, because any root argument
	 * selects the scoped branch, and on a healthy repository it never fires. So the gate is
	 * copied into a fixture repository of its own, where `repoRoot` is the fixture and a run
	 * with no arguments walks the fixture's `packages/`. Without this, the 300-file floor and
	 * the database-path floor could each be deleted with every other test green.
	 */
	describe("the whole-tree floor, in a copied fixture repository", () => {
		function makeFixtureRepo(testFiles: number, pidPaths: number): string {
			const dir = makeFixtureDir();
			mkdirSync(path.join(dir, "scripts"));
			writeFileSync(path.join(dir, "scripts", "check-shared-tmp-db-path.ts"), readFileSync(gate, "utf8"));
			symlinkSync(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"));
			mkdirSync(path.join(dir, "packages", "p"), { recursive: true });
			for (let i = 0; i < testFiles; i++) {
				const body = i < pidPaths ? source("const p = `${tmpdir()}/x-${process.pid}.db`;") : "export {};\n";
				writeFileSync(path.join(dir, "packages", "p", `f${i}.test.ts`), body);
			}
			return dir;
		}

		function runCopiedGate(dir: string) {
			const result = Bun.spawnSync(["bun", "run", path.join(dir, "scripts", "check-shared-tmp-db-path.ts")], {
				cwd: dir,
			});
			return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
		}

		test("299 test files exits 2 in whole-tree mode, though a database path was read", () => {
			const { exitCode, stdout, stderr } = runCopiedGate(makeFixtureRepo(299, 1));
			expect(stdout).toContain("whole-tree mode");
			expect(stdout).toContain("299 test files scanned");
			expect(stderr).toContain("floor 300 files");
			expect(exitCode).toBe(2);
		});

		test("300 test files with no shared-tmp database path exits 2", () => {
			const { exitCode, stdout, stderr } = runCopiedGate(makeFixtureRepo(300, 0));
			expect(stdout).toContain("0 of them database paths");
			expect(stderr).toContain("scanned too little");
			expect(exitCode).toBe(2);
		});

		test("300 test files with one varying database path exits 0", () => {
			const { exitCode, stdout, stderr } = runCopiedGate(makeFixtureRepo(300, 1));
			expect(stderr).toBe("");
			expect(stdout).toContain("whole-tree mode");
			expect(stdout).toContain("1 of them database paths, 0 offences");
			expect(exitCode).toBe(0);
		});
	});
});

describe("shared-tmp-db-path on this repository", () => {
	test(
		"the whole tree reads zero offences, in whole-tree mode, having read real counts",
		() => {
			const { exitCode, stdout, stderr } = runGate();
			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
			expect(stdout).toContain("whole-tree mode");
			const match = stdout.match(
				/(\d+) test files scanned, (\d+) shared-tmp path expressions examined, (\d+) of them database paths, (\d+) offences/,
			);
			if (!match) throw new Error(`summary line not found in: ${stdout}`);
			const [, files, examined, dbPaths, found] = match.map(Number);
			expect(files).toBeGreaterThanOrEqual(300);
			expect(examined).toBeGreaterThan(0);
			expect(dbPaths).toBeGreaterThan(0);
			expect(found).toBe(0);
		},
		30_000,
	);
});
