#!/usr/bin/env bun
/**
 * Rejects a call result that can never be falsy from being used in a boolean context.
 *
 * SB23-2375. PR #190 widened `Config.entryIsTrusted()` from `boolean` to the string union
 * `"trusted" | RefusedTrust` so callers could report which predicate refused. One caller kept
 * `if (this.entryIsTrusted(path))`. Every reason string is truthy, so `replaceUntrustedLink()`
 * stopped replacing an untrusted link and the refusal path PR #176 shipped was inert.
 * TypeScript accepts a non-boolean in a boolean context, so `bun run typecheck` was clean and
 * the focused suite for the changed file was green with the defect present.
 *
 * WHAT THIS CATCHES, precisely, and nothing wider:
 *   a CALL result (or an awaited call result) whose type has NO falsy member, used as the
 *   condition of `if` / `while` / `do` / `for`, the test of a ternary, or the operand of
 *   `!`, INCLUDING every operand of the `&&` / `||` tree under one of those roots, and the
 *   left operand of a `&&` / `||` appearing anywhere else.
 *
 * WHAT IT DOES NOT CATCH, stated so nobody reads it as strict-boolean-expressions:
 *   - `boolean` widened to `string`, `number`, or any union carrying a falsy member
 *     (`"a" | null`, `"a" | ""`, `number`). Those can be false, so the call site still has
 *     two outcomes and is not unconditionally broken.
 *   - the right operand of a `&&` / `||` that is NOT under a condition root, because there
 *     it produces the value rather than being tested. `return f() && g()` returns g()'s
 *     result and is silent by design; `if (f() && g())` tests it and is reported. That
 *     distinction is why the fix for SB23-2450 descends from condition roots rather than
 *     adding `check(node.right)` to the logical-operator dispatch, which false-positives
 *     on every value-producing `&&` in the tree.
 *   - `??`, the comma operator, and a ternary's `whenTrue` / `whenFalse` branches under a
 *     condition root. None of those positions is truthy-tested, so descending into them
 *     would report values rather than conditions.
 *   - a user-declared `Object` that merges with the global interface. The global `Object`
 *     accepts every non-nullish primitive by assignability rather than by structure, so it
 *     cannot be recognised structurally and is matched by symbol name plus at least one
 *     declaration in a `.d.ts`. A global augmentation of `Object` in a project's own
 *     ambient file therefore stays silent even if it adds members.
 *   - an always-truthy value reached through an identifier or a property rather than a call:
 *     `while (true)`, `!process.env`, `if (map[key])` under `noUncheckedIndexedAccess: false`.
 *     Measured 2026-09-21: 109 such sites in 72 files, nearly all correct as written.
 *   - the general strict-boolean-expressions class. Measured the same day: 3836 sites in
 *     333 files, which is why the blanket rule was not shippable and this narrow one was.
 *
 * WHY A SCRIPT AND NOT A LINT RULE: biome 2.4.10 has no type-aware boolean rule, and there is
 * no eslint in this tree, so `typescript-eslint`'s strict-boolean family cannot run here
 * without adding a linter. This needs the type checker, so it runs on the TypeScript API.
 *
 * WHY NOT A DISCRIMINATED UNION ON THE RETURN TYPE INSTEAD: probed 2026-09-21 with `tsc`
 * against `declare function f(): { ok: true } | { ok: false; reason: string }; if (f()) {}`.
 * Zero diagnostics, exit 0. TypeScript refuses truthiness only for `void` (TS1345),
 * functions (TS2774) and Promises (TS2801). An object union truthy-tests exactly as silently
 * as a string union, so that route does not make the mistake unrepresentable.
 *
 * Usage: bun run scripts/check-boolean-widening.ts [tsconfig path]
 * Exit 0 clean, 1 offences found, 2 the check could not run (which is never a pass).
 */
import * as path from "node:path";
import ts from "typescript";

const repoRoot = path.resolve(import.meta.dir, "..");
const tsconfigPath = path.resolve(process.argv[2] ?? path.join(repoRoot, "tsconfig.json"));
const projectRoot = path.dirname(tsconfigPath);

