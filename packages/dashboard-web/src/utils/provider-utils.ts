/**
 * Utility functions for provider-specific logic in the web UI
 */
import {
	getDefaultEndpoint,
	isKnownProvider,
	PROVIDER_NAMES,
	requiresSessionDurationTracking,
} from "@better-ccflare/types";

/**
 * Check if a provider supports auto-fallback and auto-refresh features
 * Currently only Anthropic OAuth accounts support these features
 */
export function providerSupportsAutoFeatures(provider: string): boolean {
	return (
		provider === PROVIDER_NAMES.ANTHROPIC ||
		provider === PROVIDER_NAMES.CODEX ||
		provider === PROVIDER_NAMES.ZAI
	);
}

/**
 * Providers whose upstream answers by the SAME model ids the client asks for.
 *
 * This is the one and only definition of the passthrough rule. An empty model
 * field means "forward whatever model the client sent, untouched" — which is
 * only meaningful when the upstream natively accepts Claude model ids, i.e.
 * Anthropic OAuth accounts and Claude Console API accounts.
 *
 * On every other provider the Claude id sent by the client lands on a foreign
 * catalog and gets coerced by an embedded default map. That is the exact path
 * that produced `400 The 'gpt-5.3-codex' model is not supported...` on a codex
 * account. So outside this list, choosing a model is mandatory.
 *
 * Never compare `provider === "anthropic"` at a call site: use the helper
 * below, so the criterion stays in a single place.
 */
export const PASSTHROUGH_PROVIDERS: readonly string[] = [
	PROVIDER_NAMES.ANTHROPIC,
	PROVIDER_NAMES.CLAUDE_CONSOLE_API,
];

/**
 * True when the model field may be left empty (passthrough) for this provider.
 *
 * An absent/unknown provider (no account picked yet) is NOT passthrough: we
 * cannot promise a behaviour we do not know the upstream supports.
 */
export function providerAllowsClientModelPassthrough(
	provider?: string | null,
): boolean {
	return PASSTHROUGH_PROVIDERS.includes((provider ?? "").trim());
}

/**
 * Check if a provider supports custom billing type configuration
 * (anthropic-compatible and openai-compatible providers)
 */
export function providerSupportsCustomBilling(provider: string): boolean {
	return (
		provider === PROVIDER_NAMES.ANTHROPIC_COMPATIBLE ||
		provider === PROVIDER_NAMES.OPENAI_COMPATIBLE
	);
}

/**
 * Check if a provider shows quota-window usage information on the account page.
 * Anthropic and Codex show 5-hour and 7-day windows, NanoGPT shows daily/monthly,
 * and Zai exposes time/token quota windows.
 */
/**
 * Check if a provider uses session-based usage windows (e.g. Anthropic 5h, Codex 5h).
 * Only these providers should show the session token breakdown on account cards.
 */
export function providerHasSessionWindow(provider: string): boolean {
	return requiresSessionDurationTracking(provider);
}

export function providerShowsWeeklyUsage(provider: string): boolean {
	return (
		provider === PROVIDER_NAMES.ANTHROPIC ||
		provider === PROVIDER_NAMES.CODEX ||
		provider === PROVIDER_NAMES.NANOGPT ||
		provider === PROVIDER_NAMES.ZAI ||
		provider === PROVIDER_NAMES.XAI ||
		// Alibaba Coding Plan emits its own five_hour/weekly/monthly shape
		// (see AlibabaCodingPlanUsageData + alibaba-coding-plan-usage-fetcher).
		// Without this entry the isAlibabaData branch in RateLimitProgress and
		// the pool-usage eligibility set both silently never render.
		provider === PROVIDER_NAMES.ALIBABA_CODING_PLAN ||
		// MiniMax Token Plan normalizes its native weekly window to the
		// canonical `seven_day` key (see minimax-usage-fetcher.ts). Without
		// this entry AccountListItem passes showWeekly=false and both 5h
		// and 7d windows collapse to a single fallback bar — the bug
		// fixed in this branch.
		provider === PROVIDER_NAMES.MINIMAX
	);
}

/**
 * Check if a provider shows a credit balance (USD remaining) instead of utilization windows
 */
export function providerShowsCreditsBalance(provider: string): boolean {
	return provider === PROVIDER_NAMES.KILO;
}

/**
 * Check if a provider supports custom endpoints
 */
export function providerSupportsCustomEndpoints(provider: string): boolean {
	// Most providers support custom endpoints, but we can add specific logic if needed
	return isKnownProvider(provider);
}

/**
 * Get the default endpoint for a provider
 */
export function getDefaultEndpointForProvider(provider: string): string {
	return getDefaultEndpoint(provider);
}

/**
 * A recurring peak-hour window, expressed as a half-open range of UTC hours.
 *
 * These constants are the single source of truth for both the "is it peak right
 * now" predicates below and the localized labels rendered by the dashboard. They
 * are deliberately stated in UTC rather than in the vendor's own timezone: the
 * predicates have always been fixed-UTC, and deriving the label from a different
 * definition would let the badge disagree with the colour of the dot beside it.
 */
export interface PeakWindow {
	/** Inclusive start, as an hour of the UTC day. */
	startUtcHour: number;
	/** Exclusive end, as an hour of the UTC day. */
	endUtcHour: number;
	/** When true, the window does not occur on Saturday or Sunday (UTC). */
	weekdaysOnly: boolean;
}

/** Zai peak hours: 14:00–18:00 Singapore time (UTC+8), every day. */
export const ZAI_PEAK_WINDOW: PeakWindow = {
	startUtcHour: 6,
	endUtcHour: 10,
	weekdaysOnly: false,
};

/** Anthropic OAuth peak hours: 5am–11am PT, weekdays. */
export const ANTHROPIC_PEAK_WINDOW: PeakWindow = {
	startUtcHour: 13,
	endUtcHour: 19,
	weekdaysOnly: true,
};

function isWithinPeakWindow(window: PeakWindow, ts: number): boolean {
	const d = new Date(ts);
	if (window.weekdaysOnly) {
		const day = d.getUTCDay();
		// Weekdays only (Mon=1 through Fri=5)
		if (day === 0 || day === 6) return false;
	}
	const utcHour = d.getUTCHours() + d.getUTCMinutes() / 60;
	return utcHour >= window.startUtcHour && utcHour < window.endUtcHour;
}

/**
 * Check if a given timestamp (default: now) falls within Zai peak hours.
 * Zai peak hours are 14:00–18:00 Singapore time (UTC+8).
 */
export function isZaiPeakHour(ts?: number): boolean {
	return isWithinPeakWindow(ZAI_PEAK_WINDOW, ts ?? Date.now());
}

/**
 * Check if a given timestamp (default: now) falls within Anthropic OAuth peak hours.
 * Peak hours are weekdays 5am–11am PT (1pm–7pm UTC), Monday–Friday.
 * During these windows, 5-hour sessions consume a larger share of the weekly budget.
 */
export function isAnthropicPeakHour(ts?: number): boolean {
	return isWithinPeakWindow(ANTHROPIC_PEAK_WINDOW, ts ?? Date.now());
}
