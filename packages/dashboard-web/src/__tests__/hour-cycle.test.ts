/**
 * Every time the dashboard shows a person is on the 24-hour clock (SB23-3521).
 *
 * A formatter left to the locale prints "3:04 PM" for an en-US viewer and
 * "15:04" for an en-GB one, so a page that looked right on one machine is wrong
 * on the next. This walks every non-test source file in the package and fails
 * on:
 *
 *   unpinned             an hour-bearing formatter whose inline options do not
 *                        set `hourCycle: "h23"` after their last spread
 *   options-not-literal  an hour-bearing formatter whose options arrive by
 *                        reference, where the hour cycle cannot be read
 *   hour12               `hour12` anywhere in code; it overrides `hourCycle`
 *                        and `hour12: false` renders midnight as 24 in some
 *                        engines
 *   hour-cycle-not-h23   any `hourCycle` other than the literal "h23"
 *   toggle-key           the retired `ccflare-24h-time` localStorage key
 *   date-fns-pattern     a date-fns `format`/`lightFormat` pattern carrying a
 *                        12-hour (`h`, `K`, `k`), day-period (`a`, `b`, `B`)
 *                        or locale-time (`p`) token, or a pattern that is not
 *                        a literal
 *   date-fns-relative    `formatRelative`, which prints locale time
 *
 * Hour-bearing means `toLocaleTimeString`, `toLocaleString` on anything that is
 * not a number, and `toLocaleDateString` or `Intl.DateTimeFormat` with an
 * `hour`, `timeStyle` or `dayPeriod` option. Whether a `toLocaleString`
 * receiver is a number is read from the TypeScript checker, not from its name:
 * `total.toLocaleString()` on a Date is reported and `when.toLocaleString()` on
 * a number is not. Chart tick formatters are plain functions, so the calls
 * inside them are covered like any other.
 *
 * It replaces #262's scan of RateLimitProgress.tsx alone, which read argument
 * text and could not see a formatter without an `hour:` option.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const PACKAGE_DIR = path.resolve(import.meta.dir, "../..");
const SRC_DIR = path.join(PACKAGE_DIR, "src");
const FIXTURE = path.join(import.meta.dir, "fixtures", "hour-cycle.fixture.ts");

/** A program build costs about 6s unloaded; give it room under a full suite. */
const SCAN_TIMEOUT_MS = 120_000;

interface Offence {
	file: string;
	line: number;
	rule: string;
	text: string;
}

interface ScanResult {
	offences: Offence[];
	/** Hour-bearing formatters that passed, so a scan that stops matching shows. */
	pinned: number;
}

function isTestPath(file: string): boolean {
	return (
		/\.test\.tsx?$/.test(file) || file.split(path.sep).includes("__tests__")
	);
}

let cached: { program: ts.Program; checker: ts.TypeChecker } | undefined;

function program(): { program: ts.Program; checker: ts.TypeChecker } {
	if (cached) return cached;
	const configPath = path.join(PACKAGE_DIR, "tsconfig.json");
	const config = ts.readConfigFile(configPath, ts.sys.readFile);
	if (config.error) throw new Error(`cannot read ${configPath}`);
	const parsed = ts.parseJsonConfigFileContent(
		config.config,
		ts.sys,
		PACKAGE_DIR,
	);
	const roots = parsed.fileNames.filter((f) => !isTestPath(f));
	const built = ts.createProgram([...roots, FIXTURE], parsed.options);
	cached = { program: built, checker: built.getTypeChecker() };
	return cached;
}

function propertyName(node: ts.ObjectLiteralElementLike): string | undefined {
	if (!node.name) return undefined;
	if (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) {
		return node.name.text;
	}
	return undefined;
}

