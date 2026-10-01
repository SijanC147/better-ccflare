import { describe, expect, it } from "bun:test";
import { MAX_MIN_RESET_REMAINING_MS } from "@better-ccflare/types";
import {
	effectiveThreshold,
	evaluateUsagePause,
	isUsagePauseWindowConfigured,
	parseUsagePauseMinResetMs,
	parseUsagePauseThreshold,
	readUsageResets,
	readUsageUtilization,
	restrictToReportedWindows,
	supportsUsagePauseThreshold,
	USAGE_THRESHOLD_PAUSE_REASON,
	unreportedWindowRefusal,
	usagePauseWindowsForProvider,
} from "./usage-threshold";

const off = { enabled: false, percent: null, minResetRemainingMs: null };
const NO_THRESHOLDS = { fiveHour: off, weekly: off };
/** A window switched on at `percent`. */
const on = (percent: number) => ({
	enabled: true,
	percent,
	minResetRemainingMs: null,
});
const NO_RESETS = { fiveHour: null, weekly: null };
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

describe("parseUsagePauseThreshold", () => {
	it("accepts whole percentages from 1 to 100", () => {
		expect(parseUsagePauseThreshold(1)).toBe(1);
		expect(parseUsagePauseThreshold(80)).toBe(80);
		expect(parseUsagePauseThreshold(100)).toBe(100);
	});

	it("reads numeric strings, so a form field can be handed over as-is", () => {
		expect(parseUsagePauseThreshold("80")).toBe(80);
	});

	it("treats null, undefined and empty string as 'no threshold'", () => {
		expect(parseUsagePauseThreshold(null)).toBeNull();
		expect(parseUsagePauseThreshold(undefined)).toBeNull();
		expect(parseUsagePauseThreshold("")).toBeNull();
	});

	it("rejects out-of-range, fractional and non-numeric values", () => {
		expect(() => parseUsagePauseThreshold(0)).toThrow();
		expect(() => parseUsagePauseThreshold(101)).toThrow();
		expect(() => parseUsagePauseThreshold(-5)).toThrow();
		expect(() => parseUsagePauseThreshold(80.5)).toThrow();
		expect(() => parseUsagePauseThreshold("eighty")).toThrow();
		expect(() => parseUsagePauseThreshold(Number.NaN)).toThrow();
	});
});

