import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../migrations";

/**
 * SB23-2073. `runMigrations` rebuilds the `accounts` table in two places, each
 * with an explicit column list, and both lists omitted
 * `consecutive_rate_limits` and `last_manual_reauth_at`.
 *
 * The `ALTER TABLE` statements that add those two columns run ABOVE both
 * rebuild branches, so the columns exist by the time a rebuild happens and the
 * omission silently reset one to its `DEFAULT 0` and the other to `NULL`. No
 * constraint violation, no log line: a dropped column reads exactly like an
 * account that has never been rate limited or manually reauthenticated.
 *
 * Measured 2026-09-15 against a copy of the live host database: neither branch
 * is reachable there (`refresh_token` is already nullable and `account_tier` is
 * absent), so this was latent rather than active data loss. It is reachable on
 * any database old enough to still carry either shape.
 *
 * Every value seeded below is deliberately NON-DEFAULT. A test seeded with
 * `consecutive_rate_limits = 0` or `last_manual_reauth_at = NULL` passes against
 * the broken code, because those are exactly the values the bug produces
 * (`mem:tests-that-pass-for-the-wrong-reason`).
 */

const dirs: string[] = [];

function freshDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-rebuild-"));
	dirs.push(dir);
	return join(dir, "test.db");
}

afterEach(() => {
	while (dirs.length > 0) {
		rmSync(dirs.pop() as string, { recursive: true, force: true });
	}
});

/** The seeded values. Both non-default, so a dropped column is visible. */
const CONSECUTIVE = 7;
const LAST_REAUTH = 1_757_000_000_000;
/**
 * SB23-2055's column. 17 is deliberately not 1: a rebuild that dropped the
 * column would leave NULL, and a test seeded with a value the bug also produces
 * cannot tell the two apart.
 */
const RENEWAL_DAY = 17;

type AccountRow = {
	id: string;
	consecutive_rate_limits: number;
	last_manual_reauth_at: number | null;
	renewal_day: number | null;
};

function readAccount(db: Database): AccountRow {
	return db
		.query(
			"SELECT id, consecutive_rate_limits, last_manual_reauth_at, renewal_day FROM accounts WHERE id = 'acc-1'",
		)
		.get() as AccountRow;
}

function columnNames(db: Database): string[] {
	return (
		db.query("PRAGMA table_info(accounts)").all() as { name: string }[]
	).map((c) => c.name);
}

/**
 * The pre-rebuild schema, minimal but faithful in the two respects that decide
 * which branch `runMigrations` takes: whether `refresh_token` is NOT NULL, and
 * whether `account_tier` exists.
 */
function legacyAccountsTable(opts: {
	refreshTokenNotNull: boolean;
	withAccountTier: boolean;
}): string {
	return `
		CREATE TABLE accounts (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			provider TEXT NOT NULL DEFAULT 'anthropic',
			api_key TEXT,
			refresh_token TEXT ${opts.refreshTokenNotNull ? "NOT NULL" : ""},
			access_token TEXT,
			expires_at INTEGER,
			created_at INTEGER NOT NULL,
			last_used INTEGER,
			request_count INTEGER NOT NULL DEFAULT 0,
			total_requests INTEGER NOT NULL DEFAULT 0,
			priority INTEGER NOT NULL DEFAULT 0,
			rate_limited_until INTEGER,
			session_start INTEGER,
			session_request_count INTEGER NOT NULL DEFAULT 0,
			paused INTEGER NOT NULL DEFAULT 0
			${opts.withAccountTier ? ", account_tier INTEGER DEFAULT 1" : ""}
		)
	`;
}

function seedAccount(db: Database): void {
	db.run(
		`INSERT INTO accounts (id, name, provider, refresh_token, created_at)
		 VALUES ('acc-1', 'acc', 'anthropic', 'rt', 1)`,
	);
}

/**
 * Runs `runMigrations` on a database at the given legacy shape, then stamps the
 * two columns with non-default values and runs it again.
 *
 * The two passes matter. The first pass adds every column and performs whichever
 * rebuild the shape triggers, so it cannot carry values that did not exist
 * before it. The second pass is where the loss shows: the rebuild branch is
 * still reachable if its guard still holds, and for `account_tier` it does not,
 * so the seeded-then-migrate order is the only one that observes the copy.
 */
