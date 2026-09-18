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
	modelMappings: boolean;
	requestTransformer: boolean;
	autoPauseOnOverage: boolean;
	peakHoursPause: boolean;
	qwenReauth: boolean;
	anthropicReauth: boolean;
	codexReauth: boolean;
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
			configured: account.renewalDay !== null,
		});
	}

	if (handlers.customEndpoint) {
		actions.push({
			id: "custom-endpoint",
			label: "Custom endpoint",
			title: account.customEndpoint
				? `Custom endpoint: ${account.customEndpoint}`
				: "Set custom endpoint",
			configured: account.customEndpoint !== null,
		});
	}

	if (handlers.modelMappings) {
		actions.push({
			id: "model-mappings",
			label: "Model mappings",
			title: account.modelMappings
				? `Model mappings configured (${Object.keys(account.modelMappings).length} mappings)`
				: "Configure model mappings",
			configured: account.modelMappings !== null,
		});
	}

	if (account.provider === "openai-compatible" && handlers.requestTransformer) {
		actions.push({
			id: "request-transformer",
			label: "Request transformer",
			title: account.requestTransformer
				? "Request transformer: Max Tokens → Max Completion Tokens"
				: "Configure request transformer",
			configured: account.requestTransformer !== null,
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
