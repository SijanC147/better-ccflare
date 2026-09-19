/**
 * `GET /api/analytics/models` over a real in-memory SQLite database.
 *
 * The neighbouring analytics tests (`analytics-account-costs.test.ts`,
 * `analytics-burn-rate.test.ts`) stub `db.query` and assert the row mapping.
 * That cannot work here: every claim this endpoint makes is a claim about the
 * SQL — the missing `LIMIT`, the window, the denominator of the average, the
 * `billing_type` split. A stub returns whatever rows the test hands it no
 * matter what the query says, so a mutation to the SQL would survive every
 * assertion. The schema is built with `ensureSchema` + `runMigrations` and the
 * handler runs against it through `BunSqlAdapter`, exactly as the server does.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import {
	BunSqlAdapter,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import { NO_ACCOUNT_ID } from "@better-ccflare/types";
import type { APIContext } from "../../types";
import { createAnalyticsModelsHandler } from "../analytics-models";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

let db: Database;
let context: APIContext;

type RequestRow = {
	id: string;
	timestamp?: number;
	accountUsed?: string | null;
	model?: string | null;
	success?: boolean;
	inputTokens?: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	costUsd?: number;
	billingType?: string | null;
	tokensPerSecond?: number | null;
	project?: string | null;
};

function insertRequest(row: RequestRow): void {
	db.run(
		`INSERT INTO requests
			(id, timestamp, method, path, account_used, status_code, success,
			 response_time_ms, failover_attempts, model, input_tokens,
			 cache_read_input_tokens, cache_creation_input_tokens, output_tokens,
			 total_tokens, cost_usd, billing_type, output_tokens_per_second, project)
		 VALUES (?, ?, 'POST', '/v1/messages', ?, 200, ?, 100, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			row.id,
			row.timestamp ?? Date.now() - HOUR_MS,
			row.accountUsed ?? null,
			(row.success ?? true) ? 1 : 0,
			row.model ?? null,
			row.inputTokens ?? 0,
			row.cacheReadTokens ?? 0,
			row.cacheCreationTokens ?? 0,
			row.outputTokens ?? 0,
			row.totalTokens ?? 0,
			row.costUsd ?? 0,
			row.billingType ?? "api",
			row.tokensPerSecond ?? null,
			row.project ?? null,
		],
	);
}

async function call(query: string): Promise<Response> {
	return createAnalyticsModelsHandler(context)(new URLSearchParams(query));
}

async function rowsFor(query: string) {
	const response = await call(query);
	expect(response.status).toBe(200);
	const body = await response.json();
	return body.models as Array<Record<string, number | string | null>>;
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

describe("GET /api/analytics/models — no cap", () => {
	it("returns every model in the window, past the ten the analytics report caps at", async () => {
		// 12 > the LIMIT 10 that model_distribution, cost_by_model and
		// modelPerformance all carry inside /api/analytics.
		for (let i = 0; i < 12; i++) {
			insertRequest({ id: `r${i}`, model: `model-${i}`, totalTokens: 10 });
		}

		const rows = await rowsFor("range=24h");

		expect(rows).toHaveLength(12);
		expect(new Set(rows.map((r) => r.model)).size).toBe(12);
	});
});

describe("GET /api/analytics/models — plan-billed models survive", () => {
	it("keeps a model whose every request cost 0 USD on a plan", async () => {
		// /api/analytics drops these: cost_by_model filters
		// `COALESCE(cost_usd, 0) > 0` (analytics.ts:266), so a plan-billed
		// model has no cost row at all and its tokens are invisible there.
		insertRequest({
			id: "plan-1",
			model: "plan-model",
			billingType: "plan",
			costUsd: 0,
			inputTokens: 700,
			outputTokens: 300,
			totalTokens: 1000,
		});
		insertRequest({
			id: "api-1",
			model: "api-model",
			billingType: "api",
			costUsd: 0.5,
			totalTokens: 200,
		});

		const rows = await rowsFor("range=24h");
		const plan = rows.find((r) => r.model === "plan-model");
		const api = rows.find((r) => r.model === "api-model");

		expect(plan).toBeDefined();
		expect(plan?.totalTokens).toBe(1000);
		expect(plan?.inputTokens).toBe(700);
		expect(plan?.outputTokens).toBe(300);
		expect(plan?.planCostUsd).toBe(0);
		expect(plan?.apiCostUsd).toBe(0);
		expect(plan?.totalCostUsd).toBe(0);

		expect(api?.apiCostUsd).toBe(0.5);
		expect(api?.planCostUsd).toBe(0);
	});

	it("splits cost by billing_type on a model billed both ways", async () => {
		insertRequest({
			id: "m1",
			model: "mixed",
			billingType: "plan",
			costUsd: 1.25,
		});
		insertRequest({
			id: "m2",
			model: "mixed",
			billingType: "api",
			costUsd: 2.75,
		});

		const [row] = await rowsFor("range=24h");

		expect(row.planCostUsd).toBe(1.25);
		expect(row.apiCostUsd).toBe(2.75);
		expect(row.totalCostUsd).toBe(4);
	});
});

describe("GET /api/analytics/models — a NULL billing_type", () => {
	it("counts the cost as api, so plan + api equals the total", async () => {
		// `billing_type = 'plan'` and a bare `billing_type != 'plan'` are BOTH
		// false against NULL in SQL three-valued logic, so before SB23-2297 a
		// NULL-billed request landed in neither CASE branch while
		// SUM(COALESCE(cost_usd, 0)) still counted it, and plan + api fell
		// short of the total by exactly the NULL-billed spend.
		//
		// The query now reads COALESCE(billing_type, 'api'), matching the
		// column's own schema default and stats.repository.ts, so the two
		// buckets sum to the total for every row.
		//
		// Written with raw SQL on purpose: the local insertRequest helper
		// above defaults billingType to "api", so it cannot express the case
		// this test is about. The production insertRequest does NOT coerce;
		// it writes `data.billingType || null`, so a NULL is reachable in
		// ordinary traffic. Every NULL row on the live host is a 429 that
		// failed before response headers arrived.
		db.run(
			`INSERT INTO requests (id, timestamp, method, path, status_code, success, model, cost_usd, billing_type)
			 VALUES ('null-billing', ?, 'POST', '/v1/messages', 200, 1, 'unknown-billing', 7, NULL)`,
			[Date.now() - HOUR_MS],
		);

		const [row] = await rowsFor("range=24h");

		expect(row.planCostUsd).toBe(0);
		expect(row.apiCostUsd).toBe(7);
		expect(row.totalCostUsd).toBe(7);
		expect((row.planCostUsd as number) + (row.apiCostUsd as number)).toBe(
			row.totalCostUsd as number,
		);
	});
});

describe("GET /api/analytics/models — a third billing_type", () => {
	it("counts anything that is not 'plan' as api cost", async () => {
		// `api_cost_usd` is `billing_type != 'plan'`, not `= 'api'`. With only
		// 'plan' and 'api' ever inserted those two predicates are
		// indistinguishable, so a third value is what pins the one actually
		// written. Under `= 'api'` this cost would vanish from apiCostUsd
		// while still appearing in totalCostUsd, and nothing else would notice.
		insertRequest({
			id: "third-billing",
			model: "third",
			billingType: "credits",
			costUsd: 3,
		});

		const [row] = await rowsFor("range=24h");

		expect(row.apiCostUsd).toBe(3);
		expect(row.planCostUsd).toBe(0);
		expect(row.totalCostUsd).toBe(3);
	});
});

describe("GET /api/analytics/models — a NULL success", () => {
	it("counts the row as neither a success nor, by subtraction, a silent loss", async () => {
		// `success` is BOOLEAN with no NOT NULL and no default
		// (migrations.ts:143), so a NULL is storable. `success = TRUE` is
		// false against it, so successRequests excludes the row while
		// COUNT(*) includes it, and errorRequests is computed in TypeScript
		// as requests - successRequests. A NULL therefore reports as an
		// error rather than vanishing, which is the safer of the two
		// readings and is pinned here because nothing else states it.
		db.run(
			`INSERT INTO requests (id, timestamp, method, path, status_code, success, model, total_tokens)
			 VALUES ('null-success', ?, 'POST', '/v1/messages', 200, NULL, 'tri-state', 500)`,
			[Date.now() - HOUR_MS],
		);
		insertRequest({
			id: "real-success",
			model: "tri-state",
			success: true,
			totalTokens: 100,
		});

		// A stored integer that is neither 0 nor 1. This is what separates
		// `success = TRUE` from `success != FALSE`: against 2 the first is
		// false and the second is true, while against NULL both are false, so
		// the NULL row above cannot tell the two predicates apart on its own.
		db.run(
			`INSERT INTO requests (id, timestamp, method, path, status_code, success, model, total_tokens)
			 VALUES ('two-success', ?, 'POST', '/v1/messages', 200, 2, 'tri-state', 900)`,
			[Date.now() - HOUR_MS],
		);

		const [row] = await rowsFor("range=24h");

		expect(row.requests).toBe(3);
		expect(row.successRequests).toBe(1);
		expect(row.errorRequests).toBe(2);
		// requests and successRequests are both SQL counts, so the
		// subtraction cannot go negative and cannot lose a row.
		expect(
			(row.successRequests as number) + (row.errorRequests as number),
		).toBe(row.requests);
		// Neither the NULL row nor the 2 row reaches the successful average.
		expect(row.avgTotalTokensPerSuccess).toBe(100);
	});
});

describe("GET /api/analytics/models — the models filter", () => {
	it("returns exactly the named models, using the shared `models` parameter", async () => {
		// Same parameter name buildRequestFilters reads (query-filters.ts:98).
		for (const model of ["alpha", "beta", "gamma"]) {
			insertRequest({ id: `f-${model}`, model });
		}

		const rows = await rowsFor("range=24h&models=alpha,beta");

		expect(rows.map((r) => r.model).sort()).toEqual(["alpha", "beta"]);
	});
});

describe("GET /api/analytics/models — the range window", () => {
	it("excludes a request older than the range", async () => {
		// This is the whereClause guard. Replacing the handler's
		// buildRequestFilters clause with `1=1` makes `stale` appear.
		insertRequest({
			id: "fresh",
			model: "fresh-model",
			timestamp: Date.now() - HOUR_MS,
		});
		insertRequest({
			id: "stale",
			model: "stale-model",
			timestamp: Date.now() - 2 * DAY_MS,
		});

		const rows = await rowsFor("range=24h");

		expect(rows.map((r) => r.model)).toEqual(["fresh-model"]);
	});

	it("widens to include it at range=7d", async () => {
		insertRequest({
			id: "fresh",
			model: "fresh-model",
			timestamp: Date.now() - HOUR_MS,
		});
		insertRequest({
			id: "stale",
			model: "stale-model",
			timestamp: Date.now() - 2 * DAY_MS,
		});

		const rows = await rowsFor("range=7d");

		expect(rows.map((r) => r.model).sort()).toEqual([
			"fresh-model",
			"stale-model",
		]);
	});
});

describe("GET /api/analytics/models — the token average denominator", () => {
	/**
	 * Every token column carries `DEFAULT 0` and the collector writes `?? 0`
	 * before the insert, so a request that reported no usage is stored as a
	 * real zero, not NULL. A NULL-skipping aggregate protects nothing: only
	 * naming the denominator does.
	 *
	 * Fixture: two successful rows at 1000 and 3000 total tokens, one failed
	 * row at 0. Over successful rows the average is 4000 / 2 = 2000. Over
	 * COUNT(*) it is 4000 / 3 = 1333.33…, so swapping the denominator for
	 * COUNT(*) moves the number and this test fails.
	 */
	beforeEach(() => {
		insertRequest({
			id: "ok-1",
			model: "avg-model",
			success: true,
			totalTokens: 1000,
		});
		insertRequest({
			id: "ok-2",
			model: "avg-model",
			success: true,
			totalTokens: 3000,
		});
		insertRequest({
			id: "failed",
			model: "avg-model",
			success: false,
			totalTokens: 0,
		});
	});

	it("averages total tokens over successful requests only", async () => {
		const [row] = await rowsFor("range=24h");

		expect(row.requests).toBe(3);
		expect(row.successRequests).toBe(2);
		expect(row.errorRequests).toBe(1);
		expect(row.avgTotalTokensPerSuccess).toBe(2000);
	});

	it("does not average over COUNT(*)", async () => {
		// Stated as its own assertion so the failure message names the defect
		// rather than only reporting a number that moved.
		const [row] = await rowsFor("range=24h");
		const overAllRows = 4000 / 3;

		expect(row.avgTotalTokensPerSuccess).not.toBeCloseTo(overAllRows, 5);
	});

	it("promotes the division so a non-exact average keeps its fraction", async () => {
		// The `* 1.0` in the SQL is the whole reason this value is not an
		// integer, and the 4000/2 fixture above cannot see it: both engines
		// integer-divide two integers, so dropping the promotion truncates
		// silently and an exact division looks identical either way.
		//
		// Three successful rows totalling 1000 tokens divide to
		// 333.3333333333333; without the promotion the same rows give 333.
		db.run("DELETE FROM requests");
		for (const [id, tokens] of [
			["frac-1", 300],
			["frac-2", 300],
			["frac-3", 400],
		] as const) {
			insertRequest({
				id,
				model: "frac-model",
				success: true,
				totalTokens: tokens,
			});
		}

		const [row] = await rowsFor("range=24h");

		expect(row.avgTotalTokensPerSuccess).not.toBe(333);
		expect(row.avgTotalTokensPerSuccess).toBeCloseTo(1000 / 3, 6);
	});

	it("reports null rather than 0 when a model has no successful request", async () => {
		db.run("DELETE FROM requests WHERE success = 1");

		const [row] = await rowsFor("range=24h");

		expect(row.successRequests).toBe(0);
		// A model that never succeeded has no average, and 0 would read as
		// "succeeded with no tokens".
		expect(row.avgTotalTokensPerSuccess).toBeNull();
	});
});