const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
if (configFile.error) {
	console.error(
		`check-boolean-widening: could not read ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, " ")}`,
	);
	process.exit(2);
}
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, projectRoot);
if (parsed.errors.length > 0) {
	for (const e of parsed.errors) {
		console.error(
			`check-boolean-widening: ${ts.flattenDiagnosticMessageText(e.messageText, " ")}`,
		);
	}
	process.exit(2);
}

const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();

/**
 * The global `Object` interface, the one from `lib.es5.d.ts`. It accepts every non-nullish
 * primitive by assignability rather than by structure, so `if (f())` where f returns `Object`
 * genuinely can be false and must not be reported. Structure cannot tell it apart: it has
 * seven members, which is exactly what an always-truthy object type looks like.
 *
 * Matched by symbol name plus at least one declaration in a `.d.ts`, not by
 * `checker.typeToString(type) === "Object"`, which was the shipped test and is the same
 * rendered-name instrument SB23-2451 removed from the empty-object branch. Measured
 * 2026-09-21: a module-scoped `interface Object { localOnly: 1 }` renders as `Object`, so the
 * rendered-name test silenced a genuinely always-truthy call result. Its symbol has no
 * declaration in a declaration file, so this one reports it.
 *
 * `.some` rather than `.every` on purpose. A project that augments the global `Object` in its
 * own ambient file gives that symbol declarations in both a `.d.ts` and its own file, and the
 * augmented type still accepts primitives, so it must stay silent.
 */
function isGlobalObjectInterface(type: ts.Type): boolean {
	const symbol = type.getSymbol();
	if (symbol?.name !== "Object") return false;
	const declarations = symbol.getDeclarations();
	if (declarations === undefined) return false;
	return declarations.some((d) => d.getSourceFile().isDeclarationFile);
}

/**
 * True when the type declares nothing at all, which is `{}` however it is spelled. `{}` accepts
 * every non-nullish primitive, so a call returning one can be false and must not be reported.
 *
 * Structural, because an empty object type IS structural and the shipped test compared the
 * RENDERED name against `"{}"`. Measured 2026-09-21 against the gate at `0c0ed042`: `interface
 * Empty {}` renders as `Empty` and a type alias `type AliasEmpty = {}` renders as `AliasEmpty`,
 * so both were reported, and `export const x: Empty = 0` compiles under `tsc --strict`. A false
 * positive here fails a required check on correct code.
 *
 * Construct signatures are counted alongside call signatures because `interface Ctor { new (): X }`
 * has zero properties, zero index infos and zero CALL signatures. Without this clause it reads as
 * empty and the gate goes silent on an always-truthy call result, which is the failure direction
 * that matters. Measured, not reasoned: the shipped gate reports `Ctor` and this must keep doing so.
 */
function isStructurallyEmpty(type: ts.Type): boolean {
	return (
		checker.getPropertiesOfType(type).length === 0 &&
		checker.getIndexInfosOfType(type).length === 0 &&
		checker.getSignaturesOfType(type, ts.SignatureKind.Call).length === 0 &&
		checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length === 0
	);
}

/**
 * True when this single (non-union) type has a falsy inhabitant. `any` and `unknown` count as
 * falsy-capable so the check stays silent rather than guessing, and a type parameter is
 * unknowable here so it counts too. Object types, including arrays and functions, are the only
 * things that are always truthy, along with a non-empty string literal and a non-zero number.
 */