/** `hourCycle: "h23"` with no spread after it that could override it. */
function pinsH23(options: ts.ObjectLiteralExpression): boolean {
	let pinnedAt = -1;
	let lastSpread = -1;
	options.properties.forEach((p, i) => {
		if (ts.isSpreadAssignment(p)) lastSpread = i;
		else if (
			ts.isPropertyAssignment(p) &&
			propertyName(p) === "hourCycle" &&
			ts.isStringLiteralLike(p.initializer) &&
			p.initializer.text === "h23"
		) {
			pinnedAt = i;
		}
	});
	return pinnedAt > lastSpread;
}

/** An `hour`, `timeStyle` or `dayPeriod` option, or a spread that may hold one. */
function asksForHour(options: ts.ObjectLiteralExpression): boolean {
	return options.properties.some(
		(p) =>
			ts.isSpreadAssignment(p) ||
			["hour", "timeStyle", "dayPeriod"].includes(propertyName(p) ?? ""),
	);
}

function isNumeric(checker: ts.TypeChecker, node: ts.Expression): boolean {
	const type = checker.getNonNullableType(checker.getTypeAtLocation(node));
	const parts = type.isUnion() ? type.types : [type];
	return parts.every(
		(t) =>
			(t.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike)) !== 0,
	);
}

function isIntlDateTimeFormat(callee: ts.Expression): boolean {
	return (
		ts.isPropertyAccessExpression(callee) &&
		callee.name.text === "DateTimeFormat" &&
		ts.isIdentifier(callee.expression) &&
		callee.expression.text === "Intl"
	);
}

/** Local names bound to date-fns exports, mapped to the export they name. */
function dateFnsBindings(sf: ts.SourceFile): Map<string, string> {
	const out = new Map<string, string>();
	for (const stmt of sf.statements) {
		if (
			!ts.isImportDeclaration(stmt) ||
			!ts.isStringLiteral(stmt.moduleSpecifier) ||
			!/^date-fns(\/|$)/.test(stmt.moduleSpecifier.text)
		) {
			continue;
		}
		const clause = stmt.importClause;
		if (clause?.name) {
			out.set(clause.name.text, path.basename(stmt.moduleSpecifier.text));
		}
		const bindings = clause?.namedBindings;
		if (bindings && ts.isNamedImports(bindings)) {
			for (const el of bindings.elements) {
				out.set(el.name.text, (el.propertyName ?? el.name).text);
			}
		}
	}
	return out;
}

/** date-fns pattern tokens that print a 12-hour clock, a day period or locale time. */
function hasTwelveHourToken(pattern: string): boolean {
	const unquoted = pattern.replace(/''/g, "").replace(/'[^']*'/g, "");
	return /[hKkabBp]/.test(unquoted);
}

