import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { Config } from "@better-ccflare/config";
import type { BunSqlAdapter as BunSqlAdapterType } from "@better-ccflare/database";
import { BunSqlAdapter, ensureSchema } from "@better-ccflare/database";
import type { RequestResponse } from "@better-ccflare/types";
import {
	AlertService,
	classifyUpstreamError,
	isAlertableErrorPath,
} from "../alerts";

function makeConfig(): Config {
	return Object.assign(new EventEmitter(), {
		getAlertDailySpendUsd: () => 0,
		getAlertTokensPerHour: () => 0,
		getAlertRequestTokens: () => 0,
		getAlertAnomalyEnabled: () => false,
		getAlertAnomalyIntervalMinutes: () => 15,
		getAlertAnomalyBaselineWindowMinutes: () => 1440,
		getAlertAnomalyLoopMinRequests: () => 25,
		getAlertCooldownMinutes: () => 60,
		getAlertWebhookUrl: () => "",
	}) as unknown as Config;
}

const NOW = 1_760_000_000_000;

function makeSummary(
	overrides: Partial<RequestResponse> = {},
): RequestResponse {
	return {
		id: "req-live",
		timestamp: new Date(NOW).toISOString(),
		method: "POST",
		path: "/v1/messages",
		accountUsed: "account-1",
		statusCode: 500,
		success: false,
		errorMessage: "upstream failure",
		responseTimeMs: 12,
		failoverAttempts: 0,
		...overrides,
	};
}

describe("classifyUpstreamError", () => {
	it("splits 429 out of the 4xx class", () => {
		expect(classifyUpstreamError(429)).toBe("429");
		expect(classifyUpstreamError(400)).toBe("4xx");
		expect(classifyUpstreamError(499)).toBe("4xx");
	});

	it("classifies server errors and ignores successes", () => {
		expect(classifyUpstreamError(500)).toBe("5xx");
		expect(classifyUpstreamError(529)).toBe("5xx");
		expect(classifyUpstreamError(599)).toBe("5xx");
		expect(classifyUpstreamError(200)).toBeNull();
		expect(classifyUpstreamError(399)).toBeNull();
		expect(classifyUpstreamError(600)).toBeNull();
		expect(classifyUpstreamError(null)).toBeNull();
		expect(classifyUpstreamError(undefined)).toBeNull();
		expect(classifyUpstreamError(Number.NaN)).toBeNull();
	});
});

describe("isAlertableErrorPath", () => {
	it("excludes the proxy-fallthrough paths that 503 on a healthy install", () => {
		expect(isAlertableErrorPath("/api/health")).toBe(false);
		expect(isAlertableErrorPath("/api/version")).toBe(false);
	});

	it("keeps real inference paths and the handled version siblings", () => {
		expect(isAlertableErrorPath("/v1/messages")).toBe(true);
		expect(isAlertableErrorPath("/api/version/check")).toBe(true);
		expect(isAlertableErrorPath("/api/version/status")).toBe(true);
		expect(isAlertableErrorPath(null)).toBe(true);
	});
});

