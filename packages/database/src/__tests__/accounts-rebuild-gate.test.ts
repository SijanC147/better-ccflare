import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../migrations";

/**
 * SB23-3919. `runMigrations` rebuilds `accounts` in two places, each copying a
 * fixed column list. A column whose `ALTER` runs above a rebuild and is missing
 * from its list is DROPPED by that rebuild: no constraint violation, no log
 * line, and if the ALTER is guarded on the PRAGMA read before the transaction
 * the column does not come back for that server lifetime. It happened three
 * times (`consecutive_rate_limits` and `last_manual_reauth_at` in SB23-2073,
 * `rate_limit_reset_at` in SB23-2531), and each fix added the column without
 * stopping the next one.
 *
 * Two forms of the same rule, because each catches what the other cannot:
 *
 * - The source gate reads `migrations.ts` and requires, for each rebuild, that
 *   its column list is exactly the base columns plus every column whose ALTER
 *   sits above it, and that its SELECT copies them in the CREATE's order. It
 *   names the column and the rebuild in its failure.
 * - The behavioural gate builds each rebuild's legacy shape from a fresh
 *   install, so a column added tomorrow is in the fixture without anyone
 *   editing this file, seeds a non-default value in every column, forces the
 *   rebuild and requires every value back.
 *
 * The one stated exception: the six `usage_pause_*` columns are absent from the
 * refresh_token rebuild's list by design. Their ALTERs sit BELOW that rebuild
 * and re-read the PRAGMA, so on the only shape that rebuild meets (a database
 * old enough to have refresh_token NOT NULL, which predates every usage_pause
 * column) they are added after it. Moving any of those ALTERs above the rebuild
 * fails both gates.
 */

const MIGRATIONS_SOURCE = join(import.meta.dir, "..", "migrations.ts");

/** Absent from the refresh_token rebuild's list by design; see above. */
const USAGE_PAUSE_EXCEPTION = [
	"usage_pause_five_hour_threshold",
	"usage_pause_weekly_threshold",
	"usage_pause_five_hour_enabled",
	"usage_pause_weekly_enabled",
	"usage_pause_five_hour_min_reset_remaining_ms",
	"usage_pause_weekly_min_reset_remaining_ms",
].sort();

const dirs: string[] = [];

function freshDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-rebuild-gate-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	while (dirs.length > 0) {
		rmSync(dirs.pop() as string, { recursive: true, force: true });
	}
});

type ColumnInfo = {
	cid: number;
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
};

function tableInfo(db: Database): ColumnInfo[] {
	return db.query("PRAGMA table_info(accounts)").all() as ColumnInfo[];
}

function freshColumns(): ColumnInfo[] {
	const db = new Database(join(freshDir(), "fresh.db"));
	runMigrations(db);
	const info = tableInfo(db);
	db.close();
	return info;
}

function difference(a: Iterable<string>, b: Iterable<string>): string[] {
	const bs = new Set(b);
	return [...new Set(a)].filter((x) => !bs.has(x)).sort();
}

// ---------------------------------------------------------------------------
// Source gate
// ---------------------------------------------------------------------------

type Rebuild = {
	/** Offset of `CREATE TABLE accounts_new (` inside runMigrations. */
	at: number;
	create: string[];
	/** The INSERT's own column list, when it names one. */
	target: string[] | null;
	/** The column each SELECT item reads, in order. */
	select: string[];
};

/** Column names from a CREATE TABLE body: the first word of each line. */
function createColumns(body: string): string[] {
	return body
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => (line.match(/^([a-z_][a-z0-9_]*)\s/) ?? [])[1] ?? "")
		.filter((name) => name.length > 0);
}

/** Splits on commas outside parentheses. */
function topLevelItems(list: string): string[] {
	const items: string[] = [];
	let depth = 0;
	let current = "";
	for (const ch of list) {
		if (ch === "(") depth++;
		if (ch === ")") depth--;
		if (ch === "," && depth === 0) {
			items.push(current.trim());
			current = "";
		} else {
			current += ch;
		}
	}
	if (current.trim().length > 0) items.push(current.trim());
	return items;
}

/**
 * The one known column a SELECT item reads, so `COALESCE(paused, 0)` and
 * `CASE WHEN refresh_token = '' THEN NULL ELSE refresh_token END` map to their
 * column. An item reading none or two is reported, not guessed.
 */