describe("evaluateUsagePause", () => {
	it("does nothing when no threshold is configured", () => {
		expect(
			evaluateUsagePause({
				resets: NO_RESETS,
				now: NOW,
				thresholds: NO_THRESHOLDS,
				utilization: { fiveHour: 99, weekly: 99 },
				paused: false,
				pauseReason: null,
			}),
		).toStrictEqual({ action: "none" });
	});

	it("pauses once the 5-hour window reaches its threshold", () => {
		expect(
			evaluateUsagePause({
				resets: NO_RESETS,
				now: NOW,
				thresholds: { fiveHour: on(80), weekly: off },
				utilization: { fiveHour: 80, weekly: 10 },
				paused: false,
				pauseReason: null,
			}),
		).toStrictEqual({
			action: "pause",
			window: "five_hour",
			utilization: 80,
			threshold: 80,
			resetRemainingMs: null,
			minResetRemainingMs: null,
		});
	});

	it("pauses once the weekly window reaches its threshold", () => {
		expect(
			evaluateUsagePause({
				resets: NO_RESETS,
				now: NOW,
				thresholds: { fiveHour: off, weekly: on(90) },
				utilization: { fiveHour: 5, weekly: 93 },
				paused: false,
				pauseReason: null,
			}),
		).toStrictEqual({
			action: "pause",
			window: "weekly",
			utilization: 93,
			threshold: 90,
			resetRemainingMs: null,
			minResetRemainingMs: null,
		});
	});

	it("reports the 5-hour window first when both windows are over", () => {
		const decision = evaluateUsagePause({
			resets: NO_RESETS,
			now: NOW,
			thresholds: { fiveHour: on(50), weekly: on(50) },
			utilization: { fiveHour: 60, weekly: 70 },
			paused: false,
			pauseReason: null,
		});
		expect(decision).toStrictEqual({
			action: "pause",
			window: "five_hour",
			utilization: 60,
			threshold: 50,
			resetRemainingMs: null,
			minResetRemainingMs: null,
		});
	});

	it("stays out of the way below the threshold", () => {
		expect(
			evaluateUsagePause({
				resets: NO_RESETS,
				now: NOW,
				thresholds: { fiveHour: on(80), weekly: on(80) },
				utilization: { fiveHour: 79, weekly: 0 },
				paused: false,
				pauseReason: null,
			}),
		).toStrictEqual({ action: "none" });
	});

	it("treats 0% as a real reading, not a missing one", () => {
		expect(
			evaluateUsagePause({
				resets: NO_RESETS,
				now: NOW,
				thresholds: { fiveHour: on(80), weekly: off },
				utilization: { fiveHour: 0, weekly: null },
				paused: true,
				pauseReason: USAGE_THRESHOLD_PAUSE_REASON,
			}),
		).toStrictEqual({ action: "resume" });
	});

	it("ignores a window the usage API did not report", () => {
		expect(
			evaluateUsagePause({
				resets: NO_RESETS,
				now: NOW,
				thresholds: { fiveHour: on(80), weekly: on(80) },
				utilization: { fiveHour: null, weekly: 12 },
				paused: false,
				pauseReason: null,
			}),
		).toStrictEqual({ action: "none" });
	});

	it("does not pause an account that is already paused", () => {
		expect(
			evaluateUsagePause({
				resets: NO_RESETS,
				now: NOW,
				thresholds: { fiveHour: on(80), weekly: off },
				utilization: { fiveHour: 95, weekly: null },
				paused: true,
				pauseReason: USAGE_THRESHOLD_PAUSE_REASON,
			}),
		).toStrictEqual({ action: "none" });
	});

	it("never touches a manually paused account", () => {
		expect(
			evaluateUsagePause({
				resets: NO_RESETS,
				now: NOW,
				thresholds: { fiveHour: on(80), weekly: off },
				utilization: { fiveHour: 95, weekly: null },
				paused: true,
				pauseReason: "manual",
			}),
		).toStrictEqual({ action: "none" });
		expect(
			evaluateUsagePause({
				resets: NO_RESETS,
				now: NOW,
				thresholds: { fiveHour: on(80), weekly: off },
				utilization: { fiveHour: 3, weekly: null },
				paused: true,
				pauseReason: "manual",
			}),
		).toStrictEqual({ action: "none" });
	});

	it("uses a reason the load balancer will not auto-unpause", () => {
		// The load balancer resumes `overage`, `rate_limit_window` and unset
		// reasons once the stored rate_limit_reset elapses. That timestamp covers
		// one window, so an account benched for its weekly threshold could be
		// resumed by a 5-hour reset. Resuming is the poller's job alone.
		expect(USAGE_THRESHOLD_PAUSE_REASON).toBe("usage_threshold");
	});

	it("leaves a rate_limit_window pause to the load balancer", () => {
		expect(
			evaluateUsagePause({
				resets: NO_RESETS,
				now: NOW,
				thresholds: { fiveHour: on(80), weekly: off },
				utilization: { fiveHour: 3, weekly: null },
				paused: true,
				pauseReason: "rate_limit_window",
			}),
		).toStrictEqual({ action: "none" });
	});

	it("leaves an overage pause to the overage logic", () => {
		expect(
			evaluateUsagePause({
				resets: NO_RESETS,
				now: NOW,
				thresholds: { fiveHour: on(80), weekly: off },
				utilization: { fiveHour: 3, weekly: null },
				paused: true,
				pauseReason: "overage",
			}),
		).toStrictEqual({ action: "none" });
	});

	it("resumes once the window that paused the account has rolled over", () => {
		expect(
			evaluateUsagePause({
				resets: NO_RESETS,
				now: NOW,
				thresholds: { fiveHour: on(80), weekly: on(90) },
				utilization: { fiveHour: 2, weekly: 45 },
				paused: true,
				pauseReason: USAGE_THRESHOLD_PAUSE_REASON,
			}),
		).toStrictEqual({ action: "resume" });
	});

	it("keeps the account paused while any configured window is still over", () => {
		expect(
			evaluateUsagePause({
				resets: NO_RESETS,
				now: NOW,
				thresholds: { fiveHour: on(80), weekly: on(90) },
				utilization: { fiveHour: 2, weekly: 95 },
				paused: true,
				pauseReason: USAGE_THRESHOLD_PAUSE_REASON,
			}),
		).toStrictEqual({ action: "none" });
	});

	it("keeps the account paused while a configured window is unreadable", () => {
		expect(
			evaluateUsagePause({
				resets: NO_RESETS,
				now: NOW,
				thresholds: { fiveHour: on(80), weekly: on(90) },
				utilization: { fiveHour: 2, weekly: null },
				paused: true,
				pauseReason: USAGE_THRESHOLD_PAUSE_REASON,
			}),
		).toStrictEqual({ action: "none" });
	});

	it("resumes when a window is switched off while the account is paused", () => {
		expect(
			evaluateUsagePause({
				resets: NO_RESETS,
				now: NOW,
				thresholds: {
					fiveHour: { enabled: false, percent: 80, minResetRemainingMs: null },
					weekly: off,
				},
				utilization: { fiveHour: 99, weekly: 99 },
				paused: true,
				pauseReason: USAGE_THRESHOLD_PAUSE_REASON,
			}),
		).toStrictEqual({ action: "resume" });
	});

	it("ignores a window that is on but has no percentage yet", () => {
		expect(
			evaluateUsagePause({
				resets: NO_RESETS,
				now: NOW,
				thresholds: {
					fiveHour: { enabled: true, percent: null, minResetRemainingMs: null },
					weekly: off,
				},
				utilization: { fiveHour: 99, weekly: 99 },
				paused: false,
				pauseReason: null,
			}),
		).toStrictEqual({ action: "none" });
	});

	it("keeps the stored percentage out of the decision while the window is off", () => {
		expect(
			evaluateUsagePause({
				resets: NO_RESETS,
				now: NOW,
				thresholds: {
					fiveHour: { enabled: false, percent: 10, minResetRemainingMs: null },
					weekly: off,
				},
				utilization: { fiveHour: 99, weekly: 99 },
				paused: false,
				pauseReason: null,
			}),
		).toStrictEqual({ action: "none" });
	});

	it("resumes when the thresholds are removed while the account is paused", () => {
		expect(
			evaluateUsagePause({
				resets: NO_RESETS,
				now: NOW,
				thresholds: NO_THRESHOLDS,
				utilization: { fiveHour: 99, weekly: 99 },
				paused: true,
				pauseReason: USAGE_THRESHOLD_PAUSE_REASON,
			}),
		).toStrictEqual({ action: "resume" });
	});

	it("does not resume on a snapshot that reports none of the configured windows", () => {
		expect(
			evaluateUsagePause({
				resets: NO_RESETS,
				now: NOW,
				thresholds: { fiveHour: on(80), weekly: on(90) },
				utilization: { fiveHour: null, weekly: null },
				paused: true,
				pauseReason: USAGE_THRESHOLD_PAUSE_REASON,
			}),
		).toStrictEqual({ action: "none" });
	});
});

