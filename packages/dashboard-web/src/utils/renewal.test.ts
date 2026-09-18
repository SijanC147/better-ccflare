import { describe, expect, it } from "bun:test";
import {
	formatRenewalBadge,
	formatRenewalDate,
	viewerRenewal,
	viewerTimeZone,
} from "./renewal";

/**
 * SB23-2055. The clamping and next-occurrence arithmetic is covered where it
 * lives, in packages/types. What is covered here is the dashboard's side: that
 * the viewer's zone is what gets used, and that the badge text and tooltip date
 * are built from the calendar date without passing it through a conversion that
 * could move it by a day.
 */

describe("viewerTimeZone", () => {
	it("returns an IANA zone name", () => {
		// Not compared against a literal: the test machine and CI are in different
		// zones. What matters is that a usable name comes back rather than an
		// empty string, which Intl would then reject.
		const zone = viewerTimeZone();
		expect(zone.length).toBeGreaterThan(0);
		expect(() =>
			new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date()),
		).not.toThrow();
	});
});

describe("viewerRenewal", () => {
	it("returns null when the account has no renewal day", () => {
		expect(viewerRenewal(null)).toBeNull();
		expect(viewerRenewal(undefined)).toBeNull();
	});

	it("returns a renewal for a day that is set", () => {
		const renewal = viewerRenewal(15, Date.UTC(2026, 2, 1, 12));
		expect(renewal?.nextRenewalAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it("agrees with the viewer's own zone rather than with UTC", () => {
		// An instant that is a different calendar date in UTC and in the machine's
		// zone cannot be constructed portably, so this asserts the weaker thing
		// that is still decisive: the result matches a computation made with the
		// zone viewerTimeZone reports, whatever that zone happens to be.
		const now = Date.UTC(2026, 2, 15, 23, 30);
		const zone = viewerTimeZone();
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			day: "numeric",
		}).formatToParts(new Date(now));
		const localDay = Number(parts.find((p) => p.type === "day")?.value);

		const renewal = viewerRenewal(localDay, now);
		expect(renewal?.daysUntilRenewal).toBe(0);
	});
});

describe("formatRenewalBadge", () => {
	const at = (nextRenewalAt: string, daysUntilRenewal: number) => ({
		nextRenewalAt,
		daysUntilRenewal,
		clamped: false,
	});

	it("says today rather than in 0d", () => {
		expect(formatRenewalBadge(at("2026-03-15", 0))).toBe("Renews today");
	});

	it("says tomorrow rather than in 1d", () => {
		// "in 1d" sitting next to "today" reads as an off-by-one rather than as a
		// deliberate choice.
		expect(formatRenewalBadge(at("2026-03-16", 1))).toBe("Renews tomorrow");
	});

	it("counts days for anything further out", () => {
		expect(formatRenewalBadge(at("2026-03-27", 12))).toBe("Renews in 12d");
	});
});

describe("formatRenewalDate", () => {
	it("keeps the calendar date it was given", () => {
		// The date must not shift. Formatting a YYYY-MM-DD through a local-zone
		// conversion moves it back a day for every viewer west of UTC, which is
		// exactly the failure the wire format was chosen to avoid.
		const text = formatRenewalDate({
			nextRenewalAt: "2026-02-28",
			daysUntilRenewal: 5,
			clamped: true,
		});
		expect(text).toContain("28");
		expect(text).toContain("2026");
		expect(text).not.toContain("27");
	});

	it("keeps the first of the month on the first", () => {
		const text = formatRenewalDate({
			nextRenewalAt: "2026-01-01",
			daysUntilRenewal: 3,
			clamped: false,
		});
		expect(text).toContain("1");
		expect(text).toContain("2026");
		expect(text).not.toContain("2025");
	});
});
