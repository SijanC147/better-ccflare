/**
 * SB23-2575. `--set-usage-pause-thresholds` takes an optional trailing pair of
 * reset hours. Without it the command must behave exactly as before and keep
 * the stored reset conditions; with it, a condition given as off must really be
 * off rather than a remembered number the enabled window would then apply.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "@better-ccflare/core";
import type { UsagePauseSetting } from "@better-ccflare/core";
import {
	BunSqlAdapter,
	type DatabaseOperations,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import { setUsagePauseThresholds } from "../account";

const HOUR = 3_600_000;

describe("setUsagePauseThresholds: reset hours (SB23-2575)", () => {
	let db: Database;
	let dbOps: DatabaseOperations;
	let writes: Array<{ fiveHour: UsagePauseSetting; weekly: UsagePauseSetting }>;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		const adapter = new BunSqlAdapter(db);
		writes = [];
		dbOps = {
			getAdapter: () => adapter,
			setUsagePauseThresholds: async (
				_id: string,
				fiveHour: UsagePauseSetting,
				weekly: UsagePauseSetting,
			) => {
				writes.push({ fiveHour, weekly });
			},
		} as unknown as DatabaseOperations;
		db.run(
			`INSERT INTO accounts (id, name, provider, created_at, usage_pause_five_hour_threshold, usage_pause_five_hour_min_reset_remaining_ms, usage_pause_weekly_min_reset_remaining_ms)
			 VALUES ('acc-1', 'acc', 'anthropic', 1, 70, ${3 * HOUR}, ${48 * HOUR})`,
		);
	});

	afterEach(() => {
		db.close();
	});

	it("the three-argument form keeps the stored reset conditions", async () => {
		const result = await setUsagePauseThresholds(dbOps, "acc", "80", null);
		expect(result.success).toBe(true);
		expect(writes).toStrictEqual([
			{
				fiveHour: { enabled: true, percent: 80, minResetRemainingMs: 3 * HOUR },
				weekly: {
					enabled: false,
					percent: null,
					minResetRemainingMs: 48 * HOUR,
				},
			},
		]);
	});

	it("takes reset hours, converts them to ms, and a reset alone switches the window on", async () => {
		const result = await setUsagePauseThresholds(dbOps, "acc", null, "90", [
			"2",
			"0.5",
		]);
		expect(result.success).toBe(true);
		expect(writes).toStrictEqual([
			{
				// percent given as off with a reset on: off really means off, not the
				// stored 70 the now-enabled window would otherwise apply.
				fiveHour: {
					enabled: true,
					percent: null,
					minResetRemainingMs: 2 * HOUR,
				},
				weekly: { enabled: true, percent: 90, minResetRemainingMs: HOUR / 2 },
			},
		]);
		expect(result.message).toBe(
			"Account 'acc' usage pause thresholds set to 5h=reset >= 2h away, weekly=90% and reset >= 0.5h away",
		);
	});

	it("both conditions off switches the window off and keeps what was stored", async () => {
		await setUsagePauseThresholds(dbOps, "acc", null, null, [null, null]);
		expect(writes[0]?.fiveHour).toStrictEqual({
			enabled: false,
			percent: 70,
			minResetRemainingMs: 3 * HOUR,
		});
	});

	it("rejects negative or non-numeric hours without writing", async () => {
		for (const bad of ["-1", "soon", ""]) {
			const result = await setUsagePauseThresholds(dbOps, "acc", "80", null, [
				bad,
				null,
			]);
			expect(result.success).toBe(false);
			expect(result.message).toBe(
				`Reset hours must be a number of hours of 0 or more, or 'off' (got '${bad}')`,
			);
		}
		expect(writes).toStrictEqual([]);
	});
});
