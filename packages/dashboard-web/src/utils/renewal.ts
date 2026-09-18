import { computeNextRenewal, type RenewalStatus } from "@better-ccflare/types";

/**
 * Subscription renewal display (SB23-2055).
 *
 * The API also reports `nextRenewalAt` and `daysUntilRenewal`, computed in UTC
 * because the server has no viewer to ask. Those are correct for an API
 * consumer and wrong by up to a day for a person: a viewer at UTC+13 whose
 * local date is already the 16th would be shown a countdown measured from the
 * 15th. So the dashboard recomputes from `renewalDay`, which is the stored
 * fact, using the same helper with the browser's own zone.
 *
 * This mirrors the decision `#88` made for peak hours: the server stores and
 * sends an absolute value, and the zone is applied where the viewer is.
 */

/** The browser's IANA zone, or UTC where the runtime will not name one. */
export function viewerTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

/** Next renewal for an account, in the viewer's zone. null when none is set. */
export function viewerRenewal(
	renewalDay: number | null | undefined,
	now?: number,
): RenewalStatus | null {
	return computeNextRenewal({
		renewalDay,
		now,
		timeZone: viewerTimeZone(),
	});
}

/**
 * The short badge text, for example "Renews today" or "Renews in 12d".
 *
 * Singular for one day, because "in 1d" next to "today" reads as a bug. The
 * day count is a whole number of calendar days, so there is no rounding to
 * explain.
 */
export function formatRenewalBadge(renewal: RenewalStatus): string {
	if (renewal.daysUntilRenewal === 0) return "Renews today";
	if (renewal.daysUntilRenewal === 1) return "Renews tomorrow";
	return `Renews in ${renewal.daysUntilRenewal}d`;
}

/**
 * The date for the tooltip, written the long way so there is no ambiguity
 * between the day and the month. The value is a calendar date rather than an
 * instant, so it is formatted from its parts and never passed through a
 * timezone conversion that could move it.
 */
export function formatRenewalDate(renewal: RenewalStatus): string {
	const [year, month, day] = renewal.nextRenewalAt.split("-").map(Number);
	return new Intl.DateTimeFormat(undefined, {
		year: "numeric",
		month: "long",
		day: "numeric",
		timeZone: "UTC",
	}).format(new Date(Date.UTC(year, month - 1, day)));
}
