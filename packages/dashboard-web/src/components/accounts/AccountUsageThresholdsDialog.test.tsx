import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account } from "../../api";
import {
	getThresholdLabels,
	ThresholdRow,
} from "./AccountUsageThresholdsDialog";

const baseAccount: Account = {
	id: "account-1",
	name: "test-account",
	provider: "anthropic",
	requestCount: 0,
	totalRequests: 0,
	lastUsed: null,
	created: new Date(0).toISOString(),
	paused: false,
	requiresReauth: false,
	pauseReason: null,
	tokenStatus: "valid",
	tokenExpiresAt: null,
	rateLimitStatus: "OK",
	rateLimitReset: null,
	rateLimitRemaining: null,
	rateLimitedUntil: null,
	rateLimitedReason: null,
	rateLimitedAt: null,
	sessionInfo: "No active session",
	priority: 1,
	autoFallbackEnabled: true,
	autoRefreshEnabled: true,
	usagePauseFiveHourThreshold: null,
	usagePauseWeeklyThreshold: null,
	usagePauseFiveHourEnabled: false,
	usagePauseWeeklyEnabled: false,
	usagePauseFiveHourMinResetRemainingMs: null,
	usagePauseWeeklyMinResetRemainingMs: null,
	customEndpoint: null,
	modelMappings: null,
	requestTransformer: null,
	usageUtilization: null,
	usageWindow: null,
	usageData: null,
	usageRateLimitedUntil: null,
	usageThrottledUntil: null,
	usageThrottledWindows: [],
	hasRefreshToken: false,
	sessionStats: null,
	isPrimary: false,
	lastManualReauthAt: null,
	reauthDeadlineStatus: null,
	daysUntilReauthRequired: null,
	hoursUntilReauthRequired: null,
	renewalDay: null,
	nextRenewalAt: null,
	daysUntilRenewal: null,
};

describe("getThresholdLabels", () => {
	it("labels the windows Daily and Monthly for nanogpt accounts", () => {
		const labels = getThresholdLabels({ ...baseAccount, provider: "nanogpt" });

		expect(labels).toEqual({ fiveHourLabel: "Daily", weeklyLabel: "Monthly" });
	});

	it("keeps the 5-hour and Weekly labels for other providers", () => {
		expect(
			getThresholdLabels({ ...baseAccount, provider: "anthropic" }),
		).toEqual({ fiveHourLabel: "5-hour", weeklyLabel: "Weekly" });

		expect(getThresholdLabels({ ...baseAccount, provider: "zai" })).toEqual({
			fiveHourLabel: "5-hour",
			weeklyLabel: "Weekly",
		});
	});

	it("keeps the 5-hour and Weekly labels when there is no account", () => {
		expect(getThresholdLabels(null)).toEqual({
			fiveHourLabel: "5-hour",
			weeklyLabel: "Weekly",
		});
	});
});

describe("the xAI rows (SB23-3686)", () => {
	it("labels the weekly row Grok credits for xAI accounts", () => {
		expect(getThresholdLabels({ ...baseAccount, provider: "xai" })).toEqual({
			fiveHourLabel: "5-hour",
			weeklyLabel: "Grok credits",
		});
	});

	it("renders an unavailable row switched off with its reason and no fields", () => {
		const html = renderToStaticMarkup(
			<ThresholdRow
				id="usage-threshold-5h"
				label="5-hour"
				draft={{ enabled: true, percent: "50", minResetHours: "" }}
				onDraftChange={() => {}}
				unavailableReason="xAI reports one usage window, Grok Build credits, and no 5-hour window, so there is nothing here to pause on."
			/>,
		);

		expect(html).toContain("data-window-unavailable");
		expect(html).toContain(
			"Unavailable: xAI reports one usage window, Grok Build credits, and no 5-hour window",
		);
		expect(html).toContain("disabled");
		expect(html).not.toContain('id="usage-threshold-5h"');
		expect(html).not.toContain("Account usage is at or above");
	});

	it("renders an available row with its fields", () => {
		const html = renderToStaticMarkup(
			<ThresholdRow
				id="usage-threshold-weekly"
				label="Grok credits"
				draft={{ enabled: true, percent: "80", minResetHours: "" }}
				onDraftChange={() => {}}
			/>,
		);

		expect(html).toContain("Grok credits window");
		expect(html).toContain('id="usage-threshold-weekly"');
		expect(html).not.toContain("data-window-unavailable");
	});
});
