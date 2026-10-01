import { describe, expect, it } from "bun:test";
import type { AnthropicUsageData, UsageLimit } from "@better-ccflare/types";
import {
	collectAnthropicLimitRows,
	collectAnthropicUsageRows,
	displayLabel,
	formatExtraUsageAmount,
	formatWindowName,
	isUsageWindow,
	isWeeklyWindow,
	resolveExtraUsageDisplay,
	severityColor,
} from "./rate-limit-helpers";

const RESET = "2030-01-01T00:00:00.000Z";

// Mirrors the real /api/oauth/usage `limits[]` shape (session / weekly_all /
// weekly_scoped Fable), taken from live data.
const LIMITS_FIXTURE: UsageLimit[] = [
	{
		kind: "session",
		group: "session",
		percent: 32,
		severity: "normal",
		resets_at: RESET,
		scope: null,
		is_active: false,
	},
	{
		kind: "weekly_all",
		group: "weekly",
		percent: 92,
		severity: "critical",
		resets_at: RESET,
		scope: null,
		is_active: false,
	},
	{
		kind: "weekly_scoped",
		group: "weekly",
		percent: 100,
		severity: "critical",
		resets_at: RESET,
		scope: { model: { id: null, display_name: "Fable" }, surface: null },
		is_active: true,
	},
];

describe("collectAnthropicLimitRows (limits[] primary)", () => {
	it("maps session / weekly_all / weekly_scoped to the right rows", () => {
		const rows = collectAnthropicLimitRows(LIMITS_FIXTURE);
		expect(rows).toHaveLength(3);

		expect(rows[0]).toMatchObject({
			window: "five_hour",
			label: "5-hour",
			utilization: 32,
			group: "session",
			severity: "normal",
			isActive: false,
		});
		expect(rows[1]).toMatchObject({
			window: "seven_day",
			label: "Weekly",
			utilization: 92,
			group: "weekly",
			severity: "critical",
		});
		expect(rows[2]).toMatchObject({
			window: "seven_day_fable",
			label: "Fable (Weekly)",
			utilization: 100,
			group: "weekly",
			severity: "critical",
			isActive: true,
		});
		// scoped rows are weekly windows (pace marker + long-date reset apply)
		expect(isWeeklyWindow(rows[2].window as string)).toBe(true);
	});

	it("renders multiple weekly_scoped tiers with distinct window keys", () => {
		const rows = collectAnthropicLimitRows([
			{
				kind: "weekly_scoped",
				group: "weekly",
				percent: 10,
				resets_at: RESET,
				scope: { model: { id: null, display_name: "Opus" }, surface: null },
			},
			{
				kind: "weekly_scoped",
				group: "weekly",
				percent: 20,
				resets_at: RESET,
				scope: { model: { id: null, display_name: "Sonnet" }, surface: null },
			},
		]);
		expect(rows.map((r) => r.window)).toEqual([
			"seven_day_opus",
			"seven_day_sonnet",
		]);
		expect(rows.map((r) => r.label)).toEqual([
			"Opus (Weekly)",
			"Sonnet (Weekly)",
		]);
	});

	it("treats percent 0 as valid but skips null percent", () => {
		const rows = collectAnthropicLimitRows([
			{ kind: "session", percent: 0, resets_at: RESET },
			{ kind: "weekly_all", percent: null, resets_at: RESET },
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ window: "five_hour", utilization: 0 });
	});

	it("skips a weekly_scoped entry without a model display name", () => {
		const rows = collectAnthropicLimitRows([
			{ kind: "weekly_scoped", percent: 50, resets_at: RESET, scope: null },
			{
				kind: "weekly_scoped",
				percent: 50,
				resets_at: RESET,
				scope: { model: { id: null, display_name: "  " }, surface: null },
			},
		]);
		expect(rows).toHaveLength(0);
	});

	it("does not render unknown limit kinds", () => {
		const rows = collectAnthropicLimitRows([
			{ kind: "session", percent: 5, resets_at: RESET },
			{ kind: "some_future_kind", percent: 99, resets_at: RESET },
		]);
		expect(rows.map((r) => r.window)).toEqual(["five_hour"]);
	});
});

