#!/usr/bin/env bun
/**
 * Rejects an optional chain in a test whose subject an `expect(...)` on an earlier line
 * has already asserted to be present.
 *
 * SB23-2460. `expect(x).not.toBeNull()` is a RUNTIME assertion. It narrows nothing for
 * TypeScript, so `x?.()` or `x?.prop` on the next line typechecks perfectly, and if that
 * guard is ever moved, reordered or deleted, the optional chain evaluates to `undefined`,
 * the call is never made, and the test still passes. A test that silently skips its own
 * subject is worse than a missing test, because it is counted as coverage.
 *
 * Nothing else in this repository can see it:
 *   - `bun run typecheck` cannot, because `x?.()` is valid TypeScript by construction.
 *     That is the entire purpose of the operator.
 *   - No test fails on it, because the skip IS the passing path.
 *   - Mutation testing does not reach it unless someone mutates the guard specifically,
 *     and the guard reads as an assertion rather than as a precondition.
 *   - Biome 2.4.10 has no rule for it and there is no eslint in this tree.
 *
 * WHAT THIS CATCHES, precisely, and all four conditions must hold:
 *   1. in a `*.test.ts` or `*.test.tsx` file (this tree has no `*.spec.ts` or `*_test.ts`,
 *      checked with `find` rather than assumed),
 *   2. an optional chain whose subject is a value an `expect(...)` appearing EARLIER in the
 *      same block or any enclosing block asserts present. The original presence assertions
 *      are `.not.toBeNull()`, `.not.toBeUndefined()`, `.toBeDefined()` and `.toBeTruthy()`.
 *      SB23-2498 widened this along four axes, each tagged in `--survey`:
 *        - spelling: `res!.body`, `(res as R).body`, `res?.body` and `res["body"]` all name
 *          `res.body`;
 *        - alias: `const h = holder.cb;` makes `h` and `holder.cb` one value;
 *        - prefix: `expect(a.b.c).not.toBeNull()` throws unless `a` and `a.b` exist, so it
 *          also guards `a?.f()` and `a.b?.f()`, with the optional-link rule in
 *          impliedReceivers;
 *        - matcher: assertions that fail on a missing value without saying so, such as
 *          `toBeInstanceOf`, `toHaveProperty`, `toEqual(expect.any(...))`,
 *          `expect(typeof x).toBe("function")` and `expect(x != null).toBe(true)`.
 *      Measured at 435041b6 before gating: 0 spelling, 0 alias, 4 prefix and 43 matcher
 *      matches, of which 3 skipped a call. Two were real and are fixed in the same change;
 *      the third was a condition 4b false positive, corrected below,
 *   3. where short-circuiting the chain skips a CALL, including one further up the chain
 *      as in `x?.foo.bar()`, and
 *   4. and NOTHING DOWNSTREAM CAN REJECT `undefined`, which is true in two ways:
 *        a. the value is discarded: a statement, `void`, a comma's left operand, a `for`
 *           initialiser or incrementor, or a position that passes the value on to one of
 *           those (the right operand of `&&` / `||` / `??` / comma, a branch of `?:`, a
 *           template literal). A callback's expression body or `return` counts when the
 *           callee is known to ignore the callback's value (`forEach`, timers, the test
 *           runner, a `Promise` executor) or builds its own value from it (`then`, `map`,
 *           `filter` and so on) and that value is itself discarded, or
 *        b. it is handed to an `expect(...)` whose matcher PASSES on `undefined`, such as
 *           `toBeUndefined()`, `toBeFalsy()` or `not.toBe(...)`.
 *
 * Condition 4 is the discriminator and it took three attempts, each corrected by a
 * measurement rather than by an argument.
 *
 * Gating every skipped call reported nine sites shaped like
 * `expect(col?.type.toUpperCase()).toBe("TEXT")`. Those are not silent: short-circuiting
 * makes the whole expression `undefined`, `expect(undefined).toBe("TEXT")` fails, and the
 * test goes red with a legible message. Failing a build over code that already catches its
 * own defect is how a required gate gets switched off, which is the one failure mode it
 * cannot survive. So 4a was added and the nine dropped out.
 *
 * 4a alone was then too narrow, and the PR's reviewer found it: discarding the value is
 * only ONE way to ensure nothing rejects `undefined`. A guarded `?.` feeding
 * `toBeUndefined()` is exactly as silent, and it demonstrated three live instances in
 * `requests-stream-terminal-state.test.ts` at rung 4 — with the row lookup made to find
 * nothing and the guard deleted, that file still read 5 pass / 0 fail. Hence 4b.
 *
 * Measured on this tree, same day, same commit range: every skipped call = 9 offences,
 * 4a alone = 2, 4a-or-4b = 5. All five were real and all five are fixed here.
 *
 * Note that 4b is why `not.` is computed rather than matched. `expect(x).not.toBe(5)`
 * passes on `undefined` so it is tolerant, but `expect(x).not.toBeUndefined()` FAILS on
 * `undefined`, so it REJECTS a skip and must not be reported. A rule reading "or starts
 * with not." would have had that exactly backwards.
 *
 * CALLBACK AND OPERATOR POSITIONS (SB23-2499) are reported. Before it only an
 * `ExpressionStatement` or `void` counted as discarding, so `xs.forEach((k) => sink?.write(k))`,
 * `ok && sink?.flush()`, `(sink?.flush(), n++)` and `setTimeout(() => cb?.(), 0)` were all
 * silent, and the last of those is SB23-2460's own founding instance with the stub on the
 * other side. Measured at 435041b6: 0 offences before the widening and 0 after, across 492
 * test files, so it shipped with no cleanup.
 *
 * KNOWN MISSES that remain, deferred rather than hidden:
 *   - `return x?.f()` from a function whose caller is not one of the known callees, which
 *     needs flow analysis. A callback handed to an unknown function counts as read, which
 *     is the direction that cannot fail a correct build.
 *   - `on`, `once` and `addListener` are not treated as ignoring their callback's value,
 *     because Hono's `app.on(method, path, handler)` returns the handler's value as the
 *     response. See IGNORES_CALLBACK_RESULT.
 *   - the LEFT operand of `&&` / `||` / `??`, whose value is read as a condition.
 *   - a member call on the result of a callee the value flowed into. `p.then(() =>
 *     s?.read()).catch(() => {})` is not reported, because `.then(...).then(cb)` passes the
 *     value to `cb` and the climb cannot tell `catch` from `then` by what it does.
 *   - a guard inside an expression-bodied arrow is recorded in the enclosing block whether or
 *     not that arrow ever runs, so `const check = () => expect(x).toBeDefined(); x?.f();`
 *     reports `x?.f()` with no guard having run. N4's third point in PR #288's review; zero
 *     instances measured and left as is, because a guard inside `waitFor(() => expect(...))`
 *     is the common shape and does run.
 *   - a statement inside a function `expect(fn).toThrow()` holds is exempt even when some
 *     OTHER statement in `fn` is what throws, so `expect(() => { s?.f(); boom(); }).toThrow()`
 *     passes with `s` nullish. Telling which statement throws needs flow analysis.
 *
 * SB23-3836 closed three misses this list used to carry, each measured on Bun 1.3.14 and 1.4.2:
 *   - `expect(() => { s?.f(); }).not.toThrow()` was exempt because ANY `expect(fn)` exempted
 *     everything inside `fn`. Only `toThrow` / `toThrowError` with no net `.not`, and any
 *     `.rejects` chain, fail when `fn` runs without throwing, so only they exempt now
 *     (expectObservesSkip).
 *   - `const act = () => { s?.f(); }; expect(act).toThrow();` was REPORTED although `toThrow`
 *     observes the skip, because the arrow's holder is the `const`. A function stored under a
 *     `const` or a name now follows the name to the `expect`, by binding (isHeldThroughName).
 *   - `expect(store.get("k")).toBeDefined(); store.get("k")?.clear()` was reported because two
 *     calls with identical text were one key. A subject passing through a call is a new value
 *     at each evaluation, as the alias rule already said for `const v = store.get("k")`, so no
 *     guard licenses it. Measured on the tree at b9446617: the survey went from 323 guarded
 *     chains to 321, the two dropped both `events.at(-1)` reads in `pool-exhausted.test.ts`,
 *     and offences stayed 0.
 *
 * Condition 4b's verdicts come from `silent-skip-matchers.ts`, which a test runs against the
 * Bun executing the suite, so a Bun bump that changes how a matcher treats `undefined` fails CI.
 * Four matchers depend on their argument and are read from it: `toBe` / `toEqual` /
 * `toStrictEqual(undefined)`, `toBeTypeOf("undefined")`, `toBeOneOf([undefined, ...])` and
 * `toContainKeys([])`. `toSatisfy(fn)` is never reported, because whether a predicate holds
 * for `undefined` is not in the source text.
 * Caught correctly, for contrast: `try { s?.close(); } catch {}` and the last statement of a
 * block-bodied arrow.
 *
 * WHERE IT IS DELIBERATELY CONSERVATIVE. `sink?.write("a"); expect(buf).toEqual(["a"]);`
 * IS reported, although the effect is asserted on the very next line. The gate cannot see
 * that the following assertion observes this call, so it reports, and the advice it gives
 * is still the right advice: drop the `?.` and throw on the guard. Noted here so the
 * report is not read as a false positive when someone meets it.
 *
 * The replacement is the one PR #217 used:
 *
 *     if (!x) throw new Error("<what was supposed to have captured x>");
 *     x();
 *
 * A throw states the precondition instead of letting a `?.` skip it, it narrows the type
 * for real, and it fails loudly with a message naming what did not happen.
 *
 * WHAT IT DOES NOT CATCH, stated so nobody reads this as a ban on optional chaining, leading
 * limitation first:
 *   - a guard on EVIDENCE of the value rather than on the value. `expect(spy)
 *     .toHaveBeenCalledTimes(1); captured?.()` asserts that the stub ran, and the chain uses
 *     what the stub was meant to capture; nothing in the syntax joins the two. This is what
 *     SB23-2498's "guard spelled differently" mostly turns out to be once the spellings
 *     the four axes cover are taken out, and it needs the stub's body to see.
 *   - a guard on a DIFFERENT value. `expect(res.body).not.toBeNull()` does not license a
 *     report on `res.data?.x`: the two are siblings, and neither proves the other exists.
 *     SB23-2498 cited that pair as its example, and it stays unreported on purpose.
 *   - an alias the gate cannot prove: a `let` (it can be reassigned), a destructured
 *     binding, or a `const` holding a call's result (a new value, not a second name).
 *   - an UNGUARDED `?.`. `dbOps.dispose?.()`, `process.getgid?.()` and
 *     `provider.isStreamingResponse?.(res)` are optional members of their types and are
 *     correct as written. Measured 2026-09-21: 1248 `?.` occurrences across 169 test files,
 *     which is why the guard clause is the whole predicate and not a detail of it. This
 *     narrowing is what makes the gate shippable as a build failure rather than a warning,
 *     and it is also a blind spot: a captured-stub call with no guard in front of it, such
 *     as `let cb; ...; cb?.()`, silently skips exactly the same way and is NOT reported.
 *   - a reassignment between the guard and the use. If the subject is written to in
 *     between, the guard genuinely no longer holds and the `?.` may be correct. Tracking
 *     that needs flow analysis; this gate does not attempt it and will report the site.
 *     Silence it by moving the guard, not by widening this script.
 *   - `toEqual(literal)`, `toBe(value)` and every matcher not named in recogniseGuard.
 *     `toBeTypeOf("object")` and `expect(typeof x).toBe("object")` are deliberately absent,
 *     because `typeof null` is `"object"`.
 *   - non-test files. A `?.` in production code guarded by an `expect` is not a thing.
 *
 * WHY SYNTACTIC AND NOT TYPE-AWARE: the defect is a statement about source order and the
 * author's intent, not about types. The type of `x` is legitimately nullable in every
 * single instance; that is why the compiler accepts the `?.`. So there is nothing for a
 * type checker to contribute, and `ts.createSourceFile` per file is both sufficient and
 * an order of magnitude faster than building a program.
 *
  * Usage: bun run scripts/check-optional-chain-silent-skip.ts [--json] [--survey] [root ...]
 * Exit 0 clean, 1 offences found, 2 the check could not run (which is never a pass).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import {
	type ArgShape,
	matcherVerdictOnUndefined,
	NO_ARG_TYPE_MATCHERS,
	PRESENT_TYPEOF,
	TYPE_AND_SHAPE_MATCHERS,
} from "./silent-skip-matchers";

const repoRoot = path.resolve(import.meta.dir, "..");

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const survey = argv.includes("--survey");
const roots = argv.filter((a: string) => !a.startsWith("--"));
const searchRoots = roots.length > 0 ? roots : ["packages", "apps", "scripts"];

/**
 * Which of the two invariants below applies, decided once and PRINTED, so that turning the
 * strict one off is visible in the output rather than only in the source.
 *
 * Mutation M-H, found by PR #226's reviewer and left unfixed when that PR merged: setting
 * this to a constant `false` switches off the file floor and all three count checks, and
 * the whole suite stayed green. No fixture can catch it, because every fixture passes an
 * explicit root and so runs the scoped branch anyway, and on a healthy tree the repository
 * run exits 0 down either branch. Printing the mode is what makes the branch observable.
 */
