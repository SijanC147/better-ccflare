/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account } from "../../api";
import { AccountListItem } from "./AccountListItem";
import {
	type AccountMenuHandlers,
	accountMenuActions,
	accountMenuToggles,
} from "./account-menu-items";

/** Every optional callback supplied, so the item list is decided by the account. */
const allHandlers: AccountMenuHandlers = {
	renewalDay: true,
	customEndpoint: true,
	modelMappings: true,
	requestTransformer: true,
	autoPauseOnOverage: true,
	peakHoursPause: true,
	qwenReauth: true,
	anthropicReauth: true,
	codexReauth: true,
};

const baseAccount: Account = {
	id: "account-1",
	name: "test-account",
	provider: "anthropic",
	requestCount: 0,
	totalRequests: 0,
	lastUsed: null,
	created: new Date(0).toISOString(),
	paused: true,
	requiresReauth: false,
	pauseReason: "overage",
	tokenStatus: "expired",
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
	customEndpoint: null,
	modelMappings: null,
	requestTransformer: null,
	usageUtilization: null,
	usageWindow: null,
	usageData: null,
	usageRateLimitedUntil: null,
	usageThrottledUntil: null,
	usageThrottledWindows: [],
	hasRefreshToken: true,
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

function renderAccount(
	account: Account,
	onRequestTransformerChange?: (account: Account) => void,
): string {
	return renderToStaticMarkup(
		<AccountListItem
			account={account}
			onPauseToggle={() => {}}
			onForceResetRateLimit={() => {}}
			onRefreshUsage={async () => {}}
			onRemove={() => {}}
			onRename={() => {}}
			onPriorityChange={() => {}}
			onAutoFallbackToggle={() => {}}
			onAutoRefreshToggle={() => {}}
			onBillingTypeToggle={() => {}}
			onAnthropicReauth={() => {}}
			onRequestTransformerChange={onRequestTransformerChange}
		/>,
	);
}

describe("AccountListItem", () => {
	it("shows Needs authentication only when requiresReauth is true", () => {
		const healthyHtml = renderAccount(baseAccount);
		const requiresReauthHtml = renderAccount({
			...baseAccount,
			requiresReauth: true,
		});

		expect(healthyHtml).not.toContain("Needs authentication");
		expect(requiresReauthHtml).toContain("Needs authentication");
		expect(requiresReauthHtml).toContain(
			"Refresh token invalid — re-authenticate",
		);
		expect(requiresReauthHtml).not.toContain("Paused (overage)");
	});

	it("shows a human-readable pause reason when re-authentication is not required", () => {
		const html = renderAccount({
			...baseAccount,
			pauseReason: "failure_threshold",
		});

		expect(html).toContain("Paused (failure threshold)");
	});

	it("shows no reauth-deadline badge when the status is ok or null", () => {
		expect(renderAccount(baseAccount)).not.toContain("Reauth in");
		expect(
			renderAccount({
				...baseAccount,
				reauthDeadlineStatus: "ok",
				daysUntilReauthRequired: 10,
				hoursUntilReauthRequired: 240,
			}),
		).not.toContain("Reauth in");
	});

	it("shows the reauth-deadline badge in days when 24h or more remain", () => {
		const html = renderAccount({
			...baseAccount,
			reauthDeadlineStatus: "warning",
			daysUntilReauthRequired: 3,
			hoursUntilReauthRequired: 60,
		});

		expect(html).toContain("Reauth in 3d");
	});

	it("shows the reauth-deadline badge in hours once under 24h, even at warning tier", () => {
		const html = renderAccount({
			...baseAccount,
			reauthDeadlineStatus: "warning",
			daysUntilReauthRequired: 1,
			hoursUntilReauthRequired: 22,
		});

		expect(html).toContain("Reauth in 22h");
		expect(html).not.toContain("Reauth in 1d");
	});

	it("shows the reauth-deadline badge in hours at critical tier", () => {
		const html = renderAccount({
			...baseAccount,
			reauthDeadlineStatus: "critical",
			daysUntilReauthRequired: 1,
			hoursUntilReauthRequired: 6,
		});

		expect(html).toContain("Reauth in 6h");
	});

	it("hides the reauth-deadline badge when the account already requires authentication", () => {
		const html = renderAccount({
			...baseAccount,
			requiresReauth: true,
			reauthDeadlineStatus: "critical",
			daysUntilReauthRequired: 1,
			hoursUntilReauthRequired: 6,
		});

		expect(html).not.toContain("Reauth in");
	});

	it("shows an overdue badge when the deadline has already passed", () => {
		const html = renderAccount({
			...baseAccount,
			reauthDeadlineStatus: "expired",
			daysUntilReauthRequired: -2,
			hoursUntilReauthRequired: -48,
		});

		expect(html).toContain("Reauth overdue by 2d");
	});

	it("hides the reauth-deadline badge when the account already requires authentication, even when expired", () => {
		const html = renderAccount({
			...baseAccount,
			requiresReauth: true,
			reauthDeadlineStatus: "expired",
			daysUntilReauthRequired: -2,
			hoursUntilReauthRequired: -48,
		});

		expect(html).not.toContain("Reauth overdue");
	});

	// The request transformer control moved into the overflow menu. Radix renders
	// a closed DropdownMenuContent as nothing under renderToStaticMarkup, so the
	// two assertions below are split: the card's markup proves the control left
	// the visible row, and accountMenuActions proves it is in the menu with the
	// right configured state. Asserting the menu's markup would be vacuous.
	it("no longer renders the request transformer button in the visible card", () => {
		const html = renderAccount(
			{ ...baseAccount, provider: "openai-compatible" },
			() => {},
		);

		expect(html).not.toContain('aria-label="Configure request transformer"');
		expect(html).not.toContain("lucide-replace");
	});

	it("puts the request transformer in the menu only for openai-compatible accounts", () => {
		const openAICompatible = accountMenuActions(
			{ ...baseAccount, provider: "openai-compatible" },
			allHandlers,
		);
		const anthropicCompatible = accountMenuActions(
			{ ...baseAccount, provider: "anthropic-compatible" },
			allHandlers,
		);

		expect(openAICompatible.map((action) => action.id)).toContain(
			"request-transformer",
		);
		expect(anthropicCompatible.map((action) => action.id)).not.toContain(
			"request-transformer",
		);
	});

	it("omits the request transformer when the parent supplied no handler", () => {
		const actions = accountMenuActions(
			{ ...baseAccount, provider: "openai-compatible" },
			{ ...allHandlers, requestTransformer: false },
		);

		expect(actions.map((action) => action.id)).not.toContain(
			"request-transformer",
		);
	});

	it("marks the request transformer configured only when one is set", () => {
		const disabled = accountMenuActions(
			{ ...baseAccount, provider: "openai-compatible" },
			allHandlers,
		);
		const enabled = accountMenuActions(
			{
				...baseAccount,
				provider: "openai-compatible",
				requestTransformer: "max-tokens-to-max-completion-tokens",
			},
			allHandlers,
		);

		expect(
			disabled.find((action) => action.id === "request-transformer")
				?.configured,
		).toBe(false);
		expect(
			enabled.find((action) => action.id === "request-transformer")?.configured,
		).toBe(true);
	});

	it("renders an overflow menu trigger with an accessible name", () => {
		const html = renderAccount(baseAccount);

		// aria-haspopup proves Radix mounted the trigger rather than a bare button.
		expect(html).toContain('aria-haspopup="menu"');
		expect(html).toContain("More actions for test-account");
		expect(html).toContain("lucide-ellipsis");
	});

	it("moves Remove and the setup actions out of the visible card", () => {
		const html = renderAccount(baseAccount);

		expect(html).not.toContain("lucide-trash2");
		expect(html).not.toContain("lucide-edit-2");
		expect(html).not.toContain("lucide-zap");
	});

	it("keeps Pause and Refresh usage visible with accessible names", () => {
		const html = renderAccount(baseAccount);

		expect(html).toContain('aria-label="Resume account"');
		expect(html).toContain('aria-label="Refresh usage data"');
	});

	it("puts the auto-behaviour switches in the menu with their current state", () => {
		const toggles = accountMenuToggles(
			{ ...baseAccount, autoFallbackEnabled: true, autoRefreshEnabled: false },
			allHandlers,
		);
		const byId = new Map(toggles.map((toggle) => [toggle.id, toggle]));

		expect(byId.get("auto-fallback")?.checked).toBe(true);
		expect(byId.get("auto-refresh")?.checked).toBe(false);
		// Anthropic gets the overage toggle; zai's peak-hours toggle must not leak.
		expect(byId.has("auto-pause-on-overage")).toBe(true);
		expect(byId.has("peak-hours-pause")).toBe(false);
	});

	it("renders no switch labels in the visible card", () => {
		const html = renderAccount(baseAccount);

		expect(html).not.toContain("Auto-fallback:");
		expect(html).not.toContain("Auto-refresh:");
	});

	it("offers one re-authenticate action per provider, never two", () => {
		const anthropic = accountMenuActions(baseAccount, allHandlers).filter(
			(action) => action.id === "reauth",
		);
		const codex = accountMenuActions(
			{ ...baseAccount, provider: "codex" },
			allHandlers,
		).filter((action) => action.id === "reauth");
		const withoutRefreshToken = accountMenuActions(
			{ ...baseAccount, hasRefreshToken: false },
			allHandlers,
		).filter((action) => action.id === "reauth");

		expect(anthropic).toHaveLength(1);
		expect(anthropic[0]?.title).toContain("Anthropic");
		expect(codex).toHaveLength(1);
		expect(codex[0]?.title).toContain("Codex");
		// An Anthropic account with no refresh token has nothing to re-authenticate.
		expect(withoutRefreshToken).toHaveLength(0);
	});

	it("shows no renewal badge when the account has no renewal day", () => {
		// An unset day is not day 1. Rendering nothing is the point: a countdown
		// invented from a default would be a billing date the operator never gave.
		expect(renderAccount(baseAccount)).not.toContain("Renews");
	});

	it("shows a renewal badge for an account with a renewal day", () => {
		const html = renderAccount({ ...baseAccount, renewalDay: 15 });

		expect(html).toContain("Renews");
	});

	it("renders the badge from renewalDay, not from the server's countdown", () => {
		// nextRenewalAt and daysUntilRenewal arrive UTC-anchored. The component
		// recomputes in the viewer's zone, so a deliberately absurd server
		// countdown must not reach the badge.
		const html = renderAccount({
			...baseAccount,
			renewalDay: 15,
			nextRenewalAt: "1999-01-01",
			daysUntilRenewal: 9999,
		});

		expect(html).not.toContain("9999");
		expect(html).not.toContain("1999");
	});
});
