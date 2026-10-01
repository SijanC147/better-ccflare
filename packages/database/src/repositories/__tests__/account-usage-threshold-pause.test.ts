/**
 * Tests for the guarded usage-threshold pause/resume writes.
 *
 * Both writes are issued from a decision made against an account row read a
 * moment earlier. A manual or overage pause can land in between, and it must
 * win: the pause must not overwrite that reason, and the resume must not clear
 * it. The guards live in the SQL, so they are exercised here against a real
 * SQLite table rather than a mock.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Force @better-ccflare/core to initialise before @better-ccflare/types resolves its
// circular dependency — same pattern as account-pause-reason.test.ts.
import "@better-ccflare/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { AccountRepository } from "../account.repository";

const REASON = "usage_threshold";

function makeDb(): { db: Database; repo: AccountRepository } {
	const db = new Database(":memory:");
	db.run(`
		CREATE TABLE accounts (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			paused INTEGER DEFAULT 0,
			pause_reason TEXT,
			usage_pause_five_hour_threshold INTEGER,
			usage_pause_weekly_threshold INTEGER,
			usage_pause_five_hour_enabled INTEGER NOT NULL DEFAULT 0,
			usage_pause_weekly_enabled INTEGER NOT NULL DEFAULT 0,
			usage_pause_five_hour_min_reset_remaining_ms INTEGER,
			usage_pause_weekly_min_reset_remaining_ms INTEGER
		)
	`);
	return { db, repo: new AccountRepository(new BunSqlAdapter(db)) };
}

function insertAccount(
	db: Database,
	id: string,
	paused = 0,
	pauseReason: string | null = null,
): void {
	db.run(
		`INSERT INTO accounts (id, name, created_at, paused, pause_reason) VALUES (?, ?, ?, ?, ?)`,
		[id, id, Date.now(), paused, pauseReason],
	);
}

function getAccount(
	db: Database,
	id: string,
): { paused: number; pause_reason: string | null } {
	return db
		.query<{ paused: number; pause_reason: string | null }, [string]>(
			"SELECT paused, pause_reason FROM accounts WHERE id = ?",
		)
		.get(id) as { paused: number; pause_reason: string | null };
}

describe("AccountRepository — usage-threshold pause guards", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});

	afterEach(() => {
		db.close();
	});

	describe("pauseForUsageThreshold", () => {
		it("pauses an account that is still running", async () => {
			insertAccount(db, "acc-1");

			await repo.pauseForUsageThreshold("acc-1", REASON);

			expect(getAccount(db, "acc-1")).toStrictEqual({
				paused: 1,
				pause_reason: REASON,
			});
		});

		it("does not overwrite a manual pause that landed first", async () => {
			insertAccount(db, "acc-1", 1, "manual");

			await repo.pauseForUsageThreshold("acc-1", REASON);

			expect(getAccount(db, "acc-1")).toStrictEqual({
				paused: 1,
				pause_reason: "manual",
			});
		});

		it("does not overwrite an overage pause that landed first", async () => {
			insertAccount(db, "acc-1", 1, "overage");

			await repo.pauseForUsageThreshold("acc-1", REASON);

			expect(getAccount(db, "acc-1")).toStrictEqual({
				paused: 1,
				pause_reason: "overage",
			});
		});
	});

	describe("resumeFromUsageThreshold", () => {
		it("resumes an account it paused itself", async () => {
			insertAccount(db, "acc-1", 1, REASON);

			await repo.resumeFromUsageThreshold("acc-1", REASON);

			expect(getAccount(db, "acc-1")).toStrictEqual({
				paused: 0,
				pause_reason: null,
			});
		});

		it("leaves a manual pause alone", async () => {
			insertAccount(db, "acc-1", 1, "manual");

			await repo.resumeFromUsageThreshold("acc-1", REASON);

			expect(getAccount(db, "acc-1")).toStrictEqual({
				paused: 1,
				pause_reason: "manual",
			});
		});

		it("leaves an overage pause alone", async () => {
			insertAccount(db, "acc-1", 1, "overage");

			await repo.resumeFromUsageThreshold("acc-1", REASON);

			expect(getAccount(db, "acc-1")).toStrictEqual({
				paused: 1,
				pause_reason: "overage",
			});
		});

		it("does nothing to an account that is already running", async () => {
			insertAccount(db, "acc-1");

			await repo.resumeFromUsageThreshold("acc-1", REASON);

			expect(getAccount(db, "acc-1")).toStrictEqual({
				paused: 0,
				pause_reason: null,
			});
		});
	});

	describe("setUsagePauseThresholds", () => {
		it("writes both windows together and keeps a percentage when a window is switched off", async () => {
			insertAccount(db, "acc-1");

			await repo.setUsagePauseThresholds(
				"acc-1",
				{ enabled: true, percent: 80, minResetRemainingMs: null },
				{ enabled: true, percent: 90, minResetRemainingMs: null },
			);
			expect(
				db.query("SELECT * FROM accounts WHERE id = ?").get("acc-1") as Record<
					string,
					unknown
				>,
			).toMatchObject({
				usage_pause_five_hour_threshold: 80,
				usage_pause_weekly_threshold: 90,
			});

			expect(
				db.query("SELECT * FROM accounts WHERE id = ?").get("acc-1") as Record<
					string,
					unknown
				>,
			).toMatchObject({
				usage_pause_five_hour_enabled: 1,
				usage_pause_weekly_enabled: 1,
				usage_pause_five_hour_min_reset_remaining_ms: null,
				usage_pause_weekly_min_reset_remaining_ms: null,
			});

			// Switching a window off keeps its number for next time.
			await repo.setUsagePauseThresholds(
				"acc-1",
				{ enabled: false, percent: 80, minResetRemainingMs: null },
				{ enabled: false, percent: null, minResetRemainingMs: null },
			);
			expect(
				db.query("SELECT * FROM accounts WHERE id = ?").get("acc-1") as Record<
					string,
					unknown
				>,
			).toMatchObject({
				usage_pause_five_hour_threshold: 80,
				usage_pause_five_hour_enabled: 0,
				usage_pause_weekly_threshold: null,
				usage_pause_weekly_enabled: 0,
				usage_pause_five_hour_min_reset_remaining_ms: null,
				usage_pause_weekly_min_reset_remaining_ms: null,
			});
		});
	});
});

/**
 * SB23-2575. The reset minimums against the REAL schema rather than the
 * hand-rolled table above, so a column missing from `ensureSchema`,
 * `runMigrations` or either read-side SELECT in the repository fails here. A
 * read-side list that omits a column does not destroy data, it just never
 * reads it, so the only symptom is an account behaving as though its owner
 * never set the value: the read-back is the test.
 */
