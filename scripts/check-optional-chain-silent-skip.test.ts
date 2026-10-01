import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const gate = path.join(repoRoot, "scripts", "check-optional-chain-silent-skip.ts");

/**
 * Fixtures own their own directory and remove only what they created. A helper that returns
 * a bare path and falls back to `os.tmpdir()` is `rm -rf /tmp` on a machine where the
 * fallback fires, so the directory is asserted non-empty, asserted not to be the live
 * worktree, and recorded for teardown before anything is written into it.
 */
const created: string[] = [];

function makeFixtureDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "optional-chain-skip-"));
	expect(dir.length).toBeGreaterThan(0);
	expect(dir).not.toBe(repoRoot);
	expect(dir.startsWith(repoRoot)).toBe(false);
	created.push(dir);
	return dir;
}

/** Writes one `subject.test.ts` and returns the directory to scan. */
function makeFixture(source: string): string {
	const dir = makeFixtureDir();
	writeFileSync(path.join(dir, "subject.test.ts"), source);
	return dir;
}

afterEach(() => {
	while (created.length > 0) {
		const dir = created.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function runGate(fixtureDir: string, ...flags: string[]) {
	const result = Bun.spawnSync(["bun", "run", gate, ...flags, fixtureDir], { cwd: repoRoot });
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

describe("check-optional-chain-silent-skip", () => {
	test("fails on an optional call whose subject an earlier expect asserted present", () => {
		// The shape of SB23-2460 instance 3, `codex/provider.test.ts:5247`: a setTimeout stub
		// captures a callback, the test asserts it was captured, then invokes it optionally.
		// If the stub ever stops capturing, the call is skipped and the test still passes.
		const dir = makeFixture(
			[
				'import { expect, test } from "bun:test";',
				'test("invokes the captured callback", () => {',
				"\tlet timeoutCallback: (() => void) | null = null;",
				"\ttimeoutCallback = () => {};",
				"\texpect(timeoutCallback).not.toBeNull();",
				"\ttimeoutCallback?.();",
				"});",
			].join("\n"),
		);

		const { exitCode, stderr } = runGate(dir);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("subject.test.ts:6:2");
		expect(stderr).toContain("optional call");
		expect(stderr).toContain("not.toBeNull");
		// The report must name the line the GUARD is on as well as the line the offence is
		// on, because the fix is at the guard and a report naming only the `?.` sends the
		// reader to the half that is not wrong.
		expect(stderr).toContain("line 5");
	});

	test("fails on a call made through an optional member, which is the commoner spelling", () => {
		// `reader?.read()` parses as a CallExpression with no questionDotToken of its own,
		// wrapping a PropertyAccessExpression that has one. Without the callee check this
		// shape is filed as a skipped read and the gate stays silent on it. It is the shape
		// four of the five offences on this tree actually had.
		const dir = makeFixture(
			[
				'import { expect, test } from "bun:test";',
				'test("cancels the reader", async () => {',
				"\tconst reader: { read(): Promise<void>; cancel(): Promise<void> } | undefined =",
				"\t\tundefined as never;",
				"\texpect(reader).toBeDefined();",
				"\tawait reader?.cancel();",
				"});",
			].join("\n"),
		);

		const { exitCode, stderr } = runGate(dir);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("optional call through a member");
		expect(stderr).toContain("toBeDefined");
	});

	test("fails when the guard is in an enclosing block rather than the same one", () => {
		// cache-body-store.test.ts (SB23-2399, SB23-2448) had its `?.` inside a `for` body
		// nested in the guarded block. A gate that only searched the innermost scope would
		// have been silent on the instance that started this class.
		const dir = makeFixture(
			[
				'import { expect, test } from "bun:test";',
				'test("replays every buffered chunk", () => {',
				"\tconst sink: { write(k: string): void } | null = null as never;",
				"\texpect(sink).not.toBeNull();",
				'\tfor (const chunk of ["a", "b"]) {',
				"\t\tsink?.write(chunk);",
				"\t}",
				"});",
			].join("\n"),
		);

		const { exitCode, stderr } = runGate(dir);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("subject.test.ts:6:3");
	});

	test("passes a skipped call whose RESULT IS ASSERTED, because that fails loudly", () => {
		// This is the discriminator, and it was arrived at by being wrong first. An earlier
		// version gated every skipped call and reported nine sites shaped like
		// `expect(col?.type.toUpperCase()).toBe("TEXT")`. Short-circuiting makes the whole
		// expression undefined, `expect(undefined).toBe("TEXT")` fails, and the test goes red
		// with a legible message. Those are not silent, and failing a build over code that
		// already catches its own defect is how a gate gets switched off.
		//
		// If this test ever starts failing, the gate has been widened back over the nine and
		// the build is red on `packages/database/src/migrations.test.ts` among others.
		const dir = makeFixture(
			[
				'import { expect, test } from "bun:test";',
				'test("reports the column type", () => {',
				"\tconst col: { type: string } | undefined = undefined;",
				"\texpect(col).toBeDefined();",
				'\texpect(col?.type.toUpperCase()).toBe("TEXT");',
				"});",
			].join("\n"),
		);

		const { exitCode, stdout } = runGate(dir);
		expect(exitCode).toBe(0);
		// Surveyed, so the population stays visible, but not gated.
		expect(stdout).toContain("1 guarded optional chains");
		expect(stdout).toContain("0 offences");
	});

	test("fails on a skipped call one hop further up the chain", () => {
		// In `x?.foo.bar()` only `x?.foo` carries a questionDotToken; its parent is the
		// property access `x?.foo.bar`, and only ITS parent is the call. Testing just the
		// immediate parent files this as a skipped read and the gate is silent on it.
		const dir = makeFixture(
			[
				'import { expect, test } from "bun:test";',
				'test("flushes through the nested handle", () => {',
				"\tconst conn: { stream: { close(): void } } | null = null as never;",
				"\texpect(conn).not.toBeNull();",
				"\tconn?.stream.close();",
				"});",
			].join("\n"),
		);

		const { exitCode, stderr } = runGate(dir);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("subject.test.ts:5:2");
	});

	test("passes the `if (!x) throw` replacement, which is the fix the gate asks for", () => {
		// A gate whose prescribed fix does not satisfy it is a gate people disable.
		const dir = makeFixture(
			[
				'import { expect, test } from "bun:test";',
				'test("invokes the captured callback", () => {',
				"\tlet timeoutCallback: (() => void) | null = null;",
				"\ttimeoutCallback = () => {};",
				'\tif (!timeoutCallback) throw new Error("setTimeout stub captured no callback");',
				"\ttimeoutCallback();",
				"\texpect(true).toBe(true);",
				"});",
			].join("\n"),
		);

		const { exitCode } = runGate(dir);
		expect(exitCode).toBe(0);
	});

	test("passes an UNGUARDED optional call, which is the narrowing that makes this shippable", () => {
		// `dbOps.dispose?.()` and `process.getgid?.()` are optional members of their types
		// and are correct as written. Reporting them would have meant 1248 sites across 169
		// files and a warning nobody reads. This is the negative case that pins the
		// narrowing: if it ever starts failing, the gate has been widened into a ban on
		// optional chaining and the build will be red everywhere.
		const dir = makeFixture(
			[
				'import { test } from "bun:test";',
				'test("disposes if the adapter supports it", () => {',
				"\tconst dbOps: { dispose?: () => void } = {};",
				"\tdbOps.dispose?.();",
				"});",
			].join("\n"),
		);

		const { exitCode } = runGate(dir);
		expect(exitCode).toBe(0);
	});

	test("passes when the assertion is the OPPOSITE claim", () => {
		// `expect(x).toBeNull()` asserts absence, so a `?.` below it is correct. Reading the
		// `.not.` backwards would report the one shape that is right, and every offence this
		// gate found on the real tree came through a negated matcher, so the polarity is
		// load-bearing rather than defensive.
		const dir = makeFixture(
			[
				'import { expect, test } from "bun:test";',
				'test("returns nothing for an unknown key", () => {',
				"\tconst out: { length: number } | null = null;",
				"\texpect(out).toBeNull();",
				"\texpect(out?.length).toBeUndefined();",
				"});",
			].join("\n"),
		);

		const { exitCode } = runGate(dir);
		expect(exitCode).toBe(0);
	});

	test("passes a guard that comes AFTER the optional chain", () => {
		// Order is the whole predicate. A guard below the use does not license it, and
		// comparing positions the wrong way round would report every file that asserts
		// after reading.
		const dir = makeFixture(
			[
				'import { expect, test } from "bun:test";',
				'test("asserts afterwards", () => {',
				"\tconst entry: { size: number } | null = null;",
				"\texpect(entry?.size).toBeUndefined();",
				"\texpect(entry).not.toBeNull();",
				"});",
			].join("\n"),
		);

		const { exitCode } = runGate(dir);
		expect(exitCode).toBe(0);
	});

	test("passes a skipped READ, which is surveyed but deliberately not gated", () => {
		// The 275 guarded optional READS measured on this tree at 6be70246 are a real
		// population and this gate does not fail on them: short-circuiting yields undefined,
		// which an `expect` then almost always rejects. Gating them would have meant 275
		// failures on a clean tree. `--survey` is how that population stays re-derivable.
		const dir = makeFixture(
			[
				'import { expect, test } from "bun:test";',
				'test("reads a field", () => {',
				"\tconst entry: { size: number } | null = null as never;",
				"\texpect(entry).not.toBeNull();",
				"\texpect(entry?.size).toBe(3);",
				"});",
			].join("\n"),
		);

		const { exitCode, stdout } = runGate(dir);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("1 guarded optional chains");
		expect(stdout).toContain("0 offences");

		const survey = runGate(dir, "--survey");
		expect(survey.exitCode).toBe(0);
		expect(survey.stdout).toContain("1 guarded optional chains in 1 files, 0 of which skip a call");
	});

	test("fails when the value reaches a matcher that PASSES on undefined", () => {
		// Condition 4b, found by the PR's reviewer. Discarding the value is only one way to
		// ensure nothing rejects `undefined`; handing it to `toBeUndefined()` is another,
		// and it is exactly as silent. Three live instances existed in
		// `requests-stream-terminal-state.test.ts`, demonstrated at rung 4: with the row
		// lookup made to find nothing and the guard deleted, that file still read 5 pass.
		const dir = makeFixture(
			[
				'import { expect, test } from "bun:test";',
				'test("omits the field when nothing was recorded", () => {',
				"\tconst row: { state?: string } | undefined = undefined;",
				"\texpect(row).toBeDefined();",
				"\texpect(row?.state).toBeUndefined();",
				"});",
			].join("\n"),
		);

		const { exitCode, stderr } = runGate(dir);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("subject.test.ts:5:9");
	});

	test("fails on `not.toBe`, which also passes on undefined", () => {
		const dir = makeFixture(
			[
				'import { expect, test } from "bun:test";',
				'test("is not the sentinel", () => {',
				"\tconst row: { code?: number } | undefined = undefined;",
				"\texpect(row).toBeDefined();",
				"\texpect(row?.code).not.toBe(5);",
				"});",
			].join("\n"),
		);

		expect(runGate(dir).exitCode).toBe(1);
	});

	test("passes `not.toBeUndefined`, which REJECTS undefined", () => {
		// The polarity trap in condition 4b. A rule reading "or starts with `not.`" would
		// report this, and it is the one shape in the family that is already correct:
		// `expect(undefined).not.toBeUndefined()` fails, so a skip IS observed.
		const dir = makeFixture(
			[
				'import { expect, test } from "bun:test";',
				'test("records the field", () => {',
				"\tconst row: { state?: string } | undefined = undefined;",
				"\texpect(row).toBeDefined();",
				"\texpect(row?.state).not.toBeUndefined();",
				"});",
			].join("\n"),
		);

		expect(runGate(dir).exitCode).toBe(0);
	});

	test("passes a skipped call inside a function that `expect` is holding", () => {
		// The reviewer's false positive. `expect(() => { h?.dispatch("x"); }).toThrow(/bad/)`
		// discards the call in statement position, but the skip IS observed: a null `h`
		// means nothing throws and `toThrow` fails. Zero instances on this tree, and the
		// first shape a test author would hit, which is why it is fixed rather than filed.
		const dir = makeFixture(
			[
				'import { expect, test } from "bun:test";',
				'test("rejects a bad event", () => {',
				"\tconst h: { dispatch(k: string): void } | null = null as never;",
				"\texpect(h).not.toBeNull();",
				'\texpect(() => {',
				'\t\th?.dispatch("x");',
				"\t}).toThrow(/bad/);",
				"});",
			].join("\n"),
		);

		expect(runGate(dir).exitCode).toBe(0);
	});

	test("fails on an optional call through an ELEMENT access", () => {
		// Kills the reviewer's M-A: no fixture previously exercised the element-access
		// branch, so `skipsCall: false` could be hardcoded there and every test still passed.
		const dir = makeFixture(
			[
				'import { expect, test } from "bun:test";',
				'test("invokes the first handler", () => {',
				"\tconst hs: Array<() => void> | null = null as never;",
				"\texpect(hs).not.toBeNull();",
				"\ths?.[0]();",
				"});",
			].join("\n"),
		);

		expect(runGate(dir).exitCode).toBe(1);
	});

	test("recognises `toBeTruthy` as a presence assertion", () => {
		// Kills M-B. No fixture used `toBeTruthy`, so it could be dropped from
		// PRESENCE_MATCHERS with the whole suite green.
		const dir = makeFixture(
			[
				'import { expect, test } from "bun:test";',
				'test("flushes", () => {',
				"\tconst sink: { flush(): void } | null = null as never;",
				"\texpect(sink).toBeTruthy();",
				"\tsink?.flush();",
				"});",
			].join("\n"),
		);

		expect(runGate(dir).exitCode).toBe(1);
	});

	test("recognises `not.toBeUndefined` as a presence assertion", () => {
		// Kills M-C, and this is the one worth naming: no fixture used
		// `not.toBeUndefined`, which is the exact matcher the real
		// `codex/provider.test.ts:1160` site had. A gap in the fixtures that lines up with a
		// real site is evidence the fixtures were written from the code rather than from the
		// population they are supposed to cover.
		const dir = makeFixture(
			[
				'import { expect, test } from "bun:test";',
				'test("closes", () => {',
				"\tconst sink: { close(): void } | undefined = undefined;",
				"\texpect(sink).not.toBeUndefined();",
				"\tsink?.close();",
				"});",
			].join("\n"),
		);

		expect(runGate(dir).exitCode).toBe(1);
	});

	test("exits 2 rather than 0 when it scans no test file at all", () => {
		// PR #212's reviewer changed that gate's `process.exit(2)` to `exit(0)` and the
		// mutant survived all seven of its tests: a gate that reads no files reports zero
		// offences forever, which is indistinguishable from a clean tree. This is the
		// assertion that kills it. A non-zero exit is not enough on its own, because 1 would
		// also be non-zero and would mean the opposite, so the code is asserted exactly.
		const dir = makeFixtureDir();
		writeFileSync(path.join(dir, "not-a-test.ts"), "export const x = 1;\n");

		const { exitCode, stderr } = runGate(dir);
		expect(exitCode).toBe(2);
		expect(stderr).toContain("scanned too little");
	});

	test("a scoped run over files with no presence assertion is a pass, not an error", () => {
		// This started as the opposite assertion and the gate agreed with it, which was the
		// gate being wrong rather than the test being right. Requiring a presence assertion
		// at every scope made `check ... packages/config` exit 2 on a directory that simply
		// had none, and an error that fires on correct input is an error people route around.
		// The strong invariant now applies only to the whole-tree run, which is the one CI
		// makes and the only one whose zero anybody trusts.
		const dir = makeFixture(
			['import { test } from "bun:test";', 'test("trivial", () => {});'].join("\n"),
		);

		const { exitCode, stdout, stderr } = runGate(dir);
		expect(exitCode).toBe(0);
		expect(stderr).not.toContain("scanned too little");
		// The negative half of the mode assertion. Without this, `scanMode` could be the
		// constant "whole-tree" and the repository test above would still pass, which is
		// the same vacuous-guard shape M-H exploited in the first place.
		expect(stdout).toContain("scoped mode");
		expect(stdout).not.toContain("whole-tree mode");
	});

	test("descends into nested directories", () => {
		// The walker is hand-rolled, so a fixture proves it recurses rather than reading only
		// the top level. A gate that silently scans one directory deep would report zero on a
		// monorepo forever.
		const dir = makeFixtureDir();
		const nested = path.join(dir, "packages", "thing", "__tests__");
		mkdirSync(nested, { recursive: true });
		writeFileSync(
			path.join(nested, "deep.test.ts"),
			[
				'import { expect, test } from "bun:test";',
				'test("deep", () => {',
				"\tlet cb: (() => void) | null = null;",
				"\tcb = () => {};",
				"\texpect(cb).not.toBeNull();",
				"\tcb?.();",
				"});",
			].join("\n"),
		);

		const { exitCode, stderr } = runGate(dir);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("deep.test.ts");
	});

	test("skips node_modules, so a dependency's tests cannot fail our build", () => {
		const dir = makeFixtureDir();
		const dep = path.join(dir, "node_modules", "some-dep");
		mkdirSync(dep, { recursive: true });
		writeFileSync(
			path.join(dep, "theirs.test.ts"),
			[
				'import { expect, test } from "bun:test";',
				'test("theirs", () => {',
				"\tlet cb: (() => void) | null = null;",
				"\tcb = () => {};",
				"\texpect(cb).not.toBeNull();",
				"\tcb?.();",
				"});",
			].join("\n"),
		);

		// Nothing of ours is left to scan, so this is the scanned-nothing exit rather than a
		// pass. That is the honest answer: the gate did not clear the tree, it found no tree.
		const { exitCode, stderr } = runGate(dir);
		expect(exitCode).toBe(2);
		expect(stderr).not.toContain("theirs.test.ts");
	});

	/**
	 * SB23-2499. Positions where a call's value is thrown away without the call being an
	 * `ExpressionStatement`. Every positive has a near-miss of the same shape in which the
	 * value IS read, because widening a discard rule is only safe if the rule can still say
	 * "read" for the same syntax.
	 *
	 * The fixture header declares the subjects and guards both of them, so the body is the
	 * only variable. The offence is always on the first body line, `BODY_LINE`.
	 */
	const SB23_2499_HEADER = [
		'import { expect, test } from "bun:test";',
		'test("callback and operator positions", async () => {',
		"\tconst sink: { write(k: string): number; close(): Promise<number>; flush(): number; read(): number; label(): string; open(): void } | null = null as never;",
		"\tconst cb: (() => number) | null = null as never;",
		'\tconst xs = ["a"];',
		"\tconst p = Promise.resolve();",
		"\tconst ok = true;",
		"\tlet n = 0;",
		"\texpect(sink).not.toBeNull();",
		"\texpect(cb).not.toBeNull();",
	];
	const BODY_LINE = SB23_2499_HEADER.length + 1;

	function sb23_2499Fixture(body: string[]): string {
		return makeFixture([...SB23_2499_HEADER, ...body.map((l) => `\t${l}`), "});"].join("\n"));
	}

	const reportedPositions: Array<[string, string[]]> = [
		// The five shapes the issue names.
		["an expression-bodied arrow handed to forEach", ["xs.forEach((k) => sink?.write(k));"]],
		["an expression-bodied arrow in an awaited then", ["await p.then(() => sink?.close());"]],
		// SB23-2460's own founding instance, with the stub on the other side of the seam.
		["an expression-bodied arrow handed to setTimeout", ["setTimeout(() => cb?.(), 0);"]],
		["the right operand of && at statement level", ["ok && sink?.flush();"]],
		["the left operand of a comma", ["(sink?.flush(), n++);"]],
		// Folded in because the same climb covers them.
		["the right operand of a comma at statement level", ["(n++, sink?.flush());"]],
		["the right operand of ?? at statement level", ["n ?? sink?.flush();"]],
		["the right operand of || at statement level", ["n || sink?.flush();"]],
		["either branch of a conditional at statement level", ["ok ? sink?.flush() : n++;"]],
		["a for initialiser", ["for (sink?.open(); n < 1; n++) {}"]],
		["a for incrementor", ["for (; n < 1; sink?.open()) n++;"]],
		["a template literal statement", ["`${sink?.label()}`;"]],
		["a return from a callback handed to forEach", ["xs.forEach((k) => {", "\treturn sink?.write(k);", "});"]],
		["a map whose result is discarded", ["xs.map((k) => sink?.write(k));"]],
		["a Promise executor", ["new Promise(() => cb?.());"]],
		["a test registered with test.skip", ['test.skip("inner", () => sink?.flush());']],
		["a void expression", ["void sink?.flush();"]],
		// `finally` ignores its callback's value, so reading the call's result proves nothing.
		["a finally callback whose call's result is asserted", ["expect(await p.finally(() => sink?.read())).toBe(undefined);"]],
	];

	for (const [position, body] of reportedPositions) {
		test(`reports a guarded skipped call in ${position}`, () => {
			const { exitCode, stderr } = runGate(sb23_2499Fixture(body));
			expect(exitCode).toBe(1);
			// The offence is on the body line holding the `?.`, which is the first one except
			// in the `return` case.
			const offset = body.findIndex((line) => line.includes("?."));
			expect(stderr).toContain(`subject.test.ts:${BODY_LINE + offset}:`);
		});
	}

	const unreportedPositions: Array<[string, string[]]> = [
		// The issue's two named negatives.
		["a statement inside a function expect holds for toThrow", ["expect(() => {", '\tsink?.write("x");', "}).toThrow(/bad/);"]],
		["an awaited call inside an async function expect holds for rejects", ["await expect(async () => {", "\tawait sink?.close();", "}).rejects.toThrow();"]],
		// One near-miss per shape: the same syntax, with the value read.
		["a forEach nested inside a function expect holds", ["expect(() => xs.forEach((k) => sink?.write(k))).toThrow();"]],
		["a map whose result is asserted", ["expect(xs.map((k) => sink?.write(k))).toEqual([1]);"]],
		["a then whose result is asserted", ["expect(await p.then(() => sink?.read())).toBe(1);"]],
		["an arrow handed to a callee not known to ignore it", ['app.on("GET", "/", () => cb?.());']],
		["an arrow that is stored rather than handed over", ["const later = () => sink?.flush();", "later();"]],
		["the right operand of && whose value is asserted", ["expect(ok && sink?.flush()).toBe(1);"]],
		["the right operand of a comma whose value is asserted", ["expect((n++, sink?.read())).toBe(1);"]],
		["a conditional whose value is asserted", ["expect(ok ? sink?.read() : 0).toBe(1);"]],
		["a template literal whose value is asserted", ['expect(`${sink?.label()}`).toBe("x");']],
		["a return from a function nobody is known to discard", ["function f() {", "\treturn sink?.read();", "}", "expect(f()).toBe(1);"]],
		["a sort comparator, whose call mutates its receiver", ["xs.sort(() => sink?.read() ?? 0);"]],
		// PR #288's reviewer, S1: the flowing call's result is read by the next link.
		["a then whose result feeds another then", ["await p.then(() => sink?.read()).then((v) => expect(v).toBe(1));"]],
		["a map whose result feeds a forEach", ["xs.map((k) => sink?.write(k)).forEach((v) => expect(v).toBe(1));"]],
	];

	for (const [position, body] of unreportedPositions) {
		test(`does not report ${position}`, () => {
			const { exitCode, stderr } = runGate(sb23_2499Fixture(body));
			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
		});
	}

	/**
	 * SB23-2498. A guard spelled differently from the chain it licenses. Each case is a
	 * guard line then a discarded skipped call, inside one test body; the offence is on the
	 * last body line. Every axis has near-misses that must stay silent, because a widened
	 * condition 2 is only shippable if it can still say "different value".
	 */
	function sb23_2498Fixture(body: string[]): { dir: string; line: number } {
		const lines = [
			'import { expect, test } from "bun:test";',
			'test("a guard spelled differently", () => {',
			...body.map((l) => `\t${l}`),
			"});",
		];
		return { dir: makeFixture(lines.join("\n")), line: 2 + body.length };
	}

	const differentlySpelled: Array<[string, string[]]> = [
		// spelling
		["a non-null assertion in the guard", ["expect(res!.body).not.toBeNull();", "res.body?.flush();"]],
		["an `as` cast in the guard", ["expect(cb as () => void).not.toBeNull();", "cb?.();"]],
		["parentheses in the guard", ["expect((cb)).not.toBeNull();", "cb?.();"]],
		["a string-literal element access in the guard", ['expect(handlers["flush"]).toBeDefined();', "handlers.flush?.();"]],
		["an optional link in a guard that rejects undefined", ["expect(res?.body).toBeDefined();", "res.body?.flush();"]],
		// alias
		["a const alias of the guarded value", ["const handler = holder.cb;", "expect(holder.cb).not.toBeNull();", "handler?.();"]],
		["a guard on the const alias", ["const handler = holder.cb;", "expect(handler).not.toBeNull();", "holder.cb?.();"]],
		// prefix
		["a receiver the guard's evaluation proves present", ["expect(conn.stream.id).not.toBeNull();", "conn?.close();"]],
		["a receiver past an optional link under a matcher rejecting undefined", ["expect(conn?.stream).toBeDefined();", "conn?.close();"]],
		["the receiver of a call in the guard", ['expect(store.get("k")).toBeDefined();', "store?.clear();"]],
		// matcher
		["toBeInstanceOf", ["expect(res).toBeInstanceOf(Response);", "res?.text();"]],
		["toHaveProperty", ['expect(obj).toHaveProperty("x");', "obj?.flush();"]],
		["toHaveLength", ["expect(obj).toHaveLength(1);", "obj?.flush();"]],
		["toMatchObject", ["expect(obj).toMatchObject({});", "obj?.flush();"]],
		["toContain", ['expect(obj).toContain("x");', "obj?.flush();"]],
		["toContainEqual", ["expect(obj).toContainEqual(1);", "obj?.flush();"]],
		["toBeFunction", ["expect(cb).toBeFunction();", "cb?.();"]],
		["toBeArray", ["expect(obj).toBeArray();", "obj?.flush();"]],
		["toBeString", ["expect(obj).toBeString();", "obj?.flush();"]],
		["toBeNumber", ["expect(obj).toBeNumber();", "obj?.flush();"]],
		["toBeBoolean", ["expect(obj).toBeBoolean();", "obj?.flush();"]],
		["toBeTypeOf a present type", ['expect(cb).toBeTypeOf("function");', "cb?.();"]],
		["typeof compared to a present type", ['expect(typeof cb).toBe("function");', "cb?.();"]],
		["typeof compared away from undefined", ['expect(typeof cb).not.toBe("undefined");', "cb?.();"]],
		["a loose comparison with null", ["expect(cb != null).toBe(true);", "cb?.();"]],
		["a strict comparison with undefined", ["expect(cb !== undefined).toBeTruthy();", "cb?.();"]],
		["a comparison with null on the left", ["expect(null !== cb).toBe(true);", "cb?.();"]],
		["a double negation", ["expect(!!cb).toBe(true);", "cb?.();"]],
		["Boolean()", ["expect(Boolean(cb)).toBeTruthy();", "cb?.();"]],
		["not.toBe(null)", ["expect(cb).not.toBe(null);", "cb?.();"]],
		["not.toEqual(undefined)", ["expect(cb).not.toEqual(undefined);", "cb?.();"]],
		["not.toBeFalsy", ["expect(cb).not.toBeFalsy();", "cb?.();"]],
		["toEqual(expect.any())", ["expect(cb).toEqual(expect.any(Function));", "cb?.();"]],
		["toStrictEqual(expect.anything())", ["expect(cb).toStrictEqual(expect.anything());", "cb?.();"]],
		["toEqual(expect.objectContaining())", ["expect(obj).toEqual(expect.objectContaining({}));", "obj?.flush();"]],
		["toEqual(expect.arrayContaining())", ["expect(obj).toEqual(expect.arrayContaining([]));", "obj?.flush();"]],
		// Condition 4b: `not.toHaveProperty` passes on undefined, measured.
		["a value handed to not.toHaveProperty", ["expect(row).toBeInstanceOf(Object);", 'expect(row?.data).not.toHaveProperty("x");']],
		// Condition 4b reads the equality argument: `toBe(undefined)` passes on undefined.
		["a value handed to toBe(undefined)", ["expect(row).toBeDefined();", "expect(row?.state).toBe(undefined);"]],
		["a value handed to toBeEmpty", ["expect(row).toBeDefined();", "expect(row?.state).toBeEmpty();"]],
		["an element access handed to toBeUndefined", ["expect(row).toBeDefined();", 'expect(row?.["state"]).toBeUndefined();']],
	];

	for (const [spelling, body] of differentlySpelled) {
		test(`reports a skipped call under a guard spelled as ${spelling}`, () => {
			const { dir, line } = sb23_2498Fixture(body);
			const { exitCode, stderr } = runGate(dir);
			expect(exitCode).toBe(1);
			expect(stderr).toContain(`subject.test.ts:${line}:`);
		});
	}

	const differentValues: Array<[string, string[]]> = [
		// The issue's own example: `res.body` and `res.data` are two values, not two spellings.
		["a guard on a sibling property", ["expect(res.body).not.toBeNull();", "res.data?.flush();"]],
		["a guard on the receiver of the chain's subject", ["expect(conn).not.toBeNull();", "conn.stream?.close();"]],
		["a receiver past an optional link under not.toBeNull", ["expect(conn?.stream).not.toBeNull();", "conn?.close();"]],
		["a receiver inside an optional link under not.toBeNull", ["expect(a?.b.c).not.toBeNull();", "a.b?.flush();"]],
		["a let, which can be reassigned", ["let handler = holder.cb;", "expect(holder.cb).not.toBeNull();", "handler?.();"]],
		["a const holding a call's result", ["const handler = make();", "expect(make()).not.toBeNull();", "handler?.();"]],
		["a parameter shadowing a const alias", ["const handler = holder.cb;", "expect(holder.cb).not.toBeNull();", "[1].forEach((handler) => handler?.());"]],
		["typeof compared to object, which null also is", ['expect(typeof cb).toBe("object");', "cb?.();"]],
		["toBeTypeOf object", ['expect(cb).toBeTypeOf("object");', "cb?.();"]],
		["not.toBe a value", ["expect(cb).not.toBe(5);", "cb?.();"]],
		["toEqual a literal", ["expect(cb).toEqual(5);", "cb?.();"]],
		["not.toBeInstanceOf", ["expect(cb).not.toBeInstanceOf(Function);", "cb?.();"]],
		["a comparison asserted false", ["expect(cb !== null).toBe(false);", "cb?.();"]],
		["a double negation asserted false", ["expect(!!cb).toBe(false);", "cb?.();"]],
		// Condition 4b correction: `not.toContain` FAILS on undefined in Bun, measured, so
		// the skip is observed. This was a false positive the widening surfaced on the tree.
		["a value handed to not.toContain", ["expect(row).toBeInstanceOf(Object);", 'expect(row?.argv).not.toContain("x");']],
		// PR #288's reviewer, S3: `not.toBe(undefined)` FAILS on undefined.
		["a value handed to not.toBe(undefined)", ["expect(row).toBeDefined();", "expect(row?.state).not.toBe(undefined);"]],
		// S4: `expect(null).toEqual(expect.any(Object))` passes.
		["a guard of toEqual(expect.any(Object))", ["expect(x).toEqual(expect.any(Object));", "x?.close();"]],
		// S2: an inner binding of the guard's name is a different value.
		["a callback parameter named like the guarded value", ["expect(h).not.toBeNull();", "hs.forEach((h) => h?.());"]],
		["an inner const named like the guarded value", ["expect(h).not.toBeNull();", "{", "\tconst h = make();", "\th?.();", "}"]],
	];

	for (const [difference, body] of differentValues) {
		test(`does not report ${difference}`, () => {
			const { dir } = sb23_2498Fixture(body);
			const { exitCode, stderr } = runGate(dir);
			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
		});
	}

	test("every matcher that fails on undefined under .not keeps a chain it receives silent", () => {
		// One fixture per name would cost a gate run each, so one file holds them all and the
		// guarded count proves each line was examined: drop any name from the gate's set and
		// that line is reported. Mirrors REJECTS_UNDEFINED_EVEN_NEGATED, measured on Bun 1.4.
		const names = [
			"toContain",
			"toContainEqual",
			"toContainKey",
			"toHaveLength",
			"toMatch",
			"toMatchObject",
			"toBeEmpty",
			"toBeCloseTo",
			"toBeGreaterThan",
			"toBeGreaterThanOrEqual",
			"toBeLessThan",
			"toBeLessThanOrEqual",
			"toHaveBeenCalled",
			"toHaveBeenCalledWith",
			"toHaveBeenCalledTimes",
			"toHaveBeenLastCalledWith",
			"toHaveBeenNthCalledWith",
			"toThrow",
			"toThrowError",
			"toContainAllKeys",
			"toContainValues",
			"toIncludeRepeated",
			"toHaveReturned",
			"toHaveReturnedTimes",
			"toHaveReturnedWith",
			"toHaveLastReturnedWith",
			"toHaveNthReturnedWith",
			// SB23-3836: measured failing under `.not` on undefined on Bun 1.3.14 and 1.4.2,
			// and reported as silent skips until the set listed them.
			"toBeCalled",
			"toBeCalledTimes",
			"toBeCalledWith",
			"toHaveBeenCalledOnce",
			"toReturn",
			"lastCalledWith",
			"lastReturnedWith",
			"nthCalledWith",
			"nthReturnedWith",
		];
		const { dir } = sb23_2498Fixture([
			"expect(row).toBeDefined();",
			...names.map((name) => `expect(row?.x).not.${name}(1);`),
		]);
		const { exitCode, stdout, stderr } = runGate(dir);
		expect(stderr).toBe("");
		expect(stdout).toContain(`${names.length} guarded optional chains, 0 offences`);
		expect(exitCode).toBe(0);
	});

	/**
	 * SB23-3836. Matchers whose verdict on `undefined` depends on the argument, measured on Bun
	 * 1.3.14 and 1.4.2, and `toContainValues`, which passes on `undefined` for any array. Each
	 * reported case has a silent near-miss that differs only in the argument or the `.not`.
	 */
	const argumentReported: Array<[string, string[]]> = [
		["toContainValues, which passes on undefined", ["expect(row).toBeDefined();", "expect(row?.x).toContainValues([1]);"]],
		["toBeTypeOf(\"undefined\")", ["expect(row).toBeDefined();", 'expect(row?.x).toBeTypeOf("undefined");']],
		["not.toBeTypeOf a present type", ["expect(row).toBeDefined();", 'expect(row?.x).not.toBeTypeOf("string");']],
		["toBeOneOf a list holding undefined", ["expect(row).toBeDefined();", "expect(row?.x).toBeOneOf([undefined, 1]);"]],
		["not.toBeOneOf a list without undefined", ["expect(row).toBeDefined();", "expect(row?.x).not.toBeOneOf([1, 2]);"]],
		["toContainKeys([])", ["expect(row).toBeDefined();", "expect(row?.x).toContainKeys([]);"]],
		["not.toContainKeys a non-empty list", ["expect(row).toBeDefined();", 'expect(row?.x).not.toContainKeys(["a"]);']],
		// PR #295's reviewer: a literal undefined decides it whatever the other elements hold.
		["toBeOneOf a list holding undefined and an unfixed element", ["expect(row).toBeDefined();", "expect(row?.x).toBeOneOf([undefined, other]);"]],
	];

	for (const [matcher, body] of argumentReported) {
		test(`reports a guarded chain handed to ${matcher}`, () => {
			const { dir, line } = sb23_2498Fixture(body);
			const { exitCode, stderr } = runGate(dir);
			expect(exitCode).toBe(1);
			expect(stderr).toContain(`subject.test.ts:${line}:`);
		});
	}

	const argumentSilent: Array<[string, string[]]> = [
		["not.toContainValues", ["expect(row).toBeDefined();", "expect(row?.x).not.toContainValues([1]);"]],
		["not.toBeTypeOf(\"undefined\")", ["expect(row).toBeDefined();", 'expect(row?.x).not.toBeTypeOf("undefined");']],
		["toBeTypeOf a present type", ["expect(row).toBeDefined();", 'expect(row?.x).toBeTypeOf("string");']],
		["toBeTypeOf a type the source does not fix", ["expect(row).toBeDefined();", "expect(row?.x).toBeTypeOf(kind);"]],
		["toBeOneOf a list without undefined", ["expect(row).toBeDefined();", "expect(row?.x).toBeOneOf([1, 2]);"]],
		["not.toBeOneOf a list holding undefined", ["expect(row).toBeDefined();", "expect(row?.x).not.toBeOneOf([undefined]);"]],
		["toBeOneOf a list the source does not fix", ["expect(row).toBeDefined();", "expect(row?.x).toBeOneOf(values);"]],
		["not.toBeOneOf a list with an element the source does not fix", ["expect(row).toBeDefined();", "expect(row?.x).not.toBeOneOf([1, other]);"]],
		["not.toContainKeys([])", ["expect(row).toBeDefined();", "expect(row?.x).not.toContainKeys([]);"]],
		["toContainKeys a non-empty list", ["expect(row).toBeDefined();", 'expect(row?.x).toContainKeys(["a"]);']],
		["toSatisfy, whose predicate the source cannot evaluate", ["expect(row).toBeDefined();", "expect(row?.x).toSatisfy((v) => v === undefined);"]],
		["not.toSatisfy, whose predicate the source cannot evaluate", ["expect(row).toBeDefined();", "expect(row?.x).not.toSatisfy((v) => v === 1);"]],
	];

	for (const [matcher, body] of argumentSilent) {
		test(`does not report a guarded chain handed to ${matcher}`, () => {
			const { dir } = sb23_2498Fixture(body);
			const { exitCode, stdout, stderr } = runGate(dir);
			expect(stderr).toBe("");
			// The chain was examined and matched its guard; it is silent because of the matcher.
			expect(stdout).toContain("1 guarded optional chains, 0 offences");
			expect(exitCode).toBe(0);
		});
	}

	/**
	 * SB23-3836 item 1. Only an `expect(fn)` whose assertion fails when `fn` neither throws
	 * nor rejects observes a skip inside `fn`. Measured on Bun 1.3.14 and 1.4.2:
	 * `expect(() => {}).not.toThrow()` and `expect(() => {}).toBeFunction()` both pass.
	 */
	const heldButSilent: Array<[string, string[]]> = [
		["a statement inside a function expect holds for not.toThrow", ["expect(() => {", "\tsink?.flush();", "}).not.toThrow();"]],
		["a statement inside a function expect never calls", ["expect(() => {", "\tsink?.flush();", "}).toBeFunction();"]],
		["a function stored under a const that expect holds for not.toThrow", ["const act = () => {", "\tsink?.flush();", "};", "expect(act).not.toThrow();"]],
		// The stored name binds to a different function at the `expect`, so this one is unobserved.
		["a stored function whose name an inner const rebinds", ["const act = () => {", "\tsink?.flush();", "};", "{", "\tconst act = () => {};", "\texpect(act).toThrow();", "}"]],
		["a stored function whose name a callback parameter rebinds", ["const act = () => {", "\tsink?.flush();", "};", "[() => {}].forEach((act) => expect(act).toThrow());"]],
		["a function stored under a let", ["let act = () => {", "\tsink?.flush();", "};", "expect(act).toThrow();"]],
		// PR #295's reviewer: a loop binding is a different `act`.
		["a stored function whose name a for-of binding rebinds", ["const act = () => {", "\tsink?.flush();", "};", "for (const act of [() => {}]) expect(act).toThrow();"]],
	];

	for (const [position, body] of heldButSilent) {
		test(`reports ${position}`, () => {
			const { exitCode, stderr } = runGate(sb23_2499Fixture(body));
			expect(exitCode).toBe(1);
			const offset = body.findIndex((line) => line.includes("?."));
			expect(stderr).toContain(`subject.test.ts:${BODY_LINE + offset}:`);
		});
	}

	const heldAndObserved: Array<[string, string[]]> = [
		// N4 from PR #288's review: reported until SB23-3836, although toThrow observes the skip.
		["a function stored under a const that expect holds for toThrow", ["const act = () => {", "\tsink?.flush();", "};", "expect(act).toThrow();"]],
		["a function declaration that expect holds for toThrowError", ["function act() {", "\tsink?.flush();", "}", "expect(act).toThrowError();"]],
		["a stored async function that expect holds for rejects", ["const act = async () => {", "\tawait sink?.close();", "};", "await expect(act).rejects.toThrow();"]],
		["a stored function held by expect inside a nested test", ["const act = () => {", "\tsink?.flush();", "};", 'test("inner", () => {', "\texpect(act).toThrow();", "});"]],
		["a statement inside a function expect holds for rejects.not.toThrow", ["await expect(async () => {", "\tawait sink?.close();", "}).rejects.not.toThrow();"]],
		// PR #295's reviewer: both snapshot forms fail when the function does not throw.
		["a statement inside a function expect holds for toThrowErrorMatchingSnapshot", ["expect(() => {", "\tsink?.flush();", "}).toThrowErrorMatchingSnapshot();"]],
		["a statement inside a function expect holds for toThrowErrorMatchingInlineSnapshot", ["expect(() => {", "\tsink?.flush();", "}).toThrowErrorMatchingInlineSnapshot();"]],
	];

	for (const [position, body] of heldAndObserved) {
		test(`does not report ${position}`, () => {
			const { exitCode, stderr } = runGate(sb23_2499Fixture(body));
			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
		});
	}

	test("does not match two reads at a call-computed index as one value", () => {
		// PR #295's reviewer: `arr[next()]` twice is two indices, the same argument as N4.
		const { dir } = sb23_2498Fixture(["expect(arr[next()]).toBeDefined();", "arr[next()]?.clear();"]);
		const { exitCode, stdout, stderr } = runGate(dir);
		expect(stderr).toBe("");
		expect(stdout).toContain("0 guarded optional chains, 0 offences");
		expect(exitCode).toBe(0);
	});

	test("does not match two calls with identical text as one value", () => {
		// N4 from PR #288's review: each call returns a new value, which is why a `const`
		// holding a call's result is not an alias. The text rule now agrees with the alias rule.
		const silent = sb23_2498Fixture(['expect(store.get("k")).toBeDefined();', 'store.get("k")?.clear();']);
		const quiet = runGate(silent.dir);
		expect(quiet.stderr).toBe("");
		expect(quiet.stdout).toContain("0 guarded optional chains, 0 offences");
		expect(quiet.exitCode).toBe(0);
		// The receiver BEFORE the call is still one value, so this stays reported.
		const receiver = sb23_2498Fixture(['expect(store.get("k")).toBeDefined();', "store?.clear();"]);
		const reported = runGate(receiver.dir);
		expect(reported.exitCode).toBe(1);
		expect(reported.stderr).toContain(`subject.test.ts:${receiver.line}:`);
	});

	test("labels a chain with the best guard when two cover it", () => {
		// The baseline guard wins over a widened one, so the report names the line an author
		// recognises and the survey does not count it as a widening. Kills K32 from PR #288's
		// ledger, which survived until this fixture existed.
		const { dir } = sb23_2498Fixture([
			"expect(res).toBeInstanceOf(Response);",
			"expect(res).not.toBeNull();",
			"res?.text();",
		]);
		const { exitCode, stderr } = runGate(dir);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("`expect(...).not.toBeNull` on line 4");
		const survey = runGate(dir, "--survey");
		expect(survey.stdout).not.toContain("widened by");
	});

	test("--survey dates its count with the head and splits the widening by axis", () => {
		const { dir } = sb23_2498Fixture(["expect(res!.body).not.toBeNull();", "res.body?.flush();"]);
		const { exitCode, stdout } = runGate(dir, "--survey");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("widened by spelling: 1 guarded optional chains, 1 of which skip a call");
		// A short sha, optionally marked dirty; never the bare count with no head beside it.
		expect(stdout).toMatch(/survey at [0-9a-f]{8}(\+dirty)?: 1 guarded optional chains in 1 files/);
		// The same text under a widened matcher is the matcher axis ALONE. Tagging it as a
		// spelling too would credit the survey's spelling count with matches it did not make.
		const matcherOnly = sb23_2498Fixture(["expect(res).toBeInstanceOf(Response);", "res?.text();"]);
		const second = runGate(matcherOnly.dir, "--survey");
		expect(second.stdout).toContain("widened by matcher: 1 guarded optional chains");
		expect(second.stdout).not.toContain("spelling");
	});

	test("reads zero offences on the repository as it stands", () => {
		// Explicit timeout: this spawns the gate over the whole tree, about 1.7 s at
		// load 100. Bun's 5 s default timed it out at load 163 in a full suite
		// (SB23-3567), with nothing wrong in the tree.
		// The gate ships green, which is the SB23-2375 precedent: a check that fails the
		// build has to start from zero. This test is what makes a reintroduction fail CI, and
		// it is the one that will go red when someone writes the sixth instance.
		const result = Bun.spawnSync(["bun", "run", gate], { cwd: repoRoot });
		const stdout = result.stdout.toString();
		expect(stdout).toContain("0 offences");
		expect(result.exitCode).toBe(0);

		// This run exercises the whole-tree scanned-nothing invariant on the real tree: break
		// the walker, the parser or the guard recogniser and it exits 2 rather than 0. It can
		// only show the floor passing, never firing, so the copied fixture repository below is
		// what proves the floor fires (SB23-3925).
		//
		// It is NOT what kills a `process.exit(2)` to `exit(0)` mutation, and an earlier
		// version of this comment claimed it was. On a healthy tree this run never reaches
		// that branch, so the mutation survives here; the two fixture tests below, which do
		// reach it, are what killed it when measured. Correcting the claim rather than the
		// coverage, because a comment asserting a kill the measurement attributes elsewhere
		// is the same defect as a label written before reading the output.
		//
		// Pinning exact counts would make this fail on every added test file, so the
		// assertion is that each is non-zero: a zero in any of the three is what "reported
		// zero offences having read nothing" looks like from outside.
		// The mode must be printed AND must say whole-tree. This is what kills mutation M-H,
		// which PR #226's reviewer found and that PR shipped without fixing: setting
		// `scanningWholeRepo` to a constant `false` switched off the file floor and all
		// three count checks with the entire suite green. No fixture can reach that branch,
		// because every fixture passes an explicit root and therefore runs the scoped one,
		// and on a healthy tree this repository run exits 0 either way. Asserting the mode
		// string is the only observation that separates them.
		expect(stdout).toContain("whole-tree mode");

		const counts = stdout.match(
			/(\d+) test files scanned, (\d+) optional chains examined, (\d+) presence assertions found/,
		);
		expect(counts).not.toBeNull();
		if (!counts) throw new Error("the gate's summary line changed shape");
		for (const raw of [counts[1], counts[2], counts[3]]) {
			expect(Number(raw)).toBeGreaterThan(0);
		}

		// Both gates walk the same tree, so they must read the same number of test files. This
		// one skipped the root `__tests__` directory and read 501 where the database-path gate
		// read 502 at 3a6668af (SB23-3925). Equality, not a number, so it holds as files are
		// added; the timeout covers a second whole-tree spawn.
		const sibling = Bun.spawnSync(["bun", "run", path.join(repoRoot, "scripts", "check-shared-tmp-db-path.ts")], {
			cwd: repoRoot,
		});
		const siblingFiles = sibling.stdout.toString().match(/(\d+) test files scanned/);
		if (!siblingFiles) throw new Error(`check-shared-tmp-db-path summary not found: ${sibling.stdout}`);
		expect(Number(counts[1])).toBe(Number(siblingFiles[1]));
	}, 60_000);

	/**
	 * The whole-tree floor is unreachable from a fixture root, because any root argument selects
	 * the scoped branch, and on a healthy repository it never fires. Mutating `scannedNothing` to
	 * `false` left this file at 153 pass / 0 fail (SB23-3925, audit of 880e0797..88ba0fcf). So the
	 * gate and its matcher table are copied into a fixture repository of their own, where
	 * `repoRoot` is the fixture and a run with no arguments walks the fixture's default roots,
	 * the same approach `check-shared-tmp-db-path.test.ts` takes for its floor (#295).
	 */
	describe("the whole-tree floor, in a copied fixture repository", () => {
		// A presence assertion and an optional chain on DIFFERENT subjects: both counts are
		// non-zero and there is no offence, so the file count is the only thing that can fail.
		const CLEAN = [
			'import { expect, test } from "bun:test";',
			'test("clean", () => {',
			"\tconst a: number | undefined = 1;",
			"\tconst b: { c: () => number } | undefined = { c: () => 1 };",
			"\texpect(a).toBeDefined();",
			"\tb?.c();",
			"});",
			"",
		].join("\n");

		function makeFixtureRepo(files: Array<{ dir: string; count: number; body?: string }>): string {
			const dir = makeFixtureDir();
			mkdirSync(path.join(dir, "scripts"));
			for (const name of ["check-optional-chain-silent-skip.ts", "silent-skip-matchers.ts"]) {
				writeFileSync(path.join(dir, "scripts", name), readFileSync(path.join(repoRoot, "scripts", name), "utf8"));
			}
			symlinkSync(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"));
			for (const { dir: sub, count, body } of files) {
				mkdirSync(path.join(dir, sub), { recursive: true });
				for (let i = 0; i < count; i++) writeFileSync(path.join(dir, sub, `f${i}.test.ts`), body ?? CLEAN);
			}
			return dir;
		}

		function runCopiedGate(dir: string) {
			const result = Bun.spawnSync(["bun", "run", path.join(dir, "scripts", "check-optional-chain-silent-skip.ts")], {
				cwd: dir,
			});
			return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
		}

		test("299 clean test files exits 2 in whole-tree mode", () => {
			const { exitCode, stdout, stderr } = runCopiedGate(makeFixtureRepo([{ dir: "packages/p", count: 299 }]));
			expect(stdout).toContain("whole-tree mode");
			expect(stdout).toContain("299 test files scanned");
			expect(stderr).toContain("floor 300 files");
			expect(exitCode).toBe(2);
		}, 30_000);

		test("300 clean test files exits 0, so the 299 case fails on the floor alone", () => {
			const { exitCode, stdout, stderr } = runCopiedGate(makeFixtureRepo([{ dir: "packages/p", count: 300 }]));
			expect(stderr).toBe("");
			expect(stdout).toContain("whole-tree mode, 300 test files scanned, 300 optional chains examined, 300 presence assertions found");
			expect(exitCode).toBe(0);
		}, 30_000);

		test("300 test files with no optional chain exits 2", () => {
			const { exitCode, stdout, stderr } = runCopiedGate(
				makeFixtureRepo([{ dir: "packages/p", count: 300, body: 'import { expect, test } from "bun:test";\ntest("x", () => expect(1).toBeDefined());\n' }]),
			);
			expect(stdout).toContain("300 test files scanned, 0 optional chains examined");
			expect(stderr).toContain("scanned too little");
			expect(exitCode).toBe(2);
		}, 30_000);

		test("300 test files with no presence assertion exits 2", () => {
			const { exitCode, stdout, stderr } = runCopiedGate(
				makeFixtureRepo([{ dir: "packages/p", count: 300, body: "const b: { c: () => number } | undefined = undefined;\nb?.c();\n" }]),
			);
			expect(stdout).toContain("0 presence assertions found");
			expect(stderr).toContain("scanned too little");
			expect(exitCode).toBe(2);
		}, 30_000);

		test("the root __tests__ directory is walked by default", () => {
			// 299 under packages plus 1 under the root `__tests__` reaches the floor only if the
			// walker reads `__tests__`; dropping it from the default roots makes this 299 and exit 2.
			const { exitCode, stdout, stderr } = runCopiedGate(
				makeFixtureRepo([
					{ dir: "packages/p", count: 299 },
					{ dir: "__tests__", count: 1 },
				]),
			);
			expect(stderr).toBe("");
			expect(stdout).toContain("300 test files scanned");
			expect(exitCode).toBe(0);
		}, 30_000);
	});
});