describe("readUsageUtilization", () => {
	it("reads the flat five_hour/seven_day windows", () => {
		expect(
			readUsageUtilization({
				five_hour: { utilization: 42, resets_at: null },
				seven_day: { utilization: 7, resets_at: null },
			}),
		).toStrictEqual({ fiveHour: 42, weekly: 7 });
	});

	it("falls back to limits[] when the flat windows are gone", () => {
		expect(
			readUsageUtilization({
				limits: [
					{ kind: "session", percent: 55, resets_at: null },
					{ kind: "weekly_all", percent: 12, resets_at: null },
				],
			}),
		).toStrictEqual({ fiveHour: 55, weekly: 12 });
	});

	it("prefers the flat window and fills the other one from limits[]", () => {
		expect(
			readUsageUtilization({
				five_hour: { utilization: 30, resets_at: null },
				limits: [
					{ kind: "session", percent: 99, resets_at: null },
					{ kind: "weekly_all", percent: 60, resets_at: null },
				],
			}),
		).toStrictEqual({ fiveHour: 30, weekly: 60 });
	});

	it("ignores per-model weekly caps", () => {
		expect(
			readUsageUtilization({
				limits: [
					{
						kind: "weekly_scoped",
						percent: 97,
						resets_at: null,
						scope: { model: { id: "opus", display_name: "Opus" } },
					},
				],
			}),
		).toStrictEqual({ fiveHour: null, weekly: null });
	});

	it("returns nulls for payloads it cannot read", () => {
		expect(readUsageUtilization(null)).toStrictEqual({
			fiveHour: null,
			weekly: null,
		});
		expect(readUsageUtilization("nope")).toStrictEqual({
			fiveHour: null,
			weekly: null,
		});
		expect(
			readUsageUtilization({ five_hour: { utilization: null } }),
		).toStrictEqual({ fiveHour: null, weekly: null });
	});

	it("still reads the flat five_hour/seven_day windows when provider is explicitly 'anthropic'", () => {
		expect(
			readUsageUtilization(
				{
					five_hour: { utilization: 42, resets_at: null },
					seven_day: { utilization: 7, resets_at: null },
				},
				"anthropic",
			),
		).toStrictEqual({ fiveHour: 42, weekly: 7 });
	});

	it("still falls back to limits[] when provider is explicitly 'anthropic'", () => {
		expect(
			readUsageUtilization(
				{
					limits: [
						{ kind: "session", percent: 55, resets_at: null },
						{ kind: "weekly_all", percent: 12, resets_at: null },
					],
				},
				"anthropic",
			),
		).toStrictEqual({ fiveHour: 55, weekly: 12 });
	});

	it("uses the Anthropic-shaped fallback for codex", () => {
		const payload = {
			five_hour: { utilization: 33, resets_at: null },
			seven_day: { utilization: 66, resets_at: null },
		};
		expect(readUsageUtilization(payload, "codex")).toStrictEqual({
			fiveHour: 33,
			weekly: 66,
		});
	});

	// SB23-3686: xAI reports `{ credits: { utilization, resets_at } }`, never the
	// flat windows. Before the dedicated branch both slots read null, so a
	// threshold on an xAI account could never fire.
	describe("xai payload shape (SB23-3686)", () => {
		it("reads the Grok credits window into the weekly slot and nothing into the 5-hour one", () => {
			expect(
				readUsageUtilization(
					{
						credits: {
							utilization: 87.5,
							resets_at: "2026-10-05T00:00:00.000Z",
						},
					},
					"xai",
				),
			).toStrictEqual({ fiveHour: null, weekly: 87.5 });
		});

		it("ignores flat windows on an xAI account: its payload is the credits window alone", () => {
			expect(
				readUsageUtilization(
					{
						five_hour: { utilization: 33, resets_at: null },
						seven_day: { utilization: 66, resets_at: null },
					},
					"xai",
				),
			).toStrictEqual({ fiveHour: null, weekly: null });
		});

		it("reads null when the credits window is missing or not numeric", () => {
			expect(readUsageUtilization({}, "xai")).toStrictEqual({
				fiveHour: null,
				weekly: null,
			});
			expect(
				readUsageUtilization({ credits: { utilization: "87" } }, "xai"),
			).toStrictEqual({ fiveHour: null, weekly: null });
		});

		// The provider decides, never the key: a Codex payload carries `credits`
		// too (CodexCreditsData, SB23-2462), and reading it as xAI's would drop
		// the Codex windows on the floor. Kills a `"credits" in data` mutation of
		// the provider check.
		it("leaves a Codex payload that carries a credits balance on the flat windows", () => {
			const codex = {
				five_hour: { utilization: 12, resets_at: "2026-10-01T15:00:00.000Z" },
				seven_day: { utilization: 91, resets_at: "2026-10-06T00:00:00.000Z" },
				credits: { has_credits: true, unlimited: false, balance: "4.20" },
			};
			expect(readUsageUtilization(codex, "codex")).toStrictEqual({
				fiveHour: 12,
				weekly: 91,
			});
			expect(readUsageResets(codex, "codex")).toStrictEqual({
				fiveHour: Date.parse("2026-10-01T15:00:00.000Z"),
				weekly: Date.parse("2026-10-06T00:00:00.000Z"),
			});
		});
	});

	it("parses a minimax-shaped payload via the existing flat-shape path, no new branch required", () => {
		expect(
			readUsageUtilization(
				{
					five_hour: { utilization: 21, resetAt: 1_700_000_000_000 },
					seven_day: { utilization: 84, resetAt: 1_700_600_000_000 },
				},
				"minimax",
			),
		).toStrictEqual({ fiveHour: 21, weekly: 84 });
	});

	describe("zai payload shape", () => {
		it("reads both tokens_limit.percentage and tokens_limit_weekly.percentage", () => {
			expect(
				readUsageUtilization(
					{
						time_limit: { percentage: 5 },
						tokens_limit: { percentage: 30 },
						tokens_limit_weekly: { percentage: 65 },
					},
					"zai",
				),
			).toStrictEqual({ fiveHour: 30, weekly: 65 });
		});

		it("treats a missing tokens_limit_weekly as null (single-window plan)", () => {
			expect(
				readUsageUtilization(
					{
						time_limit: { percentage: 5 },
						tokens_limit: { percentage: 30 },
						tokens_limit_weekly: null,
					},
					"zai",
				),
			).toStrictEqual({ fiveHour: 30, weekly: null });
		});

		it("treats a fully absent tokens_limit_weekly field as null", () => {
			expect(
				readUsageUtilization(
					{
						tokens_limit: { percentage: 12 },
					},
					"zai",
				),
			).toStrictEqual({ fiveHour: 12, weekly: null });
		});

		it("never reads time_limit into either window", () => {
			expect(
				readUsageUtilization(
					{
						time_limit: { percentage: 99 },
						tokens_limit: null,
						tokens_limit_weekly: null,
					},
					"zai",
				),
			).toStrictEqual({ fiveHour: null, weekly: null });
		});

		it("treats a non-numeric or missing percentage as null", () => {
			expect(
				readUsageUtilization(
					{
						tokens_limit: { percentage: "not-a-number" },
						tokens_limit_weekly: {},
					},
					"zai",
				),
			).toStrictEqual({ fiveHour: null, weekly: null });
		});
	});

	describe("nanogpt payload shape", () => {
		it("reads daily/monthly percentUsed and multiplies by 100 when active", () => {
			expect(
				readUsageUtilization(
					{
						active: true,
						daily: { percentUsed: 0.42 },
						monthly: { percentUsed: 0.1 },
					},
					"nanogpt",
				),
			).toStrictEqual({ fiveHour: 42, weekly: 10 });
		});

		it("preserves floating point precision without rounding, e.g. 0.055 -> 5.5", () => {
			expect(
				readUsageUtilization(
					{
						active: true,
						daily: { percentUsed: 0.055 },
						monthly: { percentUsed: 0.2 },
					},
					"nanogpt",
				),
			).toStrictEqual({ fiveHour: 5.5, weekly: 20 });
		});

		it("returns nulls for both windows when active is false, regardless of daily/monthly", () => {
			expect(
				readUsageUtilization(
					{
						active: false,
						daily: { percentUsed: 0.9 },
						monthly: { percentUsed: 0.9 },
					},
					"nanogpt",
				),
			).toStrictEqual({ fiveHour: null, weekly: null });
		});

		it("treats missing or non-numeric percentUsed as null", () => {
			expect(
				readUsageUtilization(
					{
						active: true,
						daily: {},
						monthly: { percentUsed: "nope" },
					},
					"nanogpt",
				),
			).toStrictEqual({ fiveHour: null, weekly: null });
		});
	});
});

