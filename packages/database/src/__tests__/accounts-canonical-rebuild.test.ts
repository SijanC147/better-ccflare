import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../migrations";

/**
 * SB23-3918. The `account_tier` removal branch of `runMigrations` rebuilt
 * `accounts` with `CREATE TABLE accounts_new AS SELECT ...`. SQLite's CTAS
 * copies column names and affinity only, so the table it left behind had no
 * PRIMARY KEY on `id`, no NOT NULL and no DEFAULT anywhere: an INSERT omitting
 * `request_count` then stored NULL instead of 0, and the same for every other
 * defaulted column. The branch also sat below the UNIQUE index block and
 * `addPerformanceIndexes`, so the DROP TABLE took the
 * (name, provider, custom_endpoint) UNIQUE index with it for that server
 * lifetime and pinned `idx_accounts_priority` to a simple one-column form.
 *
 * The branch is now an explicit CREATE identical to a fresh install, and it
 * also fires on a table whose `id` lost its primary key, which is the mark the
 * old CTAS left, so an install that already took it is repaired.
 *
 * "Identical to a fresh install" is measured, not restated: every assertion
 * below compares against a database built by `runMigrations` from nothing, so
 * a column added later is compared without anyone editing this file.
 */

const dirs: string[] = [];

function freshDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-canonical-rebuild-"));
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

/** Index name and normalised SQL; the PK autoindex has no SQL. */
function indexSet(db: Database): string[] {
	return (
		db
			.query(
				"SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'accounts'",
			)
			.all() as { name: string; sql: string | null }[]
	)
		.map((r) => `${r.name} :: ${(r.sql ?? "").replace(/\s+/g, " ").trim()}`)
		.sort();
}

/** The schema a fresh install gets, from `runMigrations` on an empty file. */
function freshInstall(): { info: ColumnInfo[]; indexes: string[] } {
	const db = new Database(join(freshDir(), "fresh.db"));
	runMigrations(db);
	const result = { info: tableInfo(db), indexes: indexSet(db) };
	db.close();
	return result;
}

/**
 * A non-default value for every column, distinct from every other, so a
 * dropped column (NULL or its default) and a shifted one (a neighbour's value)
 * both read back wrong. Text values avoid every string a later data migration
 * in `runMigrations` rewrites: `provider` is not 'anthropic', 'muse-spark' or an
 * API-key provider, `name` matches the sanitiser's /^[a-zA-Z0-9\-_]+$/, and the
 * two token columns are non-empty.
 */
function nonDefaultRow(
	info: ColumnInfo[],
	id: string,
): Record<string, string | number> {
	const row: Record<string, string | number> = {};
	for (const col of info) {
		if (col.name === "id") row.id = id;
		else if (col.name === "name") row.name = `acct_${id}`;
		else if (col.type === "INTEGER") row[col.name] = 1000 + col.cid;
		else row[col.name] = `v-${col.name}`;
	}
	return row;
}

