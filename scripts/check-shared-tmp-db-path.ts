#!/usr/bin/env bun
/**
 * Rejects a test database path that is fixed and sits under a temp directory every checkout
 * shares.
 *
 * SB23-3844, following SB23-2480. `$TMPDIR` is per USER, not per checkout, so
 * `${process.env.TMPDIR || "/tmp"}/test-x.db` names the same file for every worktree's suite
 * running at the same moment. Two suites then open, truncate, checkpoint and unlink one
 * SQLite file under each other, which produced `SQLITE_IOERR_VNODE` in close and checkpoint
 * teardown and a test program that shrank between two runs at one head (SB23-2480). PR #290
 * fixed all 28 such paths by appending `${process.pid}`. Nothing stopped the 29th, and the
 * failure it causes reads as a load flake in somebody else's lane, so it is gated here.
 *
 * WHAT THIS CATCHES. In a `*.test.ts` or `*.test.tsx` file, any expression that builds a path
 * where all three hold:
 *   1. it is ROOTED at a shared temp root: `process.env.TMPDIR` or `Bun.env.TMPDIR` (alone or
 *      as the left of `||` / `??`), `tmpdir()`, `os.tmpdir()`, or a literal `/tmp`,
 *      `/var/tmp` or `/private/tmp`. The root may lead a template literal, a string literal,
 *      a `+` concatenation, or be the first argument of `join` / `path.join` / `resolve` /
 *      `path.resolve`;
 *   2. it names a database: the final component ends in `.db`, `.sqlite` or `.sqlite3`;
 *   3. NOTHING after the root varies. Every later component is a string literal, a
 *      no-substitution template, or an identifier declared exactly once in the file, by a
 *      `const` whose initializer is itself fixed (recursively, so a fixed directory under
 *      the root holding a fixed file is caught, as is `join(tmpdir(), NAME)` with
 *      `const NAME = "x.db"`). Anything else varies and passes: `process.pid`,
 *      `randomUUID()`, `randomBytes(...)`, `Date.now()`, a `let`, a parameter, any call,
 *      `mkdtempSync(...)`.
 * Because every expression in the file is examined, the inline form is caught too: a path
 * built inside `DatabaseFactory.initialize(...)` or `new DatabaseOperations(...)` with no
 * named constant.
 *
 * ONE REPORT PER PATH. A path is reported where it is first formed. A `const` whose
 * initializer is a fixed temp database path is reported at the initializer, and a later
 * expression that reaches the same path through that `const` is not reported again. A
 * fixed directory constant is not itself a database path, so a file joined onto it is
 * reported at the join.
 *
 * MEASURED BASELINE, 2026-10-01 at b9446617 before the fix in the same change: 497 test
 * files scanned, 353 shared-tmp path expressions, 47 of them database paths, 6 offences,
 * all in `packages/proxy/src/__tests__/integrity-scheduler.test.ts` (five `"/tmp/test.db"`
 * arguments to a mock `makeDbOps` and the `toBe` asserting the mock received it). That
 * mock never opens a file, so those became a non-temp sentinel rather than a pid-suffixed
 * path. The other 41 database paths already vary, through `${process.pid}`, a random
 * suffix or `Date.now()` from PR #290 and earlier, and stay counted on the summary line.
 *
 * NEVER CARVE OUT "it does not reach the filesystem". A gate exempting paths by what the
 * test does with them needs flow analysis to decide it and is wrong the day the mock is
 * swapped for a real database. A path that is never opened can always be a non-temp
 * sentinel such as `/nonexistent/x.db`, which costs nothing and says what it is.
 *
 * WHAT IT DOES NOT CATCH, so nobody reads a clean run as more than it is:
 *   - a root it does not recognise. `realpathSync(tmpdir())` is a call and therefore
 *     varying; it appears once in this tree, as a home directory and not a database. So do
 *     `process.env.TMP`, `process.env.TEMP`, `os.tmpdir` reached through `require`, and a
 *     temp root held in a `let` or a parameter.
 *   - a file name held in a `let`, a parameter, a property (`cfg.dbName`) or a `const`
 *     declared more than once in the file. A name declared twice is treated as varying
 *     rather than resolved by scope, which errs toward silence.
 *   - a database whose name lacks one of the three extensions, such as `test-db` or
 *     `state.bin`. The `-wal` and `-shm` siblings are not reported separately, because
 *     their base path is.
 *   - non-test files. A helper module building a fixed path for tests is not scanned; the
 *     test that calls it is, but the path is not visible there.
 *   - two processes in ONE checkout sharing a pid-suffixed path. Pids do not collide among
 *     live processes, which is the whole argument for `${process.pid}`.
 *
 * WHY SYNTACTIC AND NOT TYPE-AWARE: every input is a string; the defect is which pieces of
 * the string are literals, which is a fact about the source text. `ts.createSourceFile` per
 * file is enough and is an order of magnitude faster than building a program.
 *
 * Usage: bun run scripts/check-shared-tmp-db-path.ts [root ...]
 * Exit 0 clean, 1 offences found, 2 the check could not run (which is never a pass).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const repoRoot = path.resolve(import.meta.dir, "..");

const roots = process.argv.slice(2).filter((a: string) => !a.startsWith("--"));
// The root `__tests__` directory is included because `__tests__/api-auth.test.ts` was one of
// PR #290's 28 instances; a walker over packages, apps and scripts alone could not see it.
const searchRoots = roots.length > 0 ? roots : ["packages", "apps", "scripts", "__tests__"];

/**
 * Which invariant applies, decided once and PRINTED, so that switching the strict one off is
 * visible in the output. PR #226's reviewer set the silent-skip gate's equivalent to a
 * constant and the whole suite stayed green, because every fixture runs the scoped branch.
 */
