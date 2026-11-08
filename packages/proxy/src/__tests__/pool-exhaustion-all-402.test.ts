/**
 * SB23-11281. Since `#322` an upstream 402 fails over without benching, so a
 * pool where every account answers 402 ended on the generic 503 and lost the
 * provider's billing message. It now replays the newest native 402.
 *
 * Every upstream call lands on the `fetch` stub below, which records it and
 * throws for any host it does not know, so nothing here reaches a real
 * account.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { AnthropicProvider, usageCache } from "@better-ccflare/providers";
import type { Account, ComboWithSlots } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { clearFamilyExhaustionCache } from "../handlers/model-capacity";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";
import { fetchSlot } from "./fetch-slot";
import { makeProxyContext } from "./proxy-context-fixture";

const originalFetch = globalThis.fetch;
const MODEL = "claude-haiku-5-5";
const META_MODEL = "muse-spark-1.2-contributor";
const META_ENDPOINT = "http://127.0.0.1:9";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-x",
		name: "acc-x",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		// Beyond the refresh safety window, so no token refresh is fetched.
		expires_at: Date.now() + 3 * 60 * 60 * 1000,
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
		rate_limited_reason: null,
		rate_limited_at: null,
		requires_reauth: false,
		peak_hours_pause_enabled: false,
		request_transformer: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		last_manual_reauth_at: null,
		consecutive_rate_limits: 0,
		renewal_day: null,
		usage_pause_five_hour_threshold: null,
		usage_pause_weekly_threshold: null,
		usage_pause_five_hour_enabled: false,
		usage_pause_weekly_enabled: false,
		usage_pause_five_hour_min_reset_remaining_ms: null,
		usage_pause_weekly_min_reset_remaining_ms: null,
		...overrides,
	};
}

function makeContext(
	accounts: Account[],
	combo: ComboWithSlots | null = null,
): ProxyContext {
	return makeProxyContext({
		strategy: { select: mock((accs: Account[]) => accs) },
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => combo),
			markAccountRateLimited: mock(() =>
				Promise.resolve({ consecutiveRateLimits: 1, applied: true }),
			),
			saveRequest: mock(() => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
		},
		runtime: { clientId: "test" },
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getModelScopedCapacityRouting: () => "off",
			getStorePayloads: () => false,
			getForceAccountModel: () => false,
			getCombosEnabled: () => combo !== null,
			// A combo here always tests the terminal that skips step 11.
			getComboSessionFallback: () => combo === null,
		},
		provider: new AnthropicProvider(),
		asyncWriter: {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		},
	});
}

const BILLING_BODY = JSON.stringify({
	type: "error",
	error: {
		type: "billing_error",
		message: "Add credits at https://dev.meta.ai/billing",
	},
});

/** An Anthropic-compatible account that sends the requested model as written, so its answer is native. */
function nativeMeta(id: string, priority: number): Account {
	return makeAccount({
		id,
		name: id,
		provider: "anthropic-compatible",
		api_key: "compat-key",
		refresh_token: null,
		access_token: null,
		expires_at: null,
		custom_endpoint: META_ENDPOINT,
		priority,
	});
}

function install402(): string[] {
	const seen: string[] = [];
	fetchSlot.fetch = async (input, init) => {
		const request =
			input instanceof Request ? input : new Request(String(input), init);
		const url = new URL(request.url);
		if (!url.href.startsWith(META_ENDPOINT)) {
			throw new Error(`unexpected fetch in all-402 test: ${url.href}`);
		}
		const body = (await request.json()) as { model?: string };
		seen.push(body.model ?? "");
		return new Response(BILLING_BODY, {
			status: 402,
			headers: { "content-type": "application/json" },
		});
	};
	return seen;
}

function send(ctx: ProxyContext): Promise<Response> {
	return handleProxy(
		new Request("http://localhost/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: MODEL,
				max_tokens: 16,
				messages: [{ role: "user", content: "hello" }],
			}),
		}),
		new URL("http://localhost/v1/messages"),
		ctx,
	);
}

describe("an all-402 pool replays the native 402 (SB23-11281)", () => {
	let collector: ReturnType<typeof spyOn> | null = null;
	let refusalCollector: ReturnType<typeof spyOn> | null = null;
	beforeEach(() => {
		const fake = {
			handleStart: mock(() => {}),
			handleChunk: mock(() => {}),
			handleEnd: mock(() => Promise.resolve()),
		} as unknown as usageCollectorModule.UsageCollector;
		collector = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue(fake);
		refusalCollector = spyOn(
			usageCollectorModule,
			"tryGetUsageCollector",
		).mockReturnValue(fake);
	});

	afterEach(() => {
		collector?.mockRestore();
		refusalCollector?.mockRestore();
		fetchSlot.fetch = originalFetch;
		usageCache.clear();
		clearFamilyExhaustionCache();
		resetRateLimitProbeGatesForTests();
	});

	it("a single out-of-credit account: the client gets its 402 and billing message", async () => {
		const seen = install402();
		const response = await send(makeContext([nativeMeta("M1", 0)]));
		expect(seen).toEqual([MODEL]);
		expect(response.status).toBe(402);
		expect(await response.text()).toBe(BILLING_BODY);
	});

	it("two out-of-credit accounts: the client gets the 402, both were tried", async () => {
		const seen = install402();
		const response = await send(
			makeContext([nativeMeta("M1", 0), nativeMeta("M2", 1)]),
		);
		expect(seen).toEqual([MODEL, MODEL]);
		expect(response.status).toBe(402);
		expect(await response.text()).toBe(BILLING_BODY);
	});

	it("a combo with session fallback off: the combo terminal replays the 402", async () => {
		const seen = install402();
		const combo: ComboWithSlots = {
			id: "combo-402",
			name: "Combo402",
			description: null,
			enabled: true,
			created_at: Date.now(),
			updated_at: Date.now(),
			slots: ["M1", "M2"].map((accountId, index) => ({
				id: `slot-${index}`,
				combo_id: "combo-402",
				account_id: accountId,
				model: MODEL,
				priority: index,
				enabled: true,
				max_utilization_percent: null,
				min_reset_remaining_ms: null,
			})),
		};
		const response = await send(
			makeContext([nativeMeta("M1", 0), nativeMeta("M2", 1)], combo),
		);
		expect(seen).toEqual([MODEL, MODEL]);
		expect(response.status).toBe(402);
		expect(await response.text()).toBe(BILLING_BODY);
	});
});