describe("AccountRepository — usage pause reset minimums read back (SB23-2575)", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		repo = new AccountRepository(new BunSqlAdapter(db));
		db.run(
			`INSERT INTO accounts (id, name, provider, created_at) VALUES ('acc-1', 'acc', 'anthropic', 1)`,
		);
	});

	afterEach(() => {
		db.close();
	});

	it("writes both reset minimums and reads them back through findAll and findById", async () => {
		await repo.setUsagePauseThresholds(
			"acc-1",
			{ enabled: true, percent: null, minResetRemainingMs: 7_200_000 },
			{ enabled: false, percent: 90, minResetRemainingMs: 86_400_000 },
		);

		const [fromAll] = await repo.findAll();
		const fromId = await repo.findById("acc-1");
		for (const account of [fromAll, fromId]) {
			expect(account?.usage_pause_five_hour_min_reset_remaining_ms).toBe(
				7_200_000,
			);
			expect(account?.usage_pause_weekly_min_reset_remaining_ms).toBe(
				86_400_000,
			);
			expect(account?.usage_pause_five_hour_threshold).toBeNull();
			expect(account?.usage_pause_five_hour_enabled).toBe(true);
			expect(account?.usage_pause_weekly_threshold).toBe(90);
			expect(account?.usage_pause_weekly_enabled).toBe(false);
		}
	});

	it("reads a stored 0 back as 0, not as 'condition off'", async () => {
		// 0 ms is legal on a combo slot and here: it holds for any reset still
		// ahead. A converter that treats 0 as unset turns it into null.
		await repo.setUsagePauseThresholds(
			"acc-1",
			{ enabled: true, percent: 80, minResetRemainingMs: 0 },
			{ enabled: false, percent: null, minResetRemainingMs: null },
		);

		const [fromAll] = await repo.findAll();
		const fromId = await repo.findById("acc-1");
		expect(fromAll?.usage_pause_five_hour_min_reset_remaining_ms).toBe(0);
		expect(fromId?.usage_pause_five_hour_min_reset_remaining_ms).toBe(0);
		expect(fromAll?.usage_pause_weekly_min_reset_remaining_ms).toBeNull();
	});
});
