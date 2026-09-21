import { supportsUsagePauseThreshold } from "@better-ccflare/core";
import type { Account } from "../../api";
import {
	providerSupportsAutoFeatures,
	providerSupportsCustomBilling,
} from "../../utils/provider-utils";

/**
 * The card's overflow menu is built here rather than inline in the JSX so the
 * item list is testable. `AccountListItem.test.tsx` renders with
 * `renderToStaticMarkup` and Radix renders a closed `DropdownMenuContent` as
 * nothing, so an assertion against the rendered menu would be vacuous. These
 * functions are the real assertion; the component's only job is to map over
 * what they return.
 */

export type AccountMenuToggleId =
	| "auto-fallback"
	| "auto-refresh"
	| "plan-billing"
	| "auto-pause-on-overage"
	| "peak-hours-pause";

export type AccountMenuActionId =
	| "rename"
	| "priority"
	| "renewal-day"
	| "custom-endpoint"
	| "usage-thresholds"
	| "model-mappings"
	| "request-transformer"
	| "reauth";

export interface AccountMenuToggle {
	id: AccountMenuToggleId;
	label: string;
	title: string;
	checked: boolean;
}

export interface AccountMenuAction {
	id: AccountMenuActionId;
	label: string;
	title: string;
	/**
	 * True when the account already carries a value for this action. The card
	 * used to signal it with a `text-primary` icon and, for the request
	 * transformer, `aria-pressed`. A menu item has no pressed state, so the
	 * component renders this as a visible marker inside the menu.
	 */
	configured: boolean;
}

/**
 * Which optional callbacks the parent supplied. A control whose handler is
 * absent is not rendered, which is how the card behaved before the menu.
 */
export interface AccountMenuHandlers {
	renewalDay: boolean;
	customEndpoint: boolean;
	usageThresholds: boolean;
	modelMappings: boolean;
	requestTransformer: boolean;
	autoPauseOnOverage: boolean;
	peakHoursPause: boolean;
	qwenReauth: boolean;
	anthropicReauth: boolean;
	codexReauth: boolean;
}

/** The subset of the card's props the menu needs. */
export interface AccountMenuCallbacks {
	onRename: (account: Account) => void;
	onPriorityChange: (account: Account) => void;
	onRenewalDayChange?: (account: Account) => void;
	onCustomEndpointChange?: (account: Account) => void;
	onUsageThresholdsChange?: (account: Account) => void;
	onModelMappingsChange?: (account: Account) => void;
	onRequestTransformerChange?: (account: Account) => void;
	onReauth?: (account: Account) => void;
	onAnthropicReauth?: (account: Account) => void;
	onCodexReauth?: (account: Account) => void;
	onAutoFallbackToggle: (account: Account) => void;
	onAutoRefreshToggle: (account: Account) => void;
	onBillingTypeToggle: (account: Account) => void;
	onAutoPauseOnOverageToggle?: (account: Account) => void;
	onPeakHoursPauseToggle?: (account: Account) => void;
}

/**
 * Derived from the callbacks rather than written out a second time, so a new
 * optional control cannot be listed in one place and forgotten in the other.
 */
export function menuHandlersFrom(
	callbacks: AccountMenuCallbacks,
): AccountMenuHandlers {
	return {
		renewalDay: Boolean(callbacks.onRenewalDayChange),
		customEndpoint: Boolean(callbacks.onCustomEndpointChange),
		usageThresholds: Boolean(callbacks.onUsageThresholdsChange),
		modelMappings: Boolean(callbacks.onModelMappingsChange),
		requestTransformer: Boolean(callbacks.onRequestTransformerChange),
		autoPauseOnOverage: Boolean(callbacks.onAutoPauseOnOverageToggle),
		peakHoursPause: Boolean(callbacks.onPeakHoursPauseToggle),
		qwenReauth: Boolean(callbacks.onReauth),
		anthropicReauth: Boolean(callbacks.onAnthropicReauth),
		codexReauth: Boolean(callbacks.onCodexReauth),
	};
}

/**
 * Binds each menu id to the callback it fires. Lives here rather than inline in
 * the component so a test can assert which callback an id actually reaches: the
 * closed menu renders as nothing, so routing an id to the wrong callback is
 * otherwise invisible to the suite.
 */
export function bindAccountMenuHandlers(
	account: Account,
	callbacks: AccountMenuCallbacks,
): {
	toggle: Record<AccountMenuToggleId, () => void>;
	action: Record<AccountMenuActionId, () => void>;
} {
	return {
		toggle: {
			"auto-fallback": () => callbacks.onAutoFallbackToggle(account),
			"auto-refresh": () => callbacks.onAutoRefreshToggle(account),
			"plan-billing": () => callbacks.onBillingTypeToggle(account),
			"auto-pause-on-overage": () =>
				callbacks.onAutoPauseOnOverageToggle?.(account),
			"peak-hours-pause": () => callbacks.onPeakHoursPauseToggle?.(account),
		},
		action: {
			rename: () => callbacks.onRename(account),
			priority: () => callbacks.onPriorityChange(account),
			"renewal-day": () => callbacks.onRenewalDayChange?.(account),
			"custom-endpoint": () => callbacks.onCustomEndpointChange?.(account),
			"usage-thresholds": () => callbacks.onUsageThresholdsChange?.(account),
			"model-mappings": () => callbacks.onModelMappingsChange?.(account),
			"request-transformer": () =>
				callbacks.onRequestTransformerChange?.(account),
			reauth: () => {
				if (account.provider === "qwen") return callbacks.onReauth?.(account);
				if (account.provider === "codex")
					return callbacks.onCodexReauth?.(account);
				return callbacks.onAnthropicReauth?.(account);
			},
		},
	};
}