describe("supportsUsagePauseThreshold", () => {
	it("returns true for anthropic, codex, xai, zai, nanogpt and minimax", () => {
		expect(supportsUsagePauseThreshold("anthropic")).toBe(true);
		expect(supportsUsagePauseThreshold("codex")).toBe(true);
		expect(supportsUsagePauseThreshold("xai")).toBe(true);
		expect(supportsUsagePauseThreshold("zai")).toBe(true);
		expect(supportsUsagePauseThreshold("nanogpt")).toBe(true);
		expect(supportsUsagePauseThreshold("minimax")).toBe(true);
	});

	it("returns false for kilo, alibaba-coding-plan, unknown providers, null and undefined", () => {
		expect(supportsUsagePauseThreshold("kilo")).toBe(false);
		expect(supportsUsagePauseThreshold("alibaba-coding-plan")).toBe(false);
		expect(supportsUsagePauseThreshold("some-other-provider")).toBe(false);
		expect(supportsUsagePauseThreshold(null)).toBe(false);
		expect(supportsUsagePauseThreshold(undefined)).toBe(false);
	});
});

describe("effectiveThreshold", () => {
	it("reads the percentage only while the window is switched on", () => {
		expect(
			effectiveThreshold({
				enabled: true,
				percent: 80,
				minResetRemainingMs: null,
			}),
		).toBe(80);
		expect(
			effectiveThreshold({
				enabled: false,
				percent: 80,
				minResetRemainingMs: null,
			}),
		).toBeNull();
		expect(
			effectiveThreshold({
				enabled: true,
				percent: null,
				minResetRemainingMs: null,
			}),
		).toBeNull();
		expect(effectiveThreshold(null)).toBeNull();
		expect(effectiveThreshold(undefined)).toBeNull();
	});
});

