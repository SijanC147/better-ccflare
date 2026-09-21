import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSchema, runMigrations } from "../migrations";

/**
 * SB23-2527. The four `usage_pause_*` columns arrived with PR #231's 114-commit
 * upstream sync, and an `accounts` column costs ten places in this repository.
 * Two of the ten were already wrong in that sync, from two different authors:
 * the second rebuild column list was missing all four, and upstream had omitted
 * them from SQLite `ensureSchema`. Both were fixed before the merge.
 *
 * Two of the ten had no test pointing at them at all, which is what this file
 * adds. Measured on the merge commit before it was written:
 *
 *   `accounts-rebuild-columns.test.ts`          0 mentions of usage_pause
 *   `migrations-dedup-preserving-state.test.ts` 0 mentions of usage_pause
 *
 * `usage-threshold-migration.test.ts` already covers `ensureSchema`, the four
 * `ALTER TABLE`s, the defaults, the enabled-flag backfill and the
 * `refresh_token NOT NULL` rebuild. It does NOT cover the `account_tier`
 * removal rebuild, and nothing covered the dedup merge. Those are the two
 * places where a missing column is silent AND lossy:
 *
 *   - The rebuild list DROPS the column. No constraint violation, no log line.
 *     The `account_tier` branch is the worse of the two because its guard
 *     clears permanently: once `account_tier` is gone the branch never runs
 *     again, so the rebuild has exactly one chance to carry the data and there
 *     is no later pass to repair it.
 *   - The dedup path DELETES rows, and `#340` dedup deletions are
 *     unrecoverable without a backup taken first (`docs/rollback.md`).
 *
 * Every value seeded below is deliberately NON-DEFAULT, because NULL for a
 * threshold and 0 for an enabled flag are exactly the values a dropped column
 * produces. A test seeded with the defaults passes against the broken code
 * (`mem:tests-that-pass-for-the-wrong-reason`).
 */

const dirs: string[] = [];

function freshDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-usage-pause-"));
	dirs.push(dir);
	return join(dir, "test.db");
}

afterEach(() => {
	while (dirs.length > 0) {
		rmSync(dirs.pop() as string, { recursive: true, force: true });
	}
});

/**
 * Non-default seed values. Each is distinct from every other so a list that
 * copies the right number of columns in the wrong order is caught as well as
 * one that drops a column: a shifted list would land 4242 in the weekly slot.
 */
const FIVE_HOUR_THRESHOLD = 42;
const WEEKLY_THRESHOLD = 4242;

type UsagePauseRow = {
	usage_pause_five_hour_threshold: number | null;
	usage_pause_weekly_threshold: number | null;
	usage_pause_five_hour_enabled: number;
	usage_pause_weekly_enabled: number;
};

function readUsagePause(db: Database, id: string): UsagePauseRow {
	return db
		.query(
			`SELECT usage_pause_five_hour_threshold, usage_pause_weekly_threshold,
			        usage_pause_five_hour_enabled, usage_pause_weekly_enabled
			 FROM accounts WHERE id = ?`,
		)
		.get(id) as UsagePauseRow;
}

function columnNames(db: Database): string[] {
	return (
		db.query("PRAGMA table_info(accounts)").all() as { name: string }[]
	).map((c) => c.name);
}

