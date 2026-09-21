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

	test("stays silent on `{}`, `Object` and every other spelling of an empty object", () => {
		// SB23-2451. `{}` and the global `Object` accept every non-nullish primitive, so
		// these conditions genuinely can be false and reporting them fails the build on
		// correct code. The interface and the alias are the half the shipped gate got
		// WRONG: it compared the RENDERED name against "{}", and an empty object type is
		// structural, so `interface Empty {}` renders as `Empty` and `type AliasEmpty = {}`
		// renders as `AliasEmpty`. Measured against the gate at 0c0ed042: both were
		// reported, 2 offences, exit 1, on code that compiles under `tsc --strict`.
		//
		// Reverting `isStructurallyEmpty` to `checker.typeToString(type) === "{}"` makes
		// this case exit 1 with 2 offences naming `Empty` and `AliasEmpty`.
		const dir = makeFixture(
			[
				"interface Empty {}",
				"type AliasEmpty = {};",
				"declare function empty(): {};",
				"declare function boxed(): Object;",
				"declare function iface(): Empty;",
				"declare function alias(): AliasEmpty;",
				"export function guard(): boolean {",
				"\tif (empty()) return true;",
				"\tif (boxed()) return true;",
				"\tif (iface()) return true;",
				"\tif (alias()) return true;",
				"\treturn false;",
				"}",
			].join("\n"),
		);
		const { exitCode, stdout } = runGate(dir);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("0 offences");
		expect(stdout).toContain("4 boolean contexts examined");
	});

	test("fails on lowercase `object`, which is always truthy and carries a different flag", () => {
		// SB23-2451's second half, and a FALSE NEGATIVE rather than a false positive.
		// `object` carries `ts.TypeFlags.NonPrimitive`, a different bit from
		// `TypeFlags.Object`, so before its own branch it matched nothing in
		// `partHasFalsyValue` and fell to the conservative `return true` at the end,
		// meaning falsy-capable. It is always truthy. Deleting the `NonPrimitive` branch
		// makes this case report 0 offences and exit 0, which is the gate reading green
		// over the defect class it exists to catch.
		//
		// It is also structurally empty (zero properties, zero index infos, zero
		// signatures), so moving the branch BELOW the empty-object test has the same
		// effect: the structural test calls it falsy and the gate goes silent.
		const dir = makeFixture(
			[
				"declare function plain(): object;",
				"export function guard(): boolean {",
				"\tif (plain()) return true;",
				"\treturn false;",
				"}",
			].join("\n"),
		);
		const { exitCode, stdout, stderr } = runGate(dir);
		expect(exitCode).toBe(1);
		expect(stdout).toContain("1 offences");
		expect(stderr).toContain("subject.ts:3:6");
		expect(stderr).toContain("a call returning object can never be falsy");
	});

	test("fails on an object that declares only an index, call, or construct signature", () => {
		// The three clauses of `isStructurallyEmpty` beyond the property count, one shape
		// each, because each is a type with ZERO properties that is nonetheless always
		// truthy. Drop `getIndexInfosOfType` and `indexed` goes silent; drop the Call
		// clause and `callable` goes silent; drop the Construct clause and `ctor` goes
		// silent. The construct case is the one a property-and-call test would miss:
		// `interface Ctor { new (): X }` has zero properties, zero index infos and zero
		// CALL signatures, so without that clause it reads as `{}` and is not reported.
		const dir = makeFixture(
			[
				"interface Ctor { new (): { a: 1 } }",
				"declare function indexed(): { [k: string]: number };",
				"declare function callable(): () => void;",
				"declare function ctor(): Ctor;",
				"export function guard(): boolean {",
				"\tif (indexed()) return true;",
				"\tif (callable()) return true;",
				"\tif (ctor()) return true;",
				"\treturn false;",
				"}",
			].join("\n"),
		);
		const { exitCode, stdout, stderr } = runGate(dir);
		expect(exitCode).toBe(1);
		expect(stdout).toContain("3 offences");
		expect(stderr).toContain("subject.ts:6:6");
		expect(stderr).toContain("subject.ts:7:6");
		expect(stderr).toContain("subject.ts:8:6");
	});

	test("fails on a module-scoped `interface Object`, which is not the global one", () => {
		// The same rendered-name instrument SB23-2451 removed from the empty-object
		// branch, one line further down. `checker.typeToString(type) === "Object"` also
		// matches a module's OWN `interface Object`, which is an ordinary always-truthy
		// object type and has nothing to do with the global interface that accepts
		// primitives. Measured 2026-09-21: the shipped gate went silent on this.
		//
		// `isGlobalObjectInterface` matches on the symbol plus at least one declaration in
		// a `.d.ts`; this symbol has neither, so it is reported. Replacing that function
		// with `checker.typeToString(type) === "Object"` makes this case exit 0.
		const dir = makeFixture(
			[
				"interface Object { localOnly: 1 }",
				"declare function local(): Object;",
				"export function guard(): boolean {",
				"\tif (local()) return true;",
				"\treturn false;",
				"}",
			].join("\n"),
		);
		const { exitCode, stdout, stderr } = runGate(dir);
		expect(exitCode).toBe(1);
		expect(stdout).toContain("1 offences");
		expect(stderr).toContain("subject.ts:4:6");
	});

	test("separates the `false` literal from the `true` literal, through an alias too", () => {
		// The boolean-literal branch was `checker.typeToString(type) === "false"` and no
		// test pinned it: the PR #212 reviewer measured that mutating the string to
		// `"true"` survived the whole suite. It is now identity against
		// `checker.getFalseType()`, and this case kills the swap in both directions at
		// once: `getTrueType()` in its place makes `no()` report and `yes()` go silent,
		// so the offence count stays 1 while the line number and the rendered type both
		// move. Asserting the line is what separates the two.
		//
		// The alias is here because the identity has to survive one: measured 2026-09-21,
		// `type F = false` yields the same type object as the checker's own `false`.
		const dir = makeFixture(
			[
				"type F = false;",
				"declare function no(): false;",
				"declare function aliased(): F;",
				"declare function yes(): true;",
				"export function guard(): boolean {",
				"\tif (no()) return true;",
				"\tif (aliased()) return true;",
				"\tif (yes()) return true;",
				"\treturn false;",
				"}",
			].join("\n"),
		);
		const { exitCode, stdout, stderr } = runGate(dir);
		expect(exitCode).toBe(1);
		expect(stdout).toContain("1 offences");
		expect(stderr).toContain("subject.ts:8:6");
		expect(stderr).toContain("a call returning true can never be falsy");
		expect(stderr).not.toContain("subject.ts:6:6");
		expect(stderr).not.toContain("subject.ts:7:6");
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

	test("descends a condition root through `!`, `&&`, `||` and parentheses", () => {
		// SB23-2450, and the reviewer's fixture at 3c71d5d2 verbatim. The shipped gate
		// visited only `node.left` of a logical operator, so the two guarded lines were
		// NOT reported and it produced 2 offences here rather than 4. That is the
		// SB23-2375 defect with one guard in front of it, and `replaceUntrustedLink()`,
		// the method the whole of SB23-2375 is about, already sits behind
		// `if (uid === undefined || link.uid === uid) return false;`, so the guarded
		// spelling is the likely one rather than an exotic one.
		//
		// Reverting the condition roots from `descend` to `check` makes this case report
		// 2 offences, naming only lines 7 and 8.
		const dir = makeFixture(
			[
				'type EntryTrust = "trusted" | "directory" | "sticky-entry";',
				"declare function entryIsTrusted(p: string): EntryTrust;",
				"declare function isSymlink(p: string): boolean;",
				"export function guard(p: string): boolean {",
				"\tif (isSymlink(p) && entryIsTrusted(p)) return false;",
				"\tif (!isSymlink(p) || entryIsTrusted(p)) return false;",
				"\tif (entryIsTrusted(p)) return false;",
				"\treturn isSymlink(p) ? (entryIsTrusted(p) ? true : false) : false;",
				"}",
			].join("\n"),
		);
		const { exitCode, stdout, stderr } = runGate(dir);
		expect(exitCode).toBe(1);
		expect(stdout).toContain("4 offences");
		expect(stderr).toContain("subject.ts:5:22");
		expect(stderr).toContain("subject.ts:6:23");
		expect(stderr).toContain("subject.ts:7:6");
		expect(stderr).toContain("subject.ts:8:25");
	});

	test("stays silent on `return f() && g()`, where the right operand is the value", () => {
		// The false positive that a naive `check(node.right)` on the logical-operator
		// dispatch would create, and the reason the fix descends from condition ROOTS
		// instead. Here `entryIsTrusted(p)` is not tested at all: it is what the function
		// returns when the guard passes.
		//
		// `isSymlink()` is deliberately the left operand and deliberately `boolean`. With
		// the always-truthy call on the left the standalone left-operand dispatch would
		// report it by design, and a correct result would read as a regression.
		const dir = makeFixture(
			[
				'type EntryTrust = "trusted" | "directory";',
				"declare function entryIsTrusted(p: string): EntryTrust;",
				"declare function isSymlink(p: string): boolean;",
				"export function value(p: string): EntryTrust | false {",
				"\treturn isSymlink(p) && entryIsTrusted(p);",
				"}",
			].join("\n"),
		);
		const { exitCode, stdout } = runGate(dir);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("0 offences");
	});

	test("reports an operand reached by two routes once, not twice", () => {
		// The dedupe half of SB23-2450. A condition root descends through its `&&` / `||`
		// tree, and the visitor separately dispatches on every `&&`, `||` and `!` it walks
		// past, so each of these three lines reaches the same call expression twice.
		// Without the `visited` set each is printed on two lines of identical output and
		// the run reports 6 offences.
		//
		// The always-truthy call has to be the LEFT operand, and the negated one has to be
		// the negation's own operand, or the second route lands on a `boolean` and the
		// duplicate is invisible whether the dedupe is there or not.
		//
		// Line 8 is the one that needs `check` to strip parentheses as well as `descend`,
		// and it was found by a mutation rather than by design: removing `unwrapParens`
		// from `check` and leaving it in `descend` SURVIVED the first three lines. It has
		// to be a parenthesised LEFT OPERAND of a logical operator, because that is the
		// only position where the second route hands `check` a node `descend` never saw.
		// `descend` strips the parentheses itself before every call it makes, so
		// `if (!(f()))` converges on the same node either way. Without the strip inside
		// `check` the two routes key on the `ParenthesizedExpression` and on the
		// `CallExpression`, the set never matches, and the site is reported twice at two
		// different columns.
		const dir = makeFixture(
			[
				'type EntryTrust = "trusted" | "directory";',
				"declare function entryIsTrusted(p: string): EntryTrust;",
				"declare function isSymlink(p: string): boolean;",
				"export function guard(p: string): boolean {",
				"\tif (entryIsTrusted(p) && isSymlink(p)) return true;",
				"\tif (!entryIsTrusted(p)) return true;",
				"\tif (!(entryIsTrusted(p))) return true;",
				"\tif ((entryIsTrusted(p)) && isSymlink(p)) return true;",
				"\treturn false;",
				"}",
			].join("\n"),
		);
		const { exitCode, stdout, stderr } = runGate(dir);
		expect(exitCode).toBe(1);
		expect(stdout).toContain("4 offences");
		// One line of output per site. `toContain` cannot see a duplicate, and the offence
		// count alone cannot say WHICH site doubled, so count the occurrences of each.
		const occurrences = (needle: string) => stderr.split(needle).length - 1;
		expect(occurrences("subject.ts:5:6")).toBe(1);
		expect(occurrences("subject.ts:6:7")).toBe(1);
		expect(occurrences("subject.ts:7:8")).toBe(1);
		expect(occurrences("subject.ts:8:7")).toBe(1);
		// The column the parenthesised duplicate lands on, and no other site in this
		// fixture reports there. Without the strip inside `check` this reads 1.
		expect(occurrences("subject.ts:8:6")).toBe(0);
	});

	test("descends a ternary test that is itself a logical tree", () => {
		// The ternary root separately from the `if` root, and it needs its own fixture
		// rather than a line in the one above. A mutation reverting ONLY the ternary root
		// from `descend` to `check` SURVIVED every other case here, because the ternary
		// they all use has a bare call as its test, where `check` and `descend` agree.
		// The mutation is observable only when the test is a logical tree.
		const dir = makeFixture(
			[
				'type EntryTrust = "trusted" | "directory";',
				"declare function entryIsTrusted(p: string): EntryTrust;",
				"declare function isSymlink(p: string): boolean;",
				"export function guard(p: string): number {",
				"\treturn isSymlink(p) && entryIsTrusted(p) ? 1 : 0;",
				"}",
			].join("\n"),
		);
		const { exitCode, stdout, stderr } = runGate(dir);
		expect(exitCode).toBe(1);
		expect(stdout).toContain("1 offences");
		expect(stderr).toContain("subject.ts:5:25");
		expect(stderr).toContain("this && condition is always true");
	});

	test("does not descend `??`, the comma operator, or a ternary's branches", () => {
		// The boundary the header claims, pinned so widening it later is a deliberate act
		// rather than an accident. None of these positions is truthy-tested: `??` tests
		// its left operand for nullishness rather than truthiness, the comma operator
		// discards its left operand, and a ternary's branches are the values it produces.
		// Only `pick()` on the last line is a condition, and it is `boolean`.
		const dir = makeFixture(
			[
				'type EntryTrust = "trusted" | "directory";',
				"declare function entryIsTrusted(p: string): EntryTrust;",
				"declare function pick(p: string): boolean;",
				"export function guard(p: string): EntryTrust | number {",
				"\tconst a = entryIsTrusted(p) ?? entryIsTrusted(p);",
				"\tconst b = (entryIsTrusted(p), 1);",
				"\tconst c = pick(p) ? entryIsTrusted(p) : entryIsTrusted(p);",
				"\treturn pick(p) ? a : b + (c === a ? 0 : 1);",
				"}",
			].join("\n"),
		);
		const { exitCode, stdout } = runGate(dir);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("0 offences");
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