describe("evaluateUsagePause — reset condition (SB23-2575)", () => {
	const HOUR = 3_600_000;
	/** A window switched on with the given conditions. */
	const win = (percent: number | null, minResetRemainingMs: number | null) => ({
		enabled: true,
		percent,
		minResetRemainingMs,
	});
	const fiveHourOnly = (
		setting: ReturnType<typeof win>,
		utilization: number | null,
		resetMs: number | null,
		paused = false,
	) =>
		evaluateUsagePause({
			thresholds: { fiveHour: setting, weekly: off },
			utilization: { fiveHour: utilization, weekly: null },
			resets: { fiveHour: resetMs, weekly: null },
			paused,
			pauseReason: paused ? USAGE_THRESHOLD_PAUSE_REASON : null,
			now: NOW,
		});

	describe("pausing: only the configured conditions, and every one must hold", () => {
		it("percent only: pauses at the percent whatever the reset says", () => {
			expect(fiveHourOnly(win(80, null), 85, NOW + HOUR)).toStrictEqual({
				action: "pause",
				window: "five_hour",
				utilization: 85,
				threshold: 80,
				resetRemainingMs: null,
				minResetRemainingMs: null,
			});
		});

		it("percent only: still pauses when the payload carries no reset", () => {
			expect(fiveHourOnly(win(80, null), 85, null).action).toBe("pause");
		});

		it("reset only: pauses while the reset is at least the minimum away, and quotes no utilization", () => {
			expect(
				fiveHourOnly(win(null, 2 * HOUR), 5, NOW + 3 * HOUR),
			).toStrictEqual({
				action: "pause",
				window: "five_hour",
				utilization: null,
				threshold: null,
				resetRemainingMs: 3 * HOUR,
				minResetRemainingMs: 2 * HOUR,
			});
		});

		it("reset only: holds at exactly the minimum, the slot rule's >=", () => {
			expect(fiveHourOnly(win(null, 2 * HOUR), 5, NOW + 2 * HOUR).action).toBe(
				"pause",
			);
		});

		it("reset only: does not pause once the reset is nearer than the minimum", () => {
			expect(
				fiveHourOnly(win(null, 2 * HOUR), 99, NOW + 2 * HOUR - 1),
			).toStrictEqual({ action: "none" });
		});

		it("reset only: an absent reset does not hold, so nothing pauses", () => {
			expect(fiveHourOnly(win(null, 2 * HOUR), 99, null)).toStrictEqual({
				action: "none",
			});
		});

		it("reset only at 0 hours: holds for any reset still ahead", () => {
			expect(fiveHourOnly(win(null, 0), 0, NOW + 1).action).toBe("pause");
		});

		it("both: pauses only when the percent AND the reset hold", () => {
			expect(fiveHourOnly(win(80, 2 * HOUR), 90, NOW + 3 * HOUR)).toStrictEqual(
				{
					action: "pause",
					window: "five_hour",
					utilization: 90,
					threshold: 80,
					resetRemainingMs: 3 * HOUR,
					minResetRemainingMs: 2 * HOUR,
				},
			);
		});

		it("both: high usage with the reset near does not pause", () => {
			expect(fiveHourOnly(win(80, 2 * HOUR), 99, NOW + HOUR)).toStrictEqual({
				action: "none",
			});
		});

		it("both: the reset far away with usage below the percent does not pause", () => {
			expect(fiveHourOnly(win(80, 2 * HOUR), 50, NOW + 4 * HOUR)).toStrictEqual(
				{ action: "none" },
			);
		});

		it("both: an absent reset blocks the pause even at full usage", () => {
			expect(fiveHourOnly(win(80, 2 * HOUR), 100, null)).toStrictEqual({
				action: "none",
			});
		});

		it("neither: a window switched on with no condition is not configured and never pauses", () => {
			expect(isUsagePauseWindowConfigured(win(null, null))).toBe(false);
			expect(fiveHourOnly(win(null, null), 100, NOW + 4 * HOUR)).toStrictEqual({
				action: "none",
			});
		});

		it("stale reset: a reset already past means the reading is the previous window's, so even a percent-only rule holds off", () => {
			expect(fiveHourOnly(win(80, null), 100, NOW - 1)).toStrictEqual({
				action: "none",
			});
			expect(fiveHourOnly(win(null, 0), 100, NOW)).toStrictEqual({
				action: "none",
			});
		});

		it("a window switched off is ignored whatever its stored conditions say", () => {
			expect(
				fiveHourOnly(
					{ enabled: false, percent: 10, minResetRemainingMs: 0 },
					100,
					NOW + 4 * HOUR,
				),
			).toStrictEqual({ action: "none" });
		});

		it("evaluates the weekly window's reset against the weekly reading, not the 5-hour one", () => {
			expect(
				evaluateUsagePause({
					thresholds: { fiveHour: off, weekly: win(null, 24 * HOUR) },
					utilization: { fiveHour: 10, weekly: 10 },
					// The 5-hour reset is far away too; only the weekly one counts.
					resets: { fiveHour: NOW + 48 * HOUR, weekly: NOW + 12 * HOUR },
					paused: false,
					pauseReason: null,
					now: NOW,
				}),
			).toStrictEqual({ action: "none" });
		});
	});

	describe("resuming: still only this rule's own pauses", () => {
		it("resumes a reset-only pause once the reset is nearer than the minimum", () => {
			expect(
				fiveHourOnly(win(null, 2 * HOUR), 99, NOW + HOUR, true),
			).toStrictEqual({ action: "resume" });
		});

		it("keeps a reset-only pause while the reset is still far away", () => {
			expect(
				fiveHourOnly(win(null, 2 * HOUR), 5, NOW + 3 * HOUR, true),
			).toStrictEqual({ action: "none" });
		});

		it("resumes a both-condition pause when the reset comes near even though usage is still high", () => {
			expect(
				fiveHourOnly(win(80, 2 * HOUR), 99, NOW + HOUR, true),
			).toStrictEqual({ action: "resume" });
		});

		it("resumes a reset-only pause on the rolled-over shape Anthropic reports, 0% and no reset, so it cannot be benched forever", () => {
			expect(fiveHourOnly(win(null, 2 * HOUR), 0, null, true)).toStrictEqual({
				action: "resume",
			});
		});

		it("does not resume when the window is missing from the payload entirely", () => {
			expect(fiveHourOnly(win(null, 2 * HOUR), null, null, true)).toStrictEqual(
				{ action: "none" },
			);
			expect(fiveHourOnly(win(80, null), null, null, true)).toStrictEqual({
				action: "none",
			});
		});

		it("does not resume a both-condition pause while utilization is unreadable and the reset still far", () => {
			expect(
				fiveHourOnly(win(80, 2 * HOUR), null, NOW + 3 * HOUR, true),
			).toStrictEqual({ action: "none" });
		});

		it("resumes when the reading is stale: the window it describes has already rolled over", () => {
			expect(fiveHourOnly(win(80, null), 100, NOW - 1, true)).toStrictEqual({
				action: "resume",
			});
		});

		it("leaves a manual pause alone even when the reset condition has stopped holding", () => {
			expect(
				evaluateUsagePause({
					thresholds: { fiveHour: win(null, 2 * HOUR), weekly: off },
					utilization: { fiveHour: 0, weekly: null },
					resets: { fiveHour: NOW + HOUR, weekly: null },
					paused: true,
					pauseReason: "manual",
					now: NOW,
				}),
			).toStrictEqual({ action: "none" });
		});
	});
});

