/**
 * The peak-hour predicates, pinned to instants rather than to the clock.
 *
 * `isAnthropicPeakHour` used to compare UTC hours against a fixed 13:00–19:00
 * range. That range is 5–11am in Los Angeles only while PST is in effect, so
 * through PDT — roughly March to November — it reported peak hours an hour late
 * at both ends. These cases pin both halves of the year so a return to a fixed
 * UTC range fails here rather than in production for half a year at a time.
 */
import { describe, expect, it } from "bun:test";
import { isAnthropicPeakHour, isZaiPeakHour } from "./provider-utils";

describe("isAnthropicPeakHour", () => {
	it("opens at 12:00 UTC on a PDT weekday", () => {
		// Wednesday 2026-07-15. 12:00 UTC is 05:00 PDT.
		expect(isAnthropicPeakHour(Date.parse("2026-07-15T11:59:00Z"))).toBe(false);
		expect(isAnthropicPeakHour(Date.parse("2026-07-15T12:00:00Z"))).toBe(true);
		expect(isAnthropicPeakHour(Date.parse("2026-07-15T17:59:00Z"))).toBe(true);
		expect(isAnthropicPeakHour(Date.parse("2026-07-15T18:00:00Z"))).toBe(false);
	});

	it("opens an hour later, at 13:00 UTC, on a PST weekday", () => {
		// Wednesday 2027-01-13. 13:00 UTC is 05:00 PST.
		expect(isAnthropicPeakHour(Date.parse("2027-01-13T12:30:00Z"))).toBe(false);
		expect(isAnthropicPeakHour(Date.parse("2027-01-13T13:00:00Z"))).toBe(true);
		expect(isAnthropicPeakHour(Date.parse("2027-01-13T18:59:00Z"))).toBe(true);
		expect(isAnthropicPeakHour(Date.parse("2027-01-13T19:00:00Z"))).toBe(false);
	});

	it("is the case the old fixed UTC range got wrong", () => {
		// 12:30 UTC on a July weekday is 05:30 in Los Angeles: peak. The old
		// 13:00–19:00 UTC constant returned false here.
		expect(isAnthropicPeakHour(Date.parse("2026-07-15T12:30:00Z"))).toBe(true);
		// 18:30 UTC the same day is 11:30 local: over. The old constant said true.
		expect(isAnthropicPeakHour(Date.parse("2026-07-15T18:30:00Z"))).toBe(false);
	});

	it("never reports peak hours on the vendor's weekend", () => {
		expect(isAnthropicPeakHour(Date.parse("2026-09-12T14:00:00Z"))).toBe(false);
		expect(isAnthropicPeakHour(Date.parse("2026-09-13T14:00:00Z"))).toBe(false);
		expect(isAnthropicPeakHour(Date.parse("2026-09-14T14:00:00Z"))).toBe(true);
	});
});

describe("isZaiPeakHour", () => {
	it("holds its UTC hours in both seasons, Singapore having no DST", () => {
		for (const day of ["2026-07-15", "2027-01-13"]) {
			expect(isZaiPeakHour(Date.parse(`${day}T05:59:00Z`))).toBe(false);
			expect(isZaiPeakHour(Date.parse(`${day}T06:00:00Z`))).toBe(true);
			expect(isZaiPeakHour(Date.parse(`${day}T09:59:00Z`))).toBe(true);
			expect(isZaiPeakHour(Date.parse(`${day}T10:00:00Z`))).toBe(false);
		}
	});

	it("still runs at the weekend, unlike the Anthropic window", () => {
		// Deliberate asymmetry, not an oversight copied from the fix above: Zai's
		// window may genuinely run every day (SB23-1867, out of scope).
		expect(isZaiPeakHour(Date.parse("2026-09-12T08:00:00Z"))).toBe(true);
		expect(isZaiPeakHour(Date.parse("2026-09-13T08:00:00Z"))).toBe(true);
	});
});
