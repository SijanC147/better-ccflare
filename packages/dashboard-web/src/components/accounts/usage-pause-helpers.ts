import { MAX_MIN_RESET_REMAINING_MS } from "@better-ccflare/types";
import type { Account } from "../../api";
import {
	formatHoursForSummary,
	MAX_RESET_HOURS,
	msToHoursInput,
	type ParsedField,
	parseHoursField,
} from "../combos/slot-throttle-helpers";

// The reset field is the combo slot popover's field, so it reuses that field's
// parser, renderer and ceiling rather than a copy (SB23-2575).
export { MAX_RESET_HOURS };

/** One window's conditions as stored, and as the API takes them. */
export interface UsagePauseWindowSetting {
	enabled: boolean;
	percent: number | null;
	minResetRemainingMs: number | null;
}

/** One window as the dialog edits it: the switch, and the two fields as typed. */
export interface UsagePauseWindowDraft {
	enabled: boolean;
	percent: string;
	minResetHours: string;
}

export function draftFromSetting(
	setting: UsagePauseWindowSetting,
): UsagePauseWindowDraft {
	return {
		enabled: setting.enabled,
		percent: setting.percent === null ? "" : String(setting.percent),
		minResetHours: msToHoursInput(setting.minResetRemainingMs),
	};
}

/**
 * The account percent: a whole number from 1 to 100, unlike the slot's 0 to
 * 100. 0 is refused here because a pause at 0 percent benches the account on
 * its first poll, which `parseUsagePauseThreshold` refuses on the server too.
 */
export function parsePausePercentField(raw: string): ParsedField {
	if (raw.trim().length === 0) return null;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1 || value > 100) return "invalid";
	return value;
}

/**
 * The slot field's hours parser, bounded at the handler's own ceiling.
 * `parseHoursField` stops at `Number.MAX_SAFE_INTEGER` milliseconds, which is
 * a fraction of an hour above `MAX_MIN_RESET_REMAINING_MS`, so a value in that
 * sliver would pass the form and come back from the server as a 400.
 */
export function parsePauseResetHoursField(raw: string): ParsedField {
	const ms = parseHoursField(raw);
	if (typeof ms === "number" && ms > MAX_MIN_RESET_REMAINING_MS) {
		return "invalid";
	}
	return ms;
}

export type UsagePauseWindowError =
	| "invalid-percent"
	| "invalid-reset"
	| "on-without-condition";

export interface UsagePauseWindowValidation {
	percent: ParsedField;
	resetMs: ParsedField;
	error: UsagePauseWindowError | null;
}

export function validateWindowDraft(
	draft: UsagePauseWindowDraft,
): UsagePauseWindowValidation {
	const percent = parsePausePercentField(draft.percent);
	const resetMs = parsePauseResetHoursField(draft.minResetHours);
	let error: UsagePauseWindowError | null = null;
	if (percent === "invalid") error = "invalid-percent";
	else if (resetMs === "invalid") error = "invalid-reset";
	// A window switched on with no condition would pause at nothing; the
	// handler refuses it with a 400, so say so here first.
	else if (draft.enabled && percent === null && resetMs === null) {
		error = "on-without-condition";
	}
	return { percent, resetMs, error };
}

/** The setting to send, or null while the draft has an error. */
export function settingFromDraft(
	draft: UsagePauseWindowDraft,
): UsagePauseWindowSetting | null {
	const { percent, resetMs, error } = validateWindowDraft(draft);
	if (error !== null) return null;
	return {
		enabled: draft.enabled,
		percent: percent as number | null,
		minResetRemainingMs: resetMs as number | null,
	};
}

/**
 * One line naming a window's configured conditions, in the slot row's summary
 * wording (`describeSlotThrottle`), or null when the window pauses on nothing.
 */
export function describeUsagePauseWindow(
	label: string,
	setting: UsagePauseWindowSetting,
): string | null {
	if (!setting.enabled) return null;
	const clauses: string[] = [];
	if (setting.percent !== null) clauses.push(`usage >= ${setting.percent}%`);
	if (setting.minResetRemainingMs !== null) {
		clauses.push(
			`reset >= ${formatHoursForSummary(setting.minResetRemainingMs)}h away`,
		);
	}
	if (clauses.length === 0) return null;
	return `${label} window when ${clauses.join(" and ")}`;
}

/** The stored settings for one window, as the dialog seeds them. */
export function storedWindowSettings(account: Account | null): {
	fiveHour: UsagePauseWindowSetting;
	weekly: UsagePauseWindowSetting;
} {
	return {
		fiveHour: {
			enabled: account?.usagePauseFiveHourEnabled ?? false,
			percent: account?.usagePauseFiveHourThreshold ?? null,
			minResetRemainingMs:
				account?.usagePauseFiveHourMinResetRemainingMs ?? null,
		},
		weekly: {
			enabled: account?.usagePauseWeeklyEnabled ?? false,
			percent: account?.usagePauseWeeklyThreshold ?? null,
			minResetRemainingMs: account?.usagePauseWeeklyMinResetRemainingMs ?? null,
		},
	};
}

/**
 * Labels for the two threshold rows. The underlying fields (`fiveHour` /
 * `weekly`) and everything they save stay the same for every provider — this
 * only changes what the rows are called, because for NanoGPT accounts those
 * same two slots govern NanoGPT's daily and monthly usage windows instead of
 * a 5-hour/weekly one.
 */
export function getThresholdLabels(account: Account | null): {
	fiveHourLabel: string;
	weeklyLabel: string;
} {
	const isNanoGpt = account?.provider === "nanogpt";
	return {
		fiveHourLabel: isNanoGpt ? "Daily" : "5-hour",
		weeklyLabel: isNanoGpt ? "Monthly" : "Weekly",
	};
}
