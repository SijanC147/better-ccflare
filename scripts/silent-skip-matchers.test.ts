import { describe, expect, mock, test } from "bun:test";
import {
	ARGUMENT_DEPENDENT_MATCHERS,
	type ArgShape,
	matcherVerdictOnUndefined,
	NO_ARG_TYPE_MATCHERS,
	PRESENT_TYPEOF,
	REJECTS_UNDEFINED_EVEN_NEGATED,
	TYPE_AND_SHAPE_MATCHERS,
	UNDEFINED_TOLERANT_MATCHERS,
} from "./silent-skip-matchers";

/**
 * SB23-3836. Pins `scripts/check-optional-chain-silent-skip.ts`'s beliefs about Bun's
 * matchers against the Bun that is running this file. CI runs it on the pinned Bun (1.3.14)
 * and a developer on whatever is installed, so a Bun bump that changes how any matcher treats
 * `undefined` fails here rather than leaving the gate to report correct code or miss a skip.
 *
 * It calls `matcherVerdictOnUndefined`, the function the gate calls, rather than re-declaring
 * the tables: a copy would pin the copy.
 *
 * Every matcher Bun exposes is enumerated at run time, so a matcher a new Bun adds is checked
 * against the gate's default for an unlisted name, and fails here until it is classified.
 *
 * The snapshot matchers are never called. `toMatchInlineSnapshot` on a value writes the
 * snapshot into this file's own source.
 */
const NEVER_CALLED = new Set([
	"constructor",
	"pass",
	"fail",
	"toMatchSnapshot",
	"toMatchInlineSnapshot",
	"toThrowErrorMatchingSnapshot",
	"toThrowErrorMatchingInlineSnapshot",
]);

/**
 * Argument samples. Each covers a shape the gate distinguishes: the literal `undefined`, a
 * type string, an empty and a non-empty array, an array holding `undefined`, a predicate that
 * holds for `undefined` and one that does not. A sample a matcher refuses whatever it receives
 * (an invalid argument, not an answer about `undefined`) is skipped for that matcher; see
 * isApplicable.
 */
const SAMPLES: Array<[string, unknown[]]> = [
	["()", []],
	["(1)", [1]],
	['("x")', ["x"]],
	['("undefined")', ["undefined"]],
	['("string")', ["string"]],
	["(undefined)", [undefined]],
	["(null)", [null]],
	["([])", [[]]],
	["([1])", [[1]]],
	["([undefined])", [[undefined]]],
	["([undefined, 1])", [[undefined, 1]]],
	['(["a"])', [["a"]]],
	["({})", [{}]],
	["({ a: 1 })", [{ a: 1 }]],
	["(Object)", [Object]],
	["(1, 1)", [1, 1]],
	["(0, 2)", [0, 2]],
	['("x", 1)', ["x", 1]],
	["(v => v === undefined)", [(v: unknown) => v === undefined]],
	["(v => v === 1)", [(v: unknown) => v === 1]],
];

/** Received values that make some sample valid for some matcher, so validity is measurable. */
function receivedCandidates(): unknown[] {
	const called = mock((_x: unknown) => 1);
	called(1);
	const uncalled = mock(() => 1);
	const thrower = () => {
		throw new Error("x");
	};
	return [1, 0, -1, 2, 1.5, "x", "", "  x ", [1], [], [undefined], { a: 1 }, {}, null, true, false, Number.NaN, new Date(), Symbol("s"), called, uncalled, thrower, Object];
}

type Matchers = Record<string, (...args: unknown[]) => unknown> & { not: Record<string, (...args: unknown[]) => unknown> };

function passes(received: unknown, name: string, negated: boolean, args: unknown[]): boolean {
	const e = expect(received) as unknown as Matchers;
	try {
		// Read `.not` ONCE. Measured on Bun 1.4.2: reading it twice on the same `expect(...)`
		// flips the negation back, so `e.not[name].apply(e.not, ...)` runs the positive form.
		const target = negated ? e.not : e;
		const fn = target[name];
		if (typeof fn !== "function") return false;
		fn.apply(target, args);
		return true;
	} catch {
		return false;
	}
}

/**
 * A sample is valid for a matcher when, for some received value, the assertion or its negation
 * passes. `toBeTypeOf("x")` throws on every received value because `"x"` is not a type, so its
 * result on `undefined` says nothing about `undefined`.
 */
function isApplicable(name: string, args: unknown[]): boolean {
	return receivedCandidates().some((r) => passes(r, name, false, args) || passes(r, name, true, args));
}

function shapeOf(value: unknown): ArgShape {
	if (value === undefined) return { kind: "undefined" };
	if (value === null) return { kind: "null" };
	if (typeof value === "string") return { kind: "string", value };
	if (typeof value === "number" || typeof value === "bigint") return { kind: "number" };
	if (typeof value === "boolean") return { kind: "boolean" };
	if (Array.isArray(value)) return { kind: "array", elements: value.map(shapeOf) };
	if (typeof value === "function") return { kind: "function" };
	return { kind: "object" };
}

function bunMatcherNames(): string[] {
	const names = new Set<string>();
	let proto: object | null = expect(undefined);
	while (proto !== null && proto !== Object.prototype) {
		for (const name of Object.getOwnPropertyNames(proto)) {
			const descriptor = Object.getOwnPropertyDescriptor(proto, name);
			if (descriptor && typeof descriptor.value === "function" && !NEVER_CALLED.has(name)) names.add(name);
		}
		proto = Object.getPrototypeOf(proto);
	}
	return [...names].sort();
}