describe("collectAnthropicUsageRows (dispatch + legacy fallback)", () => {
	it("uses limits[] when present", () => {
		const rows = collectAnthropicUsageRows(
			{ limits: LIMITS_FIXTURE } as AnthropicUsageData,
			{ utilization: null, resetTime: null },
		);
		expect(rows.map((r) => r.window)).toEqual([
			"five_hour",
			"seven_day",
			"seven_day_fable",
		]);
	});

	it("does NOT take the limits path for an object-shaped `limits` (NanoGPT collision)", () => {
		// NanoGPTUsageData.limits is {daily,monthly} — must not be treated as limits[].
		const rows = collectAnthropicUsageRows(
			{ limits: { daily: 1, monthly: 2 } } as unknown as AnthropicUsageData,
			{ utilization: 7, resetTime: RESET },
		);
		// Falls through to legacy path -> only five_hour(fallback) + seven_day placeholder.
		expect(rows.map((r) => r.window)).toEqual(["five_hour", "seven_day"]);
	});

	it("falls back to legacy flat windows when limits[] is absent", () => {
		const rows = collectAnthropicUsageRows(
			{
				five_hour: { utilization: 10, resets_at: RESET },
				seven_day: { utilization: 20, resets_at: RESET },
				seven_day_fable: { utilization: 55, resets_at: RESET },
			} as AnthropicUsageData,
			{ utilization: null, resetTime: null },
		);
		expect(rows.map((r) => r.window)).toEqual([
			"five_hour",
			"seven_day",
			"seven_day_fable",
		]);
		expect(rows[2].utilization).toBe(55);
	});

	it("always includes a seven_day placeholder and a five_hour fallback", () => {
		const rows = collectAnthropicUsageRows({} as AnthropicUsageData, {
			utilization: 77,
			resetTime: RESET,
		});
		expect(rows.map((r) => r.window)).toEqual(["five_hour", "seven_day"]);
		expect(rows[0].utilization).toBe(77); // five_hour fallback used
		expect(rows[1].utilization).toBeNull(); // seven_day placeholder
	});
});

describe("severityColor", () => {
	it("prefers the API severity", () => {
		expect(severityColor("critical", 10)).toBe("critical");
		expect(severityColor("warning", 10)).toBe("warning");
		expect(severityColor("normal", 100)).toBe("normal");
	});
	it("derives from utilization when severity is absent", () => {
		expect(severityColor(undefined, 100)).toBe("critical");
		expect(severityColor(undefined, 95)).toBe("warning");
		expect(severityColor(undefined, 40)).toBe("normal");
		expect(severityColor(undefined, null)).toBe("normal");
	});
});

describe("displayLabel", () => {
	it("prefers an explicit label, else formats the window key", () => {
		expect(
			displayLabel({
				utilization: 1,
				window: "seven_day_fable",
				resetTime: RESET,
				label: "Fable (Weekly)",
			}),
		).toBe("Fable (Weekly)");
		expect(
			displayLabel({ utilization: 1, window: "five_hour", resetTime: RESET }),
		).toBe("5-hour");
	});
});

describe("isUsageWindow / isWeeklyWindow / formatWindowName (legacy helpers)", () => {
	it("isUsageWindow requires resets_at + utilization keys", () => {
		expect(isUsageWindow({ utilization: 0, resets_at: null })).toBe(true);
		expect(isUsageWindow({ utilization: 5 })).toBe(false); // extra_usage-like
		expect(isUsageWindow(null)).toBe(false);
	});
	it("isWeeklyWindow matches seven_day and seven_day_*", () => {
		expect(isWeeklyWindow("seven_day")).toBe(true);
		expect(isWeeklyWindow("seven_day_fable")).toBe(true);
		expect(isWeeklyWindow("five_hour")).toBe(false);
		// Zai's long token window is weekly too; its short one is not.
		expect(isWeeklyWindow("tokens_limit_weekly")).toBe(true);
		expect(isWeeklyWindow("tokens_limit")).toBe(false);
	});
	it("formatWindowName maps generic tiers", () => {
		expect(formatWindowName("seven_day_fable")).toBe("Fable (Weekly)");
		expect(formatWindowName("five_hour")).toBe("5-hour");
		expect(formatWindowName("seven_day")).toBe("Weekly");
		expect(formatWindowName("tokens_limit")).toBe("5-hour");
		expect(formatWindowName("tokens_limit_weekly")).toBe("Weekly");
	});
});

