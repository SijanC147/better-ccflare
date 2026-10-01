import { describe, expect, it } from "bun:test";
import { MAX_MIN_RESET_REMAINING_MS, MS_PER_HOUR } from "@better-ccflare/types";
import type { Account } from "../../api";
import {
	type AccountMenuHandlers,
	accountMenuActions,
} from "./account-menu-items";
import {
	describeUsagePauseWindow,
	draftFromSetting,
	getThresholdLabels,
	initialDialogDrafts,
	MAX_RESET_HOURS,
	parsePauseResetHoursField,
	reportableWindowSettings,
	settingFromDraft,
	storedWindowSettings,
	unavailableWindowReason,
	validateWindowDraft,
} from "./usage-pause-helpers";

describe("usage pause dialog round-trip (SB23-2575)", () => {
	it("a stored setting renders into the form and saves back unchanged", () => {
		for (const stored of [
			{ enabled: true, percent: 80, minResetRemainingMs: 2 * MS_PER_HOUR },
			{ enabled: true, percent: null, minResetRemainingMs: 0 },
			{ enabled: false, percent: 90, minResetRemainingMs: null },
			// Not a whole number of hours: msToHoursInput renders it exactly so it
			// cannot come back rounded.
			{ enabled: true, percent: null, minResetRemainingMs: 60_000 },
		]) {
			expect(settingFromDraft(draftFromSetting(stored))).toStrictEqual(stored);
		}
	});

	it("reads the account's own columns, the reset minimums included", () => {
		const account = {
			usagePauseFiveHourEnabled: true,
			usagePauseFiveHourThreshold: null,
			usagePauseFiveHourMinResetRemainingMs: 3 * MS_PER_HOUR,
			usagePauseWeeklyEnabled: false,
			usagePauseWeeklyThreshold: 75,
			usagePauseWeeklyMinResetRemainingMs: 24 * MS_PER_HOUR,
		} as Account;
		expect(storedWindowSettings(account)).toStrictEqual({
			fiveHour: {
				enabled: true,
				percent: null,
				minResetRemainingMs: 3 * MS_PER_HOUR,
			},
			weekly: {
				enabled: false,
				percent: 75,
				minResetRemainingMs: 24 * MS_PER_HOUR,
			},
		});
	});

	it("takes hours and sends milliseconds", () => {
		expect(
			settingFromDraft({ enabled: true, percent: "", minResetHours: "1.5" }),
		).toStrictEqual({
			enabled: true,
			percent: null,
			minResetRemainingMs: 1.5 * MS_PER_HOUR,
		});
	});
});

describe("usage pause dialog validation (SB23-2575)", () => {
	it("refuses a window switched on with neither condition", () => {
		expect(
			validateWindowDraft({ enabled: true, percent: "", minResetHours: "" })
				.error,
		).toBe("on-without-condition");
		expect(
			settingFromDraft({ enabled: true, percent: " ", minResetHours: "" }),
		).toBeNull();
	});

	it("allows a switched-off window with neither condition", () => {
		expect(
			settingFromDraft({ enabled: false, percent: "", minResetHours: "" }),
		).toStrictEqual({
			enabled: false,
			percent: null,
			minResetRemainingMs: null,
		});
	});

	it("keeps the account percent at 1 to 100, refusing the slot's 0", () => {
		expect(
			validateWindowDraft({ enabled: true, percent: "0", minResetHours: "" })
				.error,
		).toBe("invalid-percent");
		expect(
			validateWindowDraft({ enabled: true, percent: "101", minResetHours: "" })
				.error,
		).toBe("invalid-percent");
	});

	it("bounds the hours at the handler's ceiling, not just at MAX_SAFE_INTEGER", () => {
		expect(parsePauseResetHoursField(String(MAX_RESET_HOURS))).toBe(
			MAX_MIN_RESET_REMAINING_MS,
		);
		// Half an hour above the ceiling still fits in a safe integer, so the
		// slot's parser alone would let it through to a 400.
		expect(parsePauseResetHoursField(String(MAX_RESET_HOURS + 0.5))).toBe(
			"invalid",
		);
		expect(parsePauseResetHoursField("-1")).toBe("invalid");
		expect(parsePauseResetHoursField("soon")).toBe("invalid");
		expect(parsePauseResetHoursField("")).toBeNull();
	});
});

