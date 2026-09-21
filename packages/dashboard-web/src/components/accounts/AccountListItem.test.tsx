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
	type AccountMenuActionId,
	type AccountMenuHandlers,
	accountMenuActions,
	accountMenuToggles,
	bindAccountMenuHandlers,
	menuHandlersFrom,
} from "./account-menu-items";

/** Every optional callback supplied, so the item list is decided by the account. */
const allHandlers: AccountMenuHandlers = {
	renewalDay: true,
	customEndpoint: true,
	usageThresholds: true,
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
	usagePauseFiveHourThreshold: null,
	usagePauseWeeklyThreshold: null,
	usagePauseFiveHourEnabled: false,
	usagePauseWeeklyEnabled: false,
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
		// Each toggle is read in both positions. Asserting only the position the
		// fixture happens to carry passes against `checked: true` hardcoded, which
		// is a mutation that survived the first version of this test.
		const on = new Map(
			accountMenuToggles(
				{
					...baseAccount,
					autoFallbackEnabled: true,
					autoRefreshEnabled: true,
					autoPauseOnOverageEnabled: true,
				},
				allHandlers,
			).map((toggle) => [toggle.id, toggle]),
		);
		const off = new Map(
			accountMenuToggles(
				{
					...baseAccount,
					autoFallbackEnabled: false,
					autoRefreshEnabled: false,
					autoPauseOnOverageEnabled: false,
				},
				allHandlers,
			).map((toggle) => [toggle.id, toggle]),
		);

		expect(on.get("auto-fallback")?.checked).toBe(true);
		expect(off.get("auto-fallback")?.checked).toBe(false);
		expect(on.get("auto-refresh")?.checked).toBe(true);
		expect(off.get("auto-refresh")?.checked).toBe(false);
		expect(on.get("auto-pause-on-overage")?.checked).toBe(true);
		expect(off.get("auto-pause-on-overage")?.checked).toBe(false);
		// Anthropic gets the overage toggle; zai's peak-hours toggle must not leak.
		expect(on.has("auto-pause-on-overage")).toBe(true);
		expect(on.has("peak-hours-pause")).toBe(false);
	});

	it("reads the plan-billing toggle in both positions, on a provider that has it", () => {
		// Every other fixture here is anthropic, and providerSupportsCustomBilling
		// is true only for the two -compatible providers, so this toggle was never
		// constructed by any test and `checked` could have been a literal with the
		// suite green. It needs its own provider, not just its own assertion.
		const onPlan = accountMenuToggles(
			{ ...baseAccount, provider: "openai-compatible", billingType: "plan" },
			allHandlers,
		).find((toggle) => toggle.id === "plan-billing");
		const onApi = accountMenuToggles(
			{ ...baseAccount, provider: "openai-compatible", billingType: "api" },
			allHandlers,
		).find((toggle) => toggle.id === "plan-billing");

		expect(onPlan?.checked).toBe(true);
		expect(onApi?.checked).toBe(false);
		// An absent billing type is not plan billing.
		expect(
			accountMenuToggles(
				{ ...baseAccount, provider: "openai-compatible" },
				allHandlers,
			).find((toggle) => toggle.id === "plan-billing")?.checked,
		).toBe(false);
		// And an anthropic account gets no plan-billing toggle at all.
		expect(
			accountMenuToggles(baseAccount, allHandlers).some(
				(toggle) => toggle.id === "plan-billing",
			),
		).toBe(false);
	});

	it("reads the zai peak-hours toggle in both positions and only for zai", () => {
		const zaiOn = accountMenuToggles(
			{ ...baseAccount, provider: "zai", peakHoursPauseEnabled: true },
			allHandlers,
		).find((toggle) => toggle.id === "peak-hours-pause");
		const zaiOff = accountMenuToggles(
			{ ...baseAccount, provider: "zai", peakHoursPauseEnabled: false },
			allHandlers,
		).find((toggle) => toggle.id === "peak-hours-pause");

		expect(zaiOn?.checked).toBe(true);
		expect(zaiOff?.checked).toBe(false);
		// An absent value is off, not on: nothing invents a pause the operator
		// never asked for.
		expect(
			accountMenuToggles(
				{ ...baseAccount, provider: "zai", peakHoursPauseEnabled: undefined },
				allHandlers,
			).find((toggle) => toggle.id === "peak-hours-pause")?.checked,
		).toBe(false);
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

	// The four tests below exist because four mutations survived the first
	// version of this file: a menu id wired to the wrong callback, a `configured`
	// flag hardcoded, a handler gate deleted, and qwen reauth routed to the
	// Anthropic callback. None of them is visible in the rendered card, because a
	// closed Radix menu renders as nothing.
	it("fires the callback each toggle id is named for", () => {
		const fired: string[] = [];
		const spy = (name: string) => () => fired.push(name);
		const bound = bindAccountMenuHandlers(baseAccount, {
			onRename: spy("rename"),
			onPriorityChange: spy("priority"),
			onAutoFallbackToggle: spy("auto-fallback"),
			onAutoRefreshToggle: spy("auto-refresh"),
			onBillingTypeToggle: spy("plan-billing"),
			onAutoPauseOnOverageToggle: spy("auto-pause-on-overage"),
			onPeakHoursPauseToggle: spy("peak-hours-pause"),
		});

		bound.toggle["auto-fallback"]();
		bound.toggle["auto-refresh"]();
		bound.toggle["plan-billing"]();
		bound.toggle["auto-pause-on-overage"]();
		bound.toggle["peak-hours-pause"]();

		expect(fired).toEqual([
			"auto-fallback",
			"auto-refresh",
			"plan-billing",
			"auto-pause-on-overage",
			"peak-hours-pause",
		]);
	});

	it("fires the callback each action id is named for", () => {
		const fired: string[] = [];
		const spy = (name: string) => () => fired.push(name);
		const bound = bindAccountMenuHandlers(
			{ ...baseAccount, provider: "openai-compatible" },
			{
				onRename: spy("rename"),
				onPriorityChange: spy("priority"),
				onRenewalDayChange: spy("renewal-day"),
				onCustomEndpointChange: spy("custom-endpoint"),
				onModelMappingsChange: spy("model-mappings"),
				onRequestTransformerChange: spy("request-transformer"),
				onAutoFallbackToggle: () => {},
				onAutoRefreshToggle: () => {},
				onBillingTypeToggle: () => {},
			},
		);

		bound.action.rename();
		bound.action.priority();
		bound.action["renewal-day"]();
		bound.action["custom-endpoint"]();
		bound.action["model-mappings"]();
		bound.action["request-transformer"]();

		expect(fired).toEqual([
			"rename",
			"priority",
			"renewal-day",
			"custom-endpoint",
			"model-mappings",
			"request-transformer",
		]);
	});

	it("routes reauth to the callback for the account's own provider", () => {
		const fired: string[] = [];
		const spy = (name: string) => () => fired.push(name);
		const callbacks = {
			onRename: () => {},
			onPriorityChange: () => {},
			onAutoFallbackToggle: () => {},
			onAutoRefreshToggle: () => {},
			onBillingTypeToggle: () => {},
			onReauth: spy("qwen"),
			onAnthropicReauth: spy("anthropic"),
			onCodexReauth: spy("codex"),
		};

		bindAccountMenuHandlers(
			{ ...baseAccount, provider: "qwen" },
			callbacks,
		).action.reauth();
		bindAccountMenuHandlers(
			{ ...baseAccount, provider: "codex" },
			callbacks,
		).action.reauth();
		bindAccountMenuHandlers(baseAccount, callbacks).action.reauth();

		expect(fired).toEqual(["qwen", "codex", "anthropic"]);
	});

	it("hides every optional action whose callback the parent did not supply", () => {
		// menuHandlersFrom is what decides this, so an absent callback and a
		// present one are both read here rather than assumed.
		const none = menuHandlersFrom({
			onRename: () => {},
			onPriorityChange: () => {},
			onAutoFallbackToggle: () => {},
			onAutoRefreshToggle: () => {},
			onBillingTypeToggle: () => {},
		});
		const ids = accountMenuActions(
			{ ...baseAccount, provider: "openai-compatible" },
			none,
		).map((action) => action.id);

		expect(ids).toEqual(["rename", "priority"]);
		expect(none.renewalDay).toBe(false);
		expect(
			menuHandlersFrom({
				onRename: () => {},
				onPriorityChange: () => {},
				onAutoFallbackToggle: () => {},
				onAutoRefreshToggle: () => {},
				onBillingTypeToggle: () => {},
				onRenewalDayChange: () => {},
			}).renewalDay,
		).toBe(true);
	});

	it("marks endpoint, mappings and renewal day configured only when set", () => {
		const unset = new Map(
			accountMenuActions(baseAccount, allHandlers).map((a) => [a.id, a]),
		);
		const set = new Map(
			accountMenuActions(
				{
					...baseAccount,
					renewalDay: 15,
					customEndpoint: "https://example.invalid",
					modelMappings: { a: "b" },
				},
				allHandlers,
			).map((a) => [a.id, a]),
		);

		const ids = [
			"renewal-day",
			"custom-endpoint",
			"model-mappings",
		] as const satisfies readonly AccountMenuActionId[];
		for (const id of ids) {
			expect(unset.get(id)?.configured).toBe(false);
			expect(set.get(id)?.configured).toBe(true);
		}
		// An empty custom endpoint is not a configured one. The title ternary
		// already treats it as unset; `configured` must agree, or the menu shows
		// "Set custom endpoint" beside a "Configured" marker.
		expect(
			accountMenuActions(
				{ ...baseAccount, customEndpoint: "" },
				allHandlers,
			).find((a) => a.id === "custom-endpoint")?.configured,
		).toBe(false);
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
