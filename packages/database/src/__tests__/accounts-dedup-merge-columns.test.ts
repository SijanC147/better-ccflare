import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureSchema, runMigrations } from "../migrations";

/**
 * SB23-2531. The account dedup that precedes the unique index merges a
 * duplicate group into one survivor with one UPDATE per engine, and its own
 * comment claims every non-key `accounts` column appears there or in a named
 * exclusion. Measured 2026-10-01: three did not, in BOTH engines
 * (`rate_limit_reset_at`, `last_manual_reauth_at`, `renewal_day`), so the
 * survivor kept its own value and a discarded duplicate's was lost.
 *
 * The first block is the gate: it reads both statements from source and
 * compares their column sets against the live table, so the next column
 * added to `accounts` without a merge rule fails here rather than silently
 * dropping a value on some operator's upgrade. The second block proves the
 * three rules behave as written on SQLite.
 */

/** The dedup key and the id. Identical across a group, or kept by design. */
const NOT_MERGED = new Set(["id", "name", "provider", "custom_endpoint"]);

const SRC = join(import.meta.dir, "..");

/**
 * Column names assigned in an `UPDATE accounts SET ... WHERE` statement,
 * cut out of the source between two anchors that each occur exactly once.
 */
function assignedColumns(file: string, start: string, end: string): string[] {
	const text = readFileSync(join(SRC, file), "utf8");
	expect(text.split(start).length - 1).toBe(1);
	const from = text.indexOf(start);
	const to = text.indexOf(end, from);
	expect(to).toBeGreaterThan(from);
	const cols: string[] = [];
	for (const line of text.slice(from, to).split("\n")) {
		const m = /^\s*([a-z_]+)\s*=\s/.exec(line);
		if (m) cols.push(m[1] as string);
	}
	return cols;
}

function liveAccountsColumns(): string[] {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	const cols = (
		db.query("PRAGMA table_info(accounts)").all() as { name: string }[]
	).map((c) => c.name);
	db.close();
	return cols;
}

describe("account dedup merge: every column has a rule, in both engines", () => {
	const expected = liveAccountsColumns()
		.filter((c) => !NOT_MERGED.has(c))
		.sort();

	it("the instrument reads a statement of plausible size", () => {
		// A cut that matched nothing would read zero columns and fail below with
		// a confusing diff, and a cut that ran past the statement would read
		// assignments from unrelated SQL. Pin both ends.
		expect(expected.length).toBeGreaterThan(30);
	});

	it("SQLite: the survivor UPDATE names every non-key column exactly once", () => {
		const cols = assignedColumns(
			"migrations.ts",
			"const mergeSurvivor = db.prepare(",
			"WHERE rowid = $rowid",
		);
		expect(new Set(cols).size).toBe(cols.length);
		expect([...cols].sort()).toEqual(expected);
	});

	it("PostgreSQL: the survivor UPDATE names every non-key column exactly once", () => {
		const cols = assignedColumns(
			"migrations-pg.ts",
			"async function collapseAccountDuplicatesPreservingStatePg(",
			"WHERE id = $8",
		);
		expect(new Set(cols).size).toBe(cols.length);
		expect([...cols].sort()).toEqual(expected);
	});
});

describe("account dedup merge: the three SB23-2531 columns (SQLite)", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		// Re-enter the dedup on the next runMigrations.
		db.exec(`DROP INDEX IF EXISTS idx_accounts_unique_name_provider_endpoint`);
	});

	afterEach(() => {
		db.close();
	});

	const NOW = 1_757_000_000_000;

	function insert(
		id: string,
		lastUsed: number,
		extra: {
			rate_limit_reset_at?: number | null;
			last_manual_reauth_at?: number | null;
			renewal_day?: number | null;
		},
	): void {
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, last_used,
			   refresh_token_issued_at, rate_limit_reset_at, last_manual_reauth_at, renewal_day)
			 VALUES (?, 'dup', 'anthropic', ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			id,
			`r-${id}`,
			`a-${id}`,
			lastUsed - 1000,
			lastUsed,
			lastUsed - 1000,
			extra.rate_limit_reset_at ?? null,
			extra.last_manual_reauth_at ?? null,
			extra.renewal_day ?? null,
		);
	}

	function survivor(): {
		id: string;
		rate_limit_reset_at: number | null;
		last_manual_reauth_at: number | null;
		renewal_day: number | null;
	} {
		const rows = db
			.query(
				"SELECT id, rate_limit_reset_at, last_manual_reauth_at, renewal_day FROM accounts WHERE name = 'dup'",
			)
			.all() as ReturnType<typeof survivor>[];
		expect(rows).toHaveLength(1);
		return rows[0] as ReturnType<typeof survivor>;
	}

	it("adopts all three from a discarded duplicate when the survivor has none", () => {
		// d-1 is the survivor (newest last_used) and holds nothing; d-2 is the
		// only holder of each value, so before the fix all three were lost.
		insert("d-1", NOW, {});
		insert("d-2", NOW - 60_000, {
			rate_limit_reset_at: NOW - 5_000,
			last_manual_reauth_at: NOW - 86_400_000,
			renewal_day: 17,
		});

		runMigrations(db);

		const s = survivor();
		expect(s.id).toBe("d-1");
		expect(s.rate_limit_reset_at).toBe(NOW - 5_000);
		expect(s.last_manual_reauth_at).toBe(NOW - 86_400_000);
		expect(s.renewal_day).toBe(17);
	});

	it("takes the newest of the two timestamps, not the survivor's own", () => {
		insert("d-1", NOW, {
			rate_limit_reset_at: NOW - 50_000,
			last_manual_reauth_at: NOW - 900_000_000,
		});
		insert("d-2", NOW - 60_000, {
			rate_limit_reset_at: NOW - 5_000,
			last_manual_reauth_at: NOW - 86_400_000,
		});

		runMigrations(db);

		const s = survivor();
		expect(s.rate_limit_reset_at).toBe(NOW - 5_000);
		expect(s.last_manual_reauth_at).toBe(NOW - 86_400_000);
	});

	it("keeps the survivor's own renewal day when it has one", () => {
		insert("d-1", NOW, { renewal_day: 3 });
		insert("d-2", NOW - 60_000, { renewal_day: 17 });

		runMigrations(db);

		expect(survivor().renewal_day).toBe(3);
	});

	it("leaves an all-NULL group's timestamps NULL rather than 0", () => {
		// NULL means "never". The group's other MAX rules coalesce to 0 first,
		// which for these two would read as an instant in 1970.
		insert("d-1", NOW, {});
		insert("d-2", NOW - 60_000, {});

		runMigrations(db);

		const s = survivor();
		expect(s.rate_limit_reset_at).toBeNull();
		expect(s.last_manual_reauth_at).toBeNull();
		expect(s.renewal_day).toBeNull();
	});
});