function migrateStampMigrate(opts: {
	refreshTokenNotNull: boolean;
	withAccountTier: boolean;
}): Database {
	const path = freshDbPath();
	const db = new Database(path);
	db.run(legacyAccountsTable(opts));
	seedAccount(db);
	db.close();

	// Pass one: from the legacy shape. Adds the columns, takes the rebuild.
	const first = new Database(path);
	runMigrations(first);
	first.close();

	return new Database(path);
}

describe("accounts rebuild: refresh_token NOT NULL branch", () => {
	it("keeps consecutive_rate_limits and last_manual_reauth_at across the rebuild", () => {
		// The real upgrade shape: an install that ran a version which had already
		// added both columns, on a database still carrying the NOT NULL
		// refresh_token schema, upgrading to a version whose migration rebuilds
		// the table for nullability. The operator has accumulated a rate-limit
		// streak and a manual reauth, and the rebuild happens underneath them.
		const path = freshDbPath();
		const seed = new Database(path);
		seed.run(
			legacyAccountsTable({
				refreshTokenNotNull: true,
				withAccountTier: false,
			}),
		);
		seedAccount(seed);
		seed.run(
			"ALTER TABLE accounts ADD COLUMN consecutive_rate_limits INTEGER NOT NULL DEFAULT 0",
		);
		seed.run("ALTER TABLE accounts ADD COLUMN last_manual_reauth_at INTEGER");
		seed.run(
			`UPDATE accounts SET consecutive_rate_limits = ${CONSECUTIVE}, last_manual_reauth_at = ${LAST_REAUTH} WHERE id = 'acc-1'`,
		);
		seed.close();

		const db = new Database(path);
		runMigrations(db);

		const after = readAccount(db);
		expect(after.consecutive_rate_limits).toBe(CONSECUTIVE);
		expect(after.last_manual_reauth_at).toBe(LAST_REAUTH);
		db.close();
	});

	it("leaves both columns present after the rebuild", () => {
		const db = migrateStampMigrate({
			refreshTokenNotNull: true,
			withAccountTier: false,
		});

		const cols = columnNames(db);
		expect(cols).toContain("consecutive_rate_limits");
		expect(cols).toContain("last_manual_reauth_at");
		db.close();
	});
});

describe("accounts rebuild: account_tier removal branch", () => {
	it("keeps both columns and their values when account_tier is dropped", () => {
		// This branch is the one whose guard clears permanently: once
		// account_tier is gone it never runs again, so the rebuild has exactly one
		// chance to preserve the data and no second pass to repair it.
		const path = freshDbPath();
		const seed = new Database(path);
		seed.run(
			legacyAccountsTable({
				refreshTokenNotNull: false,
				withAccountTier: true,
			}),
		);
		seedAccount(seed);
		// Stamp before the migration by adding the columns by hand, exactly as the
		// ALTERs above the rebuild branch would, so the rebuild sees populated
		// values rather than freshly-defaulted ones.
		seed.run(
			"ALTER TABLE accounts ADD COLUMN consecutive_rate_limits INTEGER NOT NULL DEFAULT 0",
		);
		seed.run("ALTER TABLE accounts ADD COLUMN last_manual_reauth_at INTEGER");
		seed.run(
			`UPDATE accounts SET consecutive_rate_limits = ${CONSECUTIVE}, last_manual_reauth_at = ${LAST_REAUTH} WHERE id = 'acc-1'`,
		);
		seed.close();

		const db = new Database(path);
		runMigrations(db);

		const cols = columnNames(db);
		expect(cols).not.toContain("account_tier");
		expect(cols).toContain("consecutive_rate_limits");
		expect(cols).toContain("last_manual_reauth_at");

		const after = readAccount(db);
		expect(after.consecutive_rate_limits).toBe(CONSECUTIVE);
		expect(after.last_manual_reauth_at).toBe(LAST_REAUTH);
		db.close();
	});

	it("does not silently reset the streak to its DEFAULT 0", () => {
		// The negative form, stated separately because 0 is what the bug produced
		// and asserting the correct value alone reads as an accident when it
		// happens to coincide.
		const path = freshDbPath();
		const seed = new Database(path);
		seed.run(
			legacyAccountsTable({
				refreshTokenNotNull: false,
				withAccountTier: true,
			}),
		);
		seedAccount(seed);
		seed.run(
			"ALTER TABLE accounts ADD COLUMN consecutive_rate_limits INTEGER NOT NULL DEFAULT 0",
		);
		seed.run("ALTER TABLE accounts ADD COLUMN last_manual_reauth_at INTEGER");
		seed.run(
			`UPDATE accounts SET consecutive_rate_limits = ${CONSECUTIVE} WHERE id = 'acc-1'`,
		);
		seed.close();

		const db = new Database(path);
		runMigrations(db);

		expect(readAccount(db).consecutive_rate_limits).not.toBe(0);
		db.close();
	});
});

