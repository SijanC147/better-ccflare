/**
 * SB23-8202. Overage is a last resort: "only switch to overage credits after
 * all other subscription-based account options have been spent" (Sean,
 * 2026-11-08). An account spent on its plan window that serves only on
 * Anthropic extra usage or Codex credits is ordered after every account that
 * still has plan quota, so failover reaches it only when those are gone.
 *
 * No network: the selector reads the usage cache, seeded here.
 */
import { afterEach, describe, expect, it, mock } from "bun:test";
import { setUseExtraUsage } from "@better-ccflare/core";
import { usageCache } from "@better-ccflare/providers";
import type {
	Account,
	ComboWithSlots,
	RequestMeta,
} from "@better-ccflare/types";
import {
	orderOverageLast,
	selectAccountsForRequest,
} from "../account-selector";
import type { ProxyContext } from "../proxy-types";

const IN_THREE_DAYS = () =>
	new Date(Date.now() + 3 * 24 * 3_600_000).toISOString();

function account(id: string, provider: string, priority: number): Account {
	return {
		id,
		name: id,
		provider,
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: Date.now() + 3_600_000,
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
		priority,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
	} as Account;
}

function meta(): RequestMeta {
	return {
		id: "req-overage",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function ctxFor(accounts: Account[], combo: ComboWithSlots | null = null) {
	const ctx = {
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
	return ctx;
}

/** Anthropic: weekly spent, extra usage enabled and not used up. */
function seedAnthropicOnExtraUsage(id: string) {
	usageCache.set(id, {
		seven_day: { utilization: 100, resets_at: IN_THREE_DAYS() },
		extra_usage: { is_enabled: true, utilization: 10 },
	} as never);
}

/** Codex: weekly spent, a fresh positive credit balance (SB23-2289). */
function seedCodexOnCredits(id: string) {
	usageCache.set(id, {
		seven_day: { utilization: 100, resets_at: IN_THREE_DAYS() },
		credits: { has_credits: true, unlimited: false, balance: "12" },
	} as never);
}

function seedPlanQuota(id: string) {
	usageCache.set(id, {
		seven_day: { utilization: 40, resets_at: IN_THREE_DAYS() },
	} as never);
}

const ids = (accounts: Account[]) => accounts.map((a) => a.id);

afterEach(() => {
	setUseExtraUsage(false);
	usageCache.clear();
});

describe("overage last (SB23-8202)", () => {
	it("Anthropic extra usage: the quota account is chosen first, the overage account only after it", async () => {
		setUseExtraUsage(true);
		seedAnthropicOnExtraUsage("over");
		seedPlanQuota("quota");
		// The overage account ranks first by priority; the rule moves it last.
		const ordered = await selectAccountsForRequest(
			meta(),
			ctxFor([
				account("over", "anthropic", 0),
				account("quota", "anthropic", 1),
			]),
		);
		expect(ids(ordered)).toEqual(["quota", "over"]);
	});

	it("Anthropic extra usage on, plan window unspent: the account stays a plan account", async () => {
		setUseExtraUsage(true);
		usageCache.set("a", {
			seven_day: { utilization: 40, resets_at: IN_THREE_DAYS() },
			extra_usage: { is_enabled: true, utilization: 10 },
		} as never);
		seedPlanQuota("b");
		const ordered = await selectAccountsForRequest(
			meta(),
			ctxFor([account("a", "anthropic", 0), account("b", "anthropic", 1)]),
		);
		expect(ids(ordered)).toEqual(["a", "b"]);
	});

	it("the strategy sees only the plan accounts, so a session stamp lands on one that serves", async () => {
		setUseExtraUsage(true);
		seedAnthropicOnExtraUsage("over");
		seedPlanQuota("quota");
		const ctx = ctxFor([
			account("over", "anthropic", 0),
			account("quota", "anthropic", 1),
		]);
		const ordered = await selectAccountsForRequest(meta(), ctx);
		const select = (
			ctx.strategy as unknown as { select: ReturnType<typeof mock> }
		).select;
		expect(select.mock.calls.map((call) => ids(call[0] as Account[]))).toEqual([
			["quota"],
		]);
		expect(ids(ordered)).toEqual(["quota", "over"]);
	});

	it("Anthropic extra usage: with no plan account left, the overage account is used", async () => {
		setUseExtraUsage(true);
		seedAnthropicOnExtraUsage("over");
		const ordered = await selectAccountsForRequest(
			meta(),
			ctxFor([account("over", "anthropic", 0)]),
		);
		expect(ids(ordered)).toEqual(["over"]);
	});

	it("Anthropic extra usage: with the switch off, the spent account is still benched", async () => {
		seedAnthropicOnExtraUsage("over");
		seedPlanQuota("quota");
		const ordered = await selectAccountsForRequest(
			meta(),
			ctxFor([
				account("over", "anthropic", 0),
				account("quota", "anthropic", 1),
			]),
		);
		expect(ids(ordered)).toEqual(["quota"]);
	});

	it("Codex credits: the quota account is chosen first, the credit account only after it", async () => {
		seedCodexOnCredits("credits");
		seedPlanQuota("quota");
		const ordered = await selectAccountsForRequest(
			meta(),
			ctxFor([account("credits", "codex", 0), account("quota", "codex", 1)]),
		);
		expect(ids(ordered)).toEqual(["quota", "credits"]);
	});

	it("Codex credits: a pool of only the credit account still serves on credits", async () => {
		seedCodexOnCredits("credits");
		const ordered = await selectAccountsForRequest(
			meta(),
			ctxFor([account("credits", "codex", 0)]),
		);
		expect(ids(ordered)).toEqual(["credits"]);
	});

	it("leaves ranking among plan-quota accounts untouched", () => {
		seedPlanQuota("a");
		seedPlanQuota("b");
		seedCodexOnCredits("c");
		const list = [
			account("b", "codex", 1),
			account("c", "codex", 0),
			account("a", "codex", 2),
		];
		expect(ids(orderOverageLast(list, (x) => x))).toEqual(["b", "a", "c"]);
	});

	it("a combo ladder puts an overage slot after a plan slot, slot entries aligned", async () => {
		seedCodexOnCredits("credits");
		seedPlanQuota("quota");
		const combo: ComboWithSlots = {
			id: "combo",
			name: "Combo",
			description: null,
			enabled: true,
			created_at: Date.now(),
			updated_at: Date.now(),
			slots: ["credits", "quota"].map((accountId, index) => ({
				id: `slot-${index}`,
				combo_id: "combo",
				account_id: accountId,
				model: `model-${accountId}`,
				priority: index,
				enabled: true,
				max_utilization_percent: null,
				min_reset_remaining_ms: null,
			})),
		};
		const m = meta();
		const ordered = await selectAccountsForRequest(
			m,
			ctxFor(
				[account("credits", "codex", 0), account("quota", "codex", 1)],
				combo,
			),
			"claude-sonnet-4-5",
		);
		expect(ids(ordered)).toEqual(["quota", "credits"]);
	});
});
