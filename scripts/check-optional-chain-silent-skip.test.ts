import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

		const { exitCode, stderr } = runGate(dir);
		expect(exitCode).toBe(0);
		expect(stderr).not.toContain("scanned too little");
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

	test("reads zero offences on the repository as it stands", () => {
		// The gate ships green, which is the SB23-2375 precedent: a check that fails the
		// build has to start from zero. This test is what makes a reintroduction fail CI, and
		// it is the one that will go red when someone writes the sixth instance.
		const result = Bun.spawnSync(["bun", "run", gate], { cwd: repoRoot });
		const stdout = result.stdout.toString();
		expect(stdout).toContain("0 offences");
		expect(result.exitCode).toBe(0);

		// This is also where the whole-tree scanned-nothing invariant is exercised, and it is
		// the only place it can be: that stricter branch needs `roots.length === 0`, so no
		// fixture can reach it. Break the walker, the parser or the guard recogniser and this
		// run exits 2 rather than 0.
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
		const counts = stdout.match(
			/(\d+) test files scanned, (\d+) optional chains examined, (\d+) presence assertions found/,
		);
		expect(counts).not.toBeNull();
		if (!counts) throw new Error("the gate's summary line changed shape");
		for (const raw of [counts[1], counts[2], counts[3]]) {
			expect(Number(raw)).toBeGreaterThan(0);
		}
	});
});
