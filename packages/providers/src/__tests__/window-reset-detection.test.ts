import { describe, expect, it, mock } from "bun:test";
import type { NanoGPTUsageData, ZaiUsageWindow } from "@better-ccflare/types";
import { makeZaiUsage } from "../testing/zai-usage-fixture";
import type { AnyUsageData, UsageData } from "../usage-fetcher";
import {
	extractWeeklyResetTime,
	extractWeeklyUtilization,
	extractWindowResetTime,
	getRepresentativeUsageResetMs,
	getRepresentativeUsageSnapshotForProvider,
	getRepresentativeUtilizationForProvider,
	usageCache,
} from "../usage-fetcher";
import type { XaiUsageData } from "../xai-usage-fetcher";

// Typed fixtures for the providers the weekly helpers do not read. Each one
// carries real data, so a null from a weekly helper is a statement about the
// provider rather than about an empty object (SB23-2455: the `{} as any` they
// replace was not a value of any of these types).

function zaiWindow(
	percentage: number,
	resetAt: number | null,
	type: string,
): ZaiUsageWindow {
	return {
		used: percentage,
		remaining: 100 - percentage,
		percentage,
		resetAt,
		type,
	};
}

/** zai with both token windows set, the weekly one the more used. */
const ZAI_BOTH_WINDOWS = makeZaiUsage({
	tokens_limit: zaiWindow(40, 1_000, "tokens_limit"),
	tokens_limit_weekly: zaiWindow(90, 9_000, "tokens_limit_weekly"),
});

const XAI_WITH_CREDITS: XaiUsageData = {
	credits: { utilization: 75, resets_at: "2030-03-08T00:00:00.000Z" },
};

const NANOGPT_ACTIVE: NanoGPTUsageData = {
	active: true,
	limits: { daily: 100, monthly: 1000 },
	enforceDailyLimit: false,
	daily: { used: 50, remaining: 50, percentUsed: 0.5, resetAt: 2_000 },
	monthly: { used: 700, remaining: 300, percentUsed: 0.7, resetAt: 3_000 },
	state: "active",
	graceUntil: null,
};

// ── extractWindowResetTime ────────────────────────────────────────────────────

describe("extractWindowResetTime", () => {
	it("returns tokens_limit.resetAt for zai provider", () => {
		const data = makeZaiUsage({
			tokens_limit: {
				used: 10,
				remaining: 90,
				percentage: 10,
				resetAt: 9999000,
				type: "tokens_limit",
			},
		});
		expect(extractWindowResetTime(data, "zai")).toBe(9999000);
	});

	it("returns null for zai provider when tokens_limit is null", () => {
		const data = makeZaiUsage({ tokens_limit: null });
		expect(extractWindowResetTime(data, "zai")).toBeNull();
	});

	it("returns parsed resets_at ms for anthropic provider", () => {
		const resetIso = "2030-01-01T12:00:00Z";
		const data: UsageData = {
			five_hour: { utilization: 50, resets_at: resetIso },
			seven_day: { utilization: 10, resets_at: null },
		};
		expect(extractWindowResetTime(data, "anthropic")).toBe(
			new Date(resetIso).getTime(),
		);
	});

	it("returns null for anthropic when resets_at is null", () => {
		const data: UsageData = {
			five_hour: { utilization: 50, resets_at: null },
			seven_day: { utilization: 10, resets_at: null },
		};
		expect(extractWindowResetTime(data, "anthropic")).toBeNull();
	});

	it("falls back to limits[] session resets_at for anthropic limits-only payloads", () => {
		const resetIso = "2030-03-01T00:00:00.000Z";
		const data = {
			limits: [
				{ kind: "session", percent: 40, resets_at: resetIso, scope: null },
			],
		} as unknown as UsageData;
		expect(extractWindowResetTime(data, "anthropic")).toBe(
			new Date(resetIso).getTime(),
		);
	});

	it("returns parsed credits reset for xai provider", () => {
		const resetIso = "2030-02-01T00:00:00.000Z";
		const data: XaiUsageData = {
			credits: { utilization: 11, resets_at: resetIso },
		};
		expect(extractWindowResetTime(data, "xai")).toBe(
			new Date(resetIso).getTime(),
		);
	});

	it("returns null for unknown/unsupported provider", () => {
		expect(extractWindowResetTime({} as AnyUsageData, "nanogpt")).toBeNull();
	});
});