const scanningWholeRepo = roots.length === 0;
const scanMode = scanningWholeRepo ? "whole-tree" : "scoped";

/**
 * The commit the scanned tree came from, so a survey count dates itself. `+dirty` when tracked
 * files differ from it. Never an exit: a survey without git still measures the tree.
 */
function headSha(): string {
	const rev = Bun.spawnSync(["git", "-C", repoRoot, "rev-parse", "--short=8", "HEAD"]);
	if (rev.exitCode !== 0) return "an unknown head";
	const sha = rev.stdout.toString().trim();
	const status = Bun.spawnSync(["git", "-C", repoRoot, "status", "--porcelain", "--untracked-files=no"]);
	return status.exitCode === 0 && status.stdout.toString().trim() !== "" ? `${sha}+dirty` : sha;
}

/** Directories that never hold source we own. */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage", ".turbo"]);

function isTestFile(fileName: string): boolean {
	return /\.test\.tsx?$/.test(fileName);
}

function collectTestFiles(dir: string, out: string[]): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = path.join(dir, entry);
		let st: ReturnType<typeof statSync>;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) collectTestFiles(full, out);
		else if (st.isFile() && isTestFile(entry)) out.push(full);
	}
}

/** Collapses whitespace so `expect(a. b)` and `a.b?.c` compare equal on `a.b`. */
function normalise(text: string): string {
	return text.replace(/\s+/g, "");
}

/**
 * The four matchers that assert "this value is present", and therefore make a `?.` on the
 * same subject below them either redundant or a silent skip. `toBeTruthy` is included
 * because it fails on null and undefined exactly as the other three do; a caller using it
 * to mean "non-empty string" still gets a correct report, since the `?.` below it is still
 * doing nothing.
 */
const PRESENCE_MATCHERS = new Set(["toBeNull", "toBeUndefined", "toBeDefined", "toBeTruthy"]);
const NEGATED_MATCHERS = new Set(["toBeNull", "toBeUndefined"]);

/**
 * What an `expect(...)` line asserts present, and how. `target` is the expression asserted,
 * `rejectsUndefined` says whether the matcher fails on `undefined` (which is what licenses
 * every receiver in the target's chain, see impliedReceivers), and `extended` is false only
 * for the four presence matchers above, which are what the gate read before SB23-2498.
 */
type GuardMatch = {
	target: ts.Expression;
	matcher: string;
	rejectsUndefined: boolean;
	extended: boolean;
};

/**
 * SB23-2498. Matchers that also fail on a missing value although they were not written to
 * say "this exists". `TYPE_AND_SHAPE_MATCHERS`, `NO_ARG_TYPE_MATCHERS` and `PRESENT_TYPEOF` live
 * in `silent-skip-matchers.ts`, where a test runs each one on `undefined` under the running Bun.
 */
const ASYMMETRIC_PRESENT = new Set(["any", "anything", "objectContaining", "arrayContaining"]);

function isNullLiteral(e: ts.Expression): boolean {
	return e.kind === ts.SyntaxKind.NullKeyword;
}
function isUndefinedIdentifier(e: ts.Expression): boolean {
	return ts.isIdentifier(e) && e.text === "undefined";
}

