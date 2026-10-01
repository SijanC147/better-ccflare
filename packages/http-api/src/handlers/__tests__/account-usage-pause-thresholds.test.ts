/**
 * SB23-2575. `POST /api/accounts/:id/usage-pause-thresholds` gained a reset
 * condition beside each window's percent, and `GET /api/accounts` builds its
 * response object inside the list handler, so both are covered here: the write
 * path's validation and keep-stored rules, and the list handler's copy of the
 * new fields (the only copy, and the one the dashboard reads).
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Side-effect import: load @better-ccflare/core before @better-ccflare/types
// (types/agent.ts runtime-imports core while core/strategy.ts imports types).
import "@better-ccflare/core";
import type { Config } from "@better-ccflare/config";
import type { UsagePauseSetting } from "@better-ccflare/core";
import {
	BunSqlAdapter,
	type DatabaseOperations,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import { MAX_MIN_RESET_REMAINING_MS } from "@better-ccflare/types";
import {
	createAccountsListHandler,
	createAccountUsagePauseThresholdsHandler,
} from "../accounts";

const HOUR = 3_600_000;

describe("usage pause thresholds: reset condition (SB23-2575)", () => {
	let db: Database;
	let writes: Array<{ fiveHour: UsagePauseSetting; weekly: UsagePauseSetting }>;
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		const adapter = new BunSqlAdapter(db);
		writes = [];
		dbOps = {
			getAdapter: () => adapter,
			getStatsRepository: () => ({
				getSessionStats: async () => new Map(),
			}),
			setUsagePauseThresholds: async (
				_id: string,
				fiveHour: UsagePauseSetting,
				weekly: UsagePauseSetting,
			) => {
				writes.push({ fiveHour, weekly });
				await adapter.run(
					`UPDATE accounts SET usage_pause_five_hour_threshold = ?, usage_pause_five_hour_enabled = ?, usage_pause_five_hour_min_reset_remaining_ms = ?, usage_pause_weekly_threshold = ?, usage_pause_weekly_enabled = ?, usage_pause_weekly_min_reset_remaining_ms = ? WHERE id = ?`,
					[
						fiveHour.percent,
						fiveHour.enabled ? 1 : 0,
						fiveHour.minResetRemainingMs,
						weekly.percent,
						weekly.enabled ? 1 : 0,
						weekly.minResetRemainingMs,
						_id,
					],
				);
			},
		} as unknown as DatabaseOperations;
		db.run(
			`INSERT INTO accounts (id, name, provider, created_at) VALUES ('acc-1', 'acc', 'anthropic', 1)`,
		);
	});

	afterEach(() => {
		db.close();
	});

	async function post(body: unknown): Promise<Response> {
		const handler = createAccountUsagePauseThresholdsHandler(dbOps);
		return handler(
			new Request(
				"http://localhost/api/accounts/acc-1/usage-pause-thresholds",
				{
					method: "POST",
					body: JSON.stringify(body),
				},
			),
			"acc-1",
		);
	}

	it("stores a reset-only window, which the slot rule allows", async () => {
		const res = await post({
			fiveHour: { enabled: true, percent: null, minResetRemainingMs: 2 * HOUR },
			weekly: { enabled: false, percent: null, minResetRemainingMs: null },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.usagePauseFiveHourMinResetRemainingMs).toBe(2 * HOUR);
		expect(body.usagePauseFiveHourThreshold).toBeNull();
		expect(body.usagePauseFiveHourEnabled).toBe(true);
		expect(writes).toStrictEqual([
			{
				fiveHour: {
					enabled: true,
					percent: null,
					minResetRemainingMs: 2 * HOUR,
				},
				weekly: { enabled: false, percent: null, minResetRemainingMs: null },
			},
		]);
	});

	it("accepts 0 and the ceiling, the slot field's inclusive bounds", async () => {
		const res = await post({
			fiveHour: { enabled: true, percent: 80, minResetRemainingMs: 0 },
			weekly: {
				enabled: true,
				percent: null,
				minResetRemainingMs: MAX_MIN_RESET_REMAINING_MS,
			},
		});
		expect(res.status).toBe(200);
		expect(writes[0]?.fiveHour.minResetRemainingMs).toBe(0);
		expect(writes[0]?.weekly.minResetRemainingMs).toBe(
			MAX_MIN_RESET_REMAINING_MS,
		);
	});

	it("refuses a value above the ceiling, a negative and a fraction with the slot handler's message", async () => {
		for (const bad of [MAX_MIN_RESET_REMAINING_MS + 1, -1, 1.5]) {
			const res = await post({
				fiveHour: { enabled: true, percent: 80, minResetRemainingMs: bad },
				weekly: { enabled: false, percent: null },
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error?: string; message?: string };
			expect(JSON.stringify(body)).toContain(
				`minResetRemainingMs must be an integer between 0 and ${MAX_MIN_RESET_REMAINING_MS}, or null`,
			);
		}
		expect(writes).toStrictEqual([]);
	});

	it("refuses a window switched on with neither condition", async () => {
		const res = await post({
			fiveHour: { enabled: true, percent: null, minResetRemainingMs: null },
			weekly: { enabled: false, percent: null },
		});
		expect(res.status).toBe(400);
		expect(JSON.stringify(await res.json())).toContain(
			"fiveHour is switched on with no condition: set percent, minResetRemainingMs, or both",
		);
		expect(writes).toStrictEqual([]);
	});

	it("keeps the stored reset minimum when the field is omitted, and clears it on an explicit null", async () => {
		db.run(
			`UPDATE accounts SET usage_pause_five_hour_threshold = 80, usage_pause_five_hour_enabled = 1, usage_pause_five_hour_min_reset_remaining_ms = ${3 * HOUR} WHERE id = 'acc-1'`,
		);

		// Flip the window off without resending either number.
		expect((await post({ fiveHour: { enabled: false } })).status).toBe(200);
		expect(writes[0]?.fiveHour).toStrictEqual({
			enabled: false,
			percent: 80,
			minResetRemainingMs: 3 * HOUR,
		});

		expect(
			(
				await post({
					fiveHour: { enabled: true, percent: 80, minResetRemainingMs: null },
				})
			).status,
		).toBe(200);
		expect(writes[1]?.fiveHour).toStrictEqual({
			enabled: true,
			percent: 80,
			minResetRemainingMs: null,
		});
	});

	it("keeps the stored reset minimum for a bare-percentage client", async () => {
		db.run(
			`UPDATE accounts SET usage_pause_weekly_min_reset_remaining_ms = ${5 * HOUR} WHERE id = 'acc-1'`,
		);
		expect((await post({ fiveHour: null, weekly: 90 })).status).toBe(200);
		expect(writes[0]?.weekly).toStrictEqual({
			enabled: true,
			percent: 90,
			minResetRemainingMs: 5 * HOUR,
		});
	});

	it("serves both reset minimums on GET /api/accounts, a stored 0 as 0", async () => {
		db.run(
			`UPDATE accounts SET usage_pause_five_hour_min_reset_remaining_ms = 0, usage_pause_weekly_min_reset_remaining_ms = ${24 * HOUR} WHERE id = 'acc-1'`,
		);
		const list = createAccountsListHandler(dbOps, {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
		} as unknown as Config);
		const res = await list();
		expect(res.status).toBe(200);
		const [account] = (await res.json()) as Array<Record<string, unknown>>;
		expect(account?.usagePauseFiveHourMinResetRemainingMs).toBe(0);
		expect(account?.usagePauseWeeklyMinResetRemainingMs).toBe(24 * HOUR);
	});

	// SB23-3686: xAI reports no 5-hour window, so switching one on would store
	// a setting the poller drops on every snapshot.
	it("refuses to switch on a window the provider does not report (xAI 5-hour)", async () => {
		db.run(`UPDATE accounts SET provider = 'xai' WHERE id = 'acc-1'`);
		const res = await post({
			fiveHour: { enabled: true, percent: 80, minResetRemainingMs: null },
			weekly: { enabled: false, percent: null, minResetRemainingMs: null },
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string; message?: string };
		expect(JSON.stringify(body)).toContain(
			"Provider 'xai' does not report a 5-hour usage window, so it cannot be switched on; its one window, Grok credits, is the weekly slot",
		);
		expect(writes).toStrictEqual([]);
	});

	it("stores an xAI credits (weekly) window, with the 5-hour window off", async () => {
		db.run(`UPDATE accounts SET provider = 'xai' WHERE id = 'acc-1'`);
		const res = await post({
			fiveHour: { enabled: false, percent: 50, minResetRemainingMs: null },
			weekly: { enabled: true, percent: 80, minResetRemainingMs: 24 * HOUR },
		});
		expect(res.status).toBe(200);
		expect(writes).toStrictEqual([
			{
				fiveHour: { enabled: false, percent: 50, minResetRemainingMs: null },
				weekly: { enabled: true, percent: 80, minResetRemainingMs: 24 * HOUR },
			},
		]);
	});
});
