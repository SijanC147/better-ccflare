/**
 * Provider peak-hours windows and the per-account pause decision built on
 * them.
 *
 * Kept in its own module, free of scheduler dependencies, because the peak
 * state is read from three places: the scheduler's auto-pause, the
 * /api/accounts listing, and the per-request summary (REST and live SSE) that
 * the dashboard badges. Importing it from auto-refresh-scheduler would drag
 * the whole scheduler into the usage collector's import graph.
 */
import { isChinesePublicHoliday } from "./chinese-holidays";

export function isZaiPeakHour(ts = Date.now()): boolean {
	const d = new Date(ts);
	const sgtDayMs = d.getTime() + 8 * 60 * 60 * 1000;
	const sgtDay = new Date(sgtDayMs).getUTCDay();
	if (sgtDay === 0 || sgtDay === 6) return false;
	const sgtHour = (d.getUTCHours() + d.getUTCMinutes() / 60 + 8) % 24;
	return sgtHour >= 14 && sgtHour < 18;
}

/**
 * DeepSeek peak hours: 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday,
 * excluding Chinese public holidays. Both windows fall on the same UTC and
 * Beijing calendar day (09:00-12:00 / 14:00-18:00 CST), so the UTC date is
 * used for the weekday and holiday checks.
 */
export function isDeepseekPeakHour(ts = Date.now()): boolean {
	const d = new Date(ts);
	const day = d.getUTCDay();
	if (day === 0 || day === 6) return false;
	const date = d.toISOString().slice(0, 10);
	if (isChinesePublicHoliday(date)) return false;
	const utcHour = d.getUTCHours() + d.getUTCMinutes() / 60;
	return (utcHour >= 1 && utcHour < 4) || (utcHour >= 6 && utcHour < 10);
}

/**
 * Wall-clock weekday and hour in Los Angeles. `hourCycle: "h23"` so midnight
 * reads 0, never 24.
 */
const LOS_ANGELES_CLOCK = new Intl.DateTimeFormat("en-US", {
	timeZone: "America/Los_Angeles",
	weekday: "short",
	hour: "numeric",
	minute: "numeric",
	hourCycle: "h23",
});

/**
 * Anthropic OAuth peak hours: weekdays 5am-11am in Los Angeles, the vendor's
 * own timezone and its own weekend. That is 12:00-18:00 UTC while PDT is in
 * effect and 13:00-19:00 UTC the rest of the year. During these windows 5-hour
 * sessions consume a larger share of the weekly budget. Informational only:
 * not part of the peak-hours auto-pause.
 *
 * Upstream states this as a fixed 13:00-19:00 UTC, which is an hour late
 * through PDT; the fork fixed that in the dashboard in #93 (SB23-1867), and the
 * 2026-10-16 sync brings the same rule here (moved into peak-hours.ts with
 * upstream's 2026-11 split) because this now feeds `peakHours`
 * on /api/accounts (SB23-8195). Keep in sync with ANTHROPIC_PEAK_WINDOW in
 * packages/dashboard-web/src/utils/provider-utils.ts.
 */
export function isAnthropicPeakHour(ts = Date.now()): boolean {
	const parts = LOS_ANGELES_CLOCK.formatToParts(new Date(ts));
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((p) => p.type === type)?.value ?? "";
	const weekday = part("weekday");
	if (weekday === "Sat" || weekday === "Sun") return false;
	const hour = Number(part("hour")) + Number(part("minute")) / 60;
	return hour >= 5 && hour < 11;
}

/** Providers whose accounts support opt-in peak-hours auto-pause. */
export const PEAK_HOUR_CHECKS: Record<string, (ts?: number) => boolean> = {
	zai: isZaiPeakHour,
	deepseek: isDeepseekPeakHour,
};

/**
 * Server-side peak-hours state for an account's provider, served on
 * /api/accounts and on every request summary so the dashboard never
 * recomputes it. Uses the same check functions as the scheduler's
 * peak-hours auto-pause. `null` for providers without a peak concept.
 */
export function getPeakHoursState(
	provider: string | null | undefined,
	ts = Date.now(),
): { active: boolean } | null {
	// Own-property lookup: "__proto__"/"constructor" must not hit inherited props
	const key = provider ?? "";
	const check =
		key === "anthropic"
			? isAnthropicPeakHour
			: Object.hasOwn(PEAK_HOUR_CHECKS, key)
				? PEAK_HOUR_CHECKS[key]
				: undefined;
	return check ? { active: check(ts) } : null;
}