/**
 * Recognises a presence assertion and returns what it asserts present. The original four,
 * `expect(X).not.toBeNull()`, `expect(X).not.toBeUndefined()`, `expect(X).toBeDefined()`
 * and `expect(X).toBeTruthy()`, are `extended: false`. SB23-2498 adds the guards spelled
 * differently: `not.toBe(null)`, `toBeInstanceOf(...)`, `toHaveProperty(...)`,
 * `toEqual(expect.any(...))`, `expect(typeof X).toBe("function")`,
 * `expect(X != null).toBe(true)`, `expect(!!X).toBe(true)` and the rest below.
 *
 * `.not.toBeNull()` must be negated and `.toBeDefined()` must not: `expect(x).toBeNull()`
 * asserts the OPPOSITE and a `?.` below it is correct, so reading the `.not.` is not a
 * detail. Getting that backwards would report the one shape that is right.
 */
function recogniseGuard(node: ts.Node): GuardMatch | null {
	if (!ts.isCallExpression(node)) return null;
	const matcherAccess = node.expression;
	if (!ts.isPropertyAccessExpression(matcherAccess)) return null;
	const matcher = matcherAccess.name.text;

	// Walk back over `.not`, recording whether we crossed it.
	let receiver: ts.Expression = matcherAccess.expression;
	let negated = false;
	while (ts.isPropertyAccessExpression(receiver) && receiver.name.text === "not") {
		negated = !negated;
		receiver = receiver.expression;
	}
	if (!ts.isCallExpression(receiver)) return null;
	if (!ts.isIdentifier(receiver.expression) || receiver.expression.text !== "expect") return null;
	if (receiver.arguments.length !== 1) return null;
	const arg = receiver.arguments[0];
	if (!arg) return null;
	const args = node.arguments;
	// Report the spelling the author wrote. Printing the bare matcher name turns
	// `expect(x).not.toBeNull()` into "asserted present by expect(...).toBeNull", which
	// reads as the opposite of what the line says and sends the reader to the wrong line.
	const spelled = negated ? `not.${matcher}` : matcher;

	const one = args.length === 1 ? args[0] : undefined;
	const truthy =
		!negated && ((matcher === "toBe" && one?.kind === ts.SyntaxKind.TrueKeyword) || (matcher === "toBeTruthy" && args.length === 0));

	// `expect(typeof X).toBe("function")` and `expect(typeof X).not.toBe("undefined")`.
	if (ts.isTypeOfExpression(arg)) {
		if (!one || !ts.isStringLiteral(one)) return null;
		if (!["toBe", "toEqual", "toStrictEqual"].includes(matcher)) return null;
		const present = negated ? one.text === "undefined" : PRESENT_TYPEOF.has(one.text);
		return present ? { target: arg.expression, matcher: `typeof ${spelled}`, rejectsUndefined: true, extended: true } : null;
	}
	// `expect(X != null).toBe(true)`, `expect(X !== undefined).toBeTruthy()`.
	if (ts.isBinaryExpression(arg) && truthy) {
		const op = arg.operatorToken.kind;
		const loose = op === ts.SyntaxKind.ExclamationEqualsToken;
		if (!loose && op !== ts.SyntaxKind.ExclamationEqualsEqualsToken) return null;
		const [subject, other] = isNullLiteral(arg.right) || isUndefinedIdentifier(arg.right) ? [arg.left, arg.right] : [arg.right, arg.left];
		if (!isNullLiteral(other) && !isUndefinedIdentifier(other)) return null;
		// `X !== null` is true for `undefined`, so only that spelling accepts a missing value.
		const rejectsUndefined = loose || isUndefinedIdentifier(other);
		return { target: subject, matcher: `comparison ${spelled}`, rejectsUndefined, extended: true };
	}
	// `expect(!!X).toBe(true)`, `expect(Boolean(X)).toBeTruthy()`.
	if (truthy) {
		if (
			ts.isPrefixUnaryExpression(arg) &&
			arg.operator === ts.SyntaxKind.ExclamationToken &&
			ts.isPrefixUnaryExpression(arg.operand) &&
			arg.operand.operator === ts.SyntaxKind.ExclamationToken
		) {
			return { target: arg.operand.operand, matcher: `!! ${spelled}`, rejectsUndefined: true, extended: true };
		}
		if (ts.isCallExpression(arg) && ts.isIdentifier(arg.expression) && arg.expression.text === "Boolean" && arg.arguments.length === 1 && arg.arguments[0]) {
			return { target: arg.arguments[0], matcher: `Boolean ${spelled}`, rejectsUndefined: true, extended: true };
		}
	}
	// The original four come after the spellings above, because `expect(!!x).toBeTruthy()`
	// asserts `x`, not `!!x`, and no chain is ever spelled `!!x?.f()`.
	if (PRESENCE_MATCHERS.has(matcher)) {
		if (args.length !== 0) return null;
		// `expect(x).not.toBeNull()` and `expect(x).toBeDefined()` are guards.
		// `expect(x).toBeNull()` and `expect(x).not.toBeDefined()` are the opposite claim.
		if (NEGATED_MATCHERS.has(matcher) !== negated) return null;
		// `not.toBeNull()` passes on `undefined`; the other three fail on it.
		return { target: arg, matcher: spelled, rejectsUndefined: matcher !== "toBeNull", extended: false };
	}

	if (negated) {
		// `expect(X).not.toBe(null)`, `.not.toEqual(undefined)` and `.not.toBeFalsy()`.
		if (["toBe", "toEqual", "toStrictEqual"].includes(matcher) && one) {
			if (isNullLiteral(one)) return { target: arg, matcher: spelled, rejectsUndefined: false, extended: true };
			if (isUndefinedIdentifier(one)) return { target: arg, matcher: spelled, rejectsUndefined: true, extended: true };
			return null;
		}
		if (matcher === "toBeFalsy" && args.length === 0) {
			return { target: arg, matcher: spelled, rejectsUndefined: true, extended: true };
		}
		return null;
	}
	if (TYPE_AND_SHAPE_MATCHERS.has(matcher) && args.length >= 1) {
		return { target: arg, matcher: spelled, rejectsUndefined: true, extended: true };
	}
	if (NO_ARG_TYPE_MATCHERS.has(matcher) && args.length === 0) {
		return { target: arg, matcher: spelled, rejectsUndefined: true, extended: true };
	}
	if (matcher === "toBeTypeOf" && one && ts.isStringLiteral(one) && PRESENT_TYPEOF.has(one.text)) {
		return { target: arg, matcher: spelled, rejectsUndefined: true, extended: true };
	}
	// `expect(X).toEqual(expect.any(Function))`, `.toEqual(expect.objectContaining({...}))`.
	if (
		(matcher === "toEqual" || matcher === "toStrictEqual") &&
		one &&
		ts.isCallExpression(one) &&
		ts.isPropertyAccessExpression(one.expression) &&
		ts.isIdentifier(one.expression.expression) &&
		one.expression.expression.text === "expect" &&
		ASYMMETRIC_PRESENT.has(one.expression.name.text) &&
		// `expect(null).toEqual(expect.any(Object))` PASSES, measured in Bun 1.4 as in Jest,
		// because `typeof null` is "object". Found by PR #288's reviewer.
		!(
			one.expression.name.text === "any" &&
			one.arguments.length === 1 &&
			one.arguments[0] !== undefined &&
			ts.isIdentifier(one.arguments[0]) &&
			one.arguments[0].text === "Object"
		)
	) {
		return { target: arg, matcher: spelled, rejectsUndefined: true, extended: true };
	}
	return null;
}

/** Strips what changes a spelling without changing the value: parentheses, `!`, `as`. */
function unwrapValue(expr: ts.Expression): ts.Expression {
	let e = expr;
	while (
		ts.isParenthesizedExpression(e) ||
		ts.isNonNullExpression(e) ||
		ts.isAsExpression(e) ||
		ts.isSatisfiesExpression(e) ||
		ts.isTypeAssertionExpression(e)
	) {
		e = e.expression;
	}
	return e;
}

/** A name in scope: a `const` alias's canonical key, or null for any other binding. */
type ResolveAlias = (name: string) => string | null | undefined;

/**
 * The value an expression names, spelled one way. SB23-2498: `res!.body`, `(res as R).body`,
 * `res?.body`, `res["body"]` and, through `const r = res;`, `r.body` all become `res.body`,
 * so a guard written in one spelling covers a chain written in another. `viaAlias` records
 * whether a `const` alias was followed, so the survey can split that axis out.
 */