describe("review fixes: limits[] fallback (M2) + group ordering (m1)", () => {
	it("falls back to legacy flat windows when limits[] is present but empty (M2)", () => {
		// A limits[] array that yields no rows must not blank the card — the flat
		// windows still render, keeping the account row consistent with pool tiles.
		const rows = collectAnthropicUsageRows(
			{
				limits: [],
				five_hour: { utilization: 15, resets_at: RESET },
				seven_day: { utilization: 25, resets_at: RESET },
			} as unknown as AnthropicUsageData,
			{ utilization: null, resetTime: null },
		);
		expect(rows.map((r) => r.window)).toEqual(["five_hour", "seven_day"]);
		expect(rows[0].utilization).toBe(15);
		expect(rows[1].utilization).toBe(25);
	});

	it("falls back to legacy when every limits[] entry has null percent (M2)", () => {
		const rows = collectAnthropicUsageRows(
			{
				limits: [
					{ kind: "session", percent: null, resets_at: RESET },
					{ kind: "weekly_all", percent: null, resets_at: RESET },
				],
				five_hour: { utilization: 42, resets_at: RESET },
				seven_day: { utilization: 63, resets_at: RESET },
			} as unknown as AnthropicUsageData,
			{ utilization: null, resetTime: null },
		);
		expect(rows.map((r) => r.window)).toEqual(["five_hour", "seven_day"]);
		expect(rows[0].utilization).toBe(42);
	});

	it("orders session before weekly regardless of limits[] array order (m1)", () => {
		const rows = collectAnthropicLimitRows([
			{
				kind: "weekly_all",
				group: "weekly",
				percent: 50,
				resets_at: RESET,
				scope: null,
			},
			{
				kind: "session",
				group: "session",
				percent: 10,
				resets_at: RESET,
				scope: null,
			},
			{
				kind: "weekly_scoped",
				group: "weekly",
				percent: 90,
				resets_at: RESET,
				scope: { model: { id: null, display_name: "Fable" }, surface: null },
			},
		]);
		// session first, then the two weekly rows in their original relative order.
		expect(rows.map((r) => r.group)).toEqual(["session", "weekly", "weekly"]);
		expect(rows.map((r) => r.window)).toEqual([
			"five_hour",
			"seven_day",
			"seven_day_fable",
		]);
	});
});