export function accountMenuToggles(
	account: Account,
	handlers: AccountMenuHandlers,
): AccountMenuToggle[] {
	const toggles: AccountMenuToggle[] = [];

	if (providerSupportsAutoFeatures(account.provider)) {
		toggles.push({
			id: "auto-fallback",
			label: "Auto-fallback",
			title:
				"Automatically switch back to this account from lower-priority ones when its rate limit resets. Requires multiple accounts with different priorities.",
			checked: account.autoFallbackEnabled,
		});
		toggles.push({
			id: "auto-refresh",
			label: "Auto-refresh",
			title:
				"Automatically sends a minimal message when the usage window resets to avoid cold-start latency. Does not affect OAuth token refreshing.",
			checked: account.autoRefreshEnabled,
		});
	}

	if (providerSupportsCustomBilling(account.provider)) {
		toggles.push({
			id: "plan-billing",
			label: "Plan billing",
			title: "Toggle plan billing for this account",
			checked: account.billingType === "plan",
		});
	}

	if (account.provider === "anthropic" && handlers.autoPauseOnOverage) {
		toggles.push({
			id: "auto-pause-on-overage",
			label: "Auto-pause on overage",
			title:
				"Automatically pause account when overage usage is detected. Note: detection only happens when Anthropic API reports overage, so some overage usage may occur before pausing. Account resumes when usage window resets.",
			checked: account.autoPauseOnOverageEnabled ?? false,
		});
	}

	if (account.provider === "zai" && handlers.peakHoursPause) {
		toggles.push({
			id: "peak-hours-pause",
			label: "Peak hours pause",
			title:
				"Automatically pause this account during Zai peak hours (14:00–18:00 SGT)",
			checked: account.peakHoursPauseEnabled ?? false,
		});
	}

	return toggles;
}

export function accountMenuActions(
	account: Account,
	handlers: AccountMenuHandlers,
): AccountMenuAction[] {
	const actions: AccountMenuAction[] = [
		{
			id: "rename",
			label: "Rename",
			title: "Rename account",
			configured: false,
		},
		{
			id: "priority",
			label: "Change priority",
			title: "Change account priority",
			configured: false,
		},
	];

	if (handlers.renewalDay) {
		actions.push({
			id: "renewal-day",
			label: "Renewal day",
			title: account.renewalDay
				? `Subscription renews on day ${account.renewalDay} of the month`
				: "Set the subscription renewal day",
			configured: Boolean(account.renewalDay),
		});
	}

	if (handlers.customEndpoint) {
		actions.push({
			id: "custom-endpoint",
			label: "Custom endpoint",
			title: account.customEndpoint
				? `Custom endpoint: ${account.customEndpoint}`
				: "Set custom endpoint",
			configured: Boolean(account.customEndpoint),
		});
	}

	// Upstream renders this as a Gauge button on the card. The fork keeps every
	// configuration control in the overflow menu, so it lands here instead, in
	// the same position upstream gave it: between the endpoint and the mappings.
	if (supportsUsagePauseThreshold(account.provider) && handlers.usageThresholds) {
		const activeUsageThresholds = [
			account.usagePauseFiveHourEnabled && account.usagePauseFiveHourThreshold
				? `${account.usagePauseFiveHourThreshold}% of the 5-hour window`
				: null,
			account.usagePauseWeeklyEnabled && account.usagePauseWeeklyThreshold
				? `${account.usagePauseWeeklyThreshold}% of the weekly window`
				: null,
		].filter((entry): entry is string => entry !== null);
		actions.push({
			id: "usage-thresholds",
			label: "Usage pause thresholds",
			title:
				activeUsageThresholds.length > 0
					? `Pauses at ${activeUsageThresholds.join(", ")}`
					: "Set usage pause thresholds",
			configured: activeUsageThresholds.length > 0,
		});
	}

	if (handlers.modelMappings) {
		actions.push({
			id: "model-mappings",
			label: "Model mappings",
			title: account.modelMappings
				? `Model mappings configured (${Object.keys(account.modelMappings).length} mappings)`
				: "Configure model mappings",
			configured: Boolean(account.modelMappings),
		});
	}

	if (account.provider === "openai-compatible" && handlers.requestTransformer) {
		actions.push({
			id: "request-transformer",
			label: "Request transformer",
			title: account.requestTransformer
				? "Request transformer: Max Tokens → Max Completion Tokens"
				: "Configure request transformer",
			configured: Boolean(account.requestTransformer),
		});
	}

	// At most one re-authentication variant renders: the provider decides which
	// callback the parent supplied.
	const reauthTitle = reauthTitleFor(account, handlers);
	if (reauthTitle) {
		actions.push({
			id: "reauth",
			label: "Re-authenticate",
			title: reauthTitle,
			configured: false,
		});
	}

	return actions;
}

function reauthTitleFor(
	account: Account,
	handlers: AccountMenuHandlers,
): string | null {
	if (account.provider === "qwen" && handlers.qwenReauth) {
		return "Re-authenticate this Qwen account (preserves all metadata)";
	}
	if (
		account.provider === "anthropic" &&
		account.hasRefreshToken &&
		handlers.anthropicReauth
	) {
		return "Re-authenticate this Anthropic account (preserves all metadata)";
	}
	if (account.provider === "codex" && handlers.codexReauth) {
		return "Re-authenticate this Codex account (preserves all metadata)";
	}
	return null;
}
