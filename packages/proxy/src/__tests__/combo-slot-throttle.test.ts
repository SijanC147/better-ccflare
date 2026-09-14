/**
 * Per-slot throttle thresholds on combo members (SB23-1269).
 *
 * Only the configured conditions are evaluated, and every configured one must
 * hold: a utilization-only rule skips on utilization, a reset-only rule skips on
 * the reset distance, a rule with both set needs both, and a rule with neither
 * never skips. A skip advances to the next slot rather than failing the request.
 *
 * Distinct from the pace-based, globally-configured throttling in
 * usage-throttling.ts, which runs after selection and answers 529.
 */
import { afterEach, describe, expect, it, mock } from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type {
	Account,
	ComboSlot,
	ComboWithSlots,
	RequestMeta,
} from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import {
	isSlotThrottled,
	selectAccountsForRequest,
} from "../handlers/account-selector";

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-x",
		name: "acc-x",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: NOW + 3 * HOUR,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: NOW,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
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
		...overrides,
	};
}

function makeSlot(overrides: Partial<ComboSlot> = {}): ComboSlot {
	return {
		id: "slot-1",
		combo_id: "combo-1",
		account_id: "acc-1",
		model: "claude-sonnet-4-5",
		priority: 0,
		enabled: true,
		max_utilization_percent: null,
		min_reset_remaining_ms: null,
		...overrides,
	};
}

function makeCombo(slots: ComboSlot[]): ComboWithSlots {
	return {
		id: "combo-1",
		name: "Test Combo",
		description: null,
		enabled: true,
		created_at: NOW,
		updated_at: NOW,
		slots,
	};
}

function makeContext(
	accounts: Account[],
	combo: ComboWithSlots | null,
): ProxyContext {
	return {
		strategy: { select: mock((accs: Account[]) => accs) } as never,
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => combo),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getModelScopedCapacityRouting: () => "off",
		} as never,
		provider: { name: "anthropic", canHandle: () => true } as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
	};
}

function makeMeta(): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: NOW,
		headers: new Headers({ "Content-Type": "application/json" }),
	} as unknown as RequestMeta;
}

/** Seed the representative (five-hour) window the selector reads. */
function setUsage(accountId: string, utilization: number, resetsAt: number) {
	usageCache.set(accountId, {
		five_hour: {
			utilization,
			resets_at: new Date(resetsAt).toISOString(),
		},
		seven_day: { utilization: 0, resets_at: null },
	} as never);
}

afterEach(() => {
	usageCache.delete("acc-1");
	usageCache.delete("acc-2");
});

describe("isSlotThrottled — the rule itself", () => {
	it("skips when utilization is at or above the threshold and the reset is still far away", () => {
		const slot = makeSlot({
			max_utilization_percent: 80,
			min_reset_remaining_ms: HOUR,
		});
		expect(
			isSlotThrottled(slot, { utilization: 85, resetMs: NOW + 4 * HOUR }, NOW),
		).toBe(true);
	});

	it("does not skip when the reset is nearer than the configured distance", () => {
		const slot = makeSlot({
			max_utilization_percent: 80,
			min_reset_remaining_ms: HOUR,
		});
		// Same 85% utilization as above; only the reset distance differs, so this
		// case is what the reset clause buys on its own.
		expect(
			isSlotThrottled(
				slot,
				{ utilization: 85, resetMs: NOW + 5 * 60_000 },
				NOW,
			),
		).toBe(false);
	});

	it("does not skip below the utilization threshold however far the reset is", () => {
		const slot = makeSlot({
			max_utilization_percent: 80,
			min_reset_remaining_ms: HOUR,
		});
		expect(
			isSlotThrottled(slot, { utilization: 79, resetMs: NOW + 4 * HOUR }, NOW),
		).toBe(false);
	});

	it("is inert when neither threshold is configured", () => {
		expect(
			isSlotThrottled(
				makeSlot(),
				{ utilization: 100, resetMs: NOW + 4 * HOUR },
				NOW,
			),
		).toBe(false);
	});

	it("skips on the utilization threshold alone when it is the only one configured", () => {
		const slot = makeSlot({ max_utilization_percent: 50 });
		// The reset is five minutes away, which would defeat the reset clause if
		// one were configured. It is not, so it is not considered.
		expect(
			isSlotThrottled(
				slot,
				{ utilization: 99, resetMs: NOW + 5 * 60_000 },
				NOW,
			),
		).toBe(true);
		expect(
			isSlotThrottled(slot, { utilization: 49, resetMs: NOW + 4 * HOUR }, NOW),
		).toBe(false);
	});

	it("skips on the reset distance alone when it is the only one configured", () => {
		const slot = makeSlot({ min_reset_remaining_ms: HOUR });
		// Utilization of 1% would defeat any sane utilization clause. None is
		// configured, so only the reset distance decides.
		expect(
			isSlotThrottled(slot, { utilization: 1, resetMs: NOW + 4 * HOUR }, NOW),
		).toBe(true);
		expect(
			isSlotThrottled(
				slot,
				{ utilization: 99, resetMs: NOW + 5 * 60_000 },
				NOW,
			),
		).toBe(false);
	});

	it("still requires both clauses when both are configured", () => {
		const slot = makeSlot({
			max_utilization_percent: 80,
			min_reset_remaining_ms: HOUR,
		});
		// Each clause alone holds in one of these; neither case skips.
		expect(
			isSlotThrottled(
				slot,
				{ utilization: 99, resetMs: NOW + 5 * 60_000 },
				NOW,
			),
		).toBe(false);
		expect(
			isSlotThrottled(slot, { utilization: 10, resetMs: NOW + 4 * HOUR }, NOW),
		).toBe(false);
		expect(
			isSlotThrottled(slot, { utilization: 99, resetMs: NOW + 4 * HOUR }, NOW),
		).toBe(true);
	});

	it("fires a utilization-only rule when the provider reports no reset timestamp", () => {
		// An absent resetMs is not evidence of a stale snapshot, unlike one in the
		// past, so it blocks only the reset clause.
		expect(
			isSlotThrottled(
				makeSlot({ max_utilization_percent: 50 }),
				{ utilization: 99, resetMs: null },
				NOW,
			),
		).toBe(true);
		expect(
			isSlotThrottled(
				makeSlot({ min_reset_remaining_ms: HOUR }),
				{ utilization: 99, resetMs: null },
				NOW,
			),
		).toBe(false);
	});

	it("does not skip when there is no usage telemetry for the account", () => {
		const slot = makeSlot({
			max_utilization_percent: 80,
			min_reset_remaining_ms: HOUR,
		});
		expect(isSlotThrottled(slot, null, NOW)).toBe(false);
	});

	it("ignores a reset timestamp in the past rather than reading it as zero distance", () => {
		// A resetMs behind now means the cached snapshot predates the window
		// reset, so the utilization figure beside it is stale too. Same staleness
		// rule isUsageExhausted applies.
		const slot = makeSlot({
			max_utilization_percent: 80,
			min_reset_remaining_ms: HOUR,
		});
		expect(
			isSlotThrottled(slot, { utilization: 99, resetMs: NOW - HOUR }, NOW),
		).toBe(false);
	});
});