describe("collectAnthropicLimitRows — scoped identity (Greptile P2)", () => {
	it("keeps the first scoped occurrence byte-stable and disambiguates duplicates by surface", () => {
		const rows = collectAnthropicLimitRows([
			{
				kind: "weekly_scoped",
				percent: 50,
				resets_at: RESET,
				scope: { model: { id: null, display_name: "Fable" }, surface: "api" },
			},
			{
				kind: "weekly_scoped",
				percent: 80,
				resets_at: RESET,
				scope: {
					model: { id: null, display_name: "Fable" },
					surface: "vscode",
				},
			},
		]);
		// First occurrence keeps the exact seven_day_fable key + label so the m3
		// throttle-window match, pace marker, and snapshot tests stay stable.
		expect(rows[0].window).toBe("seven_day_fable");
		expect(rows[0].label).toBe("Fable (Weekly)");
		// Same display name, different surface -> distinct window AND label
		// (no duplicate React keys, distinguishable in projection state).
		expect(rows[1].window).not.toBe(rows[0].window);
		expect(rows[1].window?.startsWith("seven_day_")).toBe(true);
		expect(rows[1].label).not.toBe(rows[0].label);
	});

	it("does not collide a duplicate counter suffix with a real model slug", () => {
		// codex/fable: seven_day_fable_1 (dup of "Fable") must not equal
		// weeklyScopedWindowKey("Fable 1").
		const s = (name: string): UsageLimit => ({
			kind: "weekly_scoped",
			percent: 50,
			resets_at: RESET,
			scope: { model: { id: null, display_name: name }, surface: null },
		});
		const rows = collectAnthropicLimitRows([
			s("Fable"),
			s("Fable"),
			s("Fable 1"),
		]);
		const windows = rows.map((r) => r.window);
		expect(new Set(windows).size).toBe(3); // all distinct, no collision
		expect(windows[0]).toBe("seven_day_fable");
	});

	it("leaves a single scoped limit's key/label unchanged (byte-stable)", () => {
		const rows = collectAnthropicLimitRows([
			{
				kind: "weekly_scoped",
				percent: 50,
				resets_at: RESET,
				scope: { model: { id: null, display_name: "Opus" }, surface: "api" },
			},
		]);
		expect(rows[0].window).toBe("seven_day_opus");
		expect(rows[0].label).toBe("Opus (Weekly)");
	});

	it("gives every duplicate a unique window key even when surface repeats", () => {
		// Greptile P2 re-review: surface alone is not a unique disambiguator.
		const scoped = (surface: string): UsageLimit => ({
			kind: "weekly_scoped",
			percent: 50,
			resets_at: RESET,
			scope: { model: { id: null, display_name: "Fable" }, surface },
		});
		const rows = collectAnthropicLimitRows([
			scoped("api"),
			scoped("api"),
			scoped("api"),
		]);
		const windows = rows.map((r) => r.window);
		expect(new Set(windows).size).toBe(3); // all distinct -> no duplicate React keys
		expect(windows[0]).toBe("seven_day_fable"); // first stays byte-stable
	});
});

