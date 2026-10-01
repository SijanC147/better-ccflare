import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "codex-primary",
		provider: "codex",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 60_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		requires_reauth: false,
		peak_hours_pause_enabled: false,
		request_transformer: null,
		last_manual_reauth_at: null,
		consecutive_rate_limits: 0,
		renewal_day: null,
		usage_pause_five_hour_threshold: null,
		usage_pause_weekly_threshold: null,
		usage_pause_five_hour_enabled: false,
		usage_pause_weekly_enabled: false,
		...overrides,
	};
}

function makeContext(account: Account): ProxyContext {
	return {
		strategy: {
			select: (accounts: Account[]) => accounts,
		} as never,
		dbOps: {
			getAllAccounts: mock(async () => [account]),
			getActiveComboForFamily: mock(async () => null),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => true,
			getUsageThrottlingWeeklyEnabled: () => true,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
		} as never,
		provider: {
			name: "codex",
			canHandle: () => true,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
	};
}

afterEach(() => {
	usageCache.delete("acc-1");
});

describe("handleProxy usage throttling", () => {
	it("returns 529 with Retry-After when all selected accounts are throttled", async () => {
		const account = makeAccount();
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const resetAt = new Date(now + 2 * 60 * 60 * 1000).toISOString();
		usageCache.set(account.id, {
			five_hour: { utilization: 80, resets_at: resetAt },
			seven_day: { utilization: 10, resets_at: null },
		});

		const realDateNow = Date.now;
		Date.now = () => now;
		try {
			const request = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "claude-sonnet-4-5",
					messages: [{ role: "user", content: "hello" }],
					max_tokens: 16,
				}),
			});

			const response = await handleProxy(
				request,
				new URL(request.url),
				makeContext(account),
			);

			expect(response.status).toBe(529);
			expect(response.headers.get("Retry-After")).toBe("60");
		} finally {
			Date.now = realDateNow;
		}
	});
});

/**
 * SB23-2541 at the call site. The unit tests pin `getUsageThrottleStatus`;
 * these pin that `handleProxy` hands it the account's provider and the cached
 * payload, which is what a mutation at `proxy.ts` would break.
 */
describe("handleProxy weekly throttle and Codex credits (SB23-2541)", () => {
	const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
	const realFetch = globalThis.fetch;
	const realDateNow = Date.now;
	let fetched: string[] = [];
	let collectorSpy: ReturnType<typeof spyOn> | null = null;
	// Comfortably past the token refresh safety window, so routing never tries
	// to mint a token and the only upstream call is the proxied request.
	const account = (overrides: Partial<Account> = {}) =>
		makeAccount({ expires_at: NOW + 3 * 60 * 60 * 1000, ...overrides });

	/**
	 * Halfway through the week, so the throttle's expected pace is 50 percent.
	 * 100 is the acceptance case; 90 is below admission's bench line, so a
	 * negative at 90 reaches the throttle and answers its 529 rather than
	 * being benched earlier by admission (which answers 503 on its own path).
	 */
	function weeklyAt(
		weekly: number,
		credits?: {
			has_credits: boolean;
			unlimited: boolean;
			balance: string | null;
		},
	) {
		return {
			five_hour: {
				utilization: 10,
				resets_at: new Date(NOW + 2.5 * 60 * 60 * 1000).toISOString(),
			},
			seven_day: {
				utilization: weekly,
				resets_at: new Date(NOW + 3.5 * 24 * 60 * 60 * 1000).toISOString(),
			},
			...(credits ? { credits } : {}),
		};
	}

	function request() {
		return new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "claude-sonnet-4-5",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 16,
			}),
		});
	}

	beforeEach(() => {
		fetched = [];
		// Every upstream call is recorded and answered here, so nothing leaves
		// the machine. A test that expects the request to go upstream asserts
		// on what was recorded, which fails if the stub was never reached.
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			fetched.push(
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url,
			);
			return new Response(JSON.stringify({ error: "stubbed upstream" }), {
				status: 418,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;
		// Frozen before usageCache.set so the entry and the balance share NOW.
		Date.now = () => NOW;
		collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue({
			handleStart: mock(() => {}),
			handleChunk: mock(() => {}),
			handleEnd: mock(() => Promise.resolve()),
		} as unknown as usageCollectorModule.UsageCollector);
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		Date.now = realDateNow;
		collectorSpy?.mockRestore();
		collectorSpy = null;
		usageCache.delete("acc-1");
	});

	it("routes a credit-covered Codex account at seven_day = 100 instead of answering 529", async () => {
		const acct = account();
		usageCache.set(
			acct.id,
			weeklyAt(100, { has_credits: true, unlimited: false, balance: "9.99" }),
			NOW,
		);
		const req = request();

		const response = await handleProxy(
			req,
			new URL(req.url),
			makeContext(acct),
		);

		expect(response.status).not.toBe(529);
		expect(fetched.length).toBeGreaterThan(0);
		expect(fetched.every((url) => !url.startsWith("https://proxy.local"))).toBe(
			true,
		);
	});

	it("answers 529 for a Codex account ahead of weekly pace with no credits, without contacting upstream", async () => {
		const acct = account();
		usageCache.set(acct.id, weeklyAt(90), NOW);
		const req = request();

		const response = await handleProxy(
			req,
			new URL(req.url),
			makeContext(acct),
		);

		expect(response.status).toBe(529);
		expect(fetched).toEqual([]);
	});

	it("answers 529 for an Anthropic account whose payload carries a covering credits key", async () => {
		const acct = account({
			provider: "anthropic",
			name: "claude-a",
		});
		usageCache.set(
			acct.id,
			weeklyAt(90, { has_credits: true, unlimited: false, balance: "9.99" }),
			NOW,
		);
		const req = request();

		const response = await handleProxy(
			req,
			new URL(req.url),
			makeContext(acct),
		);

		expect(response.status).toBe(529);
		expect(fetched).toEqual([]);
	});
});