describe("usage pause summaries (SB23-2575)", () => {
	it("names only the configured conditions, in the slot row's wording", () => {
		expect(
			describeUsagePauseWindow("5-hour", {
				enabled: true,
				percent: 80,
				minResetRemainingMs: 2 * MS_PER_HOUR,
			}),
		).toBe("5-hour window when usage >= 80% and reset >= 2h away");
		expect(
			describeUsagePauseWindow("Weekly", {
				enabled: true,
				percent: null,
				minResetRemainingMs: 36 * MS_PER_HOUR,
			}),
		).toBe("Weekly window when reset >= 36h away");
		expect(
			describeUsagePauseWindow("Weekly", {
				enabled: false,
				percent: 90,
				minResetRemainingMs: null,
			}),
		).toBeNull();
	});

	it("marks a reset-only account as configured in the card menu", () => {
		const account = {
			id: "a",
			name: "a",
			provider: "anthropic",
			usagePauseFiveHourEnabled: true,
			usagePauseFiveHourThreshold: null,
			usagePauseFiveHourMinResetRemainingMs: 2 * MS_PER_HOUR,
			usagePauseWeeklyEnabled: false,
			usagePauseWeeklyThreshold: null,
			usagePauseWeeklyMinResetRemainingMs: null,
		} as Account;
		const item = accountMenuActions(account, {
			usageThresholds: true,
		} as AccountMenuHandlers).find(
			(action) => action.id === "usage-thresholds",
		);
		expect(item?.configured).toBe(true);
		expect(item?.title).toBe(
			"Pauses on the 5-hour window when reset >= 2h away",
		);
	});
});

describe("xAI windows in the dashboard (SB23-3686)", () => {
	const xai = {
		id: "x",
		name: "x",
		provider: "xai",
		usagePauseFiveHourEnabled: true,
		usagePauseFiveHourThreshold: 50,
		usagePauseFiveHourMinResetRemainingMs: null,
		usagePauseWeeklyEnabled: true,
		usagePauseWeeklyThreshold: 80,
		usagePauseWeeklyMinResetRemainingMs: 24 * MS_PER_HOUR,
	} as Account;

	it("labels the weekly slot by what xAI reports, not by a period", () => {
		expect(getThresholdLabels(xai)).toStrictEqual({
			fiveHourLabel: "5-hour",
			weeklyLabel: "Grok credits",
		});
	});

	it("gives the xAI 5-hour window a reason and the credits window none", () => {
		expect(unavailableWindowReason(xai, "five_hour")).toBe(
			"xAI reports one usage window, Grok Build credits, and no 5-hour window, so there is nothing here to pause on.",
		);
		expect(unavailableWindowReason(xai, "weekly")).toBeNull();
	});

	it("leaves both windows available for every other provider", () => {
		for (const provider of [
			"anthropic",
			"codex",
			"zai",
			"nanogpt",
			"minimax",
		]) {
			const account = { ...xai, provider } as Account;
			expect(unavailableWindowReason(account, "five_hour")).toBeNull();
			expect(unavailableWindowReason(account, "weekly")).toBeNull();
		}
	});

	it("switches the xAI 5-hour window off and keeps its numbers", () => {
		expect(reportableWindowSettings(xai)).toStrictEqual({
			fiveHour: { enabled: false, percent: 50, minResetRemainingMs: null },
			weekly: storedWindowSettings(xai).weekly,
		});
	});

	// What Save sends for a stale 5-hour row: off, numbers kept, so the API's
	// refusal of an unreported window switched on is never reached.
	it("opens the dialog with the xAI 5-hour draft off and saves it that way", () => {
		const drafts = initialDialogDrafts(xai);
		expect(drafts.fiveHour).toStrictEqual({
			enabled: false,
			percent: "50",
			minResetHours: "",
		});
		expect(settingFromDraft(drafts.fiveHour)).toStrictEqual({
			enabled: false,
			percent: 50,
			minResetRemainingMs: null,
		});
		expect(settingFromDraft(drafts.weekly)).toStrictEqual(
			storedWindowSettings(xai).weekly,
		);
	});

	it("names only the credits window in the card menu summary", () => {
		const item = accountMenuActions(xai, {
			usageThresholds: true,
		} as AccountMenuHandlers).find(
			(action) => action.id === "usage-thresholds",
		);
		expect(item?.title).toBe(
			"Pauses on the Grok credits window when usage >= 80% and reset >= 24h away",
		);
	});
});
