/**
 * Localized rendering of the provider peak-hour windows.
 *
 * The badge in RateLimitProgress used to read `Peak hours (5–11am PT, weekdays)`
 * and `Peak hours (14:00–18:00 SGT)`: fixed labels in timezones almost no viewer
 * is in. These helpers turn the same window definitions into the viewer's own
 * local time, plus a countdown to the next boundary.
 *
 * Everything here is pure and takes the timestamp, timezone and hour cycle as
 * arguments, so it can be tested against a pinned instant in a pinned zone.
 */
import type { PeakWindow } from "./provider-utils";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A weekly window always recurs within 8 days, even across a weekend skip. */
const MAX_LOOKAHEAD_DAYS = 8;

/** One concrete occurrence of a recurring window, as absolute instants. */
export interface PeakOccurrence {
	/** Start of the occurrence (epoch ms). */
	start: number;
	/** End of the occurrence (epoch ms), exclusive. */
	end: number;
	/** True when the reference timestamp falls inside this occurrence. */
	active: boolean;
}

/** The calendar and clock fields of `ts` as read in `timeZone`. */
interface ZonedParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

function zonedParts(ts: number, timeZone: string): ZonedParts {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		// `hour12: false` renders midnight as hour 24 in some engines; h23 does not.
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(new Date(ts));
	const read = (type: Intl.DateTimeFormatPartTypes): number =>
		Number(parts.find((part) => part.type === type)?.value);
	return {
		year: read("year"),
		month: read("month"),
		day: read("day"),
		hour: read("hour"),
		minute: read("minute"),
		second: read("second"),
	};
}

/**
 * The offset of `timeZone` at `ts`, in milliseconds: the zone's wall clock minus
 * UTC. `America/Los_Angeles` yields -7h on PDT and -8h otherwise.
 *
 * This is the only place the offset is ever produced, and it is always produced
 * for a specific instant. Writing `-7` or `-8` anywhere is the bug this module
 * was rewritten to remove.
 */
function zoneOffsetMs(ts: number, timeZone: string): number {
	const p = zonedParts(ts, timeZone);
	const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
	// The formatted parts carry no milliseconds, so compare against whole seconds.
	return asUtc - Math.floor(ts / 1000) * 1000;
}

/**
 * The instant at which `hour:00:00` strikes on the given calendar date in
 * `timeZone`.
 *
 * Two passes: the first guesses with the offset in force at the same wall clock
 * read as UTC, the second re-reads the offset at that guess. The pair disagree
 * only when a DST shift falls between them, and the second pass is what lands
 * the transition day on the right side of it.
 */
function instantAtZonedHour(
	year: number,
	monthIndex: number,
	day: number,
	hour: number,
	timeZone: string,
): number {
	const wallClockAsUtc = Date.UTC(year, monthIndex, day, hour);
	const firstPass = wallClockAsUtc - zoneOffsetMs(wallClockAsUtc, timeZone);
	return wallClockAsUtc - zoneOffsetMs(firstPass, timeZone);
}

/**
 * Resolve the occurrence of `window` that matters at `ts`: the one in progress
 * if the window is active, otherwise the next one to begin.
 *
 * Occurrences are built from calendar days in the window's own zone, and each
 * day's boundaries are resolved to absolute instants through that zone's offset
 * for that date. So a vendor-side DST change moves the occurrence against UTC,
 * exactly as it moves at the vendor, and the weekend skip lands on the vendor's
 * Saturday rather than UTC's.
 *
 * The viewer's timezone still only enters when formatting, so a DST change in
 * the viewer's zone shifts the displayed clock times independently.
 */
export function resolvePeakOccurrence(
	window: PeakWindow,
	ts: number,
): PeakOccurrence {
	const today = zonedParts(ts, window.timeZone);
	// A fake-UTC stand-in for the local calendar date. Day arithmetic on it is
	// pure calendar arithmetic: UTC has no DST, so adding DAY_MS always lands on
	// the next local date, and getUTCDay() reads the local weekday.
	const localDate = Date.UTC(today.year, today.month - 1, today.day);

	const boundaries = (dayOffset: number): { start: number; end: number } => {
		const date = new Date(localDate + dayOffset * DAY_MS);
		const [year, monthIndex, day] = [
			date.getUTCFullYear(),
			date.getUTCMonth(),
			date.getUTCDate(),
		];
		return {
			start: instantAtZonedHour(
				year,
				monthIndex,
				day,
				window.startHour,
				window.timeZone,
			),
			end: instantAtZonedHour(
				year,
				monthIndex,
				day,
				window.endHour,
				window.timeZone,
			),
		};
	};

	for (let offset = 0; offset <= MAX_LOOKAHEAD_DAYS; offset++) {
		if (window.weekdaysOnly) {
			const weekday = new Date(localDate + offset * DAY_MS).getUTCDay();
			if (weekday === 0 || weekday === 6) continue;
		}
		const { start, end } = boundaries(offset);
		if (ts < end) return { start, end, active: ts >= start };
	}

	// Unreachable for any window that occurs at least weekly; the loop above
	// covers a full week plus a day. Returning the lookahead edge keeps the
	// return type honest without throwing inside a render.
	return { ...boundaries(MAX_LOOKAHEAD_DAYS), active: false };
}