function canonicalKey(
	expr: ts.Expression,
	resolveAlias: ResolveAlias,
): { key: string; viaAlias: boolean; hasCall: boolean } {
	let viaAlias = false;
	let hasCall = false;
	const walk = (node: ts.Expression): string => {
		const e = unwrapValue(node);
		if (ts.isIdentifier(e)) {
			const alias = resolveAlias(e.text);
			if (typeof alias === "string") {
				viaAlias = true;
				return alias;
			}
			return e.text;
		}
		if (e.kind === ts.SyntaxKind.ThisKeyword) return "this";
		if (ts.isPropertyAccessExpression(e)) return `${walk(e.expression)}.${e.name.text}`;
		if (ts.isElementAccessExpression(e)) {
			const key = unwrapValue(e.argumentExpression);
			if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) {
				return /^[A-Za-z_$][\w$]*$/.test(key.text)
					? `${walk(e.expression)}.${key.text}`
					: `${walk(e.expression)}[${JSON.stringify(key.text)}]`;
			}
			if (ts.isNumericLiteral(key)) return `${walk(e.expression)}[${Number(key.text)}]`;
			return `${walk(e.expression)}[${normalise(key.getText())}]`;
		}
		if (ts.isCallExpression(e)) {
			hasCall = true;
			return `${walk(e.expression)}(${e.arguments.map((a) => normalise(a.getText())).join(",")})`;
		}
		return normalise(e.getText());
	};
	const key = walk(expr);
	return { key, viaAlias, hasCall };
}

/**
 * Every receiver in the target's chain that the assertion proves present. Evaluating
 * `a.b.c` throws unless `a` and `a.b` are present, so `expect(a.b.c).not.toBeNull()` covers
 * `a?.f()` and `a.b?.f()` as well as `a.b.c?.f()`.
 *
 * An optional link changes that, and the matcher decides by how much. `a?.b` short-circuits
 * to `undefined` when `a` is missing, which `not.toBeNull()` ACCEPTS, so under it neither `a`
 * nor anything past the `?.` is proved. A matcher that rejects `undefined` proves the chain
 * did not short-circuit at all, so under it every receiver is present.
 */
function impliedReceivers(target: ts.Expression, rejectsUndefined: boolean): ts.Expression[] {
	const links: Array<{ receiver: ts.Expression; optional: boolean }> = [];
	let e = unwrapValue(target);
	while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e)) {
		links.push({ receiver: e.expression, optional: e.questionDotToken !== undefined });
		e = unwrapValue(e.expression);
	}
	if (rejectsUndefined) return links.map((l) => l.receiver);
	// links[0] is the outermost. Receiver k is proved only when link k and every link inside
	// it are non-optional, so that evaluating the target must have evaluated link k.
	const proved: ts.Expression[] = [];
	for (let k = 0; k < links.length; k++) {
		const link = links[k];
		if (link && links.slice(k).every((l) => !l.optional)) proved.push(link.receiver);
	}
	return proved;
}

/**
 * A guard as recorded in a scope. `exact` is the pre-SB23-2498 key, the normalised source
 * text, and is set only for the four original matchers, so a match on it is the baseline
 * the gate always reported. Everything else is a widening and is tagged with its axis.
 */
type Guard = {
	exact: string | null;
	/** The normalised text of what was asserted, whichever matcher asserted it. */
	text: string;
	key: string;
	viaAlias: boolean;
	implied: Array<{ key: string; viaAlias: boolean }>;
	extended: boolean;
	/** The scope that binds the target's root name when the guard was read, or null. */
	rootBinding: object | null;
	end: number;
	matcher: string;
	line: number;
};

/** The identifier a chain or guard target starts from: `a` for `a.b?.c()` and `(a!).b`. */
function rootIdentifier(expr: ts.Expression): string | undefined {
	let e = unwrapValue(expr);
	while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e)) {
		e = unwrapValue(e.expression);
	}
	return ts.isIdentifier(e) ? e.text : undefined;
}

/**
 * True when this optional access is what a call is being made THROUGH, so short-circuiting
 * it skips the call rather than producing `undefined` for something to compare.
 * `x?.foo()` parses as a CallExpression with no `questionDotToken` of its own wrapping a
 * PropertyAccessExpression that has one, so without this the commonest spelling of a
 * skipped call is filed as a skipped read.
 */
function isCalleeOfCall(node: ts.Node): boolean {
	// The call can sit further up the chain than the `?.` does. In `x?.foo.bar()` only
	// `x?.foo` carries a questionDotToken; its parent is the PropertyAccess `x?.foo.bar`,
	// whose parent is the call. Short-circuiting `x?.foo` still skips `.bar()`, so testing
	// only the immediate parent files a skipped call as a skipped read and the gate stays
	// silent on it. Walk up for as long as this node is what the parent is reading THROUGH,
	// and stop at the first thing that is not a member access.
	let current: ts.Node = node;
	let parent = current.parent;
	while (
		parent !== undefined &&
		(ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
		parent.expression === current
	) {
		current = parent;
		parent = current.parent;
	}
	return parent !== undefined && ts.isCallExpression(parent) && parent.expression === current;
}

/**
 * Climbs out of the chain and out of anything that passes the value along unchanged,
 * returning the first parent that actually does something with it. Used by condition 4b
 * only. Condition 4a has its own wider climb in isValueDiscarded, which also passes through
 * operators, conditionals and callbacks; sharing it would have widened 4b silently.
 */
function climbOutOfExpression(node: ts.Node): { current: ts.Node; parent: ts.Node | undefined } {
	let current: ts.Node = node;
	let parent = current.parent;
	while (parent !== undefined) {
		const passesValueThrough =
			((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
				parent.expression === current) ||
			(ts.isCallExpression(parent) && parent.expression === current) ||
			ts.isParenthesizedExpression(parent) ||
			ts.isAwaitExpression(parent) ||
			ts.isNonNullExpression(parent) ||
			ts.isAsExpression(parent) ||
			ts.isSatisfiesExpression(parent);
		if (!passesValueThrough) break;
		current = parent;
		parent = current.parent;
	}
	return { current, parent };
}


/**
 * What the source says about one matcher argument, for the verdicts in
 * silent-skip-matchers.ts. Only literals are known; an identifier, a call or a spread is
 * `unknown`, because its runtime value is not in the file.
 */
function argShape(node: ts.Expression): ArgShape {
	const e = unwrapValue(node);
	if (isUndefinedIdentifier(e)) return { kind: "undefined" };
	if (isNullLiteral(e)) return { kind: "null" };
	if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return { kind: "string", value: e.text };
	if (ts.isNumericLiteral(e) || ts.isBigIntLiteral(e)) return { kind: "number" };
	if (ts.isPrefixUnaryExpression(e) && ts.isNumericLiteral(e.operand)) return { kind: "number" };
	if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return { kind: "boolean" };
	if (ts.isArrayLiteralExpression(e)) {
		return {
			kind: "array",
			elements: e.elements.map((el) => (ts.isSpreadElement(el) || ts.isOmittedExpression(el) ? { kind: "unknown" } : argShape(el))),
		};
	}
	if (ts.isObjectLiteralExpression(e)) return { kind: "object" };
	if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return { kind: "function" };
	return { kind: "unknown" };
}

/**
 * True when this chain's value is handed to an `expect(...)` whose matcher PASSES on
 * `undefined`, which makes the skip invisible exactly as discarding it does.
 *
 * Found by the PR's reviewer, and it is the half of the silence predicate condition 4
 * missed. The real rule is "nothing downstream can reject `undefined`"; discarding the
 * value is only one way to achieve that. `expect(row?.streamTerminalState).toBeUndefined()`
 * under an `expect(row).toBeDefined()` passes whether the field is absent OR the row is,
 * and the reviewer demonstrated it at rung 4: making the lookup find nothing and deleting
 * the guard leaves that file reading 5 pass / 0 fail.
 *
 * Negation is computed rather than pattern-matched, because `not.` does not universally
 * mean tolerant. `expect(x).not.toBe(5)` passes on undefined, so it is tolerant; but
 * `expect(x).not.toBeUndefined()` FAILS on undefined, so it rejects a skip and must not be
 * reported. A rule reading "or starts with not." would have got that backwards.
 */
function isConsumedByUndefinedTolerantMatcher(node: ts.Node): boolean {
	const { current, parent } = climbOutOfExpression(node);
	if (parent === undefined) return false;
	// The value must BE the argument of an `expect(...)` call.
	if (!ts.isCallExpression(parent)) return false;
	if (!ts.isIdentifier(parent.expression) || parent.expression.text !== "expect") return false;
	if (parent.arguments.length !== 1 || parent.arguments[0] !== current) return false;

	// Walk the matcher chain hanging off `expect(...)`, counting `.not.`
	let chain: ts.Node | undefined = parent.parent;
	let negated = false;
	while (chain !== undefined && ts.isPropertyAccessExpression(chain)) {
		const name = chain.name.text;
		if (name === "not") {
			negated = !negated;
			chain = chain.parent;
			continue;
		}
		// `.resolves` / `.rejects` change what is asserted about, so the skip is observed by
		// the promise machinery rather than by the matcher. Treat as rejecting.
		if (name === "resolves" || name === "rejects") return false;
		// The verdict comes from silent-skip-matchers.ts, which a test runs against the Bun
		// executing the suite (SB23-3836). Some matchers throw on a value they cannot inspect
		// whichever way round they are asked, so `not.` does not make them tolerant; for
		// `toBe(undefined)`, `toBeTypeOf("undefined")`, `toBeOneOf([undefined])` and
		// `toContainKeys([])` the argument decides, not the name. An `unknown` verdict counts
		// as rejecting, the direction that cannot fail a correct build.
		const call = chain.parent;
		const args =
			call !== undefined && ts.isCallExpression(call) && call.expression === chain
				? call.arguments.map(argShape)
				: [];
		return matcherVerdictOnUndefined(name, negated, args) === "tolerates";
	}
	return false;
}

/**
 * Callees that throw away whatever the callback handed to them returns, so a skipped call in
 * that callback's expression body, or in its `return`, is observed by nothing.
 *
 * Matched by name, which is the weak part and is why the list is short. `on`, `once` and
 * `addListener` are deliberately ABSENT: an EventEmitter ignores a listener's value, but
 * Hono's `app.on(method, path, handler)` returns the handler's value as the response, and a
 * required gate cannot tell the two apart by spelling. An unknown callee is treated as
 * consuming the value, which is the direction that cannot fail a correct build.
 */
const IGNORES_CALLBACK_RESULT = new Set([
	"forEach",
	"setTimeout",
	"setInterval",
	"setImmediate",
	"queueMicrotask",
	// `p.finally(cb)` resolves to `p`'s value whatever `cb` returns.
	"finally",
	"nextTick",
	"requestAnimationFrame",
	"addEventListener",
	// The test runner awaits a returned promise and otherwise ignores the value.
	"test",
	"it",
	"describe",
	"beforeEach",
	"afterEach",
	"beforeAll",
	"afterAll",
]);

/**
 * Callees whose RESULT is built from the callback's value, so the callback's value is
 * discarded exactly when the call's own value is. `p.then(() => s?.close())` as a statement
 * is silent; `expect(await p.then(() => s?.read())).toBe(1)` is not. `sort` is absent because
 * it mutates its receiver, so a discarded `sort` result still has an effect someone can read.
 */
const CALLBACK_RESULT_FLOWS_INTO_CALL = new Set([
	"then",
	"catch",
	"map",
	"flatMap",
	"filter",
	"find",
	"findIndex",
	"findLast",
	"findLastIndex",
	"some",
	"every",
	"reduce",
	"reduceRight",
]);

const TEST_RUNNER_ROOTS = new Set(["test", "it", "describe"]);

/**
 * The name a callee is known by: `forEach` for `xs.forEach`, `setTimeout` for both
 * `setTimeout` and `globalThis.setTimeout`, and `test` for `test.skip` or `it.only`, whose
 * last segment is a modifier rather than a different function.
 */
function calleeName(callee: ts.Expression): string | undefined {
	if (ts.isIdentifier(callee)) return callee.text;
	if (!ts.isPropertyAccessExpression(callee)) return undefined;
	let root: ts.Expression = callee;
	while (ts.isPropertyAccessExpression(root)) root = root.expression;
	if (ts.isIdentifier(root) && TEST_RUNNER_ROOTS.has(root.text)) return root.text;
	return callee.name.text;
}

function isFunctionLike(node: ts.Node): boolean {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node) ||
		ts.isConstructorDeclaration(node)
	);
}

