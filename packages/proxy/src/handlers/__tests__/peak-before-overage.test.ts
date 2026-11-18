/**
 * SB23-12677. Plan first, then overage (Sean, 2026-11-18): a plan account in
 * its TokenHarbor peak-priced window has not used up its plan, so it is tried
 * before any account serving on Anthropic extra usage or Codex credits. The
 * pool used to drop peak-affected accounts whenever any non-peak account was
 * left, an overage account included, so the overage account served and the
 * plan account was never tried. Pool and ladder now share one order:
 * non-peak plan, peak plan, overage.
 *
 * No network: the usage cache is seeded directly and the TokenHarbor listing
 * through a stubbed fetch that is restored at once.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	setSystemTime,
} from "bun:test";
import { setUseExtraUsage } from "@better-ccflare/core";
import { usageCache } from "@better-ccflare/providers";
import type {
	Account,
	ComboWithSlots,
	RequestMeta,
} from "@better-ccflare/types";
import {
	clearTokenHarborPeakCacheForTests,
	getTokenHarborPeakListing,
} from "../../tokenharbor-peak";
import {
	getComboSlotInfo,
	selectAccountsForRequest,
} from "../account-selector";
import {
	markModelCooling,
	resetModelCooldownsForTests,
} from "../model-cooldown";
import type { ProxyContext } from "../proxy-types";

// 2026-09-23 02:00 UTC is outside the "14:00–00:00 UTC" off-peak window.
const WED_PEAK_MS = Date.UTC(2026, 8, 23, 2, 0);
const MODEL = "claude-opus-5-5";

function makeAccount(overrides: Partial<Account>): Account {
	return {
		night_window_enabled: false,
		plan_monthly_usd: null,
		id: "acc",
		name: "acc",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: WED_PEAK_MS + 3_600_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: WED_PEAK_MS,
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

function tokenHarbor(id: string, priority: number): Account {
	return makeAccount({
		id,
		name: id,
		priority,
		provider: "anthropic-compatible",
		custom_endpoint: "https://tokenharbor.ai",
		api_key: "test-key",
		peak_hours_pause_enabled: true,
	});
}

/** An Anthropic account spent on its week, serving on extra usage. */
function anthropicOnOverage(id: string, priority: number): Account {
	usageCache.set(id, {
		seven_day: {
			utilization: 100,
			resets_at: new Date(WED_PEAK_MS + 3 * 86_400_000).toISOString(),
		},
		extra_usage: { is_enabled: true, utilization: 10 },
	} as never);
	return makeAccount({ id, name: id, priority });
}

async function seedListing(
	account: Account,
	peakModels: string[],
	originalFetch: typeof globalThis.fetch,
): Promise<void> {
	globalThis.fetch = (async () =>
		new Response(
			JSON.stringify({
				data: peakModels.map((id) => ({
					id,
					pricing: { off_peak: { window: "14:00–00:00 UTC" } },
				})),
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		)) as unknown as typeof globalThis.fetch;
	try {
		await getTokenHarborPeakListing(account);
	} finally {
		globalThis.fetch = originalFetch;
	}
}

function meta(): RequestMeta {
	return {
		id: "req-peak-overage",
		method: "POST",
		path: "/v1/messages",
		timestamp: WED_PEAK_MS,
		headers: new Headers(),
	};
}

function ctxFor(
	accounts: Account[],
	combo: ComboWithSlots | null = null,
): ProxyContext {
	return {
		strategy: { select: mock((candidates: Account[]) => candidates) },
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => combo),
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) },
		config: {
			getModelScopedCapacityRouting: () => "off",
			getCombosEnabled: () => combo !== null,
		},
	} as unknown as ProxyContext;
}

function combo(accountIds: string[]): ComboWithSlots {
	return {
		id: "combo-1",
		name: "Peak overage",
		description: null,
		enabled: true,
		created_at: WED_PEAK_MS,
		updated_at: WED_PEAK_MS,
		slots: accountIds.map((accountId, i) => ({
			id: `slot-${i}`,
			combo_id: "combo-1",
			account_id: accountId,
			model: MODEL,
			priority: i,
			enabled: true,
			max_utilization_percent: null,
			min_reset_remaining_ms: null,
		})),
	};
}

const ids = (accounts: Account[]) => accounts.map((a) => a.id);

describe("a peak-priced plan account comes before overage (SB23-12677)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		setSystemTime(new Date(WED_PEAK_MS));
		clearTokenHarborPeakCacheForTests();
		originalFetch = globalThis.fetch;
		setUseExtraUsage(true);
	});

	afterEach(() => {
		setSystemTime();
		globalThis.fetch = originalFetch;
		clearTokenHarborPeakCacheForTests();
		setUseExtraUsage(false);
		usageCache.clear();
		resetModelCooldownsForTests();
	});

	it("pool: a peak-priced TokenHarbor plan account is selected before an Anthropic overage account", async () => {
		const over = anthropicOnOverage("over", 0);
		const peak = tokenHarbor("th-peak", 1);
		await seedListing(peak, [MODEL], originalFetch);

		const ordered = await selectAccountsForRequest(
			meta(),
			ctxFor([over, peak]),
			MODEL,
		);
		expect(ids(ordered)).toEqual(["th-peak", "over"]);
	});

	it("pool: non-peak plan, then peak plan, then overage", async () => {
		const over = anthropicOnOverage("over", 0);
		const peak = tokenHarbor("th-peak", 1);
		const flat = tokenHarbor("th-flat", 2);
		await seedListing(peak, [MODEL], originalFetch);
		await seedListing(flat, ["deepseek-v4-pro"], originalFetch);

		const ordered = await selectAccountsForRequest(
			meta(),
			ctxFor([over, peak, flat]),
			MODEL,
		);
		expect(ids(ordered)).toEqual(["th-flat", "th-peak", "over"]);
	});

	it("pool: a cooling flat plan account gives way to the peak plan account, then overage", async () => {
		const over = anthropicOnOverage("over", 0);
		const peak = tokenHarbor("th-peak", 1);
		const flat = tokenHarbor("th-flat", 2);
		await seedListing(peak, [MODEL], originalFetch);
		await seedListing(flat, ["deepseek-v4-pro"], originalFetch);
		markModelCooling("th-flat", MODEL, WED_PEAK_MS + 60_000, WED_PEAK_MS);

		const ordered = await selectAccountsForRequest(
			meta(),
			ctxFor([over, peak, flat]),
			MODEL,
		);
		expect(ids(ordered)).toEqual(["th-peak", "over"]);
	});

	it("ladder: non-peak plan, then peak plan, then overage, slots index-aligned", async () => {
		const over = anthropicOnOverage("over", 0);
		const peak = tokenHarbor("th-peak", 1);
		const flat = tokenHarbor("th-flat", 2);
		await seedListing(peak, [MODEL], originalFetch);
		await seedListing(flat, ["deepseek-v4-pro"], originalFetch);

		const requestMeta = meta();
		const ordered = await selectAccountsForRequest(
			requestMeta,
			ctxFor([over, peak, flat], combo(["over", "th-peak", "th-flat"])),
			MODEL,
		);
		expect(ids(ordered)).toEqual(["th-flat", "th-peak", "over"]);
		expect(
			getComboSlotInfo(requestMeta)?.slots.map((s) => s.accountId),
		).toEqual(["th-flat", "th-peak", "over"]);
	});
});
