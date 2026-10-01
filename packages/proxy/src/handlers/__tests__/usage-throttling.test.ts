import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	CODEX_CREDITS_MAX_AGE_MS,
	usageCache,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import {
	collectWindows,
	createUsageThrottledResponse,
	getUsageThrottleStatus,
	getUsageThrottleUntil,
} from "../usage-throttling";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "Codex Account",
		provider: "codex",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: null,
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
		usage_pause_five_hour_min_reset_remaining_ms: null,
		usage_pause_weekly_min_reset_remaining_ms: null,
		...overrides,
	};
}

describe("getUsageThrottleUntil", () => {
	it("returns a future resume time when Codex usage is ahead of the pacing line", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const resetAt = new Date(now + 2 * 60 * 60 * 1000).toISOString();

		const throttleUntil = getUsageThrottleUntil(
			{
				five_hour: { utilization: 80, resets_at: resetAt },
				seven_day: { utilization: 10, resets_at: null },
			},
			"anthropic",
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
		);

		expect(throttleUntil).not.toBeNull();
		expect(throttleUntil).toBeGreaterThan(now);
	});

	it("does not throttle when usage is below the pacing line", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const resetAt = new Date(now + 30 * 60 * 1000).toISOString();

		const throttleUntil = getUsageThrottleUntil(
			{
				five_hour: { utilization: 10, resets_at: resetAt },
				seven_day: { utilization: 5, resets_at: null },
			},
			"anthropic",
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
		);

		expect(throttleUntil).toBeNull();
	});

	it("does not double-count anthropic-like usage as Alibaba usage", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const resetAt = now + 2 * 24 * 60 * 60 * 1000;

		const throttleUntil = getUsageThrottleUntil(
			{
				five_hour: {
					utilization: 10,
					resets_at: new Date(now + 30 * 60 * 1000).toISOString(),
				},
				seven_day: {
					utilization: 10,
					resets_at: new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString(),
				},
				weekly: { percentUsed: 95, resetAt },
				monthly: {
					percentUsed: 10,
					resetAt: now + 20 * 24 * 60 * 60 * 1000,
				},
			},
			"anthropic",
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
		);

		expect(throttleUntil).toBeNull();
	});

	it("can throttle weekly usage independently from the 5-hour window", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const throttleStatus = getUsageThrottleStatus(
			{
				five_hour: {
					utilization: 10,
					resets_at: new Date(now + 30 * 60 * 1000).toISOString(),
				},
				seven_day: {
					utilization: 95,
					resets_at: new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString(),
				},
			},
			"anthropic",
			{ fiveHourEnabled: false, weeklyEnabled: true },
			now,
		);

		expect(throttleStatus.throttledWindows).toEqual(["seven_day"]);
		expect(throttleStatus.throttleUntil).not.toBeNull();
	});

	it("caps throttleUntil at the window reset when utilization exceeds 100%", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const resetAt = new Date(now + 60 * 60 * 1000).toISOString();

		const throttleUntil = getUsageThrottleUntil(
			{
				five_hour: { utilization: 120, resets_at: resetAt },
				seven_day: { utilization: 10, resets_at: null },
			},
			"anthropic",
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
		);

		expect(throttleUntil).toBe(new Date(resetAt).getTime());
	});
});