describe("GET /api/analytics/models — avgTokensPerSecond", () => {
	it("skips rows that recorded no rate, the one column that is NULL when absent", async () => {
		// output_tokens_per_second is the only usage column without
		// `DEFAULT 0` (migrations.ts:152), so AVG's NULL-skipping is correct
		// here and nowhere else.
		insertRequest({ id: "t1", model: "rate", tokensPerSecond: 40 });
		insertRequest({ id: "t2", model: "rate", tokensPerSecond: 60 });
		insertRequest({ id: "t3", model: "rate", tokensPerSecond: null });

		const [row] = await rowsFor("range=24h");

		expect(row.avgTokensPerSecond).toBe(50);
	});

	it("is null when no request recorded a rate", async () => {
		insertRequest({ id: "t1", model: "rate", tokensPerSecond: null });

		const [row] = await rowsFor("range=24h");

		expect(row.avgTokensPerSecond).toBeNull();
	});

	it("counts a failed request that still measured a rate", async () => {
		// This pins the one deliberate divergence between the two averages
		// this endpoint returns. avgTotalTokensPerSuccess restricts to
		// successes because a failure stores 0 tokens and that zero would
		// enter the mean; avgTokensPerSecond does not, because the rate is
		// written only when output tokens were produced, gated on
		// `finalOutputTokens > 0` and not on success
		// (usage-collector.ts:830), so a request that produced none is
		// already NULL and already skipped. The two populations therefore
		// differ by exactly this row: failed, and carrying a real measured
		// rate.
		//
		// Chosen so the two candidate populations give different numbers. A
		// success CASE would return 40, successes only; the intended
		// NULL-skipping average over both returns 50. Equal values would make
		// the assertion pass under either reading.
		insertRequest({
			id: "fr1",
			model: "rate",
			success: true,
			tokensPerSecond: 40,
		});
		insertRequest({
			id: "fr2",
			model: "rate",
			success: false,
			tokensPerSecond: 60,
		});

		const [row] = await rowsFor("range=24h");

		expect(row.avgTokensPerSecond).toBe(50);
		// The neighbouring average is the contrast, and it reads the other
		// way: the failed row contributes 0 tokens and is excluded, so this is
		// the successful row alone rather than a mean over both.
		expect(row.successRequests).toBe(1);
	});
});