function isExpectCall(node: ts.Node): boolean {
	return (
		ts.isCallExpression(node) &&
		ts.isIdentifier(node.expression) &&
		node.expression.text === "expect"
	);
}

/**
 * True when nobody reads what this function returns, decided by where the function itself
 * is handed. Anything not positively known to ignore the value counts as reading it.
 */
function isReturnValueDiscarded(fn: ts.Node): boolean {
	if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
	let current: ts.Node = fn;
	let parent = current.parent;
	while (
		parent !== undefined &&
		(ts.isParenthesizedExpression(parent) ||
			ts.isAsExpression(parent) ||
			ts.isSatisfiesExpression(parent))
	) {
		current = parent;
		parent = current.parent;
	}
	if (parent === undefined) return false;
	if (ts.isNewExpression(parent)) {
		// A Promise executor's return value goes nowhere.
		return (
			ts.isIdentifier(parent.expression) &&
			parent.expression.text === "Promise" &&
			parent.arguments?.[0] === current
		);
	}
	if (!ts.isCallExpression(parent)) return false;
	// `expect(() => ...)` needs no case of its own: `expect` is in neither list, so the
	// function counts as read, and isHeldByExpect covers statements inside it.
	if (!parent.arguments.includes(current as ts.Expression)) return false;
	const name = calleeName(parent.expression);
	if (name === undefined) return false;
	if (IGNORES_CALLBACK_RESULT.has(name)) return true;
	if (CALLBACK_RESULT_FLOWS_INTO_CALL.has(name)) return isValueDiscarded(parent, true);
	return false;
}

/**
 * True when the value of this expression goes nowhere, climbing through every position that
 * passes a value along: the chain itself, parentheses, `await`, `!`, `as`, `satisfies`, the
 * right operand of `&&` / `||` / `??`, either branch of `?:`, the right operand of a comma,
 * and a template literal. It stops at a position that throws the value away (a statement,
 * `void`, a comma's left operand, a `for` initialiser or incrementor) or that hands it to a
 * function's caller (an arrow's expression body, a `return`), where the question becomes
 * whether that caller reads it.
 *
 * Kept separate from climbOutOfExpression on purpose. That climb is shared with condition
 * 4b, and widening it would change which matchers count as receiving the chain's value,
 * which neither SB23-2499 nor any measurement asked for.
 */
