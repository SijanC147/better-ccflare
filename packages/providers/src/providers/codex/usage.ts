import type { CodexCredits, UsageData, UsageWindow } from "../../usage-fetcher";

export interface ParseCodexUsageHeadersOptions {
	baseTimeMs?: number;
	allowRelativeResetAfter?: boolean;
	defaultUtilization?: number;
}

const DEFAULT_UTILIZATION = 0;
const FIVE_HOUR_WINDOW_MINUTES = 5 * 60;
const SEVEN_DAY_WINDOW_MINUTES = 7 * 24 * 60;

export interface NormalizedCodexInputUsage {
	/** Total context occupied upstream, including cached tokens. */
	totalInputTokens: number;
	/** Anthropic's additive, uncached input token field. */
	inputTokens: number;
	cacheReadInputTokens: number;
}

/**
 * Convert Codex's cache-inclusive input total to Anthropic's additive usage
 * fields. OpenAI's usage.input_tokens counts cached tokens toward the total;
 * Anthropic's input_tokens is additive and excludes tokens already reported
 * via cache_read_input_tokens. Copying the inclusive total into both fields
 * double-counts cached tokens for clients and billing that expect Anthropic
 * semantics.
 */
export function normalizeCodexInputUsage(
	totalInputTokens: unknown,
	cachedTokens: unknown,
): NormalizedCodexInputUsage {
	const total =
		typeof totalInputTokens === "number" &&
		Number.isFinite(totalInputTokens) &&
		totalInputTokens >= 0
			? totalInputTokens
			: 0;
	const cached =
		typeof cachedTokens === "number" &&
		Number.isFinite(cachedTokens) &&
		cachedTokens >= 0
			? Math.min(cachedTokens, total)
			: 0;

	return {
		totalInputTokens: total,
		inputTokens: total - cached,
		cacheReadInputTokens: cached,
	};
}

