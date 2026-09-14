/**
 * Every case here pins BOTH the instant and the timezone. A test that reads the
 * machine's zone would pass in Europe/Malta and say nothing about anyone else,
 * which is the exact bug this module exists to fix.
 *
 * The reference instants are stated as UTC so they can be checked by hand
 * against the window constants in provider-utils.
 */
import { describe, expect, it } from "bun:test";
import {
	formatCountdown,
	formatPeakDayPrefix,
	formatPeakRange,
	peakHoursLabel,
	resolvePeakOccurrence,
} from "./peak-hours";
import { ANTHROPIC_PEAK_WINDOW, ZAI_PEAK_WINDOW } from "./provider-utils";

const MALTA = { timeZone: "Europe/Malta", locale: "en-GB", hour12: false };
const NEW_YORK = { timeZone: "America/New_York", locale: "en-US" };

/**
 * September is PDT (UTC-7), so the Anthropic window's 5–11am Los Angeles is
 * 12:00–18:00 UTC on these dates. It is 13:00–19:00 UTC on PST dates instead;
 * see the vendor-zone suite at the bottom of this file.
 */
/** Wednesday 2026-09-09, inside the Anthropic window (12:00–18:00 UTC). */
const WED_INSIDE = Date.parse("2026-09-09T14:30:00Z");
/** Wednesday 2026-09-09, before the window opens. */
const WED_BEFORE = Date.parse("2026-09-09T09:00:00Z");
/** Wednesday 2026-09-09, after the window has closed. */
const WED_AFTER = Date.parse("2026-09-09T20:00:00Z");
/** Saturday 2026-09-12, 10:00 UTC — no Anthropic window all weekend. */
const SATURDAY = Date.parse("2026-09-12T10:00:00Z");
/** Saturday 2026-09-12, 08:00 UTC — inside the Zai window (06:00–10:00 UTC). */
const SATURDAY_ZAI = Date.parse("2026-09-12T08:00:00Z");

describe("resolvePeakOccurrence", () => {
	it("reports the window in progress as active", () => {
		const occurrence = resolvePeakOccurrence(ANTHROPIC_PEAK_WINDOW, WED_INSIDE);
		expect(occurrence.active).toBe(true);
		expect(occurrence.start).toBe(Date.parse("2026-09-09T12:00:00Z"));
		expect(occurrence.end).toBe(Date.parse("2026-09-09T18:00:00Z"));
	});

	it("returns today's window before it opens", () => {
		const occurrence = resolvePeakOccurrence(ANTHROPIC_PEAK_WINDOW, WED_BEFORE);
		expect(occurrence.active).toBe(false);
		expect(occurrence.start).toBe(Date.parse("2026-09-09T12:00:00Z"));
	});

	it("rolls to the next day once today's window has closed", () => {
		const occurrence = resolvePeakOccurrence(ANTHROPIC_PEAK_WINDOW, WED_AFTER);
		expect(occurrence.active).toBe(false);
		expect(occurrence.start).toBe(Date.parse("2026-09-10T12:00:00Z"));
	});

	it("skips the weekend for a weekdays-only window", () => {
		const occurrence = resolvePeakOccurrence(ANTHROPIC_PEAK_WINDOW, SATURDAY);
		expect(occurrence.active).toBe(false);
		// Monday 2026-09-14, not Sunday.
		expect(occurrence.start).toBe(Date.parse("2026-09-14T12:00:00Z"));
	});

	it("does not skip the weekend for a window without a weekday rule", () => {
		const occurrence = resolvePeakOccurrence(ZAI_PEAK_WINDOW, SATURDAY_ZAI);
		expect(occurrence.active).toBe(true);
		expect(occurrence.start).toBe(Date.parse("2026-09-12T06:00:00Z"));
		expect(occurrence.end).toBe(Date.parse("2026-09-12T10:00:00Z"));
	});

	it("treats the end of the window as exclusive", () => {
		// SATURDAY is exactly 10:00 UTC, the Zai window's end boundary.
		const occurrence = resolvePeakOccurrence(ZAI_PEAK_WINDOW, SATURDAY);
		expect(occurrence.active).toBe(false);
		expect(occurrence.start).toBe(Date.parse("2026-09-13T06:00:00Z"));
	});
});