describe("AlertService upstream_error alerts", () => {
	let sqlite: Database;
	let adapter: BunSqlAdapterType;
	let service: AlertService;

	function insertRequest(
		id: string,
		statusCode: number,
		options: {
			timestamp?: number;
			accountUsed?: string | null;
			path?: string;
		} = {},
	): void {
		sqlite
			.prepare(
				`INSERT INTO requests (id, timestamp, method, path, account_used, status_code, success)
				 VALUES (?, ?, ?, ?, ?, ?, 0)`,
			)
			.run(
				id,
				options.timestamp ?? NOW,
				"POST",
				options.path ?? "/v1/messages",
				options.accountUsed === undefined ? "account-1" : options.accountUsed,
				statusCode,
			);
	}

	beforeEach(() => {
		sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		sqlite
			.prepare(
				`INSERT INTO accounts (id, name, provider, api_key, refresh_token, access_token, expires_at, created_at, request_count, total_requests)
				 VALUES ('account-1', 'Backup account', 'anthropic', NULL, NULL, NULL, NULL, ?, 0, 0)`,
			)
			.run(NOW);
		adapter = new BunSqlAdapter(sqlite);
		service = new AlertService(adapter, makeConfig());
	});

	afterEach(() => {
		service.stop();
		sqlite.close();
	});

	it("stays silent below the three-error threshold", async () => {
		insertRequest("r1", 500);
		insertRequest("r2", 500);
		await service.evaluateRequest(makeSummary({ id: "r2" }));
		expect(await service.listAlerts()).toHaveLength(0);
	});

	it("raises one grouped alert once three errors land in the window", async () => {
		insertRequest("r1", 500);
		insertRequest("r2", 503);
		insertRequest("r3", 529);
		await service.evaluateRequest(makeSummary({ id: "r3", statusCode: 529 }));
		const alerts = await service.listAlerts();
		expect(alerts).toHaveLength(1);
		expect(alerts[0].type).toBe("upstream_error");
		expect(alerts[0].severity).toBe("critical");
		expect(alerts[0].value).toBe(3);
		expect(alerts[0].account).toBe("Backup account");
		expect(alerts[0].message).toContain("Backup account");
	});

	it("collapses a storm into one alert per cooldown bucket", async () => {
		for (let i = 0; i < 40; i++) insertRequest(`r${i}`, 429);
		for (let i = 0; i < 40; i++) {
			await service.evaluateRequest(
				makeSummary({ id: `r${i}`, statusCode: 429 }),
			);
		}
		const alerts = await service.listAlerts();
		expect(alerts).toHaveLength(1);
		expect(alerts[0].severity).toBe("warning");
		expect(alerts[0].title).toBe("Upstream rate limiting");
	});

	it("keeps 429 and 5xx on the same account as separate alerts", async () => {
		for (let i = 0; i < 3; i++) insertRequest(`a${i}`, 429);
		for (let i = 0; i < 3; i++) insertRequest(`b${i}`, 500);
		await service.evaluateRequest(makeSummary({ id: "a0", statusCode: 429 }));
		await service.evaluateRequest(makeSummary({ id: "b0", statusCode: 500 }));
		const alerts = await service.listAlerts();
		expect(alerts).toHaveLength(2);
		expect(new Set(alerts.map((a) => a.severity))).toEqual(
			new Set(["warning", "critical"]),
		);
	});

	it("never fires on /api/health or /api/version, which 503 when healthy", async () => {
		for (let i = 0; i < 10; i++) {
			insertRequest(`h${i}`, 503, { path: "/api/health" });
		}
		for (let i = 0; i < 10; i++) {
			insertRequest(`v${i}`, 503, { path: "/api/version" });
		}
		await service.evaluateRequest(
			makeSummary({ id: "h0", statusCode: 503, path: "/api/health" }),
		);
		await service.evaluateRequest(
			makeSummary({ id: "v0", statusCode: 503, path: "/api/version" }),
		);
		expect(await service.listAlerts()).toHaveLength(0);
	});

	/*
	 * The two cases below close mutations that survived the merge gate on PR #80
	 * (SB23-1825). Both predicates were correct and neither was fault-sensitive,
	 * so either could have been removed by a refactor without a test failing.
	 */

	it("does not count errors older than the window toward the threshold", async () => {
		// UPSTREAM_ERROR_WINDOW_MS is 15 minutes. Setting it to 0 changed no test
		// result, which meant no fixture straddled the boundary and the clause was
		// never the deciding factor in any assertion.
		const beyondWindow = NOW - 16 * 60 * 1000;
		insertRequest("old1", 500, { timestamp: beyondWindow });
		insertRequest("old2", 500, { timestamp: beyondWindow });
		insertRequest("fresh", 500);
		await service.evaluateRequest(makeSummary({ id: "fresh" }));
		// Three 500s exist, but only one is inside the window, so the threshold
		// of three is not met.
		expect(await service.listAlerts()).toHaveLength(0);
	});

	it("counts errors inside the window that are not the triggering request", async () => {
		// The companion to the case above: same shape, timestamps moved inside the
		// boundary, so the alert must fire. Without this, a window of Infinity
		// would also pass the test above.
		const insideWindow = NOW - 14 * 60 * 1000;
		insertRequest("in1", 500, { timestamp: insideWindow });
		insertRequest("in2", 500, { timestamp: insideWindow });
		insertRequest("fresh", 500);
		await service.evaluateRequest(makeSummary({ id: "fresh" }));
		expect(await service.listAlerts()).toHaveLength(1);
	});

	it("counts 429s separately from other 4xx in the windowed SQL, not only in the classifier", async () => {
		// classifyUpstreamError already pins the 429/4xx split, but the windowed
		// count restates the same rule as SQL (`status_code <> 429` in the 4xx
		// predicate). Deleting that clause left all 14 tests green: the rule lives
		// in two places and only one was asserted.
		//
		// Two 400s and one 429 on one account. If 429 folded into 4xx the 4xx
		// class would reach three and fire; split, neither class reaches the
		// threshold and nothing fires.
		insertRequest("c1", 400);
		insertRequest("c2", 400);
		insertRequest("c3", 429);
		await service.evaluateRequest(makeSummary({ id: "c3", statusCode: 429 }));
		await service.evaluateRequest(makeSummary({ id: "c2", statusCode: 400 }));
		expect(await service.listAlerts()).toHaveLength(0);
	});

	it("excludes health-probe rows from the count for a real failing path", async () => {
		for (let i = 0; i < 10; i++) {
			insertRequest(`h${i}`, 503, { path: "/api/health" });
		}
		insertRequest("real", 503);
		await service.evaluateRequest(makeSummary({ id: "real", statusCode: 503 }));
		expect(await service.listAlerts()).toHaveLength(0);
	});

	it("ignores errors that fell outside the 15-minute window", async () => {
		const old = NOW - 20 * 60 * 1000;
		insertRequest("o1", 500, { timestamp: old });
		insertRequest("o2", 500, { timestamp: old });
		insertRequest("r3", 500);
		await service.evaluateRequest(makeSummary({ id: "r3" }));
		expect(await service.listAlerts()).toHaveLength(0);
	});

	it("groups accountless failures instead of dropping them", async () => {
		for (let i = 0; i < 3; i++) {
			insertRequest(`n${i}`, 503, { accountUsed: null });
		}
		await service.evaluateRequest(
			makeSummary({ id: "n0", statusCode: 503, accountUsed: null }),
		);
		const alerts = await service.listAlerts();
		expect(alerts).toHaveLength(1);
		expect(alerts[0].account).toBeNull();
		expect(alerts[0].message).toContain("no account");
	});

	it("does not count another account's errors toward this account", async () => {
		for (let i = 0; i < 5; i++) {
			insertRequest(`x${i}`, 500, { accountUsed: "account-2" });
		}
		insertRequest("mine", 500);
		await service.evaluateRequest(makeSummary({ id: "mine" }));
		expect(await service.listAlerts()).toHaveLength(0);
	});

	it("does not fire on a successful response", async () => {
		for (let i = 0; i < 5; i++) insertRequest(`s${i}`, 500);
		await service.evaluateRequest(makeSummary({ id: "ok", statusCode: 200 }));
		expect(await service.listAlerts()).toHaveLength(0);
	});
});