function partHasFalsyValue(type: ts.Type): boolean {
	// An intersection is falsy-capable only when every constituent is, and
	// `TypeFlags.Intersection` is not `TypeFlags.Object`, so without this branch
	// `{ a: 1 } & { b: 2 }` falls through to the conservative `return true` at the
	// end and the gate goes SILENT on an always-truthy call result. That is the
	// direction that matters: it reads green over the defect class it exists to
	// catch. Found by probing the gate rather than by reading it.
	if (type.isIntersection()) return type.types.every(partHasFalsyValue);
	const f = type.flags;
	if (
		f &
		(ts.TypeFlags.Any |
			ts.TypeFlags.Unknown |
			ts.TypeFlags.Null |
			ts.TypeFlags.Undefined |
			ts.TypeFlags.Void |
			ts.TypeFlags.Never |
			ts.TypeFlags.TypeParameter)
	) {
		return true;
	}
	// Identity against the checker's own `false` type, not `typeToString(type) === "false"`.
	// The rendered form was the shipped test and no test pinned it: mutating the string to
	// `"true"` survived the whole suite. Measured 2026-09-21 that this identity holds through
	// a type alias as well, so `type F = false` is still recognised as falsy-capable.
	if (f & ts.TypeFlags.BooleanLiteral) {
		return type === checker.getFalseType();
	}
	if (f & ts.TypeFlags.StringLiteral) return (type as ts.StringLiteralType).value === "";
	if (f & ts.TypeFlags.NumberLiteral) return (type as ts.NumberLiteralType).value === 0;
	if (f & (ts.TypeFlags.Boolean | ts.TypeFlags.String | ts.TypeFlags.Number)) return true;
	if (f & (ts.TypeFlags.BigInt | ts.TypeFlags.BigIntLiteral | ts.TypeFlags.EnumLike)) return true;
	// Lowercase `object` carries `TypeFlags.NonPrimitive`, which is a different bit from
	// `TypeFlags.Object`, so before this branch it matched nothing and fell to the
	// conservative `return true` at the end. It is always truthy, so that was a FALSE
	// NEGATIVE: the gate read green over a condition that can never be false. It is also
	// structurally empty (zero properties, zero index infos, zero signatures), so it has to
	// be decided before the empty-object test below, which would otherwise call it falsy.
	if (f & ts.TypeFlags.NonPrimitive) return false;
	if (f & ts.TypeFlags.Object) {
		// `{}` and the global `Object` interface carry `TypeFlags.Object` but accept every
		// non-nullish primitive, so `if (f())` where f returns `{}` genuinely can be
		// false and reporting it fails the build on a correct condition. Every other
		// object type, including arrays, functions and class instances, is always
		// truthy.
		if (isGlobalObjectInterface(type)) return true;
		return isStructurallyEmpty(type);
	}
	return true;
}

function alwaysTruthy(type: ts.Type): boolean {
	const parts = type.isUnion() ? type.types : [type];
	return parts.every((part) => !partHasFalsyValue(part));
}

/** Unwraps parentheses and `!` assertions to ask whether the value came out of a call. */
function isCallResult(expr: ts.Expression): boolean {
	let inner: ts.Expression = expr;
	// A cast has to be unwrapped, and it is the case that matters most: a cast is
	// exactly what an author reaches for when a return type has just been widened and
	// something downstream complains, so `if (f() as EntryTrust)` is the same defect
	// with the author's own workaround in front of it. Found by the reviewer at
	// 3c71d5d2; before this, all three assertion forms walked off the end of the loop
	// and the gate was silent on them.
	while (
		ts.isParenthesizedExpression(inner) ||
		ts.isNonNullExpression(inner) ||
		ts.isAsExpression(inner) ||
		ts.isTypeAssertionExpression(inner) ||
		ts.isSatisfiesExpression(inner)
	) {
		inner = inner.expression;
	}
	if (ts.isAwaitExpression(inner)) return isCallResult(inner.expression);
	// `new C()` is always truthy by construction and a tagged template is a call in
	// everything but node kind. Neither is a `CallExpression`.
	return (
		ts.isCallExpression(inner) ||
		ts.isNewExpression(inner) ||
		ts.isTaggedTemplateExpression(inner)
	);
}

type Offence = { file: string; line: number; column: number; context: string; type: string; text: string };
const offences: Offence[] = [];
let contextsExamined = 0;
let filesScanned = 0;

/**
 * Every expression already reported on, so a node reached by two routes is counted and reported
 * once. A condition root descends through its `&&` / `||` tree, and the visitor separately
 * dispatches on every `&&`, `||` and `!` it walks past, so `if (f() && g())` reaches `f()` twice
 * and `if (!f())` reaches `f()` twice. Without this the left operand of a guarded condition is
 * reported on two lines of identical output.
 */
const visited = new Set<ts.Node>();

/** Parentheses are not a boolean context of their own, so both routes must key on the same node. */
function unwrapParens(expr: ts.Expression): ts.Expression {
	let inner: ts.Expression = expr;
	while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
	return inner;
}