describe("GET /api/analytics/models — rows with no model", () => {
	it("excludes them, and says so in meta", async () => {
		insertRequest({ id: "named", model: "named-model", totalTokens: 10 });
		insertRequest({ id: "unnamed", model: null, totalTokens: 999 });

		const response = await call("range=24h");
		const body = await response.json();

		expect(body.models.map((r: { model: string }) => r.model)).toEqual([
			"named-model",
		]);
		expect(body.meta.excludesNullModel).toBe(true);
		expect(body.meta.modelColumn).toBe("model");
	});
});

describe("GET /api/analytics/models — ordering", () => {
	it("orders by requests descending, then model ascending", async () => {
		// The two equal-count models are inserted in the order c then a, which
		// is the reverse of the order asserted. That is what makes this test
		// cover the `r.model ASC` tiebreak rather than merely agree with it.
		// Measured 2026-09-18: with a1 inserted before c1, removing the
		// tiebreak from the handler left this test green, because the order
		// SQLite then returned for the tied pair happened to match insertion
		// order and so matched the assertion. An ORDER BY with no tiebreak
		// gives an unspecified order for tied rows, so a fixture whose natural
		// order already equals the answer cannot tell the clause is gone.
		insertRequest({ id: "b1", model: "b-model" });
		insertRequest({ id: "b2", model: "b-model" });
		insertRequest({ id: "c1", model: "c-model" });
		insertRequest({ id: "a1", model: "a-model" });

		const rows = await rowsFor("range=24h");

		expect(rows.map((r) => r.model)).toEqual(["b-model", "a-model", "c-model"]);
	});

	/**
	 * These two pin the placement of the NULL dimension value, which is the one
	 * part of this ORDER BY whose default differs between the two engines this
	 * handler runs on. Measured 2026-09-18: on `ORDER BY project ASC` with one
	 * NULL among three rows, SQLite returned the NULL first and PostgreSQL
	 * 18.6 returned it last. The handler therefore says `NULLS LAST`
	 * explicitly, and these assert it from the SQLite side, where the
	 * unqualified clause puts the NULL first and so fails them.
	 *
	 * Asserting the full array rather than the NULL's index on purpose: an
	 * index assertion still passes if the two named projects swap.
	 */
	it("places a null project last, not first, on groupBy=project", async () => {
		insertRequest({ id: "n1", model: "shared", project: "b-proj" });
		insertRequest({ id: "n2", model: "shared", project: null });
		insertRequest({ id: "n3", model: "shared", project: "a-proj" });

		const rows = await rowsFor("range=24h&groupBy=project");

		expect(rows.map((r) => r.project)).toEqual(["a-proj", "b-proj", null]);
	});

	it("places the unattributed account last, not first, on groupBy=account", async () => {
		// `a.name` is nullable here without the column being nullable: the
		// LEFT JOIN yields NULL for a request with no account at all, which is
		// this `null`, and for one naming an account row that no longer exists.
		db.run(
			"INSERT INTO accounts (id, name, created_at) VALUES ('ord-b', 'b-acct', ?)",
			[Date.now()],
		);
		db.run(
			"INSERT INTO accounts (id, name, created_at) VALUES ('ord-a', 'a-acct', ?)",
			[Date.now()],
		);
		insertRequest({ id: "o1", model: "shared", accountUsed: "ord-b" });
		insertRequest({ id: "o2", model: "shared", accountUsed: null });
		insertRequest({ id: "o3", model: "shared", accountUsed: "ord-a" });

		const rows = await rowsFor("range=24h&groupBy=account");

		expect(rows.map((r) => r.account)).toEqual([
			"a-acct",
			"b-acct",
			NO_ACCOUNT_ID,
		]);
	});
});