describe("combo slot selection honours the per-slot throttle", () => {
	const realDateNow = Date.now;

	function withFrozenClock<T>(fn: () => T): T {
		Date.now = () => NOW;
		try {
			return fn();
		} finally {
			Date.now = realDateNow;
		}
	}

	function twoSlotCombo(firstSlot: Partial<ComboSlot>): ComboWithSlots {
		return makeCombo([
			makeSlot({ id: "slot-1", account_id: "acc-1", ...firstSlot }),
			makeSlot({ id: "slot-2", account_id: "acc-2", priority: 1 }),
		]);
	}

	it("skips a throttled slot and routes to the next one", async () => {
		setUsage("acc-1", 90, NOW + 4 * HOUR);
		setUsage("acc-2", 5, NOW + 4 * HOUR);
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "acc-1" }),
				makeAccount({ id: "acc-2", name: "acc-2" }),
			],
			twoSlotCombo({
				max_utilization_percent: 80,
				min_reset_remaining_ms: HOUR,
			}),
		);

		const selected = await withFrozenClock(() =>
			selectAccountsForRequest(makeMeta(), ctx, "claude-sonnet-4-5"),
		);

		expect(selected.map((a) => a.id)).toEqual(["acc-2"]);
	});

	it("leaves selection untouched when the slot carries no thresholds", async () => {
		setUsage("acc-1", 90, NOW + 4 * HOUR);
		setUsage("acc-2", 5, NOW + 4 * HOUR);
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "acc-1" }),
				makeAccount({ id: "acc-2", name: "acc-2" }),
			],
			twoSlotCombo({}),
		);

		const selected = await withFrozenClock(() =>
			selectAccountsForRequest(makeMeta(), ctx, "claude-sonnet-4-5"),
		);

		expect(selected.map((a) => a.id)).toEqual(["acc-1", "acc-2"]);
	});

	it("falls through the existing all-slots-unavailable path when every slot is throttled", async () => {
		setUsage("acc-1", 90, NOW + 4 * HOUR);
		setUsage("acc-2", 95, NOW + 4 * HOUR);
		const accounts = [
			makeAccount({ id: "acc-1", name: "acc-1" }),
			makeAccount({ id: "acc-2", name: "acc-2" }),
		];
		const combo = makeCombo([
			makeSlot({
				id: "slot-1",
				account_id: "acc-1",
				max_utilization_percent: 80,
				min_reset_remaining_ms: HOUR,
			}),
			makeSlot({
				id: "slot-2",
				account_id: "acc-2",
				priority: 1,
				max_utilization_percent: 80,
				min_reset_remaining_ms: HOUR,
			}),
		]);
		const ctx = makeContext(accounts, combo);
		const meta = makeMeta();

		const selected = await withFrozenClock(() =>
			selectAccountsForRequest(meta, ctx, "claude-sonnet-4-5"),
		);

		// The existing fallback path, not an error: normal (non-combo) selection
		// runs and no combo state is stamped on the request.
		expect(meta.comboName).toBeUndefined();
		expect(selected.length).toBeGreaterThan(0);
	});
});
