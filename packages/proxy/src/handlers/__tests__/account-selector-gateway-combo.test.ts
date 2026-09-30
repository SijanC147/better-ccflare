import { describe, expect, it, mock } from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import {
	GATEWAY_COMBO_HEADER,
	GATEWAY_REQUIRE_MODEL_HEADER,
} from "@better-ccflare/types";
import {
	getComboSlotInfo,
	selectAccountsForRequest,
} from "../account-selector";
import type { ProxyContext } from "../proxy-types";

// The combos switch decides whether combo routing runs at all. These tests
// pin the switch to routing; dashboard visibility is deliberately independent.

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "anthropic",
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
		...overrides,
	};
}

function meta(headers: Record<string, string>): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(headers),
	};
}

const codexA = makeAccount({ id: "cdx-a", name: "CDX-A", provider: "codex" });
const codexB = makeAccount({ id: "cdx-b", name: "CDX-B", provider: "codex" });
const claude = makeAccount({ id: "claude-1", name: "CLAUDE" });

const COMBO = {
	id: "combo-gpt",
	name: "GptStandard",
	description: null,
	enabled: true,
	created_at: 0,
	updated_at: 0,
};

function slot(id: string, accountId: string, model: string, priority: number) {
	return {
		id,
		combo_id: COMBO.id,
		account_id: accountId,
		model,
		priority,
		enabled: true,
		max_utilization_percent: null,
		min_reset_remaining_ms: null,
	};
}

function makeCtx(opts: {
	accounts: Account[];
	combos?: Array<typeof COMBO>;
	slots?: ReturnType<typeof slot>[];
	combosEnabled?: boolean;
}) {
	const getActiveComboForFamily = mock(async () => null);
	const ctx = {
		strategy: {
			select: mock((_all: Account[], _meta: RequestMeta) => opts.accounts),
		},
		dbOps: {
			getAllAccounts: mock(async () => opts.accounts),
			getActiveComboForFamily,
			listCombos: mock(async () => opts.combos ?? [COMBO]),
			getComboSlots: mock(async () => opts.slots ?? []),
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) },
		config: { getCombosEnabled: () => opts.combosEnabled ?? true },
	} as unknown as ProxyContext;
	return { ctx, getActiveComboForFamily };
}

describe("selectAccountsForRequest — gateway combo", () => {
	it("routes through the named combo's slots in priority order, whatever the model family", async () => {
		const { ctx, getActiveComboForFamily } = makeCtx({
			accounts: [claude, codexA, codexB],
			slots: [
				slot("s2", "cdx-b", "gpt-5.5", 1),
				slot("s1", "cdx-a", "gpt-5.6-terra", 0),
			],
			// The global family switch does not govern a gateway ladder.
			combosEnabled: false,
		});
		const m = meta({ [GATEWAY_COMBO_HEADER]: "GptStandard" });
		const selected = await selectAccountsForRequest(m, ctx, "gpt-5.6-terra");
		expect(selected.map((a) => a.id)).toEqual(["cdx-a", "cdx-b"]);
		expect(getComboSlotInfo(m)?.slots).toEqual([
			{ accountId: "cdx-a", modelOverride: "gpt-5.6-terra" },
			{ accountId: "cdx-b", modelOverride: "gpt-5.5" },
		]);
		expect(m.comboName).toBe("GptStandard");
		expect(getComboSlotInfo(m)?.gatewayLadder).toBe(true);
		expect(getActiveComboForFamily).not.toHaveBeenCalled();
	});

	it("refuses when the named combo is missing or disabled, rather than using the pool", async () => {
		for (const combos of [[], [{ ...COMBO, enabled: false }]]) {
			const { ctx } = makeCtx({
				accounts: [claude, codexA],
				combos,
				slots: [slot("s1", "cdx-a", "gpt-5.5", 0)],
			});
			const m = meta({ [GATEWAY_COMBO_HEADER]: "GptStandard" });
			const selected = await selectAccountsForRequest(m, ctx, "gpt-5.5");
			expect(selected).toEqual([]);
			// Marked so proxy.ts answers with the combo refusal, not as pool
			// exhaustion with a Retry-After that waiting never satisfies.
			expect(m.comboName).toBe("GptStandard");
			expect(getComboSlotInfo(m)?.gatewayLadder).toBe(true);
		}
	});

	it("an exhausted ladder stops rather than falling back to the pool", async () => {
		const paused = { ...codexA, paused: true };
		const { ctx } = makeCtx({
			accounts: [claude, paused],
			slots: [slot("s1", "cdx-a", "gpt-5.5", 0)],
		});
		const m = meta({ [GATEWAY_COMBO_HEADER]: "GptStandard" });
		expect(await selectAccountsForRequest(m, ctx, "gpt-5.5")).toEqual([]);
	});

	it("the skipCombo re-selection after every slot failed does not widen to the pool", async () => {
		// proxy.ts re-selects with skipCombo once the ladder's attempts have all
		// failed. The slots are still "available" by account state, which is
		// exactly why the re-selection must not simply walk them again or reach
		// the pool.
		const { ctx } = makeCtx({
			accounts: [claude, codexA],
			slots: [slot("s1", "cdx-a", "gpt-5.5", 0)],
		});
		const m = meta({ [GATEWAY_COMBO_HEADER]: "GptStandard" });
		expect(
			await selectAccountsForRequest(m, ctx, "gpt-5.5", { skipCombo: true }),
		).toEqual([]);
	});

	it("without a combo, the require-model header keeps a GPT id off Claude accounts", async () => {
		const { ctx } = makeCtx({ accounts: [claude, codexA] });
		const selected = await selectAccountsForRequest(
			meta({ [GATEWAY_REQUIRE_MODEL_HEADER]: "1" }),
			ctx,
			"gpt-5.5",
		);
		expect(selected.map((a) => a.id)).toEqual(["cdx-a"]);

		const { ctx: plain } = makeCtx({ accounts: [claude, codexA] });
		const unfiltered = await selectAccountsForRequest(
			meta({}),
			plain,
			"gpt-5.5",
		);
		expect(unfiltered.map((a) => a.id)).toEqual(["claude-1", "cdx-a"]);
	});
});