describe("GET /api/analytics/models — groupBy", () => {
	beforeEach(() => {
		db.run(
			"INSERT INTO accounts (id, name, created_at) VALUES ('a1', 'acct-A', ?)",
			[Date.now()],
		);
		db.run(
			"INSERT INTO accounts (id, name, created_at) VALUES ('a2', 'acct-B', ?)",
			[Date.now()],
		);
	});

	it("splits a model per account, and names the unattributed bucket", async () => {
		insertRequest({
			id: "g1",
			model: "shared",
			accountUsed: "a1",
			totalTokens: 100,
		});
		insertRequest({
			id: "g2",
			model: "shared",
			accountUsed: "a2",
			totalTokens: 200,
		});
		insertRequest({
			id: "g3",
			model: "shared",
			accountUsed: null,
			totalTokens: 300,
		});

		const rows = await rowsFor("range=24h&groupBy=account");

		expect(rows).toHaveLength(3);
		expect(rows.map((r) => [r.account, r.totalTokens]).sort()).toEqual([
			["acct-A", 100],
			["acct-B", 200],
			[NO_ACCOUNT_ID, 300],
		]);
		// The ungrouped call collapses them back into one row.
		expect(await rowsFor("range=24h")).toHaveLength(1);
	});

	it("splits a model per project, keeping null as null", async () => {
		insertRequest({
			id: "p1",
			model: "shared",
			project: "proj-x",
			totalTokens: 10,
		});
		insertRequest({
			id: "p2",
			model: "shared",
			project: null,
			totalTokens: 20,
		});

		const rows = await rowsFor("range=24h&groupBy=project");

		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.project).sort()).toEqual([null, "proj-x"]);
	});

	it("rejects an unknown groupBy with 400 rather than ignoring it", async () => {
		// Silently ignoring it would return model-only rows that a caller
		// reads as per-account rows with one account.
		const response = await call("range=24h&groupBy=apiKey");

		expect(response.status).toBe(400);
	});

	it("omits the account and project keys entirely when ungrouped", async () => {
		insertRequest({ id: "u1", model: "solo", accountUsed: "a1" });

		const [row] = await rowsFor("range=24h");

		expect(row).not.toHaveProperty("account");
		expect(row).not.toHaveProperty("project");
	});
});

