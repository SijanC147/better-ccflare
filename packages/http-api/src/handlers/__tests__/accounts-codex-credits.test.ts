import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@better-ccflare/config";
import {
	BunSqlAdapter,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import { parseCodexUsageHeaders, usageCache } from "@better-ccflare/providers";
import type { AccountResponse } from "@better-ccflare/types";
import { createAccountsListHandler } from "../accounts";

/**
 * `normalizeCodexUsageData` rebuilds the usage object field by field, so a field
 * it does not name is dropped between the parser and the dashboard with nothing
 * failing. These tests are the reason a parser change alone is not enough:
 * they assert `credits` survives on BOTH paths that reach the handler, the
 * in-memory cache and the reparse of a stored response payload. SB23-2257.
 */

const ACCOUNT_ID = "codex-credits-acct";
const CONFIG = {
	getUsageThrottlingFiveHourEnabled: () => false,
	getUsageThrottlingWeeklyEnabled: () => false,
} as unknown as Config;

type UsageWithCredits = {
	five_hour: { utilization: number | null; resets_at: string | null };
	seven_day: { utilization: number | null; resets_at: string | null };
	credits?: {
		has_credits: boolean;
		unlimited: boolean;
		balance: string | null;
	};
};

describe("GET /api/accounts — Codex credits pass-through", () => {
	let sqlite: Database;
	let adapter: BunSqlAdapter;

	beforeEach(async () => {
		sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		runMigrations(sqlite);
		adapter = new BunSqlAdapter(sqlite);
		// The cache is module-level and shared across tests in the process.
		usageCache.delete(ACCOUNT_ID);
		await adapter.run(
			`INSERT INTO accounts (
				id, name, provider, refresh_token, access_token, expires_at, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				ACCOUNT_ID,
				"Codex credits",
				"codex",
				"refresh-token",
				"access-token",
				Date.now() + 3_600_000,
				Date.now(),
			],
		);
	});

	afterEach(() => {
		usageCache.delete(ACCOUNT_ID);
		sqlite.close();
	});

	function makeHandler() {
		const dbOps = {
			getAdapter: () => adapter,
			getStatsRepository: () => ({
				getSessionStats: async () => new Map(),
			}),
			getLatestUsageSnapshot: async () => null,
		};
		return createAccountsListHandler(dbOps as never, CONFIG);
	}

	async function readUsage(): Promise<UsageWithCredits | null> {
		const response = await makeHandler()();
		const accounts = (await response.json()) as AccountResponse[];
		const account = accounts.find((a) => a.id === ACCOUNT_ID);
		return (account?.usageData as UsageWithCredits | null) ?? null;
	}

	/** A weekly-exhausted window, the state this feature exists to annotate. */
	function exhaustedWindows() {
		return {
			five_hour: {
				utilization: 0,
				resets_at: new Date(Date.now() + 3_600_000).toISOString(),
			},
			seven_day: {
				utilization: 100,
				resets_at: new Date(Date.now() + 129_600_000).toISOString(),
			},
		};
	}

	it("carries credits from the usage cache to the response", async () => {
		usageCache.set(ACCOUNT_ID, {
			...exhaustedWindows(),
			credits: { has_credits: true, unlimited: false, balance: "9.99" },
		} as never);

		const usage = await readUsage();

		expect(usage?.credits).toEqual({
			has_credits: true,
			unlimited: false,
			balance: "9.99",
		});
		// The weekly bar and its reset must survive alongside the credits: the
		// operator reads the balance against the countdown, not instead of it.
		expect(usage?.seven_day.utilization).toBe(100);
		expect(usage?.seven_day.resets_at).not.toBeNull();
	});

	it("reports usageUtilization for a weekly-only Codex payload with no five_hour key", async () => {
		// The parser omits a window the headers did not report, and a Pro
		// account reports only the weekly one. This pins the live path: the
		// handler's normalizeCodexUsageData rebuilds BOTH keys (an absent window
		// becomes UNKNOWN_WINDOW), so the account keeps its utilization whatever
		// shape the cache holds. It does not exercise the shape guard at the
		// anthropic-style branch, which the dashboard tests cover (PR #231
		// review, finding 1); a mutation restoring that guard's two-key
		// conjunction survives this test by design.
		usageCache.set(ACCOUNT_ID, {
			seven_day: {
				utilization: 87,
				resets_at: new Date(Date.now() + 129_600_000).toISOString(),
			},
		} as never);

		const response = await makeHandler()();
		const accounts = (await response.json()) as AccountResponse[];
		const account = accounts.find((a) => a.id === ACCOUNT_ID);

		expect(account?.usageUtilization).toBe(87);
		expect(account?.usageWindow).toBe("seven_day");
		expect(account?.usageData).not.toBeNull();
	});

	it("carries credits stored the way the live proxy path stores them", async () => {
		// The test above hand-builds the cache entry, which proves the normalizer
		// passes `credits` through but says nothing about whether anything ever
		// puts it there. Both production writers store the parser's return value
		// WHOLE — `response-processor.ts` sets `codexUsage` and the on-demand
		// refresher in `apps/server` sets `fetchResult.data` — so this stores
		// exactly that object and asserts the field survives the round trip. A
		// field-by-field rebuild appearing at either writer would kill this test
		// while every other test here stayed green.
		const nowSeconds = Math.floor(Date.now() / 1000);
		const parsed = parseCodexUsageHeaders(
			new Headers({
				"x-codex-secondary-window-minutes": "10080",
				"x-codex-secondary-used-percent": "100",
				"x-codex-secondary-reset-at": String(nowSeconds + 129_600),
				"x-codex-credits-has-credits": "true",
				"x-codex-credits-unlimited": "false",
				"x-codex-credits-balance": "7.25",
			}),
		);
		expect(parsed?.credits).toBeDefined();
		usageCache.set(ACCOUNT_ID, parsed as never);

		const usage = await readUsage();

		expect(usage?.credits).toEqual({
			has_credits: true,
			unlimited: false,
			balance: "7.25",
		});
		expect(usage?.seven_day.utilization).toBe(100);
	});

	it("omits the credits KEY when the cache has none", async () => {
		usageCache.set(ACCOUNT_ID, exhaustedWindows() as never);

		const usage = await readUsage();

		expect(usage).not.toBeNull();
		expect(usage && "credits" in usage).toBe(false);
		expect(usage?.seven_day.utilization).toBe(100);
	});

	it("carries credits recovered from a stored response payload", async () => {
		// The persisted path reparses raw headers, so it exercises the parser and
		// the normalizer together. Nothing is in the cache here.
		const nowSeconds = Math.floor(Date.now() / 1000);
		await adapter.run(
			`INSERT INTO requests (id, timestamp, method, path, account_used, model, success)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				"req-credits",
				Date.now(),
				"POST",
				"/v1/messages",
				ACCOUNT_ID,
				"gpt-5.5",
				1,
			],
		);
		await adapter.run(
			`INSERT INTO request_payloads (id, json, timestamp) VALUES (?, ?, ?)`,
			[
				"req-credits",
				JSON.stringify({
					meta: { timestamp: Date.now() },
					response: {
						status: 200,
						headers: {
							"x-codex-primary-window-minutes": "300",
							"x-codex-primary-used-percent": "0",
							"x-codex-primary-reset-at": String(nowSeconds + 3600),
							"x-codex-secondary-window-minutes": "10080",
							"x-codex-secondary-used-percent": "100",
							"x-codex-secondary-reset-at": String(nowSeconds + 129_600),
							"x-codex-credits-has-credits": "true",
							"x-codex-credits-unlimited": "false",
							"x-codex-credits-balance": "42.50",
						},
					},
				}),
				Date.now(),
			],
		);

		const usage = await readUsage();

		expect(usage?.credits).toEqual({
			has_credits: true,
			unlimited: false,
			balance: "42.50",
		});
		expect(usage?.seven_day.utilization).toBe(100);
	});

	it("does not let a STALE stored balance reach the routing cache", async () => {
		// MUST-FIX 1 from PR #236's review. These rows are stored request
		// payloads of arbitrary age and there is no age filter on them, so this
		// path can reparse a balance from days ago. Before the fix it was
		// installed into `usageCache` undated, which reads as "observed just
		// now", and since SB23-2289 a fresh positive balance ADMITS an account
		// whose weekly window is spent. The trigger is a plain dashboard poll of
		// GET /api/accounts after any restart, so it needed nobody to do
		// anything unusual, and it repeats every time the entry expires.
		//
		// `normalizeCodexUsageData` drops a WINDOW whose resets_at has passed;
		// credits carry no resets_at, so nothing else here ages them.
		const nowSeconds = Math.floor(Date.now() / 1000);
		const longAgo = Date.now() - 24 * 60 * 60 * 1000;
		await adapter.run(
			`INSERT INTO requests (id, timestamp, method, path, account_used, model, success)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				"req-stale-credits",
				longAgo,
				"POST",
				"/v1/messages",
				ACCOUNT_ID,
				"gpt-5.5",
				1,
			],
		);
		await adapter.run(
			`INSERT INTO request_payloads (id, json, timestamp) VALUES (?, ?, ?)`,
			[
				"req-stale-credits",
				JSON.stringify({
					meta: { timestamp: longAgo },
					response: {
						status: 200,
						headers: {
							"x-codex-primary-window-minutes": "300",
							"x-codex-primary-used-percent": "0",
							"x-codex-primary-reset-at": String(nowSeconds + 3600),
							"x-codex-secondary-window-minutes": "10080",
							"x-codex-secondary-used-percent": "100",
							"x-codex-secondary-reset-at": String(nowSeconds + 129_600),
							"x-codex-credits-has-credits": "true",
							"x-codex-credits-unlimited": "false",
							"x-codex-credits-balance": "42.50",
						},
					},
				}),
				longAgo,
			],
		);

		await readUsage();

		// The cache is what account selection reads. A day-old balance must not
		// be in it, however fresh the entry that carries it.
		const routed = usageCache.get(ACCOUNT_ID) as UsageWithCredits | null;
		expect(routed).not.toBeNull();
		expect(routed && "credits" in routed).toBe(false);
		// The windows themselves are untouched: this withholds a stale balance,
		// it does not discard the usage reading beside it.
		expect(routed?.seven_day.utilization).toBe(100);
	});

	it("omits the credits key on the persisted path when no credit header was stored", async () => {
		const nowSeconds = Math.floor(Date.now() / 1000);
		await adapter.run(
			`INSERT INTO requests (id, timestamp, method, path, account_used, model, success)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				"req-nocredits",
				Date.now(),
				"POST",
				"/v1/messages",
				ACCOUNT_ID,
				"gpt-5.5",
				1,
			],
		);
		await adapter.run(
			`INSERT INTO request_payloads (id, json, timestamp) VALUES (?, ?, ?)`,
			[
				"req-nocredits",
				JSON.stringify({
					meta: { timestamp: Date.now() },
					response: {
						status: 200,
						headers: {
							"x-codex-secondary-window-minutes": "10080",
							"x-codex-secondary-used-percent": "100",
							"x-codex-secondary-reset-at": String(nowSeconds + 129_600),
						},
					},
				}),
				Date.now(),
			],
		);

		const usage = await readUsage();

		expect(usage).not.toBeNull();
		expect(usage && "credits" in usage).toBe(false);
	});
});