/**
 * Format a duration as a short countdown: `3d 4h`, `2h 15m`, `9m`, `< 1m`.
 * Only the two largest non-zero units are shown; that is enough to act on and
 * short enough to sit inside a badge.
 */
export function formatCountdown(ms: number): string {
	if (ms <= 0) return "now";
	const totalMinutes = Math.floor(ms / 60000);
	if (totalMinutes < 1) return "< 1m";
	const days = Math.floor(totalMinutes / (24 * 60));
	const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	return `${minutes}m`;
}

/** Options for rendering a window label. Defaults match the viewer's browser. */
export interface PeakLabelOptions {
	/** IANA zone, e.g. `Europe/Malta`. Defaults to the resolved local zone. */
	timeZone?: string;
	/** BCP-47 locale. Defaults to the resolved local locale. */
	locale?: string;
	/** Force a 12- or 24-hour clock. Defaults to the locale's own convention. */
	hour12?: boolean;
}

function timeFormatter(options: PeakLabelOptions): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat(options.locale, {
		hour: "numeric",
		minute: "2-digit",
		hour12: options.hour12,
		timeZone: options.timeZone,
	});
}

function sameLocalDay(
	a: number,
	b: number,
	options: PeakLabelOptions,
): boolean {
	const formatter = new Intl.DateTimeFormat("en-CA", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		timeZone: options.timeZone,
	});
	return formatter.format(new Date(a)) === formatter.format(new Date(b));
}

/**
 * Format an occurrence's clock range in the viewer's timezone, for example
 * `3:00–9:00 PM` becomes `15:00–21:00` on a 24-hour locale.
 */
export function formatPeakRange(
	occurrence: PeakOccurrence,
	options: PeakLabelOptions = {},
): string {
	const formatter = timeFormatter(options);
	return `${formatter.format(new Date(occurrence.start))}–${formatter.format(
		new Date(occurrence.end),
	)}`;
}

/**
 * Weekday prefix for an upcoming occurrence that does not start on the viewer's
 * current local day, so `9:00–15:00` is not mistaken for later today. Returns
 * an empty string when the occurrence starts today.
 */
export function formatPeakDayPrefix(
	occurrence: PeakOccurrence,
	ts: number,
	options: PeakLabelOptions = {},
): string {
	if (sameLocalDay(occurrence.start, ts, options)) return "";
	if (sameLocalDay(occurrence.start, ts + DAY_MS, options)) return "tomorrow ";
	const formatter = new Intl.DateTimeFormat(options.locale, {
		weekday: "short",
		timeZone: options.timeZone,
	});
	return `${formatter.format(new Date(occurrence.start))} `;
}

/** The badge text and the countdown that sits beside it. */
export interface PeakLabel {
	/** True when the window is in progress at `ts`. */
	active: boolean;
	/** Primary text, e.g. `Peak hours 15:00–21:00`. */
	text: string;
	/** Countdown to the next boundary, e.g. `ends in 2h 15m`. */
	countdown: string;
	/** Title attribute spelling both out for narrow layouts. */
	title: string;
}

/**
 * Build the full localized label for a window at a given instant.
 *
 * Active: `Peak hours 15:00–21:00` / `ends in 2h 15m`.
 * Otherwise: `Off-peak · next peak tomorrow 15:00–21:00` / `in 9h 40m`.
 */
export function peakHoursLabel(
	window: PeakWindow,
	ts: number,
	options: PeakLabelOptions = {},
): PeakLabel {
	const occurrence = resolvePeakOccurrence(window, ts);
	const range = formatPeakRange(occurrence, options);

	if (occurrence.active) {
		const countdown = `ends in ${formatCountdown(occurrence.end - ts)}`;
		const text = `Peak hours ${range}`;
		return {
			active: true,
			text,
			countdown,
			title: `${text} · ${countdown}`,
		};
	}

	const prefix = formatPeakDayPrefix(occurrence, ts, options);
	const countdown = `in ${formatCountdown(occurrence.start - ts)}`;
	const text = `Off-peak · next peak ${prefix}${range}`;
	return {
		active: false,
		text,
		countdown,
		title: `${text} · ${countdown}`,
	};
}

/** Read the dashboard's shared 24-hour clock preference, if one is stored. */
export function prefersTwentyFourHourClock(): boolean | undefined {
	try {
		return localStorage.getItem("ccflare-24h-time") === "true"
			? true
			: undefined;
	} catch {
		// Private browsing and SSR both throw here; fall back to the locale.
		return undefined;
	}
}