function insertRow(db: Database, row: Record<string, string | number>): void {
	const names = Object.keys(row);
	db.query(
		`INSERT INTO accounts (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
	).run(...names.map((n) => row[n] as string | number));
}

function readRow(db: Database, id: string): Record<string, unknown> {
	return db.query("SELECT * FROM accounts WHERE id = ?").get(id) as Record<
		string,
		unknown
	>;
}

/**
 * The damage the old branch left, reproduced exactly: its CTAS, DROP, RENAME
 * and the UNIQUE `idx_accounts_id` it recreated.
 */
function applyOldCtasRebuild(db: Database): void {
	db.run("CREATE TABLE accounts_new AS SELECT * FROM accounts");
	db.run("DROP TABLE accounts");
	db.run("ALTER TABLE accounts_new RENAME TO accounts");
	db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_id ON accounts(id)");
}

function backups(dir: string): string[] {
	return readdirSync(dir).filter((f) => f.includes(".backup."));
}

describe("accounts canonical rebuild: account_tier removal (SB23-3918)", () => {
	function migratedWithTier(): {
		db: Database;
		seeded: Record<string, string | number>;
	} {
		const fresh = freshInstall();
		const path = join(freshDir(), "tier.db");
		const first = new Database(path);
		runMigrations(first);
		first.run("ALTER TABLE accounts ADD COLUMN account_tier INTEGER DEFAULT 1");
		const seeded = nonDefaultRow(fresh.info, "acc-1");
		insertRow(first, { ...seeded, account_tier: 3 });
		first.close();

		const db = new Database(path);
		runMigrations(db);
		return { db, seeded };
	}

	it("takes the branch and leaves the schema identical to a fresh install", () => {
		const fresh = freshInstall();
		const { db } = migratedWithTier();

		const info = tableInfo(db);
		// The branch ran: without this, an untouched table would pass the
		// equality below only because the guard never fired.
		expect(info.map((c) => c.name)).not.toContain("account_tier");
		// cid, name, type, notnull, dflt_value and pk, column by column.
		expect(info).toEqual(fresh.info);
		db.close();
	});

	it("keeps id as the primary key, the NOT NULLs and the defaults", () => {
		const { db } = migratedWithTier();
		const byName = new Map(tableInfo(db).map((c) => [c.name, c]));

		expect(byName.get("id")?.pk).toBe(1);
		for (const name of [
			"name",
			"created_at",
			"consecutive_rate_limits",
			"peak_hours_pause_enabled",
			"usage_pause_five_hour_enabled",
			"usage_pause_weekly_enabled",
		]) {
			expect({ name, notnull: byName.get(name)?.notnull }).toEqual({
				name,
				notnull: 1,
			});
		}
		expect(byName.get("request_count")?.dflt_value).toBe("0");
		expect(byName.get("provider")?.dflt_value).toBe("'anthropic'");
		expect(byName.get("cross_region_mode")?.dflt_value).toBe("'geographic'");
		db.close();
	});

	it("carries a non-default value in every column through the rebuild", () => {
		const { db, seeded } = migratedWithTier();
		expect(readRow(db, "acc-1")).toEqual(seeded);
		db.close();
	});

	it("applies the defaults to an INSERT that omits them", () => {
		const { db } = migratedWithTier();
		db.run(
			"INSERT INTO accounts (id, name, created_at) VALUES ('acc-2', 'acc_2', 5)",
		);
		const row = readRow(db, "acc-2");

		expect(row.request_count).toBe(0);
		expect(row.total_requests).toBe(0);
		expect(row.priority).toBe(0);
		expect(row.paused).toBe(0);
		expect(row.consecutive_rate_limits).toBe(0);
		expect(row.provider).toBe("anthropic");
		expect(row.cross_region_mode).toBe("geographic");
		db.close();
	});

	it("rejects a duplicate id and a NULL name", () => {
		const { db } = migratedWithTier();
		expect(() =>
			db.run(
				"INSERT INTO accounts (id, name, provider, created_at) VALUES ('acc-1', 'other', 'other', 5)",
			),
		).toThrow(/UNIQUE constraint failed: accounts\.id/);
		expect(() =>
			db.run("INSERT INTO accounts (id, created_at) VALUES ('acc-3', 5)"),
		).toThrow(/NOT NULL constraint failed: accounts\.name/);
		db.close();
	});

	it("leaves the index set identical to a fresh install", () => {
		// The UNIQUE (name, provider, custom_endpoint) index used to be missing
		// for the whole first lifetime after this branch, and the simple
		// idx_accounts_priority it recreated kept the composite one out forever.
		const fresh = freshInstall();
		const { db } = migratedWithTier();
		expect(indexSet(db)).toEqual(fresh.indexes);
		db.close();
	});
});

describe("accounts canonical rebuild: repairs a table the old CTAS damaged (SB23-3918)", () => {
	function damagedDatabase(): {
		dir: string;
		path: string;
		seeded: Record<string, string | number>;
	} {
		const fresh = freshInstall();
		const dir = freshDir();
		const path = join(dir, "damaged.db");
		const db = new Database(path);
		runMigrations(db);
		applyOldCtasRebuild(db);
		const seeded = nonDefaultRow(fresh.info, "acc-1");
		insertRow(db, seeded);
		// What every insert site does on a damaged table: name the columns it
		// cares about and let the rest take their DEFAULT, which no longer
		// exists, so they store NULL.
		db.run(
			"INSERT INTO accounts (id, name, created_at) VALUES ('acc-omitted', 'acc_omitted', 9)",
		);
		db.close();
		return { dir, path, seeded };
	}

	it("reproduces the damage the issue describes before migrating", () => {
		// The fixture has to be able to show the other answer, or the repair
		// assertions below prove nothing.
		const { path } = damagedDatabase();
		const db = new Database(path);
		const byName = new Map(tableInfo(db).map((c) => [c.name, c]));
		expect(byName.get("id")?.pk).toBe(0);
		expect(byName.get("name")?.notnull).toBe(0);
		expect(byName.get("request_count")?.dflt_value).toBeNull();
		const omitted = readRow(db, "acc-omitted");
		expect(omitted.request_count).toBeNull();
		expect(omitted.consecutive_rate_limits).toBeNull();
		db.close();
	});

	it("rebuilds it to the fresh-install schema and index set", () => {
		const fresh = freshInstall();
		const { path } = damagedDatabase();
		const db = new Database(path);
		runMigrations(db, path);

		expect(tableInfo(db)).toEqual(fresh.info);
		expect(indexSet(db)).toEqual(fresh.indexes);
		db.close();
	});

	it("keeps every stored value and restores the defaults a NULL lost", () => {
		const { path, seeded } = damagedDatabase();
		const db = new Database(path);
		runMigrations(db, path);

		expect(readRow(db, "acc-1")).toEqual(seeded);

		const omitted = readRow(db, "acc-omitted");
		// Required: NOT NULL DEFAULT 0, so a NULL would have failed the copy.
		expect(omitted.consecutive_rate_limits).toBe(0);
		expect(omitted.peak_hours_pause_enabled).toBe(0);
		expect(omitted.usage_pause_five_hour_enabled).toBe(0);
		expect(omitted.usage_pause_weekly_enabled).toBe(0);
		// Chosen: nullable with a default, which every reader treats NULL as.
		expect(omitted.request_count).toBe(0);
		expect(omitted.total_requests).toBe(0);
		expect(omitted.priority).toBe(0);
		expect(omitted.requires_reauth).toBe(0);
		expect(omitted.session_request_count).toBe(0);
		expect(omitted.paused).toBe(0);
		expect(omitted.auto_fallback_enabled).toBe(0);
		expect(omitted.auto_refresh_enabled).toBe(0);
		expect(omitted.auto_pause_on_overage_enabled).toBe(0);
		expect(omitted.provider).toBe("anthropic");
		expect(omitted.cross_region_mode).toBe("geographic");
		// No default to restore: these stay NULL.
		expect(omitted.billing_type).toBeNull();
		expect(omitted.renewal_day).toBeNull();
		db.close();
	});

	it("takes a backup first, and a second run neither rebuilds nor backs up", () => {
		const { dir, path } = damagedDatabase();
		const db = new Database(path);
		runMigrations(db, path);
		expect(backups(dir)).toHaveLength(1);

		db.run(
			"INSERT INTO accounts (id, name, created_at) VALUES ('acc-after', 'acc_after', 11)",
		);
		runMigrations(db, path);
		expect(backups(dir)).toHaveLength(1);
		// Still canonical, and the row written in between is untouched.
		expect(readRow(db, "acc-after").request_count).toBe(0);
		db.close();
	});
});

describe("accounts refresh_token rebuild: index set (SB23-3918)", () => {
	it("leaves the index set identical to a fresh install", () => {
		// The refresh_token NOT NULL rebuild recreated the same simple
		// idx_accounts_priority, which addPerformanceIndexes' IF NOT EXISTS then
		// skipped. Built from the fresh shape with refresh_token NOT NULL and the
		// six usage_pause columns removed, which is the shape that branch meets.
		const fresh = freshInstall();
		const usagePause = new Set([
			"usage_pause_five_hour_threshold",
			"usage_pause_weekly_threshold",
			"usage_pause_five_hour_enabled",
			"usage_pause_weekly_enabled",
			"usage_pause_five_hour_min_reset_remaining_ms",
			"usage_pause_weekly_min_reset_remaining_ms",
		]);
		const columns = fresh.info
			.filter((c) => !usagePause.has(c.name))
			.map(
				(c) =>
					`${c.name} ${c.type}${c.pk ? " PRIMARY KEY" : ""}${
						c.notnull || c.name === "refresh_token" ? " NOT NULL" : ""
					}${c.dflt_value !== null ? ` DEFAULT ${c.dflt_value}` : ""}`,
			);
		const path = join(freshDir(), "legacy.db");
		const db = new Database(path);
		db.run(`CREATE TABLE accounts (${columns.join(", ")})`);
		runMigrations(db);

		expect(tableInfo(db).find((c) => c.name === "refresh_token")?.notnull).toBe(
			0,
		);
		expect(indexSet(db)).toEqual(fresh.indexes);
		db.close();
	});
});