const scanningWholeRepo = roots.length === 0;
const scanMode = scanningWholeRepo ? "whole-tree" : "scoped";

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

/** A literal that IS a shared temp root, with or without a trailing slash. */
const TMP_ROOT_LITERALS = new Set(["/tmp", "/var/tmp", "/private/tmp", "/tmp/", "/var/tmp/", "/private/tmp/"]);
/** A literal path that starts under a shared temp root. */
const TMP_ROOT_PREFIX = /^\/(?:private\/|var\/)?tmp\//;
const DB_EXTENSION = /\.(?:db|sqlite3?)$/i;
/** Stands in for a piece whose value is unknown, so a later literal still has a position. */
const UNKNOWN_PIECE = "\u0000";

/**
 * The abstract value of an expression.
 *   - root: a shared temp root and nothing after it yet.
 *   - str:  a string; `fixed` when every piece is known.
 *   - tmp:  a path under a shared temp root; `text` is everything after the root.
 *   - unknown: anything else.
 * `viaDbConst` marks a value that reached a fixed temp database path through a `const`
 * already reported at its initializer, so the use is not reported a second time.
 */
type Value =
	| { k: "root" }
	| { k: "str"; fixed: boolean; text: string }
	| { k: "tmp"; fixed: boolean; text: string; viaDbConst: boolean }
	| { k: "unknown" };

const UNKNOWN: Value = { k: "unknown" };

function isReportable(v: Value): boolean {
	return v.k === "tmp" && v.fixed && DB_EXTENSION.test(v.text) && !v.viaDbConst;
}

/** Promotes a string that is, or starts under, a shared temp root. */
function norm(v: Value): Value {
	if (v.k !== "str") return v;
	if (v.fixed && TMP_ROOT_LITERALS.has(v.text)) return { k: "root" };
	if (TMP_ROOT_PREFIX.test(v.text)) return { k: "tmp", fixed: v.fixed, text: v.text, viaDbConst: false };
	return v;
}

/** A value used as a piece of a larger string. */
function asPiece(v: Value): { fixed: boolean; text: string; viaDbConst: boolean } {
	if (v.k === "str") return { fixed: v.fixed, text: v.text, viaDbConst: false };
	if (v.k === "tmp") return { fixed: false, text: v.text, viaDbConst: v.viaDbConst };
	return { fixed: false, text: UNKNOWN_PIECE, viaDbConst: false };
}

