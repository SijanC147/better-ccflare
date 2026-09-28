/**
 * Tests for the internal isZaiPeakHour() helper in auto-refresh-scheduler.ts.
 *
 * Z.ai's peak pricing window is 14:00-18:00 Singapore time (UTC+8), every
 * day — there is no weekday/weekend restriction. This mirrors the
 * ZAI_PEAK_WINDOW rule in packages/dashboard-web/src/utils/provider-utils.ts
 * (weekdaysOnly: false, SB23-1867) and is regression-covered there too, in
 * packages/dashboard-web/src/utils/peak-predicates.test.ts. An earlier
 * version of this file (and of the helper itself) added a weekday gate that
 * incorrectly treated Saturday/Sunday as never-peak; these tests instead pin
 * that weekends are treated the same as weekdays.
 *
 * isZaiPeakHour is exported solely for testability; it is not otherwise part
 * of the module's public surface and has no other callers outside this
 * file's AutoRefreshScheduler.checkPeakHoursPause().
 *
 * All timestamps are constructed with Date.UTC(...) so the tests are
 * deterministic regardless of the machine's local timezone.
 *
 * Reference calendar (all 2026-09, UTC):
 *   21 Mon, 22 Tue, 23 Wed, 24 Thu, 25 Fri, 26 Sat, 27 Sun, 28 Mon
 */
import { describe, expect, it } from "bun:test";
import { isZaiPeakHour } from "../auto-refresh-scheduler";

describe("isZaiPeakHour", () => {
	it("returns true for a weekday inside the peak window (Wed 15:00 SGT)", () => {
		// Wed 2026-09-23, 15:00 SGT = 07:00 UTC.
		const ts = Date.UTC(2026, 8, 23, 7, 0);
		expect(isZaiPeakHour(ts)).toBe(true);
	});

	it("returns false for a weekday before the peak window (Wed 10:00 SGT)", () => {
		// Wed 2026-09-23, 10:00 SGT = 02:00 UTC.
		const ts = Date.UTC(2026, 8, 23, 2, 0);
		expect(isZaiPeakHour(ts)).toBe(false);
	});

	it("returns false for a weekday after the peak window (Wed 20:00 SGT)", () => {
		// Wed 2026-09-23, 20:00 SGT = 12:00 UTC.
		const ts = Date.UTC(2026, 8, 23, 12, 0);
		expect(isZaiPeakHour(ts)).toBe(false);
	});

	it("returns true on Saturday at an hour inside the peak window (Sat 15:00 SGT) — no weekday gate", () => {
		// Sat 2026-09-26, 15:00 SGT = 07:00 UTC.
		const ts = Date.UTC(2026, 8, 26, 7, 0);
		expect(isZaiPeakHour(ts)).toBe(true);
	});

	it("returns true on Sunday at an hour inside the peak window (Sun 15:00 SGT) — no weekday gate", () => {
		// Sun 2026-09-27, 15:00 SGT = 07:00 UTC.
		const ts = Date.UTC(2026, 8, 27, 7, 0);
		expect(isZaiPeakHour(ts)).toBe(true);
	});

	it("returns true at the lower boundary, 14:00 SGT (window is inclusive of 14:00)", () => {
		// Wed 2026-09-23, 14:00 SGT = 06:00 UTC.
		const ts = Date.UTC(2026, 8, 23, 6, 0);
		expect(isZaiPeakHour(ts)).toBe(true);
	});

	it("returns false at the upper boundary, 18:00 SGT (window is exclusive of 18:00)", () => {
		// Wed 2026-09-23, 18:00 SGT = 10:00 UTC.
		const ts = Date.UTC(2026, 8, 23, 10, 0);
		expect(isZaiPeakHour(ts)).toBe(false);
	});

	it("returns false outside the window on a weekend too (Sat 10:00 SGT)", () => {
		// Sat 2026-09-26, 10:00 SGT = 02:00 UTC.
		const ts = Date.UTC(2026, 8, 26, 2, 0);
		expect(isZaiPeakHour(ts)).toBe(false);
	});

	it("defaults to Date.now() when no timestamp is provided", () => {
		// Just verify it doesn't throw and returns a boolean when called with
		// no arguments (exercises the `ts = Date.now()` default parameter).
		expect(typeof isZaiPeakHour()).toBe("boolean");
	});
});