describe("silent-skip-matchers agrees with the running Bun", () => {
	const names = bunMatcherNames();

	test("Bun exposes the matchers this file was measured against", () => {
		// A floor, not a pin: 1.3.14 and 1.4.2 both expose 79 callable matchers besides the
		// snapshot ones. Far fewer means the enumeration broke and every test below is vacuous.
		expect(names.length).toBeGreaterThan(60);
		expect(names).toContain("toBeUndefined");
		expect(names).toContain("toHaveBeenCalled");
	});

	test("every name in the gate's tables is a Bun matcher", () => {
		// `toBeNullish` sat in the tolerant set until SB23-3836 and is not a Bun matcher, so the
		// entry did nothing. An entry for a name Bun lacks is a claim nobody can test.
		const tabled = [
			...UNDEFINED_TOLERANT_MATCHERS,
			...REJECTS_UNDEFINED_EVEN_NEGATED,
			...ARGUMENT_DEPENDENT_MATCHERS,
			...TYPE_AND_SHAPE_MATCHERS,
			...NO_ARG_TYPE_MATCHERS,
		];
		const missing = tabled.filter((name) => !names.includes(name));
		expect(missing).toEqual([]);
	});

	test("the verdict on undefined matches Bun for every matcher, both ways round, every valid sample", () => {
		const disagreements: string[] = [];
		const unclassified: string[] = [];
		for (const name of names) {
			let applicable = 0;
			for (const [label, args] of SAMPLES) {
				if (!isApplicable(name, args)) continue;
				applicable++;
				for (const negated of [false, true]) {
					const verdict = matcherVerdictOnUndefined(name, negated, args.map(shapeOf));
					if (verdict === "unknown") continue;
					const bun = passes(undefined, name, negated, args) ? "tolerates" : "rejects";
					if (bun !== verdict) {
						disagreements.push(`${negated ? "not." : ""}${name}${label}: Bun ${bun}, gate ${verdict}`);
					}
				}
			}
			// A matcher no sample can exercise is a matcher this test cannot see. Add a sample.
			if (applicable === 0) unclassified.push(name);
		}
		expect(unclassified).toEqual([]);
		expect(disagreements).toEqual([]);
	});

	test("a matcher the gate cannot decide really does depend on its argument", () => {
		// `unknown` is only honest where Bun's answer moves with the argument. If a Bun bump
		// made `toSatisfy` constant, the gate could classify it by name and this says so.
		for (const name of names) {
			const outcomes = new Set<string>();
			let undecided = false;
			for (const [, args] of SAMPLES) {
				if (!isApplicable(name, args)) continue;
				for (const negated of [false, true]) {
					if (matcherVerdictOnUndefined(name, negated, args.map(shapeOf)) === "unknown") undecided = true;
				}
				outcomes.add(`${passes(undefined, name, false, args)}/${passes(undefined, name, true, args)}`);
			}
			if (undecided) expect({ name, argumentDependent: outcomes.size > 1 }).toEqual({ name, argumentDependent: true });
		}
	});

	test("every argument-dependent matcher really does depend on its argument", () => {
		for (const name of ARGUMENT_DEPENDENT_MATCHERS) {
			const outcomes = new Set<string>();
			for (const [, args] of SAMPLES) {
				if (!isApplicable(name, args)) continue;
				outcomes.add(`${passes(undefined, name, false, args)}/${passes(undefined, name, true, args)}`);
			}
			expect({ name, outcomes: outcomes.size > 1 }).toEqual({ name, outcomes: true });
		}
	});

	test("every guard matcher fails on undefined, so a ?. below it is a silent skip", () => {
		// recogniseGuard treats these as proving the value present. Each must fail when the value
		// is missing, for every valid sample, or the gate reports a `?.` that is doing real work.
		const passingOnUndefined: string[] = [];
		const check = (name: string, args: unknown[], label: string) => {
			if (passes(undefined, name, false, args)) passingOnUndefined.push(`${name}${label}`);
		};
		for (const name of TYPE_AND_SHAPE_MATCHERS) {
			let applicable = 0;
			for (const [label, args] of SAMPLES) {
				if (args.length === 0 || !isApplicable(name, args)) continue;
				applicable++;
				check(name, args, label);
			}
			expect({ name, applicable: applicable > 0 }).toEqual({ name, applicable: true });
		}
		for (const name of NO_ARG_TYPE_MATCHERS) check(name, [], "()");
		for (const type of PRESENT_TYPEOF) check("toBeTypeOf", [type], `("${type}")`);
		// The original four presence assertions.
		check("toBeDefined", [], "()");
		check("toBeTruthy", [], "()");
		if (passes(undefined, "toBeUndefined", true, [])) passingOnUndefined.push("not.toBeUndefined()");
		// `not.toBeNull()` passes on undefined and the gate knows it (rejectsUndefined: false);
		// what it does prove is that the value is not null.
		if (passes(null, "toBeNull", true, [])) passingOnUndefined.push("not.toBeNull() on null");
		expect(passingOnUndefined).toEqual([]);
	});
});