function concat(a: Value, b: Value): Value {
	if (a.k === "root") {
		if (b.k === "root") return { k: "tmp", fixed: true, text: "", viaDbConst: false };
		const p = asPiece(b);
		return { k: "tmp", fixed: p.fixed, text: p.text, viaDbConst: p.viaDbConst };
	}
	if (a.k === "tmp") {
		const p = b.k === "root" ? { fixed: false, text: UNKNOWN_PIECE, viaDbConst: false } : asPiece(b);
		return { k: "tmp", fixed: a.fixed && p.fixed, text: a.text + p.text, viaDbConst: a.viaDbConst || p.viaDbConst };
	}
	// An empty fixed prefix is the head of `${root}/...`, so it passes the next value through.
	if (a.k === "str" && a.fixed && a.text === "") return b;
	const left = asPiece(a);
	const right = b.k === "root" ? { fixed: false, text: UNKNOWN_PIECE } : asPiece(b);
	return norm({ k: "str", fixed: left.fixed && right.fixed, text: left.text + right.text });
}

/** Strips wrappers that do not change a value. */
function unwrap(node: ts.Expression): ts.Expression {
	let n = node;
	while (
		ts.isParenthesizedExpression(n) ||
		ts.isAsExpression(n) ||
		ts.isNonNullExpression(n) ||
		ts.isSatisfiesExpression(n) ||
		ts.isTypeAssertionExpression(n)
	) {
		n = n.expression;
	}
	return n;
}

function isEnvTmpdir(node: ts.Expression): boolean {
	// `process.env.TMPDIR`, `process.env["TMPDIR"]`, `Bun.env.TMPDIR`.
	let obj: ts.Expression;
	let name: string;
	if (ts.isPropertyAccessExpression(node)) {
		obj = unwrap(node.expression);
		name = node.name.text;
	} else if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
		obj = unwrap(node.expression);
		name = node.argumentExpression.text;
	} else {
		return false;
	}
	if (name !== "TMPDIR" || !ts.isPropertyAccessExpression(obj) || obj.name.text !== "env") return false;
	const base = unwrap(obj.expression);
	return ts.isIdentifier(base) && (base.text === "process" || base.text === "Bun");
}

/** `tmpdir()` or `<anything>.tmpdir()`, with no arguments. */
function isTmpdirCall(node: ts.CallExpression): boolean {
	const callee = unwrap(node.expression);
	if (ts.isIdentifier(callee)) return callee.text === "tmpdir";
	return ts.isPropertyAccessExpression(callee) && callee.name.text === "tmpdir";
}

/** `join`, `resolve`, `path.join`, `path.resolve`, or any `<identifier>.join/resolve`. */
function isPathJoinCall(node: ts.CallExpression): boolean {
	const callee = unwrap(node.expression);
	if (ts.isIdentifier(callee)) return callee.text === "join" || callee.text === "resolve";
	return (
		ts.isPropertyAccessExpression(callee) &&
		ts.isIdentifier(unwrap(callee.expression)) &&
		(callee.name.text === "join" || callee.name.text === "resolve")
	);
}

class FileEvaluator {
	/** Names declared exactly once in the file by a `const` with an initializer. */
	private readonly constInit = new Map<string, ts.Expression>();
	private readonly resolving = new Set<string>();