// ── extractWeeklyResetTime ─────────────────────────────────────────────────

describe("extractWeeklyResetTime", () => {
	it("returns parsed seven_day resets_at ms for anthropic provider", () => {
		const resetIso = "2030-01-08T12:00:00Z";
		const data: UsageData = {
			five_hour: { utilization: 50, resets_at: "2030-01-01T12:00:00Z" },
			seven_day: { utilization: 10, resets_at: resetIso },
		};
		expect(extractWeeklyResetTime(data, "anthropic")).toBe(
			new Date(resetIso).getTime(),
		);
	});

	it("returns null for anthropic when seven_day resets_at is null", () => {
		const data: UsageData = {
			five_hour: { utilization: 50, resets_at: "2030-01-01T12:00:00Z" },
			seven_day: { utilization: 10, resets_at: null },
		};
		expect(extractWeeklyResetTime(data, "anthropic")).toBeNull();
	});

	it("falls back to limits[] weekly_all resets_at for limits-only payloads", () => {
		const resetIso = "2030-03-08T00:00:00.000Z";
		const data = {
			limits: [
				{ kind: "session", percent: 40, resets_at: null, scope: null },
				{
					kind: "weekly_all",
					percent: 60,
					resets_at: resetIso,
					scope: null,
				},
			],
		} as unknown as UsageData;
		expect(extractWeeklyResetTime(data, "codex")).toBe(
			new Date(resetIso).getTime(),
		);
	});

	it("returns null for providers without a weekly_all window (zai, xai, unsupported)", () => {
		expect(extractWeeklyResetTime(makeZaiUsage(), "zai")).toBeNull();
		// zai's own weekly token window is not a weekly_all window.
		expect(extractWeeklyResetTime(ZAI_BOTH_WINDOWS, "zai")).toBeNull();
		expect(extractWeeklyResetTime(XAI_WITH_CREDITS, "xai")).toBeNull();
		expect(extractWeeklyResetTime(NANOGPT_ACTIVE, "nanogpt")).toBeNull();
	});
});

// ── extractWeeklyUtilization ───────────────────────────────────────────────
// Regression coverage for #443 review feedback: the out-of-band-reset
// detector must read the seven_day window specifically, not the
// account-wide max utilization (which a busy five_hour session window would
// keep non-zero even while seven_day silently resets).

describe("extractWeeklyUtilization", () => {
	it("returns seven_day utilization for anthropic provider", () => {
		const data: UsageData = {
			five_hour: { utilization: 90, resets_at: "2030-01-01T12:00:00Z" },
			seven_day: { utilization: 42, resets_at: "2030-01-08T12:00:00Z" },
		};
		expect(extractWeeklyUtilization(data, "anthropic")).toBe(42);
	});

	it("reads 0% seven_day utilization even when five_hour is busy", () => {
		const data: UsageData = {
			five_hour: { utilization: 88, resets_at: "2030-01-01T12:00:00Z" },
			seven_day: { utilization: 0, resets_at: null },
		};
		expect(extractWeeklyUtilization(data, "anthropic")).toBe(0);
	});

	it("falls back to limits[] weekly_all percent for limits-only payloads", () => {
		const data = {
			limits: [
				{ kind: "session", percent: 90, resets_at: null, scope: null },
				{ kind: "weekly_all", percent: 0, resets_at: null, scope: null },
			],
		} as unknown as UsageData;
		expect(extractWeeklyUtilization(data, "codex")).toBe(0);
	});

	it("returns null for providers without a weekly_all window (zai, xai, unsupported)", () => {
		expect(extractWeeklyUtilization(makeZaiUsage(), "zai")).toBeNull();
		expect(extractWeeklyUtilization(ZAI_BOTH_WINDOWS, "zai")).toBeNull();
		expect(extractWeeklyUtilization(XAI_WITH_CREDITS, "xai")).toBeNull();
		expect(extractWeeklyUtilization(NANOGPT_ACTIVE, "nanogpt")).toBeNull();
	});

	it("returns null when neither seven_day nor limits[] weekly_all is present", () => {
		expect(extractWeeklyUtilization({} as UsageData, "anthropic")).toBeNull();
	});
});