function itemColumn(item: string, known: Set<string>): string {
	const found = new Set(
		(item.match(/[a-z_][a-z0-9_]*/g) ?? []).filter((w) => known.has(w)),
	);
	if (found.size !== 1) {
		return `<unparsed: ${item.replace(/\s+/g, " ")}>`;
	}
	return [...found][0] as string;
}

function parseSource(known: Set<string>): {
	base: string[];
	alters: { name: string; at: number }[];
	rebuilds: Rebuild[];
} {
	const source = readFileSync(MIGRATIONS_SOURCE, "utf8");

	const schemaStart = source.indexOf("export function ensureSchema(");
	const schemaBody = source.slice(schemaStart);
	const accountsCreate = schemaBody.match(
		/CREATE TABLE IF NOT EXISTS accounts \(([\s\S]*?)\n\s*\)\s*`/,
	);
	const ensureSchemaColumns = createColumns(accountsCreate?.[1] ?? "");

	const start = source.indexOf("export function runMigrations(");
	const end = source.indexOf("\nexport function ", start + 1);
	const body = source.slice(start, end);

	const alters = [
		...body.matchAll(/ALTER TABLE accounts ADD COLUMN (\w+)/g),
	].map((m) => ({ name: m[1] as string, at: m.index as number }));
	const altered = new Set(alters.map((a) => a.name));
	// Columns the oldest accounts table already had, which no ALTER adds.
	const base = ensureSchemaColumns.filter((c) => !altered.has(c));

	const rebuilds: Rebuild[] = [];
	for (const m of body.matchAll(
		/CREATE TABLE accounts_new \(([\s\S]*?)\n\s*\)\s*`/g,
	)) {
		const at = m.index as number;
		const after = body.slice(at);
		const insert = after.match(
			/INSERT INTO accounts_new\s*(?:\(([\s\S]*?)\))?\s*SELECT([\s\S]*?)\bFROM accounts\b/,
		);
		rebuilds.push({
			at,
			create: createColumns(m[1] as string),
			target: insert?.[1]
				? topLevelItems(insert[1]).map((c) => c.trim())
				: null,
			select: topLevelItems(insert?.[2] ?? "").map((item) =>
				itemColumn(item, known),
			),
		});
	}
	return { base, alters, rebuilds };
}

describe("accounts rebuild gate: source (SB23-3919)", () => {
	const fresh = freshColumns().map((c) => c.name);
	const known = new Set([...fresh, "account_tier"]);
	const { base, alters, rebuilds } = parseSource(known);

	it("finds what it gates on", () => {
		// A parser that matched nothing would pass every comparison below.
		expect(base).toEqual(
			expect.arrayContaining(["id", "name", "refresh_token", "created_at"]),
		);
		expect(alters.length).toBeGreaterThan(30);
		// A third rebuild, or one that stopped matching, has to be looked at
		// rather than silently ungated.
		expect(rebuilds).toHaveLength(2);
		for (const r of rebuilds) expect(r.create.length).toBeGreaterThan(35);
	});

	it("every rebuild's list is the base columns plus every column ALTERed above it", () => {
		const problems: string[] = [];
		rebuilds.forEach((r, i) => {
			const required = [
				...base,
				...alters.filter((a) => a.at < r.at).map((a) => a.name),
			];
			const missing = difference(required, r.create);
			const extra = difference(r.create, required);
			if (missing.length > 0) {
				problems.push(
					`rebuild ${i + 1} drops ${missing.join(", ")}: its ALTER runs above the rebuild, so add it to the CREATE and the SELECT`,
				);
			}
			if (extra.length > 0) {
				problems.push(
					`rebuild ${i + 1} copies ${extra.join(", ")}, whose ALTER runs below it, so the SELECT fails on a database that has not got it yet`,
				);
			}
		});
		expect(problems).toEqual([]);
	});

	it("every rebuild's SELECT copies its CREATE's columns in the same order", () => {
		// The refresh_token rebuild's INSERT names no columns, so a SELECT item
		// out of position lands its value in a neighbour.
		for (const r of rebuilds) {
			expect(r.select).toEqual(r.create);
			if (r.target !== null) expect(r.target).toEqual(r.create);
		}
	});

	it("the refresh_token rebuild omits exactly the usage_pause columns, whose ALTERs sit below it", () => {
		const [first] = rebuilds as [Rebuild];
		// The stated exception, and nothing else. A column here that is not a
		// usage_pause column belongs in that rebuild's list.
		expect(difference(fresh, first.create)).toEqual(USAGE_PAUSE_EXCEPTION);
		const misplaced = alters
			.filter((a) => USAGE_PAUSE_EXCEPTION.includes(a.name) && a.at < first.at)
			.map((a) => a.name);
		expect(misplaced).toEqual([]);
	});

	it("the canonical rebuild copies every column a fresh install has", () => {
		const [, second] = rebuilds as [Rebuild, Rebuild];
		expect(second.create).toEqual(fresh);
	});
});