function parseNumber(value: string | null): number | null {
	if (!value) return null;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function toIsoString(timestampMs: number | null): string | null {
	if (timestampMs === null || !Number.isFinite(timestampMs)) return null;
	try {
		return new Date(timestampMs).toISOString();
	} catch {
		return null;
	}
}

function parseResetAtSeconds(value: string | null): string | null {
	const parsed = parseNumber(value);
	if (parsed === null) return null;
	return toIsoString(parsed * 1000);
}

function parseResetAfterSeconds(
	value: string | null,
	baseTimeMs: number,
	allowRelativeResetAfter: boolean,
): string | null {
	if (!allowRelativeResetAfter || !Number.isFinite(baseTimeMs)) return null;
	const parsed = parseNumber(value);
	if (parsed === null) return null;
	return toIsoString(baseTimeMs + parsed * 1000);
}

function toUsageWindow(
	utilization: number | null,
	resetsAt: string | null,
): UsageWindow | null {
	if (utilization === null && resetsAt === null) return null;
	return {
		utilization: utilization ?? 0,
		resets_at: resetsAt,
	};
}

function pickWindowSlot(
	windowMinutes: number | null,
): "five_hour" | "seven_day" | null {
	if (windowMinutes === null) return null;
	if (windowMinutes <= FIVE_HOUR_WINDOW_MINUTES) return "five_hour";
	if (windowMinutes >= SEVEN_DAY_WINDOW_MINUTES) return "seven_day";
	return null;
}

function readWindow(
	headers: Headers,
	prefix: "primary" | "secondary",
	baseTimeMs: number,
	allowRelativeResetAfter: boolean,
	defaultUtilization: number,
): {
	window: "five_hour" | "seven_day" | null;
	data: UsageWindow | null;
} {
	const windowMinutes = parseNumber(
		headers.get(`x-codex-${prefix}-window-minutes`),
	);
	const utilization = parseNumber(
		headers.get(`x-codex-${prefix}-used-percent`),
	);
	const resetsAt =
		parseResetAtSeconds(headers.get(`x-codex-${prefix}-reset-at`)) ??
		parseResetAfterSeconds(
			headers.get(`x-codex-${prefix}-reset-after-seconds`),
			baseTimeMs,
			allowRelativeResetAfter,
		);

	// Treat a window as present only when it has meaningful data.
	// Mirrors codex-rs behavior for empty (0%, 0min, no reset) placeholders.
	const hasMeaningfulWindowData =
		utilization !== 0 || windowMinutes !== 0 || resetsAt !== null;

	return {
		window: pickWindowSlot(windowMinutes),
		data: hasMeaningfulWindowData
			? toUsageWindow(utilization ?? defaultUtilization, resetsAt)
			: null,
	};
}

/**
 * Upstream writes these as JSON booleans, and codex-rs reads them back through
 * a string parse, so the value arrives as the text "true" or "false". Anything
 * else is absent rather than false: a header we cannot read is not upstream
 * telling us "no".
 */
function parseHeaderBool(value: string | null): boolean | null {
	if (value === null) return null;
	const normalized = value.trim().toLowerCase();
	if (normalized === "true") return true;
	if (normalized === "false") return false;
	return null;
}

/**
 * The credit balance, or null when upstream did not report one.
 *
 * Gated on `x-codex-credits-has-credits` alone, mirroring codex-rs
 * `parse_credits_snapshot`. Absent is omitted, never zeroed: rendering
 * "0 credits" for an account upstream never spoke about is a confident lie in
 * the direction that makes an operator stop using a working account.
 */
export function parseCodexCreditsHeaders(
	headers: Headers,
): CodexCredits | null {
	const hasCredits = parseHeaderBool(
		headers.get("x-codex-credits-has-credits"),
	);
	if (hasCredits === null) return null;

	const balance = headers.get("x-codex-credits-balance");
	const trimmedBalance = balance?.trim();

	return {
		has_credits: hasCredits,
		// An unreadable `unlimited` is not "unlimited": default to the bounded
		// reading, so a malformed header can never render "Unlimited".
		unlimited:
			parseHeaderBool(headers.get("x-codex-credits-unlimited")) ?? false,
		// Kept as the upstream string so the dashboard prints what the Codex CLI
		// prints. An empty header is no balance, not the empty string.
		balance: trimmedBalance ? trimmedBalance : null,
	};
}

export function parseCodexUsageHeaders(
	headers: Headers,
	options: ParseCodexUsageHeadersOptions = {},
): UsageData | null {
	const {
		baseTimeMs = Date.now(),
		allowRelativeResetAfter = true,
		defaultUtilization = DEFAULT_UTILIZATION,
	} = options;
	const primary = readWindow(
		headers,
		"primary",
		baseTimeMs,
		allowRelativeResetAfter,
		defaultUtilization,
	);
	const secondary = readWindow(
		headers,
		"secondary",
		baseTimeMs,
		allowRelativeResetAfter,
		defaultUtilization,
	);

	const legacyFiveHourReset = parseResetAtSeconds(
		headers.get("x-codex-5h-reset-at"),
	);
	const legacySevenDayReset = parseResetAtSeconds(
		headers.get("x-codex-7d-reset-at"),
	);

	const fiveHour =
		(primary.window === "five_hour" ? primary.data : null) ??
		(secondary.window === "five_hour" ? secondary.data : null) ??
		(legacyFiveHourReset
			? toUsageWindow(defaultUtilization, legacyFiveHourReset)
			: null);
	const sevenDay =
		(primary.window === "seven_day" ? primary.data : null) ??
		(secondary.window === "seven_day" ? secondary.data : null) ??
		(legacySevenDayReset
			? toUsageWindow(defaultUtilization, legacySevenDayReset)
			: null);

	if (!fiveHour && !sevenDay) {
		return null;
	}

	// Deliberately inside the window gate, not above it: the credits line is
	// rendered beside the weekly bar, and every measured response carrying the
	// credits headers carried the window headers too. Returning usage data for a
	// credits-only response would put accounts into the "has usage data" bucket
	// that every admission and pool-average reader consults, which is a routing
	// change and not this issue's.
	const credits = parseCodexCreditsHeaders(headers);

	return {
		five_hour: fiveHour ?? { utilization: defaultUtilization, resets_at: null },
		seven_day: sevenDay ?? { utilization: defaultUtilization, resets_at: null },
		...(credits ? { credits } : {}),
	};
}