describe("formatPeakRange", () => {
	it("renders the Anthropic window in Malta's local clock", () => {
		const occurrence = resolvePeakOccurrence(ANTHROPIC_PEAK_WINDOW, WED_INSIDE);
		// 12:00–18:00 UTC is 14:00–20:00 in Malta during CEST.
		expect(formatPeakRange(occurrence, MALTA)).toBe("14:00–20:00");
	});

	it("renders the same window differently in New York", () => {
		const occurrence = resolvePeakOccurrence(ANTHROPIC_PEAK_WINDOW, WED_INSIDE);
		// 12:00–18:00 UTC is 8:00 AM–2:00 PM in New York during EDT.
		expect(formatPeakRange(occurrence, NEW_YORK)).toBe("8:00 AM–2:00 PM");
	});

	it("renders the Zai window in Malta's local clock", () => {
		const occurrence = resolvePeakOccurrence(ZAI_PEAK_WINDOW, SATURDAY_ZAI);
		// 06:00–10:00 UTC is 08:00–12:00 in Malta during CEST.
		expect(formatPeakRange(occurrence, MALTA)).toBe("8:00–12:00");
	});

	it("follows the viewer's own DST change, not a fixed offset", () => {
		// January: Los Angeles is on PST, so the window is 13:00–19:00 UTC, and
		// Malta is on CET rather than CEST. Both shifts land on 14:00–20:00 local.
		const winter = Date.parse("2027-01-13T14:30:00Z");
		const occurrence = resolvePeakOccurrence(ANTHROPIC_PEAK_WINDOW, winter);
		expect(occurrence.start).toBe(Date.parse("2027-01-13T13:00:00Z"));
		expect(formatPeakRange(occurrence, MALTA)).toBe("14:00–20:00");
	});
});

describe("formatPeakDayPrefix", () => {
	it("is empty when the window starts on the viewer's current day", () => {
		const occurrence = resolvePeakOccurrence(ANTHROPIC_PEAK_WINDOW, WED_BEFORE);
		expect(formatPeakDayPrefix(occurrence, WED_BEFORE, MALTA)).toBe("");
	});

	it("says tomorrow for the next day's window", () => {
		const occurrence = resolvePeakOccurrence(ANTHROPIC_PEAK_WINDOW, WED_AFTER);
		expect(formatPeakDayPrefix(occurrence, WED_AFTER, MALTA)).toBe("tomorrow ");
	});

	it("names the weekday when the window is further out", () => {
		const occurrence = resolvePeakOccurrence(ANTHROPIC_PEAK_WINDOW, SATURDAY);
		expect(formatPeakDayPrefix(occurrence, SATURDAY, MALTA)).toBe("Mon ");
	});
});

describe("formatCountdown", () => {
	it("renders hours and minutes", () => {
		expect(formatCountdown(2 * 3600_000 + 15 * 60_000)).toBe("2h 15m");
	});

	it("drops a zero minute component", () => {
		expect(formatCountdown(3 * 3600_000)).toBe("3h");
	});

	it("renders minutes alone under an hour", () => {
		expect(formatCountdown(9 * 60_000)).toBe("9m");
	});

	it("renders days and hours for long waits", () => {
		expect(formatCountdown(2 * 86400_000 + 5 * 3600_000)).toBe("2d 5h");
	});

	it("floors sub-minute waits rather than showing 0m", () => {
		expect(formatCountdown(20_000)).toBe("< 1m");
	});

	it("reports a non-positive duration as now", () => {
		expect(formatCountdown(0)).toBe("now");
		expect(formatCountdown(-1)).toBe("now");
	});
});

describe("peakHoursLabel", () => {
	it("counts down to the end while the window is active", () => {
		const label = peakHoursLabel(ANTHROPIC_PEAK_WINDOW, WED_INSIDE, MALTA);
		expect(label.active).toBe(true);
		expect(label.text).toBe("Peak hours 14:00–20:00");
		expect(label.countdown).toBe("ends in 3h 30m");
		expect(label.title).toBe("Peak hours 14:00–20:00 · ends in 3h 30m");
	});

	it("counts down to the start when off-peak later the same day", () => {
		const label = peakHoursLabel(ANTHROPIC_PEAK_WINDOW, WED_BEFORE, MALTA);
		expect(label.active).toBe(false);
		expect(label.text).toBe("Off-peak · next peak 14:00–20:00");
		expect(label.countdown).toBe("in 3h");
	});

	it("names the next weekday when the wait crosses the weekend", () => {
		const label = peakHoursLabel(ANTHROPIC_PEAK_WINDOW, SATURDAY, MALTA);
		expect(label.active).toBe(false);
		expect(label.text).toBe("Off-peak · next peak Mon 14:00–20:00");
		expect(label.countdown).toBe("in 2d 2h");
	});

	it("localizes the Zai window too, with no weekend gap", () => {
		const label = peakHoursLabel(ZAI_PEAK_WINDOW, SATURDAY_ZAI, MALTA);
		expect(label.active).toBe(true);
		expect(label.text).toBe("Peak hours 8:00–12:00");
		expect(label.countdown).toBe("ends in 2h");
	});
});

/**
 * The window is fixed at the vendor, not in UTC, so its UTC hours move when the
 * vendor's zone changes offset. Los Angeles is UTC-7 on PDT and UTC-8 otherwise.
 *
 * Note which half of the year was wrong. SB23-1867 states the inversion: the old
 * fixed 13:00–19:00 UTC constant is 5–11am PST, so it was correct in winter and
 * an hour late through PDT, roughly March to November — not the other way round.
 */