describe("usage_pause columns: account_tier removal rebuild (SB23-2527)", () => {
	/**
	 * Reaching this branch needs `account_tier` present at the moment
	 * `runMigrations` reads the table, and the four columns already populated,
	 * so the rebuild copies real values rather than freshly-defaulted ones.
	 *
	 * The order is: run the migration once to get the production schema, add
	 * `account_tier` back by hand, stamp the four columns, then run again. The
	 * first pass cannot carry values that did not exist before it, so
	 * seed-then-migrate is the only order that observes the copy.
	 */
	function migrateAddTierStampMigrate(): Database {
		const path = freshDbPath();
		const first = new Database(path);
		ensureSchema(first);
		runMigrations(first);
		first.run(
			`INSERT INTO accounts (id, name, provider, refresh_token, created_at)
			 VALUES ('acc-1', 'acc', 'anthropic', 'rt', 1)`,
		);
		// Put the table back into the shape whose guard triggers the rebuild.
		first.run("ALTER TABLE accounts ADD COLUMN account_tier INTEGER DEFAULT 1");
		first.run(
			`UPDATE accounts SET
			   usage_pause_five_hour_threshold = ${FIVE_HOUR_THRESHOLD},
			   usage_pause_weekly_threshold = ${WEEKLY_THRESHOLD},
			   usage_pause_five_hour_enabled = 1,
			   usage_pause_weekly_enabled = 1
			 WHERE id = 'acc-1'`,
		);
		first.close();

		const db = new Database(path);
		runMigrations(db);
		return db;
	}

	it("drops account_tier and keeps all four usage_pause columns", () => {
		const db = migrateAddTierStampMigrate();
		const cols = columnNames(db);

		// The branch actually ran. Without this the test would pass on a database
		// that never entered the rebuild at all, which is the vacuous form.
		expect(cols).not.toContain("account_tier");

		expect(cols).toContain("usage_pause_five_hour_threshold");
		expect(cols).toContain("usage_pause_weekly_threshold");
		expect(cols).toContain("usage_pause_five_hour_enabled");
		expect(cols).toContain("usage_pause_weekly_enabled");
		db.close();
	});

	it("carries all four values through the rebuild unchanged", () => {
		const db = migrateAddTierStampMigrate();
		const row = readUsagePause(db, "acc-1");

		expect(row.usage_pause_five_hour_threshold).toBe(FIVE_HOUR_THRESHOLD);
		expect(row.usage_pause_weekly_threshold).toBe(WEEKLY_THRESHOLD);
		expect(row.usage_pause_five_hour_enabled).toBe(1);
		expect(row.usage_pause_weekly_enabled).toBe(1);
		db.close();
	});

	it("does not reset the thresholds to NULL or the flags to 0", () => {
		// The negative form, stated separately. NULL and 0 are what a dropped
		// column produces, so asserting the correct value alone reads as an
		// accident when the two coincide. These four assertions are what fail if
		// the column is removed from the rebuild list.
		const db = migrateAddTierStampMigrate();
		const row = readUsagePause(db, "acc-1");

		expect(row.usage_pause_five_hour_threshold).not.toBeNull();
		expect(row.usage_pause_weekly_threshold).not.toBeNull();
		expect(row.usage_pause_five_hour_enabled).not.toBe(0);
		expect(row.usage_pause_weekly_enabled).not.toBe(0);
		db.close();
	});

	it("keeps the two thresholds in their own columns", () => {
		// A rebuild list with the right count in the wrong order produces two
		// non-NULL thresholds and passes every assertion above.
		const db = migrateAddTierStampMigrate();
		const row = readUsagePause(db, "acc-1");

		expect(row.usage_pause_five_hour_threshold).not.toBe(WEEKLY_THRESHOLD);
		expect(row.usage_pause_weekly_threshold).not.toBe(FIVE_HOUR_THRESHOLD);
		db.close();
	});
});