function isValueDiscarded(node: ts.Node, readsThroughMembers = false): boolean {
	let current: ts.Node = node;
	let parent = current.parent;
	while (parent !== undefined) {
		// Climbing through `.foo` and `.foo()` is right for the `?.` chain itself, because a
		// short-circuit skips the whole chain. It is wrong for the result of a callee the value
		// FLOWED into: in `p.then(() => s?.read()).then((v) => expect(v).toBe(1))` the second
		// `.then` receives the value. Found by PR #288's reviewer; a member access there now
		// counts as reading it, so `p.then(...).catch(() => {})` is a miss rather than a report.
		const throughMember =
			!readsThroughMembers &&
			(((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
				parent.expression === current) ||
				(ts.isCallExpression(parent) && parent.expression === current));
		const passesValueThrough =
			throughMember ||
			ts.isParenthesizedExpression(parent) ||
			ts.isAwaitExpression(parent) ||
			ts.isNonNullExpression(parent) ||
			ts.isAsExpression(parent) ||
			ts.isSatisfiesExpression(parent) ||
			(ts.isBinaryExpression(parent) &&
				parent.right === current &&
				(parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
					parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
					parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
					parent.operatorToken.kind === ts.SyntaxKind.CommaToken)) ||
			(ts.isConditionalExpression(parent) &&
				(parent.whenTrue === current || parent.whenFalse === current)) ||
			(ts.isTemplateSpan(parent) && parent.expression === current) ||
			(ts.isTemplateExpression(parent) && ts.isTemplateSpan(current));
		if (!passesValueThrough) break;
		current = parent;
		parent = current.parent;
	}
	if (parent === undefined) return false;
	// A statement is where a value goes nowhere. `void x?.f()` says so explicitly.
	if (ts.isExpressionStatement(parent) || ts.isVoidExpression(parent)) return true;
	// `(x?.f(), n++)` evaluates the left operand for its effect and drops its value.
	if (
		ts.isBinaryExpression(parent) &&
		parent.operatorToken.kind === ts.SyntaxKind.CommaToken &&
		parent.left === current
	) {
		return true;
	}
	if (
		ts.isForStatement(parent) &&
		(parent.initializer === current || parent.incrementor === current)
	) {
		return true;
	}
	// The value becomes the function's return value, so it is discarded when the caller
	// ignores what the function returns: `xs.forEach((k) => s?.write(k))`.
	if (ts.isArrowFunction(parent) && parent.body === current) {
		return isReturnValueDiscarded(parent);
	}
	if (ts.isReturnStatement(parent) && parent.expression === current) {
		let fn: ts.Node | undefined = parent.parent;
		while (fn !== undefined && !isFunctionLike(fn)) fn = fn.parent;
		return fn !== undefined && isReturnValueDiscarded(fn);
	}
	return false;
}

/**
 * True when the assertion hanging off this `expect(fn)` fails if `fn` runs without throwing or
 * rejecting, so a call skipped inside `fn` is observed. Measured on Bun 1.3.14 and 1.4.2
 * (SB23-3836): `expect(() => {}).toThrow()` and `.toThrowError()` fail, any `.rejects` chain on
 * an async function that resolves fails, and `expect(() => {}).not.toThrow()` PASSES, as does
 * every matcher that never calls the function (`toBeFunction`, `toBeDefined`). So only those
 * two shapes observe a skip.
 */
function expectObservesSkip(expectCall: ts.CallExpression): boolean {
	let node: ts.Node = expectCall;
	let negated = false;
	let rejects = false;
	while (node.parent !== undefined && ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) {
		const name = node.parent.name.text;
		if (name === "not") negated = !negated;
		else if (name === "rejects") rejects = true;
		else if (name !== "resolves") {
			const call = node.parent.parent;
			if (call === undefined || !ts.isCallExpression(call) || call.expression !== node.parent) return false;
			return rejects || (!negated && (name === "toThrow" || name === "toThrowError"));
		}
		node = node.parent;
	}
	return false;
}

/** True when this function, or `expect(this function)` through parentheses, is held by an observing `expect`. */
function isHeldDirectly(held: ts.Node, holder: ts.Node | undefined): boolean {
	return (
		holder !== undefined &&
		ts.isCallExpression(holder) &&
		isExpectCall(holder) &&
		holder.arguments.length === 1 &&
		holder.arguments[0] === held &&
		expectObservesSkip(holder)
	);
}

/** True when `scope` itself declares `name`, as a parameter or as a statement in its body. */
function declaresName(scope: ts.Node, name: string): boolean {
	const binds = (binding: ts.BindingName): boolean =>
		ts.isIdentifier(binding)
			? binding.text === name
			: binding.elements.some((el) => !ts.isOmittedExpression(el) && binds(el.name));
	if (isFunctionLike(scope)) {
		return (scope as ts.SignatureDeclaration).parameters.some((p) => binds(p.name));
	}
	if (ts.isCatchClause(scope)) {
		return scope.variableDeclaration !== undefined && binds(scope.variableDeclaration.name);
	}
	const statements =
		ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)
			? scope.statements
			: undefined;
	if (statements === undefined) return false;
	return statements.some(
		(st) =>
			(ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => binds(d.name))) ||
			((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name?.text === name),
	);
}

/**
 * N4 from PR #288's review, fixed in SB23-3836: `const act = () => { h?.dispatch("x"); };
 * expect(act).toThrow();` observes the skip exactly as the inline form does, and was reported
 * because the arrow's holder is the `const`, not the `expect`. A function stored under a
 * `const` or declared by name is held by `expect` when any `expect(<that name>)` in the
 * declaring scope observes a skip and its identifier binds to this declaration, not to an
 * inner parameter or declaration of the same name. One observing call is enough: the skip
 * happens on every invocation, so the first observed one fails the test.
 */
function isHeldThroughName(fn: ts.Node, held: ts.Node, holder: ts.Node | undefined): boolean {
	let name: string | undefined;
	let declaringScope: ts.Node | undefined;
	if (ts.isFunctionDeclaration(fn) && fn.name !== undefined) {
		name = fn.name.text;
		declaringScope = fn.parent;
	} else if (
		holder !== undefined &&
		ts.isVariableDeclaration(holder) &&
		holder.initializer === held &&
		ts.isIdentifier(holder.name) &&
		(ts.getCombinedNodeFlags(holder) & ts.NodeFlags.Const) !== 0
	) {
		name = holder.name.text;
		declaringScope = holder.parent?.parent?.parent;
	}
	if (name === undefined || declaringScope === undefined) return false;
	const target = name;
	const scope = declaringScope;
	let found = false;
	const visit = (n: ts.Node): void => {
		if (found) return;
		if (
			ts.isCallExpression(n) &&
			isExpectCall(n) &&
			n.arguments.length === 1 &&
			n.arguments[0] !== undefined &&
			ts.isIdentifier(n.arguments[0]) &&
			n.arguments[0].text === target &&
			expectObservesSkip(n)
		) {
			let up: ts.Node | undefined = n.parent;
			let shadowed = false;
			while (up !== undefined && up !== scope) {
				if (declaresName(up, target)) {
					shadowed = true;
					break;
				}
				up = up.parent;
			}
			if (!shadowed && up === scope) found = true;
		}
		ts.forEachChild(n, visit);
	};
	visit(scope);
	return found;
}

/**
 * True when a function enclosing this node is held by an `expect(...)` that observes a skip,
 * in which case reporting the skip would fail a correct build: `expect(() => { h?.dispatch("x");
 * }).toThrow(/bad/)` fails when `h` is null, because nothing throws.
 *
 * Every enclosing function, not only the nearest. Before SB23-2499 only the nearest was
 * checked, so `expect(() => { xs.forEach((k) => { s?.f(k); }); }).toThrow()` was reported
 * although a skip there is exactly as observed.
 *
 * SB23-3836 narrowed WHICH `expect` counts. Until then any `expect(fn)` exempted everything
 * inside `fn`, including `expect(() => { s?.f(); }).not.toThrow()`, where a nullish `s` calls
 * nothing, nothing throws, and the test passes: a silent skip the gate waved through. Now only
 * `toThrow` / `toThrowError` with no net `.not`, and any `.rejects` chain, exempt; see
 * expectObservesSkip. The same change follows a function stored under a `const` or a name to
 * the `expect` that holds it (isHeldThroughName).
 */
function isHeldByExpect(node: ts.Node): boolean {
	let scope: ts.Node | undefined = node.parent;
	while (scope !== undefined) {
		if (isFunctionLike(scope)) {
			let holder: ts.Node | undefined = scope.parent;
			let held: ts.Node = scope;
			while (holder !== undefined && ts.isParenthesizedExpression(holder)) {
				held = holder;
				holder = holder.parent;
			}
			if (isHeldDirectly(held, holder) || isHeldThroughName(scope, held, holder)) return true;
		}
		scope = scope.parent;
	}
	return false;
}

/**
 * True when the value of the expression containing this optional chain is thrown away, so
 * nothing downstream can notice that the chain short-circuited.
 *
 * This is the discriminator, and it was arrived at by being wrong first. Gating every
 * skipped call reported nine sites of the shape
 * `expect(col?.type.toUpperCase()).toBe("TEXT")`. Those are not silent: short-circuiting
 * makes the whole expression `undefined`, `expect(undefined).toBe("TEXT")` fails, and the
 * test goes red with a legible message. Reporting them would have been the gate failing a
 * build over code that already catches its own defect.
 *
 * The two genuinely dangerous sites on this tree were the ones whose result nobody reads:
 * `reader?.cancel("client disconnected")` and, in PR #217's former shape,
 * `timeoutCallback?.()`. A call made for its effect, skipped, observed by nothing.
 */
function isResultDiscarded(node: ts.Node): boolean {
	return isValueDiscarded(node) && !isHeldByExpect(node);
}

/**
 * The expression a `?.` guards, as normalised text, and whether short-circuiting it skips a
 * CALL or merely yields `undefined`. For `a.b?.c` the subject is `a.b`; for `cb?.()` it is
 * `cb`; for `xs?.[0]` it is `xs`.
 *
 * The two kinds are not the same defect and the gate treats them differently. See
 * SKIPPED_CALL_ONLY below.
 */