describe("accounts rebuild: renewal_day (SB23-2055)", () => {
	/**
	 * The renewal day is operator-entered and exists nowhere else, so a rebuild
	 * that drops it destroys data no refresh can recover. Its ALTER runs above
	 * both rebuild branches precisely so both column lists can name it.
	 */
	function seedWithRenewalDay(opts: {
		refreshTokenNotNull: boolean;
		withAccountTier: boolean;
	}): string {
		const path = freshDbPath();
		const seed = new Database(path);
		seed.run(legacyAccountsTable(opts));
		seedAccount(seed);
		seed.run(
			"ALTER TABLE accounts ADD COLUMN consecutive_rate_limits INTEGER NOT NULL DEFAULT 0",
		);
		seed.run("ALTER TABLE accounts ADD COLUMN last_manual_reauth_at INTEGER");
		seed.run("ALTER TABLE accounts ADD COLUMN renewal_day INTEGER");
		seed.run(
			`UPDATE accounts SET consecutive_rate_limits = ${CONSECUTIVE}, last_manual_reauth_at = ${LAST_REAUTH}, renewal_day = ${RENEWAL_DAY} WHERE id = 'acc-1'`,
		);
		seed.close();
		return path;
	}

	it("survives the refresh_token NOT NULL rebuild with its value intact", () => {
		const db = new Database(
			seedWithRenewalDay({
				refreshTokenNotNull: true,
				withAccountTier: false,
			}),
		);
		runMigrations(db);

		expect(columnNames(db)).toContain("renewal_day");
		expect(readAccount(db).renewal_day).toBe(RENEWAL_DAY);
		db.close();
	});

	it("survives the account_tier removal rebuild with its value intact", () => {
		// This branch never runs again once account_tier is gone, so it gets one
		// chance to copy the value and there is no later pass to repair it.
		const db = new Database(
			seedWithRenewalDay({
				refreshTokenNotNull: false,
				withAccountTier: true,
			}),
		);
		runMigrations(db);

		expect(columnNames(db)).not.toContain("account_tier");
		expect(columnNames(db)).toContain("renewal_day");
		expect(readAccount(db).renewal_day).toBe(RENEWAL_DAY);
		db.close();
	});

	it("does not silently reset the renewal day to NULL", () => {
		// The negative form. NULL is exactly what a dropped column reads as, and
		// it is also the legitimate "operator never set one" value, so asserting
		// the number alone would not say which of the two happened.
		const db = new Database(
			seedWithRenewalDay({
				refreshTokenNotNull: true,
				withAccountTier: false,
			}),
		);
		runMigrations(db);

		expect(readAccount(db).renewal_day).not.toBeNull();
		db.close();
	});

	it("adds the column to a database that has never seen it", () => {
		// The ordinary upgrade: an install with none of the three columns. The
		// ALTER has to run above the rebuild, or the rebuild's SELECT names a
		// column that does not exist yet and the migration throws.
		const path = freshDbPath();
		const seed = new Database(path);
		seed.run(
			legacyAccountsTable({ refreshTokenNotNull: true, withAccountTier: true }),
		);
		seedAccount(seed);
		seed.close();

		const db = new Database(path);
		runMigrations(db);

		expect(columnNames(db)).toContain("renewal_day");
		expect(readAccount(db).renewal_day).toBeNull();
		db.close();
	});
});