// ── zai: the 5-hour and weekly token windows together ─────────────────────
// SB23-2455. Every zai fixture in this file used to leave tokens_limit_weekly
// null, so the selection between the two token windows ran on one candidate.
// These set both and assert which one wins, through the three exported paths
// that read it: the reset (token windows only), the utilization (the max of
// every window) and the snapshot (the winner across all three windows).

describe("zai weekly token window", () => {
	it("the more-used weekly window wins: its reset and its utilization", () => {
		expect(getRepresentativeUsageResetMs(ZAI_BOTH_WINDOWS, "zai")).toBe(9_000);
		expect(
			getRepresentativeUtilizationForProvider(ZAI_BOTH_WINDOWS, "zai"),
		).toBe(90);
		expect(
			getRepresentativeUsageSnapshotForProvider(ZAI_BOTH_WINDOWS, "zai"),
		).toEqual({ utilization: 90, resetMs: 9_000 });
	});

	it("the more-used 5-hour window wins over a lighter weekly one", () => {
		const data = makeZaiUsage({
			tokens_limit: zaiWindow(95, 1_000, "tokens_limit"),
			tokens_limit_weekly: zaiWindow(30, 9_000, "tokens_limit_weekly"),
		});
		expect(getRepresentativeUsageResetMs(data, "zai")).toBe(1_000);
		expect(getRepresentativeUtilizationForProvider(data, "zai")).toBe(95);
		expect(getRepresentativeUsageSnapshotForProvider(data, "zai")).toEqual({
			utilization: 95,
			resetMs: 1_000,
		});
	});

	it("a weekly window alone is still read", () => {
		const data = makeZaiUsage({
			tokens_limit_weekly: zaiWindow(60, 7_000, "tokens_limit_weekly"),
		});
		expect(getRepresentativeUsageResetMs(data, "zai")).toBe(7_000);
		expect(getRepresentativeUsageSnapshotForProvider(data, "zai")).toEqual({
			utilization: 60,
			resetMs: 7_000,
		});
	});

	it("equal percentages prefer the later reset, whichever window holds it", () => {
		const weeklyLater = makeZaiUsage({
			tokens_limit: zaiWindow(100, 1_000, "tokens_limit"),
			tokens_limit_weekly: zaiWindow(100, 9_000, "tokens_limit_weekly"),
		});
		expect(getRepresentativeUsageResetMs(weeklyLater, "zai")).toBe(9_000);
		expect(
			getRepresentativeUsageSnapshotForProvider(weeklyLater, "zai"),
		).toEqual({ utilization: 100, resetMs: 9_000 });

		// The same tie with the order of the resets reversed, so a rule that
		// simply preferred one window would fail one of the two cases.
		const fiveHourLater = makeZaiUsage({
			tokens_limit: zaiWindow(100, 9_000, "tokens_limit"),
			tokens_limit_weekly: zaiWindow(100, 1_000, "tokens_limit_weekly"),
		});
		expect(getRepresentativeUsageResetMs(fiveHourLater, "zai")).toBe(9_000);
		expect(
			getRepresentativeUsageSnapshotForProvider(fiveHourLater, "zai"),
		).toEqual({ utilization: 100, resetMs: 9_000 });
	});

	it("on a tie, an unknown reset outranks a known one", () => {
		// Unknown is treated as latest: the account is not known to be back.
		for (const [fiveHourReset, weeklyReset] of [
			[null, 9_000],
			[9_000, null],
		] as const) {
			const data = makeZaiUsage({
				tokens_limit: zaiWindow(100, fiveHourReset, "tokens_limit"),
				tokens_limit_weekly: zaiWindow(100, weeklyReset, "tokens_limit_weekly"),
			});
			expect(getRepresentativeUsageResetMs(data, "zai")).toBeNull();
			expect(getRepresentativeUsageSnapshotForProvider(data, "zai")).toEqual({
				utilization: 100,
				resetMs: null,
			});
		}
	});

	it("the reset reads token windows only; the snapshot also weighs time_limit", () => {
		const data = makeZaiUsage({
			time_limit: zaiWindow(99, 5_000, "time_limit"),
			tokens_limit: zaiWindow(40, 1_000, "tokens_limit"),
			tokens_limit_weekly: zaiWindow(90, 9_000, "tokens_limit_weekly"),
		});
		expect(getRepresentativeUsageResetMs(data, "zai")).toBe(9_000);
		expect(getRepresentativeUtilizationForProvider(data, "zai")).toBe(99);
		expect(getRepresentativeUsageSnapshotForProvider(data, "zai")).toEqual({
			utilization: 99,
			resetMs: 5_000,
		});
	});

	it("no windows at all is no opinion", () => {
		expect(getRepresentativeUsageResetMs(makeZaiUsage(), "zai")).toBeNull();
		expect(
			getRepresentativeUtilizationForProvider(makeZaiUsage(), "zai"),
		).toBeNull();
		expect(
			getRepresentativeUsageSnapshotForProvider(makeZaiUsage(), "zai"),
		).toBeNull();
	});
});

