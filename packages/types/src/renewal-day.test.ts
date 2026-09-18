import { describe, expect, it } from "bun:test";
import {
	computeNextRenewal,
	daysInMonth,
	RENEWAL_DAY_MAX,
	RENEWAL_DAY_MIN,
} from "./account";

/**
 * SB23-2055. A subscription renewal day is a day of month, 1 to 31, and the
 * operator's value is stored exactly as typed. Clamping happens here, when the
 * next occurrence is computed, because a value clamped at write time loses the
 * intent forever: an account set to the 31st would become an account set to the
 * 28th after one February and would never renew on the 31st again.
 */

/** Midnight UTC of a calendar date, as an epoch millisecond value. */
function utc(year: number, month: number, day: number, hour = 12): number {
	return Date.UTC(year, month - 1, day, hour);
}

describe("daysInMonth", () => {
	it("gives the real length of every month of a non-leap year", () => {
		const lengths = Array.from({ length: 12 }, (_, m) => daysInMonth(2026, m));
		expect(lengths).toEqual([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
	});

	it("gives 29 days for February of a leap year", () => {
		expect(daysInMonth(2028, 1)).toBe(29);
	});

	it("gives 28 days for February of a century that is not a leap year", () => {
		// 2100 is divisible by 4 and by 100 but not by 400. A hand-rolled
		// `year % 4 === 0` rule returns 29 here and is wrong.
		expect(daysInMonth(2100, 1)).toBe(28);
	});

	it("normalizes a monthIndex outside 0 to 11, as the Date constructor does", () => {
		// The Date-based form this replaced got this for free and its comment
		// documented the 12 case as supported. A bare table lookup returns
		// undefined while the signature promises a number, and
		// `Math.min(day, undefined)` is NaN, which would reach the date string
		// with nothing throwing. Unreachable from computeNextRenewal, which wraps
		// before it calls, but daysInMonth is exported from packages/types.
		expect(daysInMonth(2026, 12)).toBe(31); // January 2027
		expect(daysInMonth(2026, -1)).toBe(31); // December 2025
		expect(daysInMonth(2027, 13)).toBe(29); // February 2028, a leap year
		expect(daysInMonth(2026, 13)).toBe(28); // February 2027
	});

	it("gives 29 days for February of a century that IS a leap year", () => {
		// The other half of the century rule, and the half that is easy to omit:
		// dropping the `|| year % 400 === 0` clause still passes every test above,
		// because no year divisible by 400 appears in any of them. 2000 and 2400
		// are leap years and a rule ending at `% 100 !== 0` calls them 28.
		expect(daysInMonth(2000, 1)).toBe(29);
		expect(daysInMonth(2400, 1)).toBe(29);
	});
});

describe("computeNextRenewal: clamping to the month's last day", () => {
	it("clamps day 31 to 28 February in a non-leap year", () => {
		const result = computeNextRenewal({
			renewalDay: 31,
			now: utc(2026, 2, 10),
		});
		expect(result?.nextRenewalAt).toBe("2026-02-28");
		expect(result?.daysUntilRenewal).toBe(18);
		expect(result?.clamped).toBe(true);
	});

	it("clamps day 31 to 29 February in a leap year", () => {
		const result = computeNextRenewal({
			renewalDay: 31,
			now: utc(2028, 2, 10),
		});
		expect(result?.nextRenewalAt).toBe("2028-02-29");
		expect(result?.clamped).toBe(true);
	});

	it("clamps day 31 to the 30th in every 30-day month", () => {
		// April, June, September and November. Each is checked on its own rather
		// than in one loop assertion so a failure names the month.
		expect(
			computeNextRenewal({ renewalDay: 31, now: utc(2026, 4, 1) })
				?.nextRenewalAt,
		).toBe("2026-04-30");
		expect(
			computeNextRenewal({ renewalDay: 31, now: utc(2026, 6, 1) })
				?.nextRenewalAt,
		).toBe("2026-06-30");
		expect(
			computeNextRenewal({ renewalDay: 31, now: utc(2026, 9, 1) })
				?.nextRenewalAt,
		).toBe("2026-09-30");
		expect(
			computeNextRenewal({ renewalDay: 31, now: utc(2026, 11, 1) })
				?.nextRenewalAt,
		).toBe("2026-11-30");
	});

	it("clamps day 30 to 28 February as well", () => {
		expect(
			computeNextRenewal({ renewalDay: 30, now: utc(2026, 2, 1) })
				?.nextRenewalAt,
		).toBe("2026-02-28");
	});

	it("does not clamp a day the month actually has", () => {
		const result = computeNextRenewal({
			renewalDay: 31,
			now: utc(2026, 1, 5),
		});
		expect(result?.nextRenewalAt).toBe("2026-01-31");
		expect(result?.clamped).toBe(false);
	});

	it("never rolls into the following month the way new Date(y, m, 31) does", () => {
		// `new Date(2026, 1, 31)` is 3 March. A renewal that lands in March is the
		// failure this whole helper exists to prevent, so the assertion is on the
		// month rather than only on the exact date.
		const result = computeNextRenewal({
			renewalDay: 31,
			now: utc(2026, 2, 1),
		});
		expect(result?.nextRenewalAt.slice(0, 7)).toBe("2026-02");
	});
});

describe("computeNextRenewal: which occurrence is next", () => {
	it("returns today with 0 days left when the renewal day is today", () => {
		const result = computeNextRenewal({
			renewalDay: 15,
			now: utc(2026, 3, 15),
		});
		expect(result?.nextRenewalAt).toBe("2026-03-15");
		expect(result?.daysUntilRenewal).toBe(0);
	});

	it("moves to next month once the day has passed", () => {
		const result = computeNextRenewal({
			renewalDay: 15,
			now: utc(2026, 3, 16),
		});
		expect(result?.nextRenewalAt).toBe("2026-04-15");
		expect(result?.daysUntilRenewal).toBe(30);
	});

	it("crosses the year boundary", () => {
		const result = computeNextRenewal({
			renewalDay: 5,
			now: utc(2026, 12, 20),
		});
		expect(result?.nextRenewalAt).toBe("2027-01-05");
		expect(result?.daysUntilRenewal).toBe(16);
	});

	it("stays on the clamped day when today IS the clamped day", () => {
		// 28 February with a stored day of 31: the clamped day is today, so the
		// renewal is today and not four weeks away.
		const result = computeNextRenewal({
			renewalDay: 31,
			now: utc(2026, 2, 28),
		});
		expect(result?.nextRenewalAt).toBe("2026-02-28");
		expect(result?.daysUntilRenewal).toBe(0);
	});

	it("renews a day-31 account on the 31st itself, then rolls to the clamped 30th", () => {
		// Late on the 31st the renewal is still today, not next month. One day
		// later the next occurrence is April, which has 30 days.
		expect(
			computeNextRenewal({ renewalDay: 31, now: utc(2026, 3, 31, 23) })
				?.nextRenewalAt,
		).toBe("2026-03-31");
		expect(
			computeNextRenewal({ renewalDay: 31, now: utc(2026, 4, 1) })
				?.nextRenewalAt,
		).toBe("2026-04-30");
	});

	it("counts whole days across a month with 31 days", () => {
		const result = computeNextRenewal({
			renewalDay: 1,
			now: utc(2026, 7, 2),
		});
		expect(result?.nextRenewalAt).toBe("2026-08-01");
		expect(result?.daysUntilRenewal).toBe(30);
	});
});

describe("computeNextRenewal: the viewer's timezone decides the answer", () => {
	it("reads today's date in the zone it is given, not in UTC", () => {
		// 2026-03-15T23:30Z is still the 15th in UTC and already the 16th in
		// Auckland. With a renewal day of 15 the two answers are a whole billing
		// cycle apart, which is why the zone is a parameter rather than a constant.
		const instant = Date.UTC(2026, 2, 15, 23, 30);

		expect(
			computeNextRenewal({ renewalDay: 15, now: instant, timeZone: "UTC" })
				?.nextRenewalAt,
		).toBe("2026-03-15");

		expect(
			computeNextRenewal({
				renewalDay: 15,
				now: instant,
				timeZone: "Pacific/Auckland",
			})?.nextRenewalAt,
		).toBe("2026-04-15");
	});

	it("reads today's date in a zone behind UTC too", () => {
		// 2026-03-16T01:00Z is the 16th in UTC and still the 15th in Honolulu,
		// which has no daylight saving to muddy the reading.
		const instant = Date.UTC(2026, 2, 16, 1, 0);

		expect(
			computeNextRenewal({ renewalDay: 15, now: instant, timeZone: "UTC" })
				?.daysUntilRenewal,
		).toBe(30);

		expect(
			computeNextRenewal({
				renewalDay: 15,
				now: instant,
				timeZone: "Pacific/Honolulu",
			})?.daysUntilRenewal,
		).toBe(0);
	});

	it("defaults to UTC when no zone is given", () => {
		const instant = Date.UTC(2026, 2, 15, 23, 30);
		expect(computeNextRenewal({ renewalDay: 15, now: instant })).toEqual(
			computeNextRenewal({ renewalDay: 15, now: instant, timeZone: "UTC" }) as
				| ReturnType<typeof computeNextRenewal>
				| never,
		);
	});

	it("counts whole calendar days across a daylight-saving transition", () => {
		// Europe/Malta springs forward on 29 March 2026. A helper that subtracted
		// two local timestamps would report 13 days and 23 hours here and floor to
		// 13. Calendar arithmetic gives the 14 a human counts on a wall calendar.
		const result = computeNextRenewal({
			renewalDay: 5,
			now: Date.UTC(2026, 2, 22, 10),
			timeZone: "Europe/Malta",
		});
		expect(result?.nextRenewalAt).toBe("2026-04-05");
		expect(result?.daysUntilRenewal).toBe(14);
	});
});

describe("computeNextRenewal: values it refuses", () => {
	it("returns null when no renewal day is set", () => {
		expect(computeNextRenewal({ renewalDay: null })).toBeNull();
		expect(computeNextRenewal({ renewalDay: undefined })).toBeNull();
	});

	it("returns null for a day outside 1 to 31 rather than clamping it", () => {
		// An out-of-range value must not quietly become the nearest legal day.
		// The API rejects these with a 400; the helper's job is to render nothing.
		expect(
			computeNextRenewal({ renewalDay: 0, now: utc(2026, 3, 1) }),
		).toBeNull();
		expect(
			computeNextRenewal({ renewalDay: 32, now: utc(2026, 3, 1) }),
		).toBeNull();
		expect(
			computeNextRenewal({ renewalDay: -1, now: utc(2026, 3, 1) }),
		).toBeNull();
	});

	it("returns null for a non-integer day", () => {
		expect(
			computeNextRenewal({ renewalDay: 1.5, now: utc(2026, 3, 1) }),
		).toBeNull();
		expect(
			computeNextRenewal({ renewalDay: Number.NaN, now: utc(2026, 3, 1) }),
		).toBeNull();
	});

	it("accepts both ends of the documented range", () => {
		expect(
			computeNextRenewal({ renewalDay: RENEWAL_DAY_MIN, now: utc(2026, 3, 1) }),
		).not.toBeNull();
		expect(
			computeNextRenewal({ renewalDay: RENEWAL_DAY_MAX, now: utc(2026, 3, 1) }),
		).not.toBeNull();
	});

	it("pins the bounds the API validates against", () => {
		expect(RENEWAL_DAY_MIN).toBe(1);
		expect(RENEWAL_DAY_MAX).toBe(31);
	});
});
