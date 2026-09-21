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
 *   condition of `if` / `while` / `do` / `for`, the test of a ternary, the operand of `!`,
 *   or the left operand of `&&` / `||`.
 *
 * WHAT IT DOES NOT CATCH, stated so nobody reads it as strict-boolean-expressions:
 *   - `boolean` widened to `string`, `number`, or any union carrying a falsy member
 *     (`"a" | null`, `"a" | ""`, `number`). Those can be false, so the call site still has
 *     two outcomes and is not unconditionally broken.
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
 * True when this single (non-union) type has a falsy inhabitant. `any` and `unknown` count as
 * falsy-capable so the check stays silent rather than guessing, and a type parameter is
 * unknowable here so it counts too. Object types, including arrays and functions, are the only
 * things that are always truthy, along with a non-empty string literal and a non-zero number.
 */
function partHasFalsyValue(type: ts.Type): boolean {
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
	if (f & ts.TypeFlags.BooleanLiteral) {
		return checker.typeToString(type) === "false";
	}
	if (f & ts.TypeFlags.StringLiteral) return (type as ts.StringLiteralType).value === "";
	if (f & ts.TypeFlags.NumberLiteral) return (type as ts.NumberLiteralType).value === 0;
	if (f & (ts.TypeFlags.Boolean | ts.TypeFlags.String | ts.TypeFlags.Number)) return true;
	if (f & (ts.TypeFlags.BigInt | ts.TypeFlags.BigIntLiteral | ts.TypeFlags.EnumLike)) return true;
	if (f & ts.TypeFlags.Object) return false;
	return true;
}

function alwaysTruthy(type: ts.Type): boolean {
	const parts = type.isUnion() ? type.types : [type];
	return parts.every((part) => !partHasFalsyValue(part));
}

/** Unwraps parentheses and `!` assertions to ask whether the value came out of a call. */
function isCallResult(expr: ts.Expression): boolean {
	let inner: ts.Expression = expr;
	while (ts.isParenthesizedExpression(inner) || ts.isNonNullExpression(inner)) {
		inner = inner.expression;
	}
	if (ts.isAwaitExpression(inner)) return isCallResult(inner.expression);
	return ts.isCallExpression(inner);
}

type Offence = { file: string; line: number; column: number; context: string; type: string; text: string };
const offences: Offence[] = [];
let contextsExamined = 0;
let filesScanned = 0;

function check(expr: ts.Expression, context: string): void {
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
		if (ts.isIfStatement(node)) check(node.expression, "if");
		else if (ts.isWhileStatement(node)) check(node.expression, "while");
		else if (ts.isDoStatement(node)) check(node.expression, "do-while");
		else if (ts.isForStatement(node) && node.condition) check(node.condition, "for");
		else if (ts.isConditionalExpression(node)) check(node.condition, "ternary");
		else if (
			ts.isPrefixUnaryExpression(node) &&
			node.operator === ts.SyntaxKind.ExclamationToken
		) {
			check(node.operand, "negation");
		} else if (ts.isBinaryExpression(node)) {
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
