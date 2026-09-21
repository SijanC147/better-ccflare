import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const gate = path.join(repoRoot, "scripts", "check-boolean-widening.ts");

/**
 * Fixtures own their own directory and remove only what they created. A helper that returns a
 * bare path and falls back to `os.tmpdir()` is `rm -rf /tmp` on a machine where the fallback
 * fires, so the directory is asserted non-empty, asserted not to be the live worktree, and
 * recorded for teardown before anything is written into it.
 */
const created: string[] = [];
function makeFixture(source: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), "boolean-widening-"));
	expect(dir.length).toBeGreaterThan(0);
	expect(dir).not.toBe(repoRoot);
	expect(dir.startsWith(repoRoot)).toBe(false);
	created.push(dir);
	writeFileSync(
		path.join(dir, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				strict: true,
				noEmit: true,
				target: "ES2022",
				module: "ESNext",
				moduleResolution: "bundler",
				skipLibCheck: true,
			},
			include: ["subject.ts"],
		}),
	);
	writeFileSync(path.join(dir, "subject.ts"), source);
	return dir;
}

afterEach(() => {
	while (created.length > 0) {
		const dir = created.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function runGate(fixtureDir: string) {
	const result = Bun.spawnSync(["bun", "run", gate, path.join(fixtureDir, "tsconfig.json")], {
		cwd: repoRoot,
	});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

describe("check-boolean-widening", () => {
	test("fails on a string-union call result used as a bare truthy test", () => {
		// The shape of SB23-2375: `entryIsTrusted()` widened from boolean to a reason union and a
		// caller kept the bare test, so the condition became unconditionally true.
		const dir = makeFixture(
			[
				'type EntryTrust = "trusted" | "directory" | "sticky-entry";',
				"declare function entryIsTrusted(entry: string): EntryTrust;",
				"export function replaceUntrustedLink(p: string): boolean {",
				"\tif (entryIsTrusted(p)) return false;",
				"\treturn true;",
				"}",
			].join("\n"),
		);
		const { exitCode, stdout, stderr } = runGate(dir);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("subject.ts:4:6");
		expect(stderr).toContain("can never be falsy");
		expect(stdout).toContain("1 offences");
	});

	test("fails on an object-union call result, which TypeScript accepts just as silently", () => {
		// A discriminated union was the other candidate fix on SB23-2375. `tsc` emits nothing for
		// `if (f())` when f returns `{ ok: true } | { ok: false; reason: string }`, so the object
		// shape is not safer than the string one and the gate has to cover it too.
		const dir = makeFixture(
			[
				"declare function check(): { ok: true } | { ok: false; reason: string };",
				"export function guard(): boolean {",
				"\treturn check() ? true : false;",
				"}",
			].join("\n"),
		);
		const { exitCode, stderr } = runGate(dir);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("subject.ts:3:9");
		expect(stderr).toContain("ternary");
	});

	test("passes when the call result is compared rather than truthy-tested", () => {
		const dir = makeFixture(
			[
				'type EntryTrust = "trusted" | "directory" | "sticky-entry";',
				"declare function entryIsTrusted(entry: string): EntryTrust;",
				"export function replaceUntrustedLink(p: string): boolean {",
				'\tif (entryIsTrusted(p) === "trusted") return false;',
				"\treturn true;",
				"}",
			].join("\n"),
		);
		const { exitCode, stdout } = runGate(dir);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("0 offences");
		// Without this the clean case is vacuous: a gate that parsed nothing also reports zero.
		const examined = /(\d+) boolean contexts examined/.exec(stdout);
		expect(examined).not.toBeNull();
		expect(Number(examined?.[1])).toBeGreaterThanOrEqual(1);
	});

	test("fails on an intersection call result, which is not a TypeFlags.Object", () => {
		// Found by probing the shipped gate, not by reading it. `TypeFlags.Intersection`
		// is not `TypeFlags.Object`, so before the intersection branch this fell through
		// to the conservative "has a falsy value" default and the gate went SILENT on an
		// always-truthy call result, which is the failure direction the gate exists to
		// prevent. Deleting the branch makes this case report 0 offences and exit 0.
		const dir = makeFixture(
			[
				"declare function inter(): { a: 1 } & { b: 2 };",
				"export function guard(): boolean {",
				"\tif (inter()) return true;",
				"\treturn false;",
				"}",
			].join("\n"),
		);
		const { exitCode, stdout, stderr } = runGate(dir);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("subject.ts:3:6");
		expect(stdout).toContain("1 offences");
	});

	test("fails on a union whose only members are an intersection and a non-empty literal", () => {
		const dir = makeFixture(
			[
				'declare function mixed(): ({ a: 1 } & { b: 2 }) | "x";',
				"export function guard(): boolean {",
				"\tif (mixed()) return true;",
				"\treturn false;",
				"}",
			].join("\n"),
		);
		const { exitCode, stdout } = runGate(dir);
		expect(exitCode).toBe(1);
		expect(stdout).toContain("1 offences");
	});

	test("fails on an intersection mixing a falsy-capable constituent with an object", () => {
		// This is the case that separates `.every` from `.some` in the intersection
		// branch, and it is the only one that does. An intersection's inhabitants are the
		// intersection of its constituents' value sets, so `{ a: 1 } & string` contains
		// only strings that also carry `a`, which excludes `""`: always truthy. `.every`
		// returns false here and reports it; `.some` returns true and goes silent.
		//
		// The first attempt at this test used `string & unknown`, which TypeScript
		// collapses to plain `string` because `unknown` is the identity for intersection,
		// so it never reached the branch at all and the `.some` mutant SURVIVED it. A
		// mutation that survives because the test never exercised the predicate looks
		// exactly like a weak assertion.
		const dir = makeFixture(
			[
				"declare function tagged(): { a: 1 } & string;",
				"export function guard(): boolean {",
				"\tif (tagged()) return true;",
				"\treturn false;",
				"}",
			].join("\n"),
		);
		const { exitCode, stdout, stderr } = runGate(dir);
		expect(exitCode).toBe(1);
		expect(stdout).toContain("1 offences");
		expect(stderr).toContain("subject.ts:3:6");
	});

	test("stays silent on an intersection whose every constituent is falsy-capable", () => {
		const dir = makeFixture(
			[
				"declare function loose(): string & (string | number);",
				"export function guard(): boolean {",
				"\tif (loose()) return true;",
				"\treturn false;",
				"}",
			].join("\n"),
		);
		const { exitCode, stdout } = runGate(dir);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("0 offences");
	});

	test("stays silent on `{}` and `Object`, which accept falsy primitives", () => {
		// Both carry `TypeFlags.Object` but accept every non-nullish primitive, so these
		// conditions genuinely can be false. Reporting them fails the build on correct
		// code. Removing the rendered-name check makes this case exit 1 with 2 offences.
		const dir = makeFixture(
			[
				"declare function empty(): {};",
				"declare function boxed(): Object;",
				"export function guard(): boolean {",
				"\tif (empty()) return true;",
				"\tif (boxed()) return true;",
				"\treturn false;",
				"}",
			].join("\n"),
		);
		const { exitCode, stdout } = runGate(dir);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("0 offences");
	});

	test("stays silent on a union that carries a falsy member, which still has two outcomes", () => {
		const dir = makeFixture(
			[
				"declare function find(id: string): string | undefined;",
				"export function has(id: string): boolean {",
				"\tif (find(id)) return true;",
				"\treturn false;",
				"}",
			].join("\n"),
		);
		const { exitCode, stdout } = runGate(dir);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("0 offences");
	});

	test("stays silent on an always-truthy value that did not come from a call", () => {
		// `while (true)` and index reads under `noUncheckedIndexedAccess: false` are 109 sites in
		// this repo and nearly all correct, which is why the gate is scoped to call results.
		const dir = makeFixture(
			[
				"export function loop(map: Record<string, string>, key: string): string {",
				"\twhile (true) {",
				"\t\tif (map[key]) return map[key];",
				"\t\treturn key;",
				"\t}",
				"}",
			].join("\n"),
		);
		const { exitCode, stdout } = runGate(dir);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("0 offences");
	});

	test("fails on a call result behind a type assertion", () => {
		// The reviewer's third false negative. `as`, the angle-bracket form and
		// `satisfies` are none of the node kinds `isCallResult` unwrapped, so the walk
		// stopped and the gate went silent. A cast is what an author adds when a return
		// type has just been widened, so this is the likeliest spelling of the defect.
		const dir = makeFixture(
			[
				'type EntryTrust = "trusted" | "directory";',
				"declare function t(): EntryTrust;",
				"export function guard(): boolean {",
				"\tif (t() as EntryTrust) return true;",
				"\tif (t() satisfies EntryTrust) return true;",
				"\treturn false;",
				"}",
			].join("\n"),
		);
		const { exitCode, stdout } = runGate(dir);
		expect(exitCode).toBe(1);
		expect(stdout).toContain("2 offences");
	});

	test("exits 2, not 0, when it built a program that examined no boolean context", () => {
		// Claim 3's entire mechanism, and the reviewer measured that mutating this
		// `process.exit(2)` to `process.exit(0)` survived all seven original tests: the
		// tsconfig-missing case exits at `readConfigFile` before a program is ever built,
		// so nothing reached this branch. A gate that never read the tree otherwise
		// reports zero offences forever, which is indistinguishable from a clean tree.
		const dir = makeFixture("export const x = 1;\n");
		const { exitCode, stdout, stderr } = runGate(dir);
		expect(exitCode).toBe(2);
		expect(stdout).toContain("0 boolean contexts examined");
		expect(stderr).toContain("not evidence of a clean tree");
	});

	test("stays silent on a union mixing one truthy and one falsy member", () => {
		// Separates `.every` from `.some` in `alwaysTruthy`. `string | undefined` does not,
		// because `string` is itself falsy-capable; `"a" | undefined` does.
		const dir = makeFixture(
			[
				'declare function maybe(): "a" | undefined;',
				"export function guard(): boolean {",
				"\tif (maybe()) return true;",
				"\treturn false;",
				"}",
			].join("\n"),
		);
		const { exitCode, stdout } = runGate(dir);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("0 offences");
	});

	test("exits 2 rather than passing when it is pointed at a tsconfig that does not exist", () => {
		const dir = makeFixture("export const x = 1;\n");
		const result = Bun.spawnSync(
			["bun", "run", gate, path.join(dir, "no-such-tsconfig.json")],
			{ cwd: repoRoot },
		);
		expect(result.exitCode).toBe(2);
		expect(result.stderr.toString()).toContain("could not read");
	});

	// 120s, not the 5000ms default. This case runs the gate over the whole program,
	// 517 files and 13515 boolean contexts, which is 2.3s on an unloaded darwin laptop
	// and timed out at 5001ms on CI at cc8f39cc. The bound is a timeout, not a
	// performance assertion: `SB23-2266` is two wall-clock assertions in this repo that
	// fail on unmodified main under concurrent load, and this must not become a third.
	test("the repository itself is clean, and the run says how much it read", () => {
		const result = Bun.spawnSync(["bun", "run", gate], { cwd: repoRoot });
		const stdout = result.stdout.toString();
		expect(result.exitCode).toBe(0);
		const files = /(\d+) files scanned/.exec(stdout);
		expect(Number(files?.[1])).toBeGreaterThan(100);
		expect(stdout).toContain("0 offences");
	}, 120_000);
});