// ---------------------------------------------------------------------------
// Behavioural gate
// ---------------------------------------------------------------------------

/**
 * A non-default value for every column, each distinct. Text avoids every
 * value a later data migration rewrites: `provider` is not 'anthropic',
 * 'muse-spark' or an API-key provider, `name` passes the sanitiser, and the two
 * token columns are non-empty because the refresh_token rebuild maps '' to NULL.
 */
function nonDefaultRow(info: ColumnInfo[]): Record<string, string | number> {
	const row: Record<string, string | number> = {};
	for (const col of info) {
		if (col.name === "id") row.id = "acc-gate";
		else if (col.name === "name") row.name = "acc_gate";
		else if (col.type === "INTEGER") row[col.name] = 5000 + col.cid;
		else row[col.name] = `gate-${col.name}`;
	}
	return row;
}

function ddl(c: ColumnInfo, overrides: { notnull?: boolean } = {}): string {
	const notnull = overrides.notnull ?? c.notnull === 1;
	return `${c.name} ${c.type}${c.pk ? " PRIMARY KEY" : ""}${
		notnull ? " NOT NULL" : ""
	}${c.dflt_value !== null ? ` DEFAULT ${c.dflt_value}` : ""}`;
}

function seedAndMigrate(
	createSql: string,
	row: Record<string, string | number>,
): Database {
	const path = join(freshDir(), "legacy.db");
	const seed = new Database(path);
	seed.run(createSql);
	const names = Object.keys(row);
	seed
		.query(
			`INSERT INTO accounts (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
		)
		.run(...names.map((n) => row[n] as string | number));
	seed.close();

	const db = new Database(path);
	runMigrations(db);
	return db;
}

function readBack(
	db: Database,
	names: string[],
): Record<string, unknown> | null {
	return db
		.query(`SELECT ${names.join(", ")} FROM accounts WHERE id = 'acc-gate'`)
		.get() as Record<string, unknown> | null;
}

describe("accounts rebuild gate: behaviour (SB23-3919)", () => {
	it("the refresh_token rebuild keeps a non-default value in every column it meets", () => {
		const fresh = freshColumns();
		const legacy = fresh.filter((c) => !USAGE_PAUSE_EXCEPTION.includes(c.name));
		const row = nonDefaultRow(legacy);
		const db = seedAndMigrate(
			`CREATE TABLE accounts (${legacy
				.map((c) => ddl(c, c.name === "refresh_token" ? { notnull: true } : {}))
				.join(", ")})`,
			row,
		);

		const info = tableInfo(db);
		// The rebuild ran.
		expect(info.find((c) => c.name === "refresh_token")?.notnull).toBe(0);
		// Every column the rebuild met, with its value; a dropped column reads
		// NULL or its default, which no seeded value is.
		const names = info.map((c) => c.name);
		expect(difference(Object.keys(row), names)).toEqual([]);
		expect(readBack(db, Object.keys(row))).toEqual(row);
		// The exception columns arrive after it, from the ALTERs below.
		expect(difference(USAGE_PAUSE_EXCEPTION, names)).toEqual([]);
		db.close();
	});

	it("the canonical rebuild keeps a non-default value in every column", () => {
		const fresh = freshColumns();
		const row = { ...nonDefaultRow(fresh), account_tier: 7 };
		const db = seedAndMigrate(
			`CREATE TABLE accounts (${[
				...fresh.map((c) => ddl(c)),
				"account_tier INTEGER DEFAULT 1",
			].join(", ")})`,
			row,
		);

		const names = tableInfo(db).map((c) => c.name);
		// The rebuild ran.
		expect(names).not.toContain("account_tier");
		const { account_tier: _tier, ...kept } = row;
		expect(difference(Object.keys(kept), names)).toEqual([]);
		expect(readBack(db, Object.keys(kept))).toEqual(kept);
		db.close();
	});
});
