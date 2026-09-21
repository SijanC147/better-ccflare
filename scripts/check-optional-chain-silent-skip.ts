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
 *   2. an optional chain whose SUBJECT TEXT is identical to the argument of an
 *      `expect(...)` presence assertion appearing EARLIER in the same block or any
 *      enclosing block. The presence assertions are `.not.toBeNull()`,
 *      `.not.toBeUndefined()`, `.toBeDefined()` and `.toBeTruthy()`,
 *   3. where short-circuiting the chain skips a CALL, including one further up the chain
 *      as in `x?.foo.bar()`, and
 *   4. where that call's RESULT IS DISCARDED, so nothing downstream can notice the skip.
 *
 * Condition 4 is the discriminator and it was arrived at by being wrong first. Gating every
 * skipped call reported nine sites shaped like `expect(col?.type.toUpperCase()).toBe("TEXT")`.
 * Those are not silent: short-circuiting makes the whole expression `undefined`,
 * `expect(undefined).toBe("TEXT")` fails, and the test goes red with a legible message.
 * Failing a build over code that already catches its own defect is how a gate gets
 * switched off. Measured on this tree: gating every skipped call reports 9 offences,
 * requiring the result to be discarded reports 2, and both were real.
 *
 * The replacement is the one PR #217 used:
 *
 *     if (!x) throw new Error("<what was supposed to have captured x>");
 *     x();
 *
 * A throw states the precondition instead of letting a `?.` skip it, it narrows the type
 * for real, and it fails loudly with a message naming what did not happen.
 *
 * WHAT IT DOES NOT CATCH, stated so nobody reads this as a ban on optional chaining:
 *   - an UNGUARDED `?.`. `dbOps.dispose?.()`, `process.getgid?.()` and
 *     `provider.isStreamingResponse?.(res)` are optional members of their types and are
 *     correct as written. Measured 2026-09-21: 1248 `?.` occurrences across 169 test files,
 *     which is why the guard clause is the whole predicate and not a detail of it. This
 *     narrowing is what makes the gate shippable as a build failure rather than a warning,
 *     and it is also the gate's blind spot: a captured-stub call with no `expect` guard in
 *     front of it, such as `let cb; ...; cb?.()`, silently skips exactly the same way and
 *     is NOT reported. SB23-2460's own worked examples include several of those.
 *   - a guard on a DIFFERENT expression text. `expect(res.body).not.toBeNull()` does not
 *     license a report on `res.data?.x`. Subject matching is on normalised source text,
 *     so `expect(a.b).not.toBeNull()` does cover `a.b?.c`, but a spelling that differs by
 *     more than whitespace is treated as a different subject.
 *   - a reassignment between the guard and the use. If the subject is written to in
 *     between, the guard genuinely no longer holds and the `?.` may be correct. Tracking
 *     that needs flow analysis; this gate does not attempt it and will report the site.
 *     Silence it by moving the guard, not by widening this script.
 *   - `toBeInstanceOf`, `toEqual` and every other matcher. Only the four presence
 *     assertions above imply "this exists from here on".
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

const repoRoot = path.resolve(import.meta.dir, "..");

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const survey = argv.includes("--survey");
const roots = argv.filter((a: string) => !a.startsWith("--"));
const searchRoots = roots.length > 0 ? roots : ["packages", "apps", "scripts"];

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

type Guard = { subject: string; end: number; matcher: string; line: number };

/**
 * Recognises `expect(X).not.toBeNull()`, `expect(X).not.toBeUndefined()`,
 * `expect(X).toBeDefined()` and `expect(X).toBeTruthy()`, and returns the normalised text
 * of `X`. Anything else returns null.
 *
 * `.not.toBeNull()` must be negated and `.toBeDefined()` must not: `expect(x).toBeNull()`
 * asserts the OPPOSITE and a `?.` below it is correct, so reading the `.not.` is not a
 * detail. Getting that backwards would report the one shape that is right.
 */
function guardSubject(node: ts.Node): { subject: string; matcher: string } | null {
	if (!ts.isCallExpression(node)) return null;
	if (node.arguments.length !== 0) return null;
	const matcherAccess = node.expression;
	if (!ts.isPropertyAccessExpression(matcherAccess)) return null;
	const matcher = matcherAccess.name.text;
	if (!PRESENCE_MATCHERS.has(matcher)) return null;

	// Walk back over `.not`, recording whether we crossed it.
	let receiver: ts.Expression = matcherAccess.expression;
	let negated = false;
	while (ts.isPropertyAccessExpression(receiver) && receiver.name.text === "not") {
		negated = !negated;
		receiver = receiver.expression;
	}
	// `expect(x).not.toBeNull()` and `expect(x).toBeDefined()` are guards.
	// `expect(x).toBeNull()` and `expect(x).not.toBeDefined()` are the opposite claim.
	if (NEGATED_MATCHERS.has(matcher) !== negated) return null;

	if (!ts.isCallExpression(receiver)) return null;
	if (!ts.isIdentifier(receiver.expression) || receiver.expression.text !== "expect") return null;
	if (receiver.arguments.length !== 1) return null;
	const arg = receiver.arguments[0];
	if (!arg) return null;
	// Report the spelling the author wrote. Printing the bare matcher name turns
	// `expect(x).not.toBeNull()` into "asserted present by expect(...).toBeNull", which
	// reads as the opposite of what the line says and sends the reader to the wrong line.
	return { subject: normalise(arg.getText()), matcher: negated ? `not.${matcher}` : matcher };
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
	let current: ts.Node = node;
	let parent = current.parent;
	// Climb out of the chain itself and out of anything that merely passes the value along
	// unchanged, so `await (x?.close())` is judged on where the `await` sits.
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
	if (parent === undefined) return false;
	// A statement is the only place a value goes nowhere. `void x?.f()` says so explicitly.
	if (ts.isExpressionStatement(parent)) return true;
	if (ts.isVoidExpression(parent)) return true;
	return false;
}