describe("vendor-zone resolution of the Anthropic window", () => {
	it("is 13:00–19:00 UTC in January, when Los Angeles is on PST", () => {
		const occurrence = resolvePeakOccurrence(
			ANTHROPIC_PEAK_WINDOW,
			Date.parse("2027-01-13T09:00:00Z"),
		);
		expect(occurrence.start).toBe(Date.parse("2027-01-13T13:00:00Z"));
		expect(occurrence.end).toBe(Date.parse("2027-01-13T19:00:00Z"));
	});

	it("is 12:00–18:00 UTC in July, when Los Angeles is on PDT", () => {
		const occurrence = resolvePeakOccurrence(
			ANTHROPIC_PEAK_WINDOW,
			Date.parse("2026-07-15T09:00:00Z"),
		);
		expect(occurrence.start).toBe(Date.parse("2026-07-15T12:00:00Z"));
		expect(occurrence.end).toBe(Date.parse("2026-07-15T18:00:00Z"));
	});

	it("renders 5–11am in Los Angeles on both of those dates", () => {
		const LA = { timeZone: "America/Los_Angeles", locale: "en-GB", hour12: false };
		const winter = resolvePeakOccurrence(
			ANTHROPIC_PEAK_WINDOW,
			Date.parse("2027-01-13T09:00:00Z"),
		);
		const summer = resolvePeakOccurrence(
			ANTHROPIC_PEAK_WINDOW,
			Date.parse("2026-07-15T09:00:00Z"),
		);
		expect(formatPeakRange(winter, LA)).toBe("5:00–11:00");
		expect(formatPeakRange(summer, LA)).toBe("5:00–11:00");
	});

	it("carries the shift across a spring-forward weekend", () => {
		// US DST always changes on a Sunday, so a weekdays-only window never
		// contains a transition. It straddles one: the Friday before the 2027
		// spring-forward is PST and the Monday after is PDT, so the gap between
		// consecutive occurrences is 65 hours, not a round 3 * 24.
		const afterFriday = resolvePeakOccurrence(
			ANTHROPIC_PEAK_WINDOW,
			Date.parse("2027-03-12T20:00:00Z"),
		);
		expect(afterFriday.start).toBe(Date.parse("2027-03-15T12:00:00Z"));
		expect(afterFriday.start - Date.parse("2027-03-12T19:00:00Z")).toBe(
			65 * 60 * 60 * 1000,
		);
	});

	it("skips the vendor's weekend, not a fixed UTC weekend", () => {
		// 06:00 UTC Saturday is 23:00 Friday in Los Angeles. Friday's window has
		// already closed, so the next one is Monday's — never Saturday's.
		const occurrence = resolvePeakOccurrence(
			ANTHROPIC_PEAK_WINDOW,
			Date.parse("2026-09-12T06:00:00Z"),
		);
		expect(occurrence.active).toBe(false);
		expect(occurrence.start).toBe(Date.parse("2026-09-14T12:00:00Z"));
	});

	it("takes the weekday from the vendor's calendar when UTC disagrees", () => {
		// Los Angeles is behind UTC, so its 5–11am window never lands on a
		// different UTC date and the two calendars happen to agree. A zone AHEAD
		// of UTC separates them: 05:00 Monday in Singapore is 21:00 SUNDAY in
		// UTC. A resolver still reading getUTCDay() would skip it as a weekend.
		const singaporeMornings = {
			timeZone: "Asia/Singapore",
			startHour: 5,
			endHour: 11,
			weekdaysOnly: true,
		};
		const occurrence = resolvePeakOccurrence(
			singaporeMornings,
			// Sunday 2026-09-13, 12:00 UTC — Sunday evening in Singapore.
			Date.parse("2026-09-13T12:00:00Z"),
		);
		expect(occurrence.active).toBe(false);
		// Monday 2026-09-14 local, which begins on Sunday in UTC.
		expect(occurrence.start).toBe(Date.parse("2026-09-13T21:00:00Z"));
		expect(occurrence.end).toBe(Date.parse("2026-09-14T03:00:00Z"));
	});

	it("leaves the Zai window on its year-round UTC hours", () => {
		// Singapore has no DST, so stating the window in Asia/Singapore rather
		// than UTC must not move it in either season.
		for (const iso of ["2027-01-13T04:00:00Z", "2026-07-15T04:00:00Z"]) {
			const occurrence = resolvePeakOccurrence(ZAI_PEAK_WINDOW, Date.parse(iso));
			const day = iso.slice(0, 10);
			expect(occurrence.start).toBe(Date.parse(`${day}T06:00:00Z`));
			expect(occurrence.end).toBe(Date.parse(`${day}T10:00:00Z`));
		}
	});
});