function scanFile(checker: ts.TypeChecker, sf: ts.SourceFile): ScanResult {
	const offences: Offence[] = [];
	let pinned = 0;
	const dateFns = dateFnsBindings(sf);
	const report = (node: ts.Node, rule: string) => {
		const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
		offences.push({
			file: path.relative(SRC_DIR, sf.fileName),
			line: line + 1,
			rule,
			text: node.getText(sf).split("\n")[0].trim(),
		});
	};

	/** Judge a formatter call whose options sit at `args[1]`. */
	const judge = (
		node: ts.Node,
		args: ts.NodeArray<ts.Expression> | undefined,
		alwaysHour: boolean,
	) => {
		const options = args?.[1];
		if (
			!options ||
			(ts.isIdentifier(options) && options.text === "undefined")
		) {
			if (alwaysHour) report(node, "unpinned");
			return;
		}
		if (!ts.isObjectLiteralExpression(options)) {
			report(node, "options-not-literal");
			return;
		}
		if (!alwaysHour && !asksForHour(options)) return;
		if (pinsH23(options)) pinned++;
		else report(node, "unpinned");
	};

	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node) && node.text === "hour12") report(node, "hour12");
		if (ts.isStringLiteralLike(node)) {
			if (node.text === "hour12") report(node, "hour12");
			if (node.text.includes("ccflare-24h-time")) report(node, "toggle-key");
		}
		if (
			(ts.isPropertyAssignment(node) ||
				ts.isShorthandPropertyAssignment(node)) &&
			propertyName(node) === "hourCycle" &&
			!(
				ts.isPropertyAssignment(node) &&
				ts.isStringLiteralLike(node.initializer) &&
				node.initializer.text === "h23"
			)
		) {
			report(node, "hour-cycle-not-h23");
		}

		if (ts.isNewExpression(node) && isIntlDateTimeFormat(node.expression)) {
			judge(node, node.arguments, false);
		}
		if (ts.isCallExpression(node)) {
			const callee = node.expression;
			if (isIntlDateTimeFormat(callee)) {
				judge(node, node.arguments, false);
			} else if (ts.isPropertyAccessExpression(callee)) {
				const method = callee.name.text;
				if (method === "toLocaleTimeString") {
					judge(node, node.arguments, true);
				} else if (method === "toLocaleDateString") {
					judge(node, node.arguments, false);
				} else if (
					method === "toLocaleString" &&
					!isNumeric(checker, callee.expression)
				) {
					judge(node, node.arguments, true);
				}
			} else if (ts.isIdentifier(callee) && dateFns.has(callee.text)) {
				const name = dateFns.get(callee.text);
				if (name === "formatRelative") report(node, "date-fns-relative");
				if (
					name === "format" ||
					name === "formatDate" ||
					name === "lightFormat"
				) {
					const pattern = node.arguments[1];
					if (
						!pattern ||
						!ts.isStringLiteralLike(pattern) ||
						hasTwelveHourToken(pattern.text)
					) {
						report(node, "date-fns-pattern");
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return { offences, pinned };
}

function scan(files: (sf: ts.SourceFile) => boolean): ScanResult {
	const { program: built, checker } = program();
	const result: ScanResult = { offences: [], pinned: 0 };
	for (const sf of built.getSourceFiles()) {
		if (!files(sf)) continue;
		const r = scanFile(checker, sf);
		result.offences.push(...r.offences);
		result.pinned += r.pinned;
	}
	return result;
}

/** `expect:` markers in the fixture, one entry per rule per line. */
function fixtureExpectations(): { line: number; rule: string }[] {
	const out: { line: number; rule: string }[] = [];
	readFileSync(FIXTURE, "utf8")
		.split("\n")
		.forEach((text, i) => {
			const marker = /\/\/ expect: (.+)$/.exec(text);
			if (!marker) return;
			for (const rule of marker[1].split(",")) {
				out.push({ line: i + 1, rule: rule.trim() });
			}
		});
	return out;
}

const byPosition = (
	a: { line: number; rule: string },
	b: { line: number; rule: string },
) => a.line - b.line || a.rule.localeCompare(b.rule);

describe("dashboard 24-hour clock", () => {
	it(
		"pins hourCycle h23 on every hour-bearing formatter in the package",
		() => {
			const { offences, pinned } = scan(
				(sf) =>
					sf.fileName.startsWith(SRC_DIR + path.sep) &&
					!isTestPath(sf.fileName),
			);

			expect(offences).toEqual([]);
			// 25 when this was written; fewer means the scan stopped matching.
			expect(pinned).toBeGreaterThanOrEqual(25);
		},
		SCAN_TIMEOUT_MS,
	);

	it(
		"reports exactly the fixture's marked lines, every rule included",
		() => {
			const expected = fixtureExpectations().sort(byPosition);
			const actual = scan((sf) => sf.fileName === FIXTURE)
				.offences.map(({ line, rule }) => ({ line, rule }))
				.sort(byPosition);

			// The markers have to be read, or an empty list matches an empty scan.
			expect(new Set(expected.map((e) => e.rule))).toEqual(
				new Set([
					"unpinned",
					"options-not-literal",
					"hour12",
					"hour-cycle-not-h23",
					"toggle-key",
					"date-fns-pattern",
					"date-fns-relative",
				]),
			);
			expect(actual).toEqual(expected);
		},
		SCAN_TIMEOUT_MS,
	);
});
