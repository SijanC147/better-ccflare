/**
 * `GET /api/analytics` over a real in-memory SQLite database, for the one
 * question a stub cannot answer: how a NULL `billing_type` is bucketed.
 *
 * `analytics-account-costs.test.ts` and `analytics-burn-rate.test.ts` drive
 * this same handler through a stubbed `db`, so the rows they assert on are the
 * rows they handed in. Every claim here is a claim about the SQL, so a stub
 * would let a mutation to the predicate survive untouched.
 *
 * `analytics-models.test.ts` already covers the seventh predicate, in
 * `analytics-models.ts`. This file covers the other six, all in
 * `analytics.ts`: the `filtered_requests` totals (:74), the burn-rate 7d and
 * 30d costs and `first_api_ts` (:105, :107, :109), the time series (:164) and
 * the per-account breakdown (:238).
 *
 * A NULL reaches `requests.billing_type` in ordinary traffic: `UsageCollector`
 * assigns `state.billingType` only on the response-headers path, so a request
 * that fails before headers arrive leaves it undefined and `insertRequest`
 * writes `data.billingType || null`. On the live host every such row is a 429.
 * The rows below carry cost so the arithmetic is visible, which a real 429
 * would not.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import {
	BunSqlAdapter,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import type { APIContext } from "../../types";
import { createAnalyticsHandler } from "../analytics";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

let db: Database;
let context: APIContext;

/**
 * Raw SQL on purpose. Every insert helper in this suite defaults a missing
 * billing type to "api", so none of them can express the case under test.
 */
function insertRow(opts: {
	id: string;
	timestamp: number;
	billingType: string | null;
	costUsd: number;
	accountUsed?: string;
}): void {
	db.run(
		`INSERT INTO requests
			(id, timestamp, method, path, account_used, status_code, success,
			 response_time_ms, failover_attempts, model, total_tokens, cost_usd,
			 billing_type)
		 VALUES (?, ?, 'POST', '/v1/messages', ?, 200, 1, 100, 0, 'a-model', 10, ?, ?)`,
		[
			opts.id,
			opts.timestamp,
			opts.accountUsed ?? "acct-1",
			opts.costUsd,
			opts.billingType,
		],
	);
}

async function analytics(query: string) {
	const response = await createAnalyticsHandler(context)(
		new URLSearchParams(query),
	);
	expect(response.status).toBe(200);
	return response.json();
}

beforeEach(() => {
	db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	const adapter = new BunSqlAdapter(db);
	context = {
		db: adapter,
		config: {} as APIContext["config"],
		dbOps: {
			getAdapter: () => adapter,
		} as unknown as APIContext["dbOps"],
		alertService: {} as APIContext["alertService"],
	};
});

describe("GET /api/analytics — a NULL billing_type counts as api", () => {
	it("makes the top-level totals sum: plan + api equals total (:74)", async () => {
		const now = Date.now();
		insertRow({
			id: "plan-row",
			timestamp: now - HOUR_MS,
			billingType: "plan",
			costUsd: 2,
		});
		insertRow({
			id: "null-row",
			timestamp: now - HOUR_MS,
			billingType: null,
			costUsd: 5,
		});

		const { totals } = await analytics("range=24h");

		expect(totals.planCostUsd).toBe(2);
		expect(totals.apiCostUsd).toBe(5);
		expect(totals.totalCostUsd).toBe(7);
		// The invariant the bare `billing_type != 'plan'` broke: before the
		// fix apiCostUsd was 0 here and the two buckets fell 5 short.
		expect(totals.planCostUsd + totals.apiCostUsd).toBe(totals.totalCostUsd);
	});

	it("makes each per-account row sum (:238)", async () => {
		const now = Date.now();
		insertRow({
			id: "acct-null",
			timestamp: now - HOUR_MS,
			billingType: null,
			costUsd: 4,
			accountUsed: "acct-1",
		});
		insertRow({
			id: "acct-plan",
			timestamp: now - HOUR_MS,
			billingType: "plan",
			costUsd: 1,
			accountUsed: "acct-1",
		});

		const { accountPerformance } = await analytics("range=24h");
		const row = accountPerformance[0];

		expect(row.apiCostUsd).toBe(4);
		expect(row.planCostUsd).toBe(1);
		expect(row.planCostUsd + row.apiCostUsd).toBe(row.totalCostUsd);
	});

	it("makes each time-series bucket sum (:164)", async () => {
		const now = Date.now();
		insertRow({
			id: "ts-null",
			timestamp: now - HOUR_MS,
			billingType: null,
			costUsd: 3,
		});

		const { timeSeries } = await analytics("range=24h");
		const withCost = timeSeries.filter(
			(p: { costUsd: number }) => p.costUsd > 0,
		);

		expect(withCost.length).toBeGreaterThan(0);
		for (const point of withCost) {
			expect(point.planCostUsd + point.apiCostUsd).toBe(point.costUsd);
		}
	});

	it("feeds the api burn rate numerator (:105, :107)", async () => {
		const now = Date.now();
		insertRow({
			id: "burn-null",
			timestamp: now - 2.5 * DAY_MS,
			billingType: null,
			costUsd: 6,
		});

		const { totals } = await analytics("range=24h");

		expect(totals.avgDailyApiCostUsd).toBeGreaterThan(0);
		expect(totals.avgWeeklyApiCostUsd).toBeGreaterThan(0);
		// The plan side is untouched by this change and has no row.
		expect(totals.avgDailyPlanCostUsd).toBe(0);
		expect(totals.avgWeeklyPlanCostUsd).toBe(0);
	});

	it("feeds first_api_ts, the burn-rate DIVISOR, not only the numerator (:109)", async () => {
		const now = Date.now();
		// `> 0` cannot pin :109. effectiveBurnRateDays returns the FULL window
		// when firstTs is null, so a broken :109 still divides by something and
		// still yields a positive rate. Only the exact divisor separates them.
		//
		// The row sits 2.5 days back, deliberately off a day boundary: the
		// handler reads its own `nowMs` microseconds after this timestamp is
		// computed, and `Math.ceil` on an exact 2.0 would tip to 3 on any
		// drift. At 2.5 the ceiling is 3 whichever side the jitter falls.
		//
		//   :109 working -> first_api_ts is the row, divisor ceil(2.5) = 3,
		//                   avgDaily = 6/3 = 2, avgWeekly = (6/3)*7 = 14.
		//   :109 broken  -> first_api_ts is NULL, divisor is the whole window,
		//                   avgDaily = 6/7 = 0.857, avgWeekly = (6/30)*7 = 1.4.
		insertRow({
			id: "divisor-null",
			timestamp: now - 2.5 * DAY_MS,
			billingType: null,
			costUsd: 6,
		});

		const { totals } = await analytics("range=24h");

		expect(totals.avgDailyApiCostUsd).toBeCloseTo(2, 6);
		expect(totals.avgWeeklyApiCostUsd).toBeCloseTo(14, 6);
	});
});