describe("model-aware limits[] throttling (Phase 2a)", () => {
	const NOW = Date.UTC(2026, 3, 28, 12, 0, 0);
	const settings = { fiveHourEnabled: true, weeklyEnabled: true };
	// A weekly window that started ~1h ago -> any utilization is over the pacing line.
	const weekReset = new Date(
		NOW + 7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000,
	).toISOString();

	const scoped = (percent: number, displayName = "Fable") =>
		({
			limits: [
				{
					kind: "weekly_scoped",
					percent,
					resets_at: weekReset,
					scope: {
						model: { id: null, display_name: displayName },
						surface: null,
					},
				},
			],
		}) as never;

	it("reads weekly_scoped from limits[] and throttles it (scopedMode 'all')", () => {
		const status = getUsageThrottleStatus(
			scoped(50),
			"anthropic",
			settings,
			NOW,
			{
				scopedMode: "all",
			},
		);
		expect(status.throttledWindows).toContain("seven_day_fable");
		expect(status.throttleUntil).not.toBeNull();
	});

	it("throttles a scoped Fable cap only for the matching request family (match mode)", () => {
		expect(
			getUsageThrottleUntil(scoped(50), "anthropic", settings, NOW, {
				requestModel: "claude-fable-5",
				scopedMode: "match",
			}),
		).not.toBeNull();
		// An Opus request over the same account is NOT throttled by the Fable cap.
		expect(
			getUsageThrottleUntil(scoped(50), "anthropic", settings, NOW, {
				requestModel: "claude-opus-4-8",
				scopedMode: "match",
			}),
		).toBeNull();
	});

	it("skips scoped windows when the request model is unknown/combo (null) in match mode", () => {
		expect(
			getUsageThrottleUntil(scoped(50), "anthropic", settings, NOW, {
				requestModel: null,
				scopedMode: "match",
			}),
		).toBeNull();
	});

	it("throttles weekly_all regardless of the request model", () => {
		const data = {
			limits: [
				{ kind: "weekly_all", percent: 50, resets_at: weekReset, scope: null },
			],
		} as never;
		expect(
			getUsageThrottleUntil(data, "anthropic", settings, NOW, {
				requestModel: "claude-opus-4-8",
				scopedMode: "match",
			}),
		).not.toBeNull();
	});

	it("throttles a dynamic seven_day_<slug> window (isWindowThrottlingEnabled default)", () => {
		const status = getUsageThrottleStatus(
			scoped(50, "Fable 4.5"),
			"anthropic",
			settings,
			NOW,
			{ scopedMode: "all" },
		);
		expect(status.throttledWindows).toContain("seven_day_fable_4_5");
	});

	it("prefers limits[] for the windows it carries (weekly_all -> seven_day)", () => {
		const data = {
			five_hour: { utilization: 5, resets_at: weekReset },
			seven_day: { utilization: 5, resets_at: weekReset },
			limits: [
				{ kind: "weekly_all", percent: 50, resets_at: weekReset, scope: null },
			],
		} as never;
		const status = getUsageThrottleStatus(data, "anthropic", settings, NOW, {
			scopedMode: "all",
		});
		// seven_day comes from the limits[] weekly_all (50%, over pace).
		expect(status.throttledWindows).toContain("seven_day");
		// the low flat five_hour (5%) is below pace, so it is not throttled.
		expect(status.throttledWindows).not.toContain("five_hour");
	});
});