function optionalSubject(
	node: ts.Node,
): { subject: string; subjectNode: ts.Expression; kind: string; skipsCall: boolean } | null {
	if (ts.isPropertyAccessExpression(node) && node.questionDotToken) {
		return {
			subject: normalise(node.expression.getText()),
			subjectNode: node.expression,
			kind: isCalleeOfCall(node) ? "optional call through a member" : "optional property access",
			skipsCall:
				(isCalleeOfCall(node) && isResultDiscarded(node)) ||
				isConsumedByUndefinedTolerantMatcher(node),
		};
	}
	if (ts.isElementAccessExpression(node) && node.questionDotToken) {
		return {
			subject: normalise(node.expression.getText()),
			subjectNode: node.expression,
			kind: isCalleeOfCall(node) ? "optional call through an element" : "optional element access",
			skipsCall:
				(isCalleeOfCall(node) && isResultDiscarded(node)) ||
				isConsumedByUndefinedTolerantMatcher(node),
		};
	}
	if (ts.isCallExpression(node) && node.questionDotToken) {
		return {
			subject: normalise(node.expression.getText()),
			subjectNode: node.expression,
			kind: "optional call",
			skipsCall: isResultDiscarded(node) || isConsumedByUndefinedTolerantMatcher(node),
		};
	}
	return null;
}

/**
 * The narrowing, and the reason the gate can fail the build instead of warning.
 *
 * Measured on this tree at 6be70246, with the guard clause applied and nothing else:
 * **275 offences across 60 test files**, of which **263 optional property accesses** and
 * **12 optional element accesses**. Reporting all 275 would have been a warning nobody
 * reads, which is the outcome SB23-2375 rejected.
 *
 * So the gate reports only a skipped call whose result is discarded. The split is not a
 * convenience, it is the distinction SB23-2460 drew itself:
 *
 *   - A skipped call whose result nobody reads means the subject under test never ran.
 *     The test asserts nothing and passes. There is no second chance to notice.
 *   - Everything else yields `undefined`, which is then handed to an `expect(...)` that
 *     fails on it. SB23-2460 records `observedSignal?.aborted` as safe "only by luck" for
 *     exactly this reason: luck that holds across the overwhelming majority of the 275,
 *     and a build failure cannot be built on a majority.
 *
 * Of the 275, exactly **2** survive conditions 3 and 4, both in `codex/provider.test.ts`:
 * `reader?.read()` and `reader?.cancel("client disconnected")` under an
 * `expect(reader).toBeDefined()`. The cancel is the entire subject of that test, so
 * skipping it leaves the assertion below passing because nothing was ever registered to
 * clear. Both are fixed in the commit that adds this file, which is why it reads 0.
 *
 * The 275 are a real population and not noise. They are recorded in SB23-2460 with this
 * script's `--survey` mode as the way to re-derive them, so a later lane can take them on
 * without re-deriving the measurement. Widening this constant to `false` is that lane's
 * first line, and its second is fixing 275 sites.
 */
const SKIPPED_CALL_ONLY = true;

/**
 * SB23-2498. Which widened matches fail the build, by axis. A match needing several axes is
 * gated only when every one of them is:
 *   - `spelling`: the guard names the same value spelled differently (`res!.body`,
 *     `(res as R).body`, `res?.body`, `res["body"]` all name `res.body`).
 *   - `alias`: the guard and the chain reach the same value through a `const` alias.
 *   - `prefix`: the chain's subject is a receiver the guard's own evaluation proves present.
 *   - `matcher`: the guard is a matcher that fails on a missing value without saying so,
 *     such as `toBeInstanceOf` or `expect(typeof x).toBe("function")`.
 */
const GATED_AXES = new Set(["spelling", "alias", "prefix", "matcher"]);

type Offence = {
	file: string;
	line: number;
	column: number;
	kind: string;
	subject: string;
	matcher: string;
	guardLine: number;
	skipsCall: boolean;
	/** "" for the baseline match; otherwise the SB23-2498 axes the match needed, "+"-joined. */
	axes: string;
	text: string;
};

const offences: Offence[] = [];
const surveyed: Offence[] = [];
let filesScanned = 0;
let optionalChainsExamined = 0;
let guardsFound = 0;

for (const root of searchRoots) {
	const abs = path.resolve(repoRoot, root);
	const files: string[] = [];
	collectTestFiles(abs, files);

	for (const fileName of files) {
		filesScanned++;
		const text = readFileSync(fileName, "utf8");
		const sourceFile = ts.createSourceFile(
			fileName,
			text,
			ts.ScriptTarget.Latest,
			/* setParentNodes */ true,
			fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
		);

		// A guard declared in an outer block still holds inside a nested one: in
		// cache-body-store.test.ts the `?.` sat in a `for` body inside the guarded block,
		// so descending the scope chain is load-bearing rather than thorough.
		//
		// A function also opens a scope, for its parameters only, so a parameter named like
		// an outer `const` alias shadows it. Guards never go into a function scope: an
		// expression-bodied arrow holding an `expect` records it in the enclosing block, as
		// it did before SB23-2498.
		type Scope = { guards: Guard[]; aliases: Map<string, string | null>; isFunction: boolean };
		const scopes: Scope[] = [];
		const resolveAlias: ResolveAlias = (name) => {
			for (let i = scopes.length - 1; i >= 0; i--) {
				const aliases = scopes[i]?.aliases;
				if (aliases?.has(name)) return aliases.get(name);
			}
			return undefined;
		};
		// The scope that binds a name, so two spellings of `h` can be told apart when an inner
		// parameter or `const` rebinds it. Names nothing in the file binds share `null`.
		const bindingOf = (name: string | undefined): object | null => {
			if (name === undefined) return null;
			for (let i = scopes.length - 1; i >= 0; i--) {
				const scope = scopes[i];
				if (scope?.aliases.has(name)) return scope;
			}
			return null;
		};
		const shadow = (binding: ts.BindingName, into: Scope | undefined): void => {
			if (!into) return;
			if (ts.isIdentifier(binding)) into.aliases.set(binding.text, null);
			else for (const el of binding.elements) if (!ts.isOmittedExpression(el)) shadow(el.name, into);
		};

		const visit = (node: ts.Node): void => {
			const opensBlock =
				ts.isBlock(node) ||
				ts.isSourceFile(node) ||
				ts.isModuleBlock(node) ||
				ts.isCaseClause(node) ||
				ts.isDefaultClause(node);
			const opensFunction = isFunctionLike(node);
			if (opensBlock || opensFunction) {
				scopes.push({ guards: [], aliases: new Map(), isFunction: opensFunction });
			}
			if (opensFunction) {
				const fn = node as ts.SignatureDeclaration;
				for (const param of fn.parameters) shadow(param.name, scopes[scopes.length - 1]);
			}

			// `const r = res;` makes `r` another spelling of `res`. Only a `const` whose
			// initialiser names an existing value counts; a call makes a new value, and a
			// `let` can be reassigned. Every other binding shadows any outer alias.
			if (ts.isVariableDeclaration(node)) {
				const innermost = scopes[scopes.length - 1];
				const init = node.initializer ? unwrapValue(node.initializer) : undefined;
				const isConst = (ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) !== 0;
				if (
					innermost &&
					isConst &&
					ts.isIdentifier(node.name) &&
					init !== undefined &&
					(ts.isIdentifier(init) ||
						init.kind === ts.SyntaxKind.ThisKeyword ||
						ts.isPropertyAccessExpression(init) ||
						ts.isElementAccessExpression(init))
				) {
					innermost.aliases.set(node.name.text, canonicalKey(init, resolveAlias).key);
				} else {
					shadow(node.name, innermost);
				}
			}

			const guard = recogniseGuard(node);
			if (guard) {
				guardsFound++;
				const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
				let target: Scope | undefined;
				for (let i = scopes.length - 1; i >= 0 && !target; i--) {
					if (!scopes[i]?.isFunction) target = scopes[i];
				}
				const canonical = canonicalKey(guard.target, resolveAlias);
				target?.guards.push({
					exact: guard.extended ? null : normalise(guard.target.getText()),
					text: normalise(guard.target.getText()),
					key: canonical.key,
					viaAlias: canonical.viaAlias,
					implied: impliedReceivers(guard.target, guard.rejectsUndefined).map((r) =>
						canonicalKey(r, resolveAlias),
					),
					extended: guard.extended,
					rootBinding: bindingOf(rootIdentifier(guard.target)),
					end: node.getEnd(),
					matcher: guard.matcher,
					line: line + 1,
				});
			}

			const optional = optionalSubject(node);
			if (optional) {
				optionalChainsExamined++;
				// Search innermost scope outwards. The guard must END before this node
				// STARTS, which is what makes `expect(x).not.toBeNull()` inside the very
				// expression being checked unable to license itself.
				//
				// The best match wins: the baseline (same text, one of the original four
				// matchers) over the same value spelled differently, over a receiver the
				// guard proves present. Ties go to the innermost, earliest guard.
				const start = node.getStart();
				const chain = canonicalKey(optional.subjectNode, resolveAlias);
				const chainBinding = bindingOf(rootIdentifier(optional.subjectNode));
				let matched: { guard: Guard; rank: number; axes: string[] } | undefined;
				// N4 from PR #288's review, fixed in SB23-3836: a subject that passes through a
				// call names a NEW value each time it is evaluated, so no earlier guard proves it.
				// `expect(store.get("k")).toBeDefined(); store.get("k")?.clear()` compares two
				// calls; the alias rule already refused `const v = store.get("k")` for the same
				// reason, and the text rule did not. `store?.clear()` under that guard is still
				// matched, because the receiver `store` precedes the call.
				for (let i = scopes.length - 1; i >= 0 && matched?.rank !== 0 && !chain.hasCall; i--) {
					const scope = scopes[i];
					if (!scope) continue;
					for (const g of scope.guards) {
						if (g.end > start) continue;
						// `hs.forEach((h) => h?.())` under `expect(h).not.toBeNull()` names a
						// different `h`. Found by PR #288's reviewer: the callback widening made
						// it reachable. An alias on either side compared resolved keys instead.
						if (!g.viaAlias && !chain.viaAlias && g.rootBinding !== chainBinding) continue;
						let candidate: { rank: number; axes: string[] } | undefined;
						if (g.exact !== null && g.exact === optional.subject) {
							candidate = { rank: 0, axes: [] };
						} else if (g.key === chain.key) {
							// Same text under a widened matcher is the matcher axis alone.
							const viaAlias = g.viaAlias || chain.viaAlias;
							const axes = g.text === optional.subject ? [] : [viaAlias ? "alias" : "spelling"];
							candidate = { rank: 1, axes };
						} else {
							const hit = g.implied.find((r) => r.key === chain.key);
							if (hit) {
								const axes = ["prefix"];
								if (hit.viaAlias || chain.viaAlias) axes.push("alias");
								candidate = { rank: 2, axes };
							}
						}
						if (!candidate) continue;
						if (candidate.rank > 0 && g.extended) candidate.axes.push("matcher");
						if (!matched || candidate.rank < matched.rank) {
							matched = { guard: g, rank: candidate.rank, axes: candidate.axes };
							if (candidate.rank === 0) break;
						}
					}
				}
				if (matched) {
					const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
					const axes = [...matched.axes].sort().join("+");
					const found: Offence = {
						file: path.relative(repoRoot, fileName),
						line: line + 1,
						column: character + 1,
						kind: optional.kind,
						subject: optional.subject,
						matcher: matched.guard.matcher,
						guardLine: matched.guard.line,
						skipsCall: optional.skipsCall,
						axes,
						text: node.getText().replace(/\s+/g, " ").slice(0, 100),
					};
					surveyed.push(found);
					const gated = matched.axes.every((a) => GATED_AXES.has(a));
					if ((!SKIPPED_CALL_ONLY || found.skipsCall) && gated) offences.push(found);
				}
			}

			ts.forEachChild(node, visit);
			if (opensBlock || opensFunction) scopes.pop();
		};

		visit(sourceFile);
	}
}