// ── onWindowReset callback via usageCache.set ─────────────────────────────────

describe("usageCache window-reset callback", () => {
	it("fires onWindowReset when zai resetAt advances to a later value", () => {
		const accountId = "zai-window-reset-test";
		const callback = mock(() => {});

		const oldData = makeZaiUsage({
			tokens_limit: {
				used: 80,
				remaining: 20,
				percentage: 80,
				resetAt: 1000000,
				type: "tokens_limit",
			},
		});
		const newData = makeZaiUsage({
			tokens_limit: {
				used: 2,
				remaining: 98,
				percentage: 2,
				resetAt: 2000000,
				type: "tokens_limit",
			},
		});

		// Seed the cache with old data, then simulate a poll delivering new data
		usageCache.set(accountId, oldData);
		usageCache.notifyWindowReset(accountId, newData, "zai", callback);

		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith(accountId);

		usageCache.delete(accountId);
	});

	it("does not fire onWindowReset when resetAt stays the same", () => {
		const accountId = "zai-no-reset-test";
		const callback = mock(() => {});

		const data = makeZaiUsage({
			tokens_limit: {
				used: 50,
				remaining: 50,
				percentage: 50,
				resetAt: 1000000,
				type: "tokens_limit",
			},
		});

		usageCache.set(accountId, data);
		usageCache.notifyWindowReset(accountId, data, "zai", callback);

		expect(callback).not.toHaveBeenCalled();

		usageCache.delete(accountId);
	});

	it("does not fire onWindowReset on the first poll (no previous data)", () => {
		const accountId = "zai-first-poll-test";
		const callback = mock(() => {});

		const data = makeZaiUsage({
			tokens_limit: {
				used: 5,
				remaining: 95,
				percentage: 5,
				resetAt: 3000000,
				type: "tokens_limit",
			},
		});

		// No prior set() — first time seeing this account
		usageCache.notifyWindowReset(accountId, data, "zai", callback);

		expect(callback).not.toHaveBeenCalled();
	});

	// The upstream reset timestamp jitters by fractions of a second around the
	// same wall-clock instant, so a bare `newResetAt > prevResetAt` misreads that
	// jitter as a window rollover. Measured over 48h of production logs: 1554 of
	// 1564 detections were jitter (largest 1.879s), the 10 genuine rollovers all
	// advanced by exactly 5.00h — an empty gap of 1.9s…17999s between the classes.
	// The literals below pin that measurement, deliberately not derived from the
	// threshold constant so a wrong constant still fails these tests.

	it("does not fire onWindowReset on sub-second jitter (332ms, as observed)", () => {
		const accountId = "zai-jitter-test";
		const callback = mock(() => {});

		const base = 1_700_000_000_000;
		const oldData = makeZaiUsage({
			tokens_limit: {
				used: 60,
				remaining: 40,
				percentage: 60,
				resetAt: base,
				type: "tokens_limit",
			},
		});
		const newData = makeZaiUsage({
			tokens_limit: {
				used: 61,
				remaining: 39,
				percentage: 61,
				resetAt: base + 332,
				type: "tokens_limit",
			},
		});

		usageCache.set(accountId, oldData);
		usageCache.notifyWindowReset(accountId, newData, "zai", callback);

		expect(callback).not.toHaveBeenCalled();

		usageCache.delete(accountId);
	});

	it("does not fire onWindowReset when the advance stays below the threshold (59s)", () => {
		const accountId = "zai-below-threshold-test";
		const callback = mock(() => {});

		const base = 1_700_000_000_000;
		const oldData = makeZaiUsage({
			tokens_limit: {
				used: 60,
				remaining: 40,
				percentage: 60,
				resetAt: base,
				type: "tokens_limit",
			},
		});
		const newData = makeZaiUsage({
			tokens_limit: {
				used: 62,
				remaining: 38,
				percentage: 62,
				resetAt: base + 59_000,
				type: "tokens_limit",
			},
		});

		usageCache.set(accountId, oldData);
		usageCache.notifyWindowReset(accountId, newData, "zai", callback);

		expect(callback).not.toHaveBeenCalled();

		usageCache.delete(accountId);
	});

	it("fires onWindowReset on a genuine 5h window rollover", () => {
		const accountId = "zai-real-rollover-test";
		const callback = mock(() => {});

		const base = 1_700_000_000_000;
		const oldData = makeZaiUsage({
			tokens_limit: {
				used: 95,
				remaining: 5,
				percentage: 95,
				resetAt: base,
				type: "tokens_limit",
			},
		});
		const newData = makeZaiUsage({
			tokens_limit: {
				used: 1,
				remaining: 99,
				percentage: 1,
				resetAt: base + 5 * 60 * 60 * 1000,
				type: "tokens_limit",
			},
		});

		usageCache.set(accountId, oldData);
		usageCache.notifyWindowReset(accountId, newData, "zai", callback);

		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith(accountId);

		usageCache.delete(accountId);
	});

	it("does not fire onWindowReset on anthropic five_hour jitter (real payload)", () => {
		const accountId = "anthropic-jitter-test";
		const callback = mock(() => {});

		// Verbatim from the production log that surfaced this bug.
		const oldData: UsageData = {
			five_hour: { utilization: 74, resets_at: "2026-08-04T07:19:59.388Z" },
			seven_day: { utilization: 31, resets_at: null },
		};
		const newData: UsageData = {
			five_hour: { utilization: 75, resets_at: "2026-08-04T07:19:59.720Z" },
			seven_day: { utilization: 31, resets_at: null },
		};

		usageCache.set(accountId, oldData);
		usageCache.notifyWindowReset(accountId, newData, "anthropic", callback);

		expect(callback).not.toHaveBeenCalled();

		usageCache.delete(accountId);
	});
});
