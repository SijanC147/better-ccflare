import {
	type UsagePauseWindow,
	usagePauseWindowsForProvider,
} from "@better-ccflare/core";
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
 *
 * xAI's weekly slot holds its one Grok Build credits window (SB23-3686), and
 * is labelled by what that window is rather than by a period: the fetcher
 * decodes a reset time but no period, so "Weekly" would claim more than the
 * code knows. The same words the usage bar prints for that row.
 */
export function getThresholdLabels(account: Account | null): {
	fiveHourLabel: string;
	weeklyLabel: string;
} {
	if (account?.provider === "xai") {
		return { fiveHourLabel: "5-hour", weeklyLabel: "Grok credits" };
	}
	const isNanoGpt = account?.provider === "nanogpt";
	return {
		fiveHourLabel: isNanoGpt ? "Daily" : "5-hour",
		weeklyLabel: isNanoGpt ? "Monthly" : "Weekly",
	};
}

/**
 * Why a window cannot carry a pause on this account, or null when it can.
 *
 * The windows come from core's `usagePauseWindowsForProvider`, the same list
 * the poller filters on, so the dialog cannot offer a window the server would
 * then ignore.
 */
export function unavailableWindowReason(
	account: Pick<Account, "provider"> | null,
	window: UsagePauseWindow,
): string | null {
	if (usagePauseWindowsForProvider(account?.provider).includes(window)) {
		return null;
	}
	if (account?.provider === "xai") {
		return "xAI reports one usage window, Grok Build credits, and no 5-hour window, so there is nothing here to pause on.";
	}
	return "This provider does not report this window, so there is nothing here to pause on.";
}

/**
 * The stored settings with every window this account cannot report switched
 * off, numbers kept: what the overflow summary names and what the dialog
 * saves, so neither promises a pause the poller will never make.
 */
export function reportableWindowSettings(account: Account | null): {
	fiveHour: UsagePauseWindowSetting;
	weekly: UsagePauseWindowSetting;
} {
	const { fiveHour, weekly } = storedWindowSettings(account);
	return {
		fiveHour: reportableWindowSetting(account?.provider, "five_hour", fiveHour),
		weekly: reportableWindowSetting(account?.provider, "weekly", weekly),
	};
}

/** One window's setting, switched off when the provider cannot report it. */
export function reportableWindowSetting(
	provider: string | null | undefined,
	window: UsagePauseWindow,
	setting: UsagePauseWindowSetting,
): UsagePauseWindowSetting {
	return usagePauseWindowsForProvider(provider).includes(window)
		? setting
		: { ...setting, enabled: false };
}