	constructor(sourceFile: ts.SourceFile) {
		const declared = new Map<string, number>();
		const bump = (name: string) => declared.set(name, (declared.get(name) ?? 0) + 1);
		const bindNames = (b: ts.BindingName) => {
			if (ts.isIdentifier(b)) bump(b.text);
			else for (const el of b.elements) if (!ts.isOmittedExpression(el)) bindNames(el.name);
		};
		const constCandidates = new Map<string, ts.Expression>();
		const visit = (node: ts.Node): void => {
			if (ts.isVariableDeclaration(node)) {
				bindNames(node.name);
				const list = node.parent;
				const isConst =
					ts.isVariableDeclarationList(list) &&
					(list.flags & ts.NodeFlags.Const) !== 0 &&
					// A `for (const x of ...)` binding takes a new value every iteration.
					!(ts.isForOfStatement(list.parent) || ts.isForInStatement(list.parent));
				if (isConst && ts.isIdentifier(node.name) && node.initializer) {
					constCandidates.set(node.name.text, node.initializer);
				}
			} else if (ts.isParameter(node)) {
				bindNames(node.name);
			} else if (
				(ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionExpression(node)) &&
				node.name
			) {
				bump(node.name.text);
			} else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isImportClause(node)) {
				if (node.name) bump(node.name.text);
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
		for (const [name, init] of constCandidates) {
			if (declared.get(name) === 1) this.constInit.set(name, init);
		}
	}

	evaluate(expr: ts.Expression): Value {
		const node = unwrap(expr);

		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
			return norm({ k: "str", fixed: true, text: node.text });
		}

		if (ts.isTemplateExpression(node)) {
			let acc: Value = norm({ k: "str", fixed: true, text: node.head.text });
			for (const span of node.templateSpans) {
				acc = concat(acc, this.evaluate(span.expression));
				acc = concat(acc, { k: "str", fixed: true, text: span.literal.text });
			}
			return acc;
		}

		if (ts.isBinaryExpression(node)) {
			const op = node.operatorToken.kind;
			if (op === ts.SyntaxKind.PlusToken) {
				return concat(this.evaluate(node.left), this.evaluate(node.right));
			}
			if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
				// `process.env.TMPDIR || "/tmp"` is a root whatever the fallback, because the
				// left side is set on every macOS login, which is where this collision happens.
				const left = this.evaluate(node.left);
				return left.k === "root" ? left : UNKNOWN;
			}
			return UNKNOWN;
		}

		if (isEnvTmpdir(node)) return { k: "root" };

		if (ts.isCallExpression(node)) {
			if (isTmpdirCall(node) && node.arguments.length === 0) return { k: "root" };
			if (isPathJoinCall(node) && node.arguments.length > 0) {
				const first = this.evaluate(node.arguments[0]);
				let acc: Value;
				if (first.k === "root") acc = { k: "tmp", fixed: true, text: "", viaDbConst: false };
				else if (first.k === "tmp") acc = first;
				else return UNKNOWN;
				for (const arg of node.arguments.slice(1)) {
					const piece = asPiece(ts.isSpreadElement(arg) ? UNKNOWN : this.evaluate(arg));
					if (acc.k !== "tmp") return UNKNOWN;
					acc = {
						k: "tmp",
						fixed: acc.fixed && piece.fixed,
						text: `${acc.text}/${piece.text}`,
						viaDbConst: acc.viaDbConst || piece.viaDbConst,
					};
				}
				return acc;
			}
			return UNKNOWN;
		}

		if (ts.isIdentifier(node)) {
			const init = this.constInit.get(node.text);
			if (!init || this.resolving.has(node.text)) return UNKNOWN;
			this.resolving.add(node.text);
			try {
				const v = this.evaluate(init);
				// Reported at the const's initializer, so a use of it is not a second report.
				if (isReportable(v) && v.k === "tmp") return { ...v, viaDbConst: true };
				return v;
			} finally {
				this.resolving.delete(node.text);
			}
		}

		return UNKNOWN;
	}
}

/** Expressions that can form a path. Identifiers are not: a path is formed where it is built. */
function isCandidate(node: ts.Node): node is ts.Expression {
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
		// An import specifier or a property name is not a value.
		const parent = node.parent;
		if (parent && (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent))) return false;
		if (parent && ts.isPropertyAssignment(parent) && parent.name === node) return false;
		return true;
	}
	if (ts.isBinaryExpression(node)) return node.operatorToken.kind === ts.SyntaxKind.PlusToken;
	if (ts.isCallExpression(node)) return isPathJoinCall(node);
	return false;
}