describe("review fixes (codex/grok/fable)", () => {
	const NOW = Date.UTC(2026, 3, 28, 12, 0, 0);
	const settings = { fiveHourEnabled: true, weeklyEnabled: true };
	const weekReset = new Date(
		NOW + 7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000,
	).toISOString();
	const fiveReset = new Date(
		NOW + 5 * 60 * 60 * 1000 - 60 * 60 * 1000,
	).toISOString();

	it("falls back to flat windows when limits[] is present but empty", () => {
		const data = {
			limits: [],
			five_hour: { utilization: 50, resets_at: fiveReset },
			seven_day: { utilization: 50, resets_at: weekReset },
		} as never;
		const status = getUsageThrottleStatus(data, "anthropic", settings, NOW, {
			scopedMode: "all",
		});
		expect(status.throttledWindows).toContain("five_hour");
	});

	it("falls back to flat windows when every limits[] entry has null percent", () => {
		const data = {
			limits: [
				{ kind: "session", percent: null, resets_at: fiveReset, scope: null },
				{
					kind: "weekly_all",
					percent: null,
					resets_at: weekReset,
					scope: null,
				},
			],
			five_hour: { utilization: 50, resets_at: fiveReset },
			seven_day: { utilization: 50, resets_at: weekReset },
		} as never;
		const status = getUsageThrottleStatus(data, "anthropic", settings, NOW, {
			scopedMode: "all",
		});
		expect(status.throttledWindows).toContain("five_hour");
	});

	it("does NOT throttle a scoped cap with an unmapped model family in match mode", () => {
		// "Mystery" contains no fable/opus/sonnet/haiku -> modelFamily undefined.
		const data = {
			limits: [
				{
					kind: "weekly_scoped",
					percent: 50,
					resets_at: weekReset,
					scope: {
						model: { id: null, display_name: "Mystery" },
						surface: null,
					},
				},
			],
		} as never;
		// match mode with any model -> scoped skipped (cannot attribute) -> no throttle.
		expect(
			getUsageThrottleUntil(data, "anthropic", settings, NOW, {
				requestModel: "claude-opus-4-8",
				scopedMode: "match",
			}),
		).toBeNull();
		// all mode (display) still surfaces the cap.
		expect(
			getUsageThrottleStatus(data, "anthropic", settings, NOW, {
				scopedMode: "all",
			}).throttledWindows,
		).toContain("seven_day_mystery");
	});

	it("does not double-count five_hour when limits[] session and flat five_hour both exist", () => {
		const data = {
			five_hour: { utilization: 90, resets_at: fiveReset },
			limits: [
				{ kind: "session", percent: 90, resets_at: fiveReset, scope: null },
			],
		} as never;
		const status = getUsageThrottleStatus(data, "anthropic", settings, NOW, {
			scopedMode: "all",
		});
		// five_hour comes from the limits[] session; the flat five_hour is NOT re-added.
		expect(
			status.throttledWindows.filter((w) => w === "five_hour"),
		).toHaveLength(1);
	});

	it("still evaluates the flat account cap when limits[] carries only a scoped row (Greptile hybrid)", () => {
		// limits[] has ONLY a per-model Fable cap; the flat five_hour account cap is
		// exhausted and NOT represented in limits[].
		const data = {
			five_hour: { utilization: 95, resets_at: fiveReset },
			limits: [
				{
					kind: "weekly_scoped",
					percent: 50,
					resets_at: weekReset,
					scope: { model: { id: null, display_name: "Fable" }, surface: null },
				},
			],
		} as never;
		// A Sonnet request: the Fable scoped cap is skipped (family mismatch), but
		// the exhausted flat five_hour ACCOUNT cap must still throttle.
		expect(
			getUsageThrottleUntil(data, "anthropic", settings, NOW, {
				requestModel: "claude-sonnet-4-5",
				scopedMode: "match",
			}),
		).not.toBeNull();
	});
});

describe("createUsageThrottledResponse", () => {
	it("returns HTTP 529 with Retry-After and an Anthropic-style overload body", async () => {
		const response = createUsageThrottledResponse([
			makeAccount({ name: "Codex A" }),
			makeAccount({ id: "acc-2", name: "Codex B" }),
		]);

		expect(response.status).toBe(529);
		expect(response.headers.get("Retry-After")).toBe("60");

		const body = (await response.json()) as {
			type: string;
			error: { type: string; message: string };
		};
		expect(body.type).toBe("error");
		expect(body.error.type).toBe("overloaded_error");
		expect(body.error.message).toContain("Codex A");
		expect(body.error.message).toContain("Codex B");
	});
});

