/**
 * What `scripts/check-optional-chain-silent-skip.ts` believes each Bun matcher does when the
 * value it receives is `undefined`. Kept apart from the gate, with no TypeScript import, so a
 * test can run every claim here against the Bun that is actually executing the suite
 * (`silent-skip-matchers.test.ts`). The gate calls `matcherVerdictOnUndefined` and nothing
 * else from this file to decide condition 4b, so the test pins the decision the gate makes and
 * not a copy of its tables.
 *
 * SB23-3836. Every entry below was measured on 2026-10-01 by running each matcher on
 * `expect(undefined)`, positive and under `.not`, with 19 argument samples, on Bun 1.3.14 (the
 * CI pin) and Bun 1.4.2. The two versions gave byte-identical results. That measurement found
 * nine negated matchers missing from the rejecting set, one positive matcher missing from the
 * tolerant set, one entry naming a matcher Bun does not have, and four matchers whose answer
 * depends on their argument. A Bun bump that changes any of it fails the pin test rather than
 * leaving the gate to drift.
 */

/**
 * What the gate can know about one argument of a matcher from the source text alone. An
 * identifier, a call or a spread is `unknown`: its runtime value is not in the file.
 */
export type ArgShape =
	| { kind: "undefined" }
	| { kind: "null" }
	| { kind: "string"; value: string }
	| { kind: "number" }
	| { kind: "boolean" }
	| { kind: "array"; elements: ArgShape[] }
	| { kind: "object" }
	| { kind: "function" }
	| { kind: "unknown" };

/**
 * `tolerates`: the assertion passes on `undefined`, so a chain that short-circuits into it is
 * observed by nothing. `rejects`: the assertion fails on `undefined`, so the skip turns the
 * test red. `unknown`: the answer depends on something the source does not show. The gate
 * treats `unknown` as `rejects`, which is the direction that cannot fail a correct build.
 */
export type Verdict = "tolerates" | "rejects" | "unknown";

/**
 * The matchers that PASS when handed `undefined` whatever their argument, so a chain
 * short-circuiting into one of them is not observed by anything. `toBeNull` is deliberately
 * absent: `expect(undefined).toBeNull()` fails, so it rejects a skip.
 *
 * `toContainValues` passes on `undefined` for every array argument, `[1]` included, measured
 * on both Bun versions. It is odd and it is what Bun does. `toBeNullish` used to be listed
 * here and is not a Bun matcher at all, so it was removed rather than left inert.
 */
export const UNDEFINED_TOLERANT_MATCHERS: ReadonlySet<string> = new Set([
	"toBeUndefined",
	"toBeEmpty",
	"toBeFalsy",
	"toBeNil",
	"toContainValues",
]);

/**
 * Matchers that FAIL on `undefined` even under `.not`, because they reject a value of the
 * wrong type before comparing anything. The first 27 came from PR #288 and its reviewer; the
 * nine after them are SB23-3836's: the call-count aliases (`toBeCalled`, `toReturn`, ...) and
 * the four un-prefixed Jest aliases, each a false positive until this set listed it.
 */
export const REJECTS_UNDEFINED_EVEN_NEGATED: ReadonlySet<string> = new Set([
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
	// SB23-3836.
	"toBeCalled",
	"toBeCalledTimes",
	"toBeCalledWith",
	"toHaveBeenCalledOnce",
	"toReturn",
	"lastCalledWith",
	"lastReturnedWith",
	"nthCalledWith",
	"nthReturnedWith",
]);

/** `toBe(undefined)` passes on `undefined` and `toBe(5)` does not: the argument decides. */
export const EQUALITY_MATCHERS: ReadonlySet<string> = new Set(["toBe", "toEqual", "toStrictEqual"]);

/**
 * Matchers whose verdict on `undefined` depends on the argument, and how the gate reads it.
 * `toSatisfy` is listed so the pin test can require that it really is argument-dependent:
 * whether a predicate holds for `undefined` is not something the source text shows, so its
 * verdict is always `unknown`.
 */