describe("GET /api/analytics/models — the shared filters reach it", () => {
	it("applies the accounts filter", async () => {
		db.run(
			"INSERT INTO accounts (id, name, created_at) VALUES ('a1', 'acct-A', ?)",
			[Date.now()],
		);
		db.run(
			"INSERT INTO accounts (id, name, created_at) VALUES ('a2', 'acct-B', ?)",
			[Date.now()],
		);
		insertRequest({ id: "f1", model: "from-a", accountUsed: "a1" });
		insertRequest({ id: "f2", model: "from-b", accountUsed: "a2" });

		const rows = await rowsFor("range=24h&accounts=acct-A");

		expect(rows.map((r) => r.model)).toEqual(["from-a"]);
	});

	it("applies the status filter", async () => {
		insertRequest({ id: "s1", model: "ok-only", success: true });
		insertRequest({ id: "s2", model: "bad-only", success: false });

		const rows = await rowsFor("range=24h&status=error");

		expect(rows.map((r) => r.model)).toEqual(["bad-only"]);
	});

	it("applies the projects filter", async () => {
		insertRequest({ id: "pr1", model: "in-x", project: "proj-x" });
		insertRequest({ id: "pr2", model: "in-y", project: "proj-y" });

		const rows = await rowsFor("range=24h&projects=proj-x");

		expect(rows.map((r) => r.model)).toEqual(["in-x"]);
	});
});

describe("GET /api/analytics/models — meta", () => {
	it("reports the effective range, normalizing an unknown one to 24h", async () => {
		insertRequest({ id: "m1", model: "any" });

		const unknown = await (await call("range=nonsense")).json();
		const known = await (await call("range=7d")).json();

		expect(unknown.meta.range).toBe("24h");
		expect(known.meta.range).toBe("7d");
	});

	it("reports the grouping", async () => {
		insertRequest({ id: "m1", model: "any" });

		expect((await (await call("range=24h")).json()).meta.groupBy).toBe("model");
		expect(
			(await (await call("range=24h&groupBy=account")).json()).meta.groupBy,
		).toBe("account");
	});
});

describe("GET /api/analytics/models — empty window", () => {
	it("returns an empty array, not an error", async () => {
		const response = await call("range=24h");
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.models).toEqual([]);
	});
});