describe("isUsagePauseWindowConfigured", () => {
	it("is true for a percent, a reset minimum, or both, and only while the window is on", () => {
		expect(
			isUsagePauseWindowConfigured({
				enabled: true,
				percent: 80,
				minResetRemainingMs: null,
			}),
		).toBe(true);
		expect(
			isUsagePauseWindowConfigured({
				enabled: true,
				percent: null,
				minResetRemainingMs: 0,
			}),
		).toBe(true);
		expect(
			isUsagePauseWindowConfigured({
				enabled: false,
				percent: 80,
				minResetRemainingMs: 0,
			}),
		).toBe(false);
		expect(isUsagePauseWindowConfigured(null)).toBe(false);
	});
});

describe("readUsageResets", () => {
	const ISO = "2026-10-01T15:00:00.000Z";
	const ISO_MS = Date.parse(ISO);
	const ISO2 = "2026-10-05T00:00:00.000Z";
	const ISO2_MS = Date.parse(ISO2);

	it("reads Anthropic's flat windows, ISO strings to epoch ms", () => {
		expect(
			readUsageResets(
				{
					five_hour: { utilization: 40, resets_at: ISO },
					seven_day: { utilization: 10, resets_at: ISO2 },
				},
				"anthropic",
			),
		).toStrictEqual({ fiveHour: ISO_MS, weekly: ISO2_MS });
	});

	it("falls back to limits[] session and weekly_all, as the utilization reader does", () => {
		expect(
			readUsageResets(
				{
					limits: [
						{ kind: "session", percent: 55, resets_at: ISO },
						{
							kind: "weekly_scoped",
							percent: 99,
							resets_at: "2026-12-01T00:00:00Z",
						},
						{ kind: "weekly_all", percent: 12, resets_at: ISO2 },
					],
				},
				"codex",
			),
		).toStrictEqual({ fiveHour: ISO_MS, weekly: ISO2_MS });
	});

	it("never borrows the limits[] reset for a flat window that has utilization but no reset", () => {
		// The utilization reader takes the flat 30, so the reset must be the flat
		// window's own (none), not the limits entry's.
		expect(
			readUsageResets(
				{
					five_hour: { utilization: 30, resets_at: null },
					limits: [{ kind: "session", percent: 99, resets_at: ISO }],
				},
				"anthropic",
			),
		).toStrictEqual({ fiveHour: null, weekly: null });
	});

	it("reads zai's token windows and ignores time_limit", () => {
		expect(
			readUsageResets(
				{
					time_limit: { percentage: 100, resetAt: 1 },
					tokens_limit: { percentage: 40, resetAt: ISO_MS },
					tokens_limit_weekly: { percentage: 20, resetAt: ISO2_MS },
				},
				"zai",
			),
		).toStrictEqual({ fiveHour: ISO_MS, weekly: ISO2_MS });
	});

	it("reads nanogpt's daily and monthly windows, and nothing for an inactive account", () => {
		const payload = {
			active: true,
			daily: { percentUsed: 0.5, resetAt: ISO_MS },
			monthly: { percentUsed: 0.1, resetAt: ISO2_MS },
		};
		expect(readUsageResets(payload, "nanogpt")).toStrictEqual({
			fiveHour: ISO_MS,
			weekly: ISO2_MS,
		});
		expect(
			readUsageResets({ ...payload, active: false }, "nanogpt"),
		).toStrictEqual({ fiveHour: null, weekly: null });
	});

	it("reads minimax's numeric resetAt on the flat windows", () => {
		expect(
			readUsageResets(
				{
					five_hour: { utilization: 40, resetAt: ISO_MS },
					seven_day: { utilization: 10, resetAt: ISO2_MS },
				},
				"minimax",
			),
		).toStrictEqual({ fiveHour: ISO_MS, weekly: ISO2_MS });
	});

	it("reads nothing from a non-object or an unparseable timestamp", () => {
		expect(readUsageResets(null, "anthropic")).toStrictEqual({
			fiveHour: null,
			weekly: null,
		});
		expect(
			readUsageResets(
				{ five_hour: { utilization: 40, resets_at: "not a date" } },
				"anthropic",
			),
		).toStrictEqual({ fiveHour: null, weekly: null });
	});
});

