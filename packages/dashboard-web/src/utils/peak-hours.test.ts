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

/** Wednesday 2026-09-09, inside the Anthropic window (13:00–19:00 UTC). */
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
		expect(occurrence.start).toBe(Date.parse("2026-09-09T13:00:00Z"));
		expect(occurrence.end).toBe(Date.parse("2026-09-09T19:00:00Z"));
	});

	it("returns today's window before it opens", () => {
		const occurrence = resolvePeakOccurrence(ANTHROPIC_PEAK_WINDOW, WED_BEFORE);
		expect(occurrence.active).toBe(false);
		expect(occurrence.start).toBe(Date.parse("2026-09-09T13:00:00Z"));
	});

	it("rolls to the next day once today's window has closed", () => {
		const occurrence = resolvePeakOccurrence(ANTHROPIC_PEAK_WINDOW, WED_AFTER);
		expect(occurrence.active).toBe(false);
		expect(occurrence.start).toBe(Date.parse("2026-09-10T13:00:00Z"));
	});

	it("skips the weekend for a weekdays-only window", () => {
		const occurrence = resolvePeakOccurrence(ANTHROPIC_PEAK_WINDOW, SATURDAY);
		expect(occurrence.active).toBe(false);
		// Monday 2026-09-14, not Sunday.
		expect(occurrence.start).toBe(Date.parse("2026-09-14T13:00:00Z"));
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
		// 13:00–19:00 UTC is 15:00–21:00 in Malta during CEST.
		expect(formatPeakRange(occurrence, MALTA)).toBe("15:00–21:00");
	});

	it("renders the same window differently in New York", () => {
		const occurrence = resolvePeakOccurrence(ANTHROPIC_PEAK_WINDOW, WED_INSIDE);
		// 13:00–19:00 UTC is 9:00 AM–3:00 PM in New York during EDT.
		expect(formatPeakRange(occurrence, NEW_YORK)).toBe("9:00 AM–3:00 PM");
	});

	it("renders the Zai window in Malta's local clock", () => {
		const occurrence = resolvePeakOccurrence(ZAI_PEAK_WINDOW, SATURDAY_ZAI);
		// 06:00–10:00 UTC is 08:00–12:00 in Malta during CEST.
		expect(formatPeakRange(occurrence, MALTA)).toBe("8:00–12:00");
	});

	it("follows the viewer's own DST change, not a fixed offset", () => {
		// Same UTC window in January, when Malta is on CET rather than CEST.
		const winter = Date.parse("2027-01-13T14:30:00Z");
		const occurrence = resolvePeakOccurrence(ANTHROPIC_PEAK_WINDOW, winter);
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
		expect(label.text).toBe("Peak hours 15:00–21:00");
		expect(label.countdown).toBe("ends in 4h 30m");
		expect(label.title).toBe("Peak hours 15:00–21:00 · ends in 4h 30m");
	});

	it("counts down to the start when off-peak later the same day", () => {
		const label = peakHoursLabel(ANTHROPIC_PEAK_WINDOW, WED_BEFORE, MALTA);
		expect(label.active).toBe(false);
		expect(label.text).toBe("Off-peak · next peak 15:00–21:00");
		expect(label.countdown).toBe("in 4h");
	});

	it("names the next weekday when the wait crosses the weekend", () => {
		const label = peakHoursLabel(ANTHROPIC_PEAK_WINDOW, SATURDAY, MALTA);
		expect(label.active).toBe(false);
		expect(label.text).toBe("Off-peak · next peak Mon 15:00–21:00");
		expect(label.countdown).toBe("in 2d 3h");
	});

	it("localizes the Zai window too, with no weekend gap", () => {
		const label = peakHoursLabel(ZAI_PEAK_WINDOW, SATURDAY_ZAI, MALTA);
		expect(label.active).toBe(true);
		expect(label.text).toBe("Peak hours 8:00–12:00");
		expect(label.countdown).toBe("ends in 2h");
	});
});