describe("resolveExtraUsageDisplay", () => {
	const extra = (
		fields: Partial<NonNullable<AnthropicUsageData["extra_usage"]>>,
	): AnthropicUsageData => ({
		extra_usage: {
			is_enabled: true,
			monthly_limit: null,
			used_credits: null,
			utilization: null,
			...fields,
		},
	});

	it("is absent when neither flag is a boolean", () => {
		expect(resolveExtraUsageDisplay(null)).toEqual({ kind: "absent" });
		expect(resolveExtraUsageDisplay({})).toEqual({ kind: "absent" });
		expect(resolveExtraUsageDisplay({ spend: { percent: 10 } })).toEqual({
			kind: "absent",
		});
	});

	it("lets spend.enabled outrank extra_usage.is_enabled, both ways", () => {
		expect(
			resolveExtraUsageDisplay({
				...extra({ is_enabled: true, monthly_limit: 10, used_credits: 1 }),
				spend: { enabled: false },
			}).kind,
		).toBe("off");
		expect(
			resolveExtraUsageDisplay({
				...extra({ is_enabled: false, monthly_limit: 10, used_credits: 1 }),
				spend: { enabled: true },
			}).kind,
		).toBe("on");
	});

	it("takes the off reason from spend first, then extra_usage, else null", () => {
		expect(
			resolveExtraUsageDisplay({
				...extra({ is_enabled: false, disabled_reason: "b" }),
				spend: { enabled: false, disabled_reason: "a" },
			}),
		).toEqual({ kind: "off", reason: "a" });
		expect(
			resolveExtraUsageDisplay(
				extra({ is_enabled: false, disabled_reason: "b" }),
			),
		).toEqual({ kind: "off", reason: "b" });
		expect(resolveExtraUsageDisplay(extra({ is_enabled: false }))).toEqual({
			kind: "off",
			reason: null,
		});
	});

	it("clamps remaining at zero and reports the limit reached", () => {
		const d = resolveExtraUsageDisplay(
			extra({ monthly_limit: 1000, used_credits: 1123, utilization: 100 }),
		);
		expect(d).toEqual({
			kind: "on",
			used: 1123,
			limit: 1000,
			remaining: 0,
			percent: 100,
			unit: null,
			limitReached: true,
		});
	});

	it("prefers spend's money objects and their unit", () => {
		const d = resolveExtraUsageDisplay({
			...extra({ monthly_limit: 9, used_credits: 9 }),
			spend: {
				enabled: true,
				used: { amount_minor: 250, currency: "USD", exponent: 2 },
				limit: { amount_minor: 1000, currency: "USD", exponent: 2 },
			},
		});
		expect(d).toMatchObject({
			used: 250,
			limit: 1000,
			remaining: 750,
			unit: { currency: "USD", exponent: 2 },
		});
	});

	it("falls back to extra_usage when spend's money disagrees on unit or is malformed", () => {
		for (const spend of [
			{
				enabled: true,
				used: { amount_minor: 1, currency: "USD", exponent: 2 },
				limit: { amount_minor: 5, currency: "EUR", exponent: 2 },
			},
			{
				enabled: true,
				// No exponent: the old row defaulted it to 2, which invents a unit.
				used: { amount_minor: 1, currency: "USD" } as never,
			},
		]) {
			expect(
				resolveExtraUsageDisplay({
					...extra({ monthly_limit: 1000, used_credits: 400 }),
					spend,
				}),
			).toMatchObject({ used: 400, limit: 1000, remaining: 600, unit: null });
		}
	});

	it("never defaults a missing exponent: the money object is unusable", () => {
		// The Overage row this replaced read `exponent ?? 2`, inventing a unit.
		// With nothing to fall back to, the reading has no figures at all.
		expect(
			resolveExtraUsageDisplay({
				spend: {
					enabled: true,
					used: { amount_minor: 150, currency: "USD" } as never,
				},
			}),
		).toMatchObject({ kind: "on", used: null, unit: null });
	});

	it("prefers a complete extra_usage reading over a spend reading missing its limit", () => {
		const d = resolveExtraUsageDisplay({
			...extra({
				monthly_limit: 1000,
				used_credits: 400,
				currency: "USD",
				decimal_places: 2,
			}),
			spend: {
				enabled: true,
				used: { amount_minor: 400, currency: "USD", exponent: 2 },
				limit: null,
			},
		});
		expect(d).toMatchObject({ used: 400, limit: 1000, remaining: 600 });
	});

	it("keeps a spend reading with only used when nothing better exists", () => {
		const d = resolveExtraUsageDisplay({
			spend: {
				enabled: true,
				used: { amount_minor: 0, currency: "USD", exponent: 2 },
			},
		});
		expect(d).toMatchObject({ used: 0, limit: null, remaining: null });
	});

	it("takes percent from spend, then utilization, then the ratio", () => {
		expect(
			resolveExtraUsageDisplay({
				...extra({ monthly_limit: 100, used_credits: 50, utilization: 7 }),
				spend: { enabled: true, percent: 3 },
			}),
		).toMatchObject({ percent: 3 });
		expect(
			resolveExtraUsageDisplay(
				extra({ monthly_limit: 100, used_credits: 50, utilization: 7 }),
			),
		).toMatchObject({ percent: 7 });
		expect(
			resolveExtraUsageDisplay(extra({ monthly_limit: 200, used_credits: 50 })),
		).toMatchObject({ percent: 25 });
		expect(
			resolveExtraUsageDisplay(extra({ monthly_limit: 0, used_credits: 0 })),
		).toMatchObject({ percent: null, limitReached: true });
	});

	it("reports the limit reached from spend_limit_reached alone", () => {
		expect(
			resolveExtraUsageDisplay(
				extra({
					monthly_limit: 100,
					used_credits: 1,
					spend_limit_reached: true,
				}),
			),
		).toMatchObject({ remaining: 99, limitReached: true });
	});

	it("invents nothing when the pool is on with no figures", () => {
		expect(resolveExtraUsageDisplay(extra({}))).toEqual({
			kind: "on",
			used: null,
			limit: null,
			remaining: null,
			percent: null,
			unit: null,
			limitReached: false,
		});
	});
});

describe("formatExtraUsageAmount", () => {
	it("formats minor units at the unit's precision, independent of locale", () => {
		expect(formatExtraUsageAmount(1234, { currency: "USD", exponent: 2 })).toBe(
			"USD 12.34",
		);
		expect(formatExtraUsageAmount(5, { currency: "JPY", exponent: 0 })).toBe(
			"JPY 5",
		);
	});

	it("prints a bare number when no unit was reported", () => {
		expect(formatExtraUsageAmount(1123, null)).toBe("1123");
	});
});
