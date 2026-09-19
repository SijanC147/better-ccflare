import { describe, expect, it } from "bun:test";
import { convertPlaceholders } from "../bun-sql-adapter";

/**
 * convertPlaceholders() rewrites SQLite `?` placeholders into PostgreSQL `$N`.
 * SQLite never receives the rewritten form, so nothing in the SQLite suite can
 * observe a defect in here. These tests call the function directly.
 *
 * The reproduction below is the real statement shape that returned HTTP 500 on
 * a live PostgreSQL 18 server on 2026-09-18 (SB23-2286). The server reported
 * `syntax error at or near "AND"`, naming neither the apostrophe that caused it
 * nor the `?` that failed to convert.
 */
describe("convertPlaceholders", () => {
	it("rewrites a bare `?` to $1", () => {
		expect(convertPlaceholders("SELECT * FROM t WHERE a = ?")).toBe(
			"SELECT * FROM t WHERE a = $1",
		);
	});

	it("numbers bare placeholders sequentially", () => {
		expect(convertPlaceholders("WHERE a = ? AND b = ? AND c = ?")).toBe(
			"WHERE a = $1 AND b = $2 AND c = $3",
		);
	});

	it("keeps the original number for `?N` style", () => {
		expect(convertPlaceholders("WHERE a = ?2 AND b = ?1")).toBe(
			"WHERE a = $2 AND b = $1",
		);
	});

	it("does not rewrite a `?` inside a string literal", () => {
		expect(convertPlaceholders("SELECT '?' AS q, x FROM t WHERE y = ?")).toBe(
			"SELECT '?' AS q, x FROM t WHERE y = $1",
		);
	});

	it("treats a doubled quote as an escaped quote, not a new literal", () => {
		// `'it''s'` is one literal. The `?` after it must still convert.
		expect(convertPlaceholders("SELECT 'it''s' WHERE a = ?")).toBe(
			"SELECT 'it''s' WHERE a = $1",
		);
	});

	// ---- the SB23-2286 defect class -------------------------------------

	it("converts a placeholder that follows an apostrophe in a line comment", () => {
		const sql = [
			"SELECT AVG(cost_usd)",
			"-- The one column with no DEFAULT 0, so AVG's NULL-skipping",
			"FROM requests WHERE timestamp >= ? AND model = ?",
		].join("\n");

		const out = convertPlaceholders(sql);

		expect(out).toContain("timestamp >= $1");
		expect(out).toContain("model = $2");
		// The negative assertion is the one that fails without the comment-skip
		// branch: before it, both placeholders survived as a literal `?`.
		expect(out).not.toContain("?");
		// The comment text itself is preserved verbatim, apostrophe included.
		expect(out).toContain("so AVG's NULL-skipping");
	});

	it("handles an odd number of apostrophes across comment and literals", () => {
		// Five apostrophes: two in `'plan'` twice, one in the prose. The odd
		// count is what left the scanner with a string literal open.
		const sql = [
			"SELECT billing_type",
			"-- MAX pairs row A's tokens with row B's issued-at",
			"FROM accounts WHERE billing_type = 'plan' OR mode = 'plan' AND id = ?",
		].join("\n");

		expect(convertPlaceholders(sql)).toContain("id = $1");
	});

	it("does not renumber a `?` inside a line comment", () => {
		const sql = [
			"SELECT x",
			"-- is this a placeholder? no",
			"FROM t WHERE a = ? AND b = ?",
		].join("\n");

		const out = convertPlaceholders(sql);

		// The comment's `?` stays a `?`, and the two real placeholders start at
		// $1 rather than being shifted to $2 and $3.
		expect(out).toContain("is this a placeholder? no");
		expect(out).toContain("a = $1");
		expect(out).toContain("b = $2");
	});

	it("skips a trailing comment on the same line as SQL", () => {
		// Trailing comments are the case every line-start-anchored static gate
		// is structurally blind to, so the parser has to carry it.
		const sql =
			"SELECT x FROM t WHERE a = ? -- don't blank this out\nAND b = ?";

		const out = convertPlaceholders(sql);

		expect(out).toContain("a = $1");
		expect(out).toContain("b = $2");
		expect(out).toContain("-- don't blank this out");
	});

	it("skips a comment that runs to the end of the statement", () => {
		const sql = "SELECT x FROM t WHERE a = ?\n-- trailing note, author's own";
		expect(convertPlaceholders(sql)).toBe(
			"SELECT x FROM t WHERE a = $1\n-- trailing note, author's own",
		);
	});

	it("does not treat `--` inside a string literal as a comment", () => {
		// The string-literal branch runs first, so this stays data. If the
		// comment branch ran first it would swallow the rest of the line and
		// the following placeholder would never convert.
		const sql = "SELECT '--' AS dashes FROM t WHERE a = ?";
		expect(convertPlaceholders(sql)).toBe(
			"SELECT '--' AS dashes FROM t WHERE a = $1",
		);
	});

	it("leaves a single hyphen and a subtraction alone", () => {
		expect(convertPlaceholders("SELECT a - b FROM t WHERE c = ?")).toBe(
			"SELECT a - b FROM t WHERE c = $1",
		);
	});

	it("does not let an apostrophe in a block comment open a string literal", () => {
		// The `--` form of this is the defect PR #160 fixed and four live
		// PostgreSQL cases 500'd on. A block comment reproduces it exactly:
		// without the skip, the apostrophe leaves the scanner believing a
		// literal is open and the following `?` reaches PostgreSQL verbatim.
		const sql = "SELECT x /* AVG's NULL-skipping */ FROM t WHERE a = ?";
		expect(convertPlaceholders(sql)).toBe(
			"SELECT x /* AVG's NULL-skipping */ FROM t WHERE a = $1",
		);
	});

	it("does not renumber a `?` inside a block comment", () => {
		// The other direction: an unskipped `?` in the comment consumes $1 and
		// shifts every real placeholder after it by one.
		const sql = "SELECT x /* why ? */ FROM t WHERE a = ? AND b = ?";
		expect(convertPlaceholders(sql)).toBe(
			"SELECT x /* why ? */ FROM t WHERE a = $1 AND b = $2",
		);
	});

	it("does not treat `/*` inside a string literal as a block comment", () => {
		// Same ordering requirement as the `'--'` case above: the string-literal
		// branch runs first, so this stays data. If the block-comment branch ran
		// first it would swallow to the next `*/` or to the end of the statement
		// and the following placeholder would never convert.
		const sql = "SELECT '/*' AS marker FROM t WHERE a = ?";
		expect(convertPlaceholders(sql)).toBe(
			"SELECT '/*' AS marker FROM t WHERE a = $1",
		);
	});

	it("copies an unterminated block comment through to the end", () => {
		// No `*/`, so everything after it is comment. A `?` inside must not be
		// renumbered, and the function must terminate rather than scan past the
		// end of the string.
		const sql = "SELECT x FROM t WHERE a = ? /* unterminated, author's ?";
		expect(convertPlaceholders(sql)).toBe(
			"SELECT x FROM t WHERE a = $1 /* unterminated, author's ?",
		);
	});

	it("leaves a division and a standalone slash alone", () => {
		expect(convertPlaceholders("SELECT a / b FROM t WHERE c = ?")).toBe(
			"SELECT a / b FROM t WHERE c = $1",
		);
	});
});