/**
 * The expression a `?.` guards, as normalised text, and whether short-circuiting it skips a
 * CALL or merely yields `undefined`. For `a.b?.c` the subject is `a.b`; for `cb?.()` it is
 * `cb`; for `xs?.[0]` it is `xs`.
 *
 * The two kinds are not the same defect and the gate treats them differently. See
 * SKIPPED_CALL_ONLY below.
 */
function optionalSubject(node: ts.Node): { subject: string; kind: string; skipsCall: boolean } | null {
	if (ts.isPropertyAccessExpression(node) && node.questionDotToken) {
		return {
			subject: normalise(node.expression.getText()),
			kind: isCalleeOfCall(node) ? "optional call through a member" : "optional property access",
			skipsCall: isCalleeOfCall(node) && isResultDiscarded(node),
		};
	}
	if (ts.isElementAccessExpression(node) && node.questionDotToken) {
		return {
			subject: normalise(node.expression.getText()),
			kind: isCalleeOfCall(node) ? "optional call through an element" : "optional element access",
			skipsCall: isCalleeOfCall(node) && isResultDiscarded(node),
		};
	}
	if (ts.isCallExpression(node) && node.questionDotToken) {
		return {
			subject: normalise(node.expression.getText()),
			kind: "optional call",
			skipsCall: isResultDiscarded(node),
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

type Offence = {
	file: string;
	line: number;
	column: number;
	kind: string;
	subject: string;
	matcher: string;
	guardLine: number;
	skipsCall: boolean;
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
		const scopes: Guard[][] = [];

		const visit = (node: ts.Node): void => {
			const opensScope =
				ts.isBlock(node) ||
				ts.isSourceFile(node) ||
				ts.isModuleBlock(node) ||
				ts.isCaseClause(node) ||
				ts.isDefaultClause(node);
			if (opensScope) scopes.push([]);

			const guard = guardSubject(node);
			if (guard) {
				guardsFound++;
				const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
				const current = scopes[scopes.length - 1];
				if (current) {
					current.push({
						subject: guard.subject,
						end: node.getEnd(),
						matcher: guard.matcher,
						line: line + 1,
					});
				}
			}

			const optional = optionalSubject(node);
			if (optional) {
				optionalChainsExamined++;
				// Search innermost scope outwards. The guard must END before this node
				// STARTS, which is what makes `expect(x).not.toBeNull()` inside the very
				// expression being checked unable to license itself.
				const start = node.getStart();
				let matched: Guard | undefined;
				for (let i = scopes.length - 1; i >= 0 && !matched; i--) {
					const scope = scopes[i];
					if (!scope) continue;
					for (const g of scope) {
						if (g.subject === optional.subject && g.end <= start) {
							matched = g;
							break;
						}
					}
				}
				if (matched) {
					const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
					const found: Offence = {
						file: path.relative(repoRoot, fileName),
						line: line + 1,
						column: character + 1,
						kind: optional.kind,
						subject: optional.subject,
						matcher: matched.matcher,
						guardLine: matched.line,
						skipsCall: optional.skipsCall,
						text: node.getText().replace(/\s+/g, " ").slice(0, 100),
					};
					surveyed.push(found);
					if (!SKIPPED_CALL_ONLY || found.skipsCall) offences.push(found);
				}
			}

			ts.forEachChild(node, visit);
			if (opensScope) scopes.pop();
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
		`check-optional-chain-silent-skip: typescript ${ts.version}, ${filesScanned} test files scanned, ${optionalChainsExamined} optional chains examined, ${guardsFound} presence assertions found, ${surveyed.length} guarded optional chains, ${offences.length} offences`,
	);
}

// The three counts are not equally meaningful at every scope, and conflating them made the
// gate exit 2 on a perfectly valid single-directory run. A fixture with one file and no
// `expect` legitimately has no presence assertion and no optional chain; the REPOSITORY does
// not, and it is the repository run whose zero has to be trustworthy.
//
// So the strong invariant applies to the whole-tree invocation, which is the one CI makes,
// and an explicit-root run only has to have found a file to parse.
const scanningWholeRepo = roots.length === 0;
const scannedNothing = scanningWholeRepo
	? filesScanned === 0 || optionalChainsExamined === 0 || guardsFound === 0
	: filesScanned === 0;

if (scannedNothing) {
	console.error(
		`check-optional-chain-silent-skip: scanned nothing (${filesScanned} files, ${optionalChainsExamined} optional chains, ${guardsFound} presence assertions), so this run is not evidence of a clean tree`,
	);
	process.exit(2);
}

// `--survey` reports the wider guarded-optional-chain population that the SKIPPED_CALL_ONLY
// narrowing leaves out, and exits 0 whatever it finds. It is a measurement, never a gate:
// giving it a failing exit code would make the narrowing pointless.
if (survey) {
	const byFile = new Map<string, number>();
	for (const o of surveyed) byFile.set(o.file, (byFile.get(o.file) ?? 0) + 1);
	if (!asJson) {
		for (const [file, count] of [...byFile].sort((a, b) => b[1] - a[1])) {
			console.log(`  ${String(count).padStart(4)}  ${file}`);
		}
		const skipsCall = surveyed.filter((o) => o.skipsCall).length;
		console.log(
			`survey: ${surveyed.length} guarded optional chains in ${byFile.size} files, ${skipsCall} of which skip a call`,
		);
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