describe("collectWindows with a single flat window", () => {
	it("collects seven_day from a Codex payload that has no five_hour key", () => {
		// parseCodexUsageHeaders omits a window the upstream did not report, so a
		// Pro account's payload is { seven_day } alone. It must still throttle.
		const resetsAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
		const windows = collectWindows({
			seven_day: { utilization: 100, resets_at: resetsAt.toISOString() },
		} as never);

		expect(windows).toHaveLength(1);
		expect(windows[0].window).toBe("seven_day");
		expect(windows[0].utilization).toBe(100);
		expect(windows[0].resetAtMs).toBe(resetsAt.getTime());
	});

	it("collects five_hour from a payload that has no seven_day key", () => {
		const resetsAt = new Date(Date.now() + 60 * 60 * 1000);
		const windows = collectWindows({
			five_hour: { utilization: 50, resets_at: resetsAt.toISOString() },
		} as never);

		expect(windows.map((w) => w.window)).toEqual(["five_hour"]);
	});

	it("still routes an Alibaba Coding Plan payload (five_hour without seven_day) to the Alibaba branch", () => {
		const now = Date.now();
		const windows = collectWindows({
			five_hour: {
				used: 10,
				total: 100,
				percentUsed: 10,
				resetAt: now + 60_000,
			},
			weekly: {
				used: 95,
				total: 100,
				percentUsed: 95,
				resetAt: now + 3 * 24 * 60 * 60 * 1000,
			},
			monthly: {
				used: 50,
				total: 100,
				percentUsed: 50,
				resetAt: now + 20 * 24 * 60 * 60 * 1000,
			},
			planName: "Coding Plan Lite",
			status: "VALID",
			remainingDays: 20,
		} as never);

		expect(windows.map((w) => w.window)).toEqual([
			"five_hour",
			"weekly",
			"monthly",
		]);
		expect(windows.find((w) => w.window === "weekly")?.utilization).toBe(95);
	});
});

/**
 * SB23-2541: the weekly usage throttle leaves out `seven_day` for a Codex
 * account whose fresh credit balance covers it, using the admission predicate
 * (`codexCreditsExcludeWeekly`) rather than a copy of it. Every negative below
 * is throttled exactly as it was before the change.
 */