// A gate that never reads a file reports zero offences forever, which is indistinguishable
// from a clean tree. PR #212's reviewer proved that is not hypothetical: it changed that
// script's `process.exit(2)` to `exit(0)` and the mutant survived all seven of its tests.
// So all three counts are printed, and a run that parsed nothing, or found no optional
// chain at all, or found none of the assertions the predicate is built on, exits 2 rather
// than passing.
const summary = {
	typescript: ts.version,
	scanMode,
	filesScanned,
	optionalChainsExamined,
	guardsFound,
	guardedOptionalChains: surveyed.length,
	offences: offences.length,
};

const reported = survey ? surveyed : offences;

if (asJson) {
	console.log(JSON.stringify({ ...summary, detail: reported }, null, 2));
} else {
	console.log(
		`check-optional-chain-silent-skip: typescript ${ts.version}, ${scanMode} mode, ${filesScanned} test files scanned, ${optionalChainsExamined} optional chains examined, ${guardsFound} presence assertions found, ${surveyed.length} guarded optional chains, ${offences.length} offences`,
	);
}

// The three counts are not equally meaningful at every scope, and conflating them made the
// gate exit 2 on a perfectly valid single-directory run. A fixture with one file and no
// `expect` legitimately has no presence assertion and no optional chain; the REPOSITORY does
// not, and it is the repository run whose zero has to be trustworthy.
//
// So the strong invariant applies to the whole-tree invocation, which is the one CI makes,
// and an explicit-root run only has to have found a file to parse.
/**
 * A floor, not a target. The reviewer killed the `> 0` version by adding `"src"` to
 * `SKIP_DIRS`: the walker then read `scripts/` alone, found 2 files, 1 chain and 1
 * assertion, and every `> 0` check passed, so the gate reported a clean tree having read
 * almost none of it. That is the scanned-nothing hole in a new suit.
 *
 * 300 is deliberately far below the 404 measured on 2026-09-21, because this must never
 * fail on a legitimately shrinking tree; it exists to catch a walker that lost a whole
 * directory, which is an order-of-magnitude event rather than a drift. If this ever fires,
 * the question is which directory stopped being scanned, not whether to lower the number.
 */
const MIN_TEST_FILES_WHOLE_REPO = 300;

const scannedNothing = scanningWholeRepo
	? filesScanned < MIN_TEST_FILES_WHOLE_REPO ||
		optionalChainsExamined === 0 ||
		guardsFound === 0
	: filesScanned === 0;

if (scannedNothing) {
	console.error(
		`check-optional-chain-silent-skip: scanned too little (${filesScanned} files, ${optionalChainsExamined} optional chains, ${guardsFound} presence assertions${scanningWholeRepo ? `, floor ${MIN_TEST_FILES_WHOLE_REPO} files` : ""}), so this run is not evidence of a clean tree`,
	);
	process.exit(2);
}

// `--survey` reports the wider guarded-optional-chain population that the SKIPPED_CALL_ONLY
// narrowing leaves out, and exits 0 whatever it finds. It is a measurement, never a gate:
// giving it a failing exit code would make the narrowing pointless.
if (survey) {
	// The population drifts with every merge, so the figure carries the head it was measured
	// at (SB23-2498): 275 at eaa5859a and 260 at c043c20a were both quoted later without one.
	const head = headSha();
	const byFile = new Map<string, number>();
	for (const o of surveyed) byFile.set(o.file, (byFile.get(o.file) ?? 0) + 1);
	if (!asJson) {
		for (const [file, count] of [...byFile].sort((a, b) => b[1] - a[1])) {
			console.log(`  ${String(count).padStart(4)}  ${file}`);
		}
		// The widened population, split by axis and then by file, so a widening can be judged
		// on what it adds rather than on one total.
		const byAxes = new Map<string, Offence[]>();
		for (const o of surveyed) {
			if (o.axes === "") continue;
			byAxes.set(o.axes, [...(byAxes.get(o.axes) ?? []), o]);
		}
		for (const [axes, found] of [...byAxes].sort((a, b) => a[0].localeCompare(b[0]))) {
			const skips = found.filter((o) => o.skipsCall).length;
			console.log(`widened by ${axes}: ${found.length} guarded optional chains, ${skips} of which skip a call`);
			const perFile = new Map<string, number>();
			for (const o of found) perFile.set(o.file, (perFile.get(o.file) ?? 0) + 1);
			for (const [file, count] of [...perFile].sort((a, b) => b[1] - a[1])) {
				console.log(`  ${String(count).padStart(4)}  ${file}`);
			}
		}
		const skipsCall = surveyed.filter((o) => o.skipsCall).length;
		console.log(
			`survey at ${head}: ${surveyed.length} guarded optional chains in ${byFile.size} files, ${skipsCall} of which skip a call`,
		);
	} else {
		console.log(JSON.stringify({ head }));
	}
	process.exit(0);
}

if (offences.length > 0) {
	if (!asJson) {
		console.error("");
		for (const o of offences) {
			console.error(
				`${o.file}:${o.line}:${o.column}  \`${o.subject}\` was asserted present by \`expect(...).${o.matcher}\` on line ${o.guardLine}, so this ${o.kind} silently skips instead of failing:  ${o.text}`,
			);
		}
		console.error("");
		console.error(
			'Replace the assertion with `if (!x) throw new Error("...")` and drop the `?.`. The throw narrows the type for real, so the call below it cannot be skipped.',
		);
	}
	process.exit(1);
}