describe("readUsageResets — xai (SB23-3686)", () => {
	it("reads the credits reset into the weekly slot, the same key its utilization comes from", () => {
		expect(
			readUsageResets(
				{
					credits: {
						utilization: 40,
						resets_at: "2026-10-05T00:00:00.000Z",
					},
				},
				"xai",
			),
		).toStrictEqual({
			fiveHour: null,
			weekly: Date.parse("2026-10-05T00:00:00.000Z"),
		});
	});

	it("reads null for a credits window with no reset, and for flat windows on an xAI account", () => {
		expect(
			readUsageResets({ credits: { utilization: 40, resets_at: null } }, "xai"),
		).toStrictEqual({ fiveHour: null, weekly: null });
		expect(
			readUsageResets(
				{ seven_day: { utilization: 40, resets_at: "2026-10-05T00:00:00Z" } },
				"xai",
			),
		).toStrictEqual({ fiveHour: null, weekly: null });
	});
});

describe("usagePauseWindowsForProvider (SB23-3686)", () => {
	it("gives xAI the weekly window only", () => {
		expect(usagePauseWindowsForProvider("xai")).toStrictEqual(["weekly"]);
	});

	it("gives every other provider both windows", () => {
		for (const provider of [
			"anthropic",
			"codex",
			"zai",
			"nanogpt",
			"minimax",
			null,
			undefined,
		]) {
			expect(usagePauseWindowsForProvider(provider)).toStrictEqual([
				"five_hour",
				"weekly",
			]);
		}
	});
});