describe("usage_pause columns: non-destructive dedup merge (SB23-2527)", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
	});

	afterEach(() => {
		db.close();
	});

	/**
	 * Full production schema, then drop the unique index so the next
	 * `runMigrations` re-enters the dedup block against seeded duplicates
	 * instead of skipping it as a no-op. Same approach as
	 * `migrations-dedup-preserving-state.test.ts`.
	 */
	function setupForDedup(): void {
		ensureSchema(db);
		runMigrations(db);
		db.run(`DROP INDEX IF EXISTS idx_accounts_unique_name_provider_endpoint`);
	}

	/**
	 * Two rows in one dedup group. `keeper` wins survivor selection on
	 * `last_used`, which is the first key in the ORDER BY at migrations.ts:541.
	 *
	 * `other` is given the NEWER `refresh_token_issued_at`, because that is the
	 * first key `freshest()` orders by (migrations.ts:637). So the survivor and
	 * the freshest row are deliberately DIFFERENT rows: a merge that just kept
	 * the survivor's own value, and a merge that just took the freshest, give
	 * different answers, and the COALESCE is the only rule that gives both of
	 * the results asserted below.
	 */
	function seedPair(opts: {
		keeper: Partial<UsagePauseRow>;
		other: Partial<UsagePauseRow>;
	}): void {
		const now = Date.now();
		const insert = db.prepare(
			`INSERT INTO accounts
			   (id, name, provider, custom_endpoint, refresh_token, access_token,
			    created_at, last_used, refresh_token_issued_at,
			    usage_pause_five_hour_threshold, usage_pause_weekly_threshold,
			    usage_pause_five_hour_enabled, usage_pause_weekly_enabled)
			 VALUES (?, 'dup', 'anthropic', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		insert.run(
			"keeper",
			"rt-keeper",
			"at-keeper",
			now - 5000,
			now, // newest last_used: wins survivor selection
			now - 5000, // older token: loses freshest()
			opts.keeper.usage_pause_five_hour_threshold ?? null,
			opts.keeper.usage_pause_weekly_threshold ?? null,
			opts.keeper.usage_pause_five_hour_enabled ?? 0,
			opts.keeper.usage_pause_weekly_enabled ?? 0,
		);
		insert.run(
			"other",
			"rt-other",
			"at-other",
			now - 4000,
			now - 10_000, // older last_used: loses survivor selection
			now, // newest token: wins freshest()
			opts.other.usage_pause_five_hour_threshold ?? null,
			opts.other.usage_pause_weekly_threshold ?? null,
			opts.other.usage_pause_five_hour_enabled ?? 0,
			opts.other.usage_pause_weekly_enabled ?? 0,
		);
	}

	function survivors(): string[] {
		return (
			db.query("SELECT id FROM accounts ORDER BY id").all() as {
				id: string;
			}[]
		).map((r) => r.id);
	}

	it("collapses the group to the expected survivor", () => {
		// Pins the precondition every other test in this describe depends on. If
		// the survivor were `other`, the threshold assertions below would be
		// reading the wrong row and could pass for the wrong reason.
		setupForDedup();
		seedPair({ keeper: {}, other: {} });
		runMigrations(db);

		expect(survivors()).toEqual(["keeper"]);
	});

	it("keeps the survivor's own threshold when it has one", () => {
		// COALESCE's first arm. The discarded row carries a different value, so a
		// merge that unconditionally took the freshest would land 4242 here.
		setupForDedup();
		seedPair({
			keeper: { usage_pause_five_hour_threshold: FIVE_HOUR_THRESHOLD },
			other: { usage_pause_five_hour_threshold: WEEKLY_THRESHOLD },
		});
		runMigrations(db);

		const row = readUsagePause(db, "keeper");
		expect(row.usage_pause_five_hour_threshold).toBe(FIVE_HOUR_THRESHOLD);
		expect(row.usage_pause_five_hour_threshold).not.toBe(WEEKLY_THRESHOLD);
	});

	it("takes the freshest threshold when the survivor has none", () => {
		// COALESCE's second arm, and the one that matters: without it the
		// operator's only copy of the value is deleted with the discarded row.
		// NULL is also what a column missing from the merge policy produces, so
		// this is the assertion that fails if the column is dropped from the
		// UPDATE at migrations.ts:676.
		setupForDedup();
		seedPair({
			keeper: {},
			other: {
				usage_pause_five_hour_threshold: FIVE_HOUR_THRESHOLD,
				usage_pause_weekly_threshold: WEEKLY_THRESHOLD,
			},
		});
		runMigrations(db);

		const row = readUsagePause(db, "keeper");
		expect(row.usage_pause_five_hour_threshold).toBe(FIVE_HOUR_THRESHOLD);
		expect(row.usage_pause_weekly_threshold).toBe(WEEKLY_THRESHOLD);
		expect(row.usage_pause_five_hour_threshold).not.toBeNull();
		expect(row.usage_pause_weekly_threshold).not.toBeNull();
	});

	it("MAXes the enabled flags, so a window enabled on any duplicate stays enabled", () => {
		// The documented policy at migrations.ts:678: these are INTEGER, 0 is a
		// real stored value rather than "unset", and MAX means enabled wins. The
		// survivor holds 0 on both flags and the discarded row holds 1, so
		// keeping the survivor's own value would give 0 and only MAX gives 1.
		setupForDedup();
		seedPair({
			keeper: {
				usage_pause_five_hour_enabled: 0,
				usage_pause_weekly_enabled: 0,
			},
			other: {
				usage_pause_five_hour_enabled: 1,
				usage_pause_weekly_enabled: 1,
			},
		});
		runMigrations(db);

		const row = readUsagePause(db, "keeper");
		expect(row.usage_pause_five_hour_enabled).toBe(1);
		expect(row.usage_pause_weekly_enabled).toBe(1);
		expect(row.usage_pause_five_hour_enabled).not.toBe(0);
		expect(row.usage_pause_weekly_enabled).not.toBe(0);
	});

	it("leaves both flags off when no duplicate had either enabled", () => {
		// The negative direction. Without this, a merge that hardcoded 1 would
		// pass the MAX test above, which is the mutation that survives a
		// positive-only assertion.
		setupForDedup();
		seedPair({ keeper: {}, other: {} });
		runMigrations(db);

		const row = readUsagePause(db, "keeper");
		expect(row.usage_pause_five_hour_enabled).toBe(0);
		expect(row.usage_pause_weekly_enabled).toBe(0);
	});

	it("keeps each flag independent of the other", () => {
		// A merge that read one column for both flags passes every assertion
		// above, because they are set together there.
		setupForDedup();
		seedPair({
			keeper: {},
			other: {
				usage_pause_five_hour_enabled: 1,
				usage_pause_weekly_enabled: 0,
			},
		});
		runMigrations(db);

		const row = readUsagePause(db, "keeper");
		expect(row.usage_pause_five_hour_enabled).toBe(1);
		expect(row.usage_pause_weekly_enabled).toBe(0);
	});
});