describe("weekly throttle and a credit-covered Codex account (SB23-2541)", () => {
	const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
	const DAY = 24 * 60 * 60 * 1000;
	const HOUR = 60 * 60 * 1000;
	const settings = { fiveHourEnabled: true, weeklyEnabled: true };
	const ACCOUNT = "sb23-2541-codex";

	type Credits = {
		has_credits: boolean;
		unlimited: boolean;
		balance: string | null;
	};

	/**
	 * Halfway through both windows, so the expected pace is 50 percent and a
	 * weekly window at 100 is throttled until its reset on its own.
	 */
	function payload(opts: {
		fiveHour?: number;
		weekly?: number;
		credits?: Credits | undefined;
	}) {
		return {
			five_hour: {
				utilization: opts.fiveHour ?? 10,
				resets_at: new Date(NOW + 2.5 * HOUR).toISOString(),
			},
			seven_day: {
				utilization: opts.weekly ?? 100,
				resets_at: new Date(NOW + 3.5 * DAY).toISOString(),
			},
			...(opts.credits ? { credits: opts.credits } : {}),
		} as never;
	}

	const covering: Credits = {
		has_credits: true,
		unlimited: false,
		balance: "9.99",
	};

	function status(data: unknown, provider: string) {
		return getUsageThrottleStatus(data as never, provider, settings, NOW, {
			scopedMode: "match",
		});
	}

	it("does not throttle a credit-covered Codex account at seven_day = 100", () => {
		const result = status(payload({ credits: covering }), "codex");
		expect(result.throttleUntil).toBeNull();
		expect(result.throttledWindows).toEqual([]);
	});

	it("does not throttle a credit-covered Codex account ahead of pace below 100: the exclusion is unconditional on utilization", () => {
		// Admission skips seven_day at any value; a throttle that excluded it
		// only at 100 would 529 this account while admission admits it.
		const result = status(payload({ weekly: 90, credits: covering }), "codex");
		expect(result.throttleUntil).toBeNull();
		expect(result.throttledWindows).toEqual([]);
		// Control: the same reading without credits is ahead of pace and throttled.
		expect(status(payload({ weekly: 90 }), "codex").throttledWindows).toEqual([
			"seven_day",
		]);
	});

	it("does not throttle an unlimited credit-covered Codex account either", () => {
		const result = status(
			payload({
				credits: { has_credits: true, unlimited: true, balance: null },
			}),
			"codex",
		);
		expect(result.throttleUntil).toBeNull();
	});

	it("leaves out a weekly_all limit for the same account, which collectWindows names seven_day", () => {
		const data = {
			limits: [
				{
					kind: "weekly_all",
					percent: 100,
					resets_at: new Date(NOW + 3.5 * DAY).toISOString(),
				},
			],
			credits: covering,
		};
		expect(status(data, "codex").throttleUntil).toBeNull();
		// Same payload without the balance: throttled, so the case above is the
		// exclusion and not an unparsed shape.
		const { credits: _c, ...bare } = data;
		expect(status(bare, "codex").throttledWindows).toEqual(["seven_day"]);
	});

	it("still throttles the five-hour window of a credit-covered Codex account", () => {
		const result = status(
			payload({ fiveHour: 80, credits: covering }),
			"codex",
		);
		expect(result.throttledWindows).toEqual(["five_hour"]);
		expect(result.throttleUntil).toBe(NOW - 2.5 * HOUR + 0.8 * 5 * HOUR);
	});

	const throttledWeekly = NOW + 3.5 * DAY;

	it.each([
		["no credits", undefined],
		[
			"a zero balance",
			{ has_credits: true, unlimited: false, balance: "0" } as Credits,
		],
		[
			"has_credits false",
			{ has_credits: false, unlimited: false, balance: "9.99" } as Credits,
		],
		[
			"has_credits true with no balance",
			{ has_credits: true, unlimited: false, balance: null } as Credits,
		],
	])("throttles a Codex account at seven_day = 100 with %s", (_label, credits) => {
		const result = status(payload({ credits }), "codex");
		expect(result.throttledWindows).toEqual(["seven_day"]);
		expect(result.throttleUntil).toBe(throttledWeekly);
	});

	it("throttles an Anthropic payload carrying a covering credits key: the gate is the provider, not the key", () => {
		const result = status(payload({ credits: covering }), "anthropic");
		expect(result.throttledWindows).toEqual(["seven_day"]);
		expect(result.throttleUntil).toBe(throttledWeekly);
	});

	it("leaves an xAI payload, whose only field is credits, exactly as before (no windows, never throttled)", () => {
		// Guard only: collectWindows yields nothing for this shape, so this case
		// passes with or without the provider gate and kills no mutation. The
		// Anthropic case above is the one that pins the gate.
		const xai = {
			credits: {
				utilization: 100,
				resets_at: new Date(NOW + 3.5 * DAY).toISOString(),
			},
		};
		expect(status(xai, "xai")).toEqual({
			throttleUntil: null,
			throttledWindows: [],
		});
	});

	describe("read through usageCache, where a stale balance is withheld", () => {
		const realNow = Date.now;
		beforeEach(() => {
			// Frozen BEFORE usageCache.set, so the entry's own timestamp is NOW
			// and only the credits' age differs between the two cases.
			Date.now = () => NOW;
		});
		afterEach(() => {
			Date.now = realNow;
			usageCache.delete(ACCOUNT);
		});

		it("does not throttle when the balance was observed just now", () => {
			usageCache.set(ACCOUNT, payload({ credits: covering }), NOW);
			expect(status(usageCache.get(ACCOUNT), "codex").throttleUntil).toBeNull();
		});

		it("throttles when the balance is older than CODEX_CREDITS_MAX_AGE_MS, though the entry is fresh", () => {
			usageCache.set(
				ACCOUNT,
				payload({ credits: covering }),
				NOW - CODEX_CREDITS_MAX_AGE_MS - 1,
			);
			const result = status(usageCache.get(ACCOUNT), "codex");
			expect(result.throttledWindows).toEqual(["seven_day"]);
			expect(result.throttleUntil).toBe(throttledWeekly);
		});
	});
});