/** Nodes that pass a value straight through to their parent candidate. */
function isTransparent(node: ts.Node): boolean {
	return (
		ts.isTemplateSpan(node) ||
		ts.isParenthesizedExpression(node) ||
		ts.isAsExpression(node) ||
		ts.isNonNullExpression(node) ||
		ts.isSatisfiesExpression(node) ||
		ts.isTypeAssertionExpression(node)
	);
}

type Offence = { file: string; line: number; column: number; text: string };

const offences: Offence[] = [];
let filesScanned = 0;
let tmpPathsExamined = 0;
let tmpDbPathsExamined = 0;

try {
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
			const evaluator = new FileEvaluator(sourceFile);

			// `insideTmpPath` is true while visiting the operands of a path already counted, so
			// `join(tmpdir(), "x")` inside `` `${join(tmpdir(), "x")}/y.db` `` is one path, not two.
			const visit = (node: ts.Node, insideTmpPath: boolean): void => {
				let childInside = insideTmpPath && isTransparent(node);
				if (isCandidate(node)) {
					const v = evaluator.evaluate(node);
					if (v.k === "tmp") {
						if (!insideTmpPath) {
							tmpPathsExamined++;
							if (DB_EXTENSION.test(v.text)) tmpDbPathsExamined++;
							if (isReportable(v)) {
								const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
								offences.push({
									file: path.relative(repoRoot, fileName),
									line: line + 1,
									column: character + 1,
									text: node.getText(sourceFile).replace(/\s+/g, " "),
								});
							}
						}
						childInside = true;
					} else {
						childInside = insideTmpPath;
					}
				}
				ts.forEachChild(node, (child) => visit(child, childInside));
			};
			visit(sourceFile, false);
		}
	}
} catch (error) {
	console.error(`check-shared-tmp-db-path: could not run: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(2);
}

console.log(
	`check-shared-tmp-db-path: typescript ${ts.version}, ${scanMode} mode, ${filesScanned} test files scanned, ${tmpPathsExamined} shared-tmp path expressions examined, ${tmpDbPathsExamined} of them database paths, ${offences.length} offences`,
);

/**
 * A floor, not a target, for the same reason as the silent-skip gate's: a walker that lost
 * a whole directory reports zero offences, which reads exactly like a clean tree. 300 is far
 * below the 497 test files measured on 2026-10-01, so a legitimately shrinking tree never
 * trips it; it catches an order-of-magnitude loss. If it fires, ask which directory stopped
 * being scanned, not whether to lower the number.
 *
 * The database-path count must also be non-zero on the whole tree: PR #290 left 28
 * pid-suffixed paths that this gate recognises, so reading none of them means the root or
 * extension recogniser broke, and a broken recogniser reports zero offences forever.
 */
const MIN_TEST_FILES_WHOLE_REPO = 300;

const scannedTooLittle = scanningWholeRepo
	? filesScanned < MIN_TEST_FILES_WHOLE_REPO || tmpDbPathsExamined === 0
	: filesScanned === 0;

if (scannedTooLittle) {
	console.error(
		`check-shared-tmp-db-path: scanned too little (${filesScanned} files, ${tmpDbPathsExamined} shared-tmp database paths${scanningWholeRepo ? `, floor ${MIN_TEST_FILES_WHOLE_REPO} files` : ""}), so this run is not evidence of a clean tree`,
	);
	process.exit(2);
}

if (offences.length > 0) {
	console.error("");
	for (const o of offences) {
		console.error(
			`${o.file}:${o.line}:${o.column}  fixed database path under a shared temp directory, which every worktree's suite opens at once:  ${o.text}`,
		);
	}
	console.error("");
	console.error(
		"Fix: append ${process.pid}, or build the path under mkdtempSync. A path the test never opens can be a non-temp sentinel such as /nonexistent/x.db.",
	);
	process.exit(1);
}