export const ARGUMENT_DEPENDENT_MATCHERS: ReadonlySet<string> = new Set([
	...EQUALITY_MATCHERS,
	"toBeTypeOf",
	"toBeOneOf",
	"toContainKeys",
	"toSatisfy",
]);

function flip(verdict: "tolerates" | "rejects", negated: boolean): "tolerates" | "rejects" {
	if (!negated) return verdict;
	return verdict === "tolerates" ? "rejects" : "tolerates";
}

/** True for a shape whose runtime value the source fixes, so it can be compared. */
function isKnown(shape: ArgShape): boolean {
	if (shape.kind === "unknown") return false;
	if (shape.kind === "array") return shape.elements.every(isKnown);
	return true;
}

/**
 * Whether `expect(undefined)[.not].<name>(...args)` passes, as the gate believes it. Every
 * matcher answers by name except the argument-dependent ones above:
 *
 *   - `toBe`, `toEqual`, `toStrictEqual`: tolerant exactly when the argument is the literal
 *     `undefined`. An identifier argument is ASSUMED not to hold `undefined`, which is the
 *     behaviour PR #288 shipped; `expect(x?.y).not.toBe(expected)` is reported on that basis.
 *   - `toBeTypeOf("undefined")` passes on `undefined`; any other type string does not. A
 *     non-literal type is `unknown`.
 *   - `toBeOneOf([...])` passes when the literal array holds `undefined`. An array with an
 *     element the source does not fix, or a non-literal argument, is `unknown`.
 *   - `toContainKeys([])` passes on `undefined`; a non-empty literal array does not. A
 *     non-literal argument is `unknown`.
 *   - `toSatisfy(fn)` is always `unknown`.
 */
export function matcherVerdictOnUndefined(name: string, negated: boolean, args: ArgShape[]): Verdict {
	const one = args.length === 1 ? args[0] : undefined;
	if (EQUALITY_MATCHERS.has(name)) {
		if (!one) return "unknown";
		return flip(one.kind === "undefined" ? "tolerates" : "rejects", negated);
	}
	if (name === "toBeTypeOf") {
		if (one?.kind !== "string") return "unknown";
		return flip(one.value === "undefined" ? "tolerates" : "rejects", negated);
	}
	if (name === "toBeOneOf") {
		if (one?.kind !== "array" || !isKnown(one)) return "unknown";
		return flip(one.elements.some((e) => e.kind === "undefined") ? "tolerates" : "rejects", negated);
	}
	if (name === "toContainKeys") {
		if (one?.kind !== "array") return "unknown";
		return flip(one.elements.length === 0 ? "tolerates" : "rejects", negated);
	}
	if (name === "toSatisfy") return "unknown";
	if (negated && REJECTS_UNDEFINED_EVEN_NEGATED.has(name)) return "rejects";
	return flip(UNDEFINED_TOLERANT_MATCHERS.has(name) ? "tolerates" : "rejects", negated);
}

/**
 * Guard matchers: `expect(x).<name>(...)` FAILS when `x` is `undefined`, so a `?.` on `x` below
 * it is a silent skip. The gate's recogniseGuard reads these; the pin test checks every one
 * fails on `undefined` under the running Bun.
 */
export const TYPE_AND_SHAPE_MATCHERS: ReadonlySet<string> = new Set([
	"toBeInstanceOf",
	"toHaveProperty",
	"toHaveLength",
	"toMatchObject",
	"toContain",
	"toContainEqual",
]);
export const NO_ARG_TYPE_MATCHERS: ReadonlySet<string> = new Set([
	"toBeFunction",
	"toBeArray",
	"toBeString",
	"toBeNumber",
	"toBeBoolean",
]);
/** `typeof x` values that a missing `x` cannot produce. `"object"` is absent: `typeof null`. */
export const PRESENT_TYPEOF: ReadonlySet<string> = new Set([
	"function",
	"string",
	"number",
	"boolean",
	"bigint",
	"symbol",
]);