describe("restrictToReportedWindows (SB23-3686)", () => {
	const both = { fiveHour: on(80), weekly: on(90) };

	it("switches off the 5-hour window on xAI and keeps its numbers", () => {
		expect(restrictToReportedWindows(both, "xai")).toStrictEqual({
			fiveHour: { enabled: false, percent: 80, minResetRemainingMs: null },
			weekly: on(90),
		});
	});

	it("leaves both windows alone for a provider that reports both", () => {
		expect(restrictToReportedWindows(both, "anthropic")).toStrictEqual(both);
		expect(restrictToReportedWindows(both, "codex")).toStrictEqual(both);
	});

	// The defect it exists for: a stale 5-hour setting on xAI reads `unknown` on
	// every poll, and an `unknown` window blocks the resume of an account the
	// credits window paused.
	it("lets an xAI account its credits window paused resume although a stale 5-hour window is on", () => {
		const input = {
			utilization: readUsageUtilization(
				{ credits: { utilization: 3, resets_at: null } },
				"xai",
			),
			resets: NO_RESETS,
			paused: true,
			pauseReason: USAGE_THRESHOLD_PAUSE_REASON,
			now: NOW,
		};
		expect(evaluateUsagePause({ ...input, thresholds: both })).toStrictEqual({
			action: "none",
		});
		expect(
			evaluateUsagePause({
				...input,
				thresholds: restrictToReportedWindows(both, "xai"),
			}),
		).toStrictEqual({ action: "resume" });
	});
});

describe("unreportedWindowRefusal (SB23-3686)", () => {
	it("refuses an xAI 5-hour window that is switched on", () => {
		expect(
			unreportedWindowRefusal("xai", { fiveHour: on(80), weekly: off }),
		).toBe(
			"Provider 'xai' does not report a 5-hour usage window, so it cannot be switched on; its one window, Grok credits, is the weekly slot",
		);
	});

	it("accepts an xAI 5-hour window that is off, numbers and all", () => {
		expect(
			unreportedWindowRefusal("xai", {
				fiveHour: { ...on(80), enabled: false },
				weekly: on(90),
			}),
		).toBeNull();
	});

	it("accepts both windows on for a provider that reports both", () => {
		expect(
			unreportedWindowRefusal("anthropic", {
				fiveHour: on(80),
				weekly: on(90),
			}),
		).toBeNull();
	});
});

describe("parseUsagePauseMinResetMs", () => {
	it("accepts whole milliseconds from 0 to the slot field's ceiling", () => {
		expect(parseUsagePauseMinResetMs(0)).toBe(0);
		expect(parseUsagePauseMinResetMs(7_200_000)).toBe(7_200_000);
		expect(parseUsagePauseMinResetMs("7200000")).toBe(7_200_000);
		expect(parseUsagePauseMinResetMs(MAX_MIN_RESET_REMAINING_MS)).toBe(
			MAX_MIN_RESET_REMAINING_MS,
		);
	});

	it("treats null, undefined and empty string as 'condition off'", () => {
		expect(parseUsagePauseMinResetMs(null)).toBeNull();
		expect(parseUsagePauseMinResetMs(undefined)).toBeNull();
		expect(parseUsagePauseMinResetMs("")).toBeNull();
	});

	it("rejects negative, fractional, non-numeric and over-ceiling values with the slot handler's message", () => {
		const message = `minResetRemainingMs must be an integer between 0 and ${MAX_MIN_RESET_REMAINING_MS}, or null`;
		for (const bad of [
			-1,
			1.5,
			"two hours",
			Number.NaN,
			MAX_MIN_RESET_REMAINING_MS + 1,
			true,
		]) {
			expect(() => parseUsagePauseMinResetMs(bad)).toThrow(message);
		}
	});
});