/**
 * Walks the boolean-context tree beneath a CONDITION root and checks every operand of it.
 *
 * SB23-2450. `if (isSymlink(p) && entryIsTrusted(p))` truthy-tests both operands, and before
 * this the gate visited only `node.left`, so the SB23-2375 defect with a single guard in front
 * of it was missed. `replaceUntrustedLink()`, the method the whole of SB23-2375 is about,
 * already sits behind `if (uid === undefined || link.uid === uid) return false;`, so the guarded
 * spelling is the likely one rather than an exotic one.
 *
 * This deliberately starts only at condition roots. Adding `check(node.right)` to the
 * logical-operator dispatch instead would report `return f() && g()`, where `g()`'s result is
 * the function's return value and is never tested.
 */
function descend(expr: ts.Expression, context: string): void {
	const inner = unwrapParens(expr);
	if (ts.isPrefixUnaryExpression(inner) && inner.operator === ts.SyntaxKind.ExclamationToken) {
		descend(inner.operand, "negation");
		return;
	}
	if (ts.isBinaryExpression(inner)) {
		const kind = inner.operatorToken.kind;
		if (kind === ts.SyntaxKind.AmpersandAmpersandToken) {
			descend(inner.left, "&&");
			descend(inner.right, "&&");
			return;
		}
		if (kind === ts.SyntaxKind.BarBarToken) {
			descend(inner.left, "||");
			descend(inner.right, "||");
			return;
		}
	}
	check(inner, context);
}

function check(rawExpr: ts.Expression, context: string): void {
	const expr = unwrapParens(rawExpr);
	if (visited.has(expr)) return;
	visited.add(expr);
	contextsExamined++;
	if (!isCallResult(expr)) return;
	const type = checker.getTypeAtLocation(expr);
	if (!alwaysTruthy(type)) return;
	const sourceFile = expr.getSourceFile();
	const { line, character } = sourceFile.getLineAndCharacterOfPosition(expr.getStart());
	offences.push({
		file: path.relative(projectRoot, sourceFile.fileName),
		line: line + 1,
		column: character + 1,
		context,
		type: checker.typeToString(type),
		text: expr.getText().replace(/\s+/g, " ").slice(0, 100),
	});
}

for (const sourceFile of program.getSourceFiles()) {
	if (sourceFile.isDeclarationFile) continue;
	if (sourceFile.fileName.includes("/node_modules/")) continue;
	if (!sourceFile.fileName.startsWith(projectRoot)) continue;
	filesScanned++;
	const visit = (node: ts.Node): void => {
		if (ts.isIfStatement(node)) descend(node.expression, "if");
		else if (ts.isWhileStatement(node)) descend(node.expression, "while");
		else if (ts.isDoStatement(node)) descend(node.expression, "do-while");
		else if (ts.isForStatement(node) && node.condition) descend(node.condition, "for");
		else if (ts.isConditionalExpression(node)) descend(node.condition, "ternary");
		else if (
			ts.isPrefixUnaryExpression(node) &&
			node.operator === ts.SyntaxKind.ExclamationToken
		) {
			descend(node.operand, "negation");
		} else if (ts.isBinaryExpression(node)) {
			// The LEFT operand only, and only here. A `&&` or `||` outside any condition
			// still truthy-tests its left operand (`const v = f() && g()`), but its right
			// operand produces the value, so descending here would report every
			// value-producing `&&` in the tree. A logical operator that IS under a
			// condition root has already had both operands descended, and `visited`
			// absorbs this second visit rather than reporting the left operand twice.
			if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) check(node.left, "&&");
			else if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken) check(node.left, "||");
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
}

// A gate that never reads a file reports zero offences forever, which is indistinguishable
// from a clean tree. Both counts are printed so the record says the program ran, and a run
// that scanned nothing exits 2 rather than passing.
console.log(
	`check-boolean-widening: typescript ${ts.version}, ${filesScanned} files scanned, ${contextsExamined} boolean contexts examined, ${offences.length} offences`,
);
if (filesScanned === 0 || contextsExamined === 0) {
	console.error(
		"check-boolean-widening: scanned nothing, so this run is not evidence of a clean tree",
	);
	process.exit(2);
}

if (offences.length > 0) {
	console.error("");
	for (const o of offences) {
		console.error(
			`${o.file}:${o.line}:${o.column}  a call returning ${o.type} can never be falsy, so this ${o.context} condition is always true:  ${o.text}`,
		);
	}
	console.error("");
	console.error(
		"Compare the result against the value you mean, for example `=== \"trusted\"`, rather than testing it for truthiness.",
	);
	process.exit(1);
}
