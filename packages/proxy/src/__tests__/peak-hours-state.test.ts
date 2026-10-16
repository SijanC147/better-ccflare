/**
 * Tests for isAnthropicPeakHour() and getPeakHoursState(), the server-side
 * source of truth for the `peakHours` field served on /api/accounts.
 *
 * Reference calendar (2026-09, UTC): 23 Wed, 26 Sat
 */
import { beforeEach, describe, expect, it } from "bun:test";
import {
	getPeakHoursState,
	isAnthropicPeakHour,
} from "../auto-refresh-scheduler";
import { resetChineseHolidayCache } from "../chinese-holidays";

describe("isAnthropicPeakHour", () => {
	// The window is 5am-11am in Los Angeles (SB23-1867, #93, SB23-8195), so
	// its UTC edges move with daylight saving. Upstream's fixed 13:00-19:00 UTC
	// is right only under PST; each PDT edge below fails it.
	it("is peak 12:00-18:00 UTC on a PDT weekday, window end exclusive", () => {
		// Wed 2026-09-23 is PDT (UTC-7).
		expect(isAnthropicPeakHour(Date.UTC(2026, 8, 23, 12, 0))).toBe(true);
		expect(isAnthropicPeakHour(Date.UTC(2026, 8, 23, 17, 59))).toBe(true);
		expect(isAnthropicPeakHour(Date.UTC(2026, 8, 23, 18, 0))).toBe(false);
		expect(isAnthropicPeakHour(Date.UTC(2026, 8, 23, 11, 59))).toBe(false);
	});

	it("is peak 13:00-19:00 UTC on a PST weekday, window end exclusive", () => {
		// Thu 2026-01-15 is PST (UTC-8).
		expect(isAnthropicPeakHour(Date.UTC(2026, 0, 15, 13, 0))).toBe(true);
		expect(isAnthropicPeakHour(Date.UTC(2026, 0, 15, 18, 59))).toBe(true);
		expect(isAnthropicPeakHour(Date.UTC(2026, 0, 15, 19, 0))).toBe(false);
		expect(isAnthropicPeakHour(Date.UTC(2026, 0, 15, 12, 59))).toBe(false);
	});

	it("is off-peak on weekends in Los Angeles", () => {
		expect(isAnthropicPeakHour(Date.UTC(2026, 8, 26, 15, 0))).toBe(false);
		// Mon 2026-09-28 00:30 UTC is still Sunday 17:30 in Los Angeles.
		expect(isAnthropicPeakHour(Date.UTC(2026, 8, 28, 0, 30))).toBe(false);
	});
});

describe("getPeakHoursState", () => {
	beforeEach(() => resetChineseHolidayCache());

	it("returns null for providers without a peak concept", () => {
		expect(
			getPeakHoursState("openai-compatible", Date.UTC(2026, 8, 23, 15)),
		).toBeNull();
		expect(getPeakHoursState("codex", Date.UTC(2026, 8, 23, 15))).toBeNull();
	});

	it("returns null for unknown and prototype-named providers", () => {
		const ts = Date.UTC(2026, 8, 23, 15);
		for (const p of [
			"__proto__",
			"constructor",
			"toString",
			"nope",
			"",
			null,
		]) {
			expect(getPeakHoursState(p, ts)).toBeNull();
		}
		expect(getPeakHoursState(undefined, ts)).toBeNull();
	});

	it("reports deepseek, zai and anthropic activity", () => {
		// Wed 02:00 UTC: deepseek peak only
		const t1 = Date.UTC(2026, 8, 23, 2, 0);
		expect(getPeakHoursState("deepseek", t1)).toEqual({ active: true });
		expect(getPeakHoursState("zai", t1)).toEqual({ active: false });
		expect(getPeakHoursState("anthropic", t1)).toEqual({ active: false });
		// Wed 15:00 UTC (23:00 SGT): anthropic peak only
		const t2 = Date.UTC(2026, 8, 23, 15, 0);
		expect(getPeakHoursState("anthropic", t2)).toEqual({ active: true });
		expect(getPeakHoursState("deepseek", t2)).toEqual({ active: false });
		// Wed 07:00 UTC (15:00 SGT): zai peak
		expect(getPeakHoursState("zai", Date.UTC(2026, 8, 23, 7, 0))).toEqual({
			active: true,
		});
	});

	it("honours the Chinese holiday calendar for deepseek", () => {
		// Mon 2026-02-16 (Spring Festival)
		expect(getPeakHoursState("deepseek", Date.UTC(2026, 1, 16, 2, 0))).toEqual({
			active: false,
		});
	});
});
