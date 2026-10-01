/**
 * Benching an account before it runs its usage window down to zero.
 *
 * The proxy already reacts to exhaustion after the fact: a 429 arrives, the
 * account earns a cooldown, and traffic fails over. That is the right
 * behaviour for a shared pool, but it is the wrong behaviour for an account
 * someone wants to keep something in reserve on — by the time the 429 lands,
 * the window is already spent.
 *
 * The usage poller knows each account's 5-hour and weekly utilization long
 * before that point. This module turns those readings into a decision: pause
 * the account at the percentage its owner nominated, and let it back in once
 * the window has rolled over. Both thresholds are per account and optional;
 * an account with neither set behaves exactly as it did before.
 *
 * Pure by design — the caller owns the database write and the logging, so the
 * rules stay testable without a database or a poller.
 */

import { MAX_MIN_RESET_REMAINING_MS } from "@better-ccflare/types";

/** A usage window that can carry a pause threshold. */
export type UsagePauseWindow = "five_hour" | "weekly";

/**
 * The reason written to `accounts.pause_reason` for a threshold pause.
 *
 * Deliberately NOT one of the load balancer's auto-unpause reasons. Those
 * paths resume an account as soon as its stored `rate_limit_reset` has
 * elapsed, and that timestamp describes one window — for Codex, whichever
 * window the provider reported. A five-hour reset would then return an
 * account to rotation while the weekly threshold it was benched for is still
 * exceeded, and it would serve traffic until the next poll benched it again.
 *
 * Resuming is therefore owned solely by the usage poller, which is the only
 * place that sees every configured window at once. The cost is that an
 * account stays benched if usage polling stops entirely; unpausing by hand
 * clears it, and polling is what the feature depends on in any case.
 */
export const USAGE_THRESHOLD_PAUSE_REASON = "usage_threshold";

/**
 * One window's setting: the conditions its owner chose, and whether the window
 * is currently in force.
 *
 * Two conditions, matching the combo slot rule (SB23-1269, SB23-2575): the
 * window's utilization is at or above `percent`, and the window's reset is still
 * at least `minResetRemainingMs` away. Either may be null, meaning that condition
 * is off. Only the configured conditions are considered and every configured one
 * must hold, so a window with only a percent pauses on utilization alone, one
 * with only a reset minimum pauses on time-to-reset alone, and one with both
 * pauses only when both hold.
 *
 * `enabled` governs the window as a whole and is stored apart from the numbers,
 * so switching a window off keeps them rather than making someone type them
 * again when they switch it back on. A window with `enabled: false`, or with
 * neither condition set, is simply not considered.
 *
 * `minResetRemainingMs` is required rather than optional so that no caller can
 * build a setting that silently drops the reset condition: an absent property
 * would read as "off" and nothing would say so.
 */
export interface UsagePauseSetting {
	enabled: boolean;
	percent: number | null;
	/** Milliseconds; the same unit and bound as `ComboSlot.min_reset_remaining_ms`. */
	minResetRemainingMs: number | null;
}

/** Per-account pause settings, one per window. */
export interface UsagePauseThresholds {
	fiveHour: UsagePauseSetting;
	weekly: UsagePauseSetting;
}

/** The percentage a window will actually pause at, or null when it will not. */
export function effectiveThreshold(
	setting: UsagePauseSetting | null | undefined,
): number | null {
	if (!setting?.enabled) return null;
	return setting.percent ?? null;
}

/** The reset minimum a window will actually pause on, or null when it will not. */
export function effectiveMinResetRemainingMs(
	setting: UsagePauseSetting | null | undefined,
): number | null {
	if (!setting?.enabled) return null;
	return setting.minResetRemainingMs ?? null;
}

/**
 * Whether a window is in force with at least one condition configured: the
 * question the poller asks before reading a payload at all. Deliberately not
 * `effectiveThreshold(...) !== null`, which is how the poller asked it before
 * SB23-2575 and which reads a reset-only window as unconfigured.
 */
export function isUsagePauseWindowConfigured(
	setting: UsagePauseSetting | null | undefined,
): boolean {
	return (
		effectiveThreshold(setting) !== null ||
		effectiveMinResetRemainingMs(setting) !== null
	);
}

/**
 * The pause windows a provider's usage payload can report at all.
 *
 * xAI reports one window, Grok Build credits, which {@link readUsageUtilization}
 * puts in the weekly slot (SB23-3686), so it has no 5-hour window to pause on.
 * Every other provider either reports both or reports each one sometimes, which
 * a snapshot's own nulls already express.
 *
 * Keyed on the provider, never on the payload: a Codex payload carries a
 * `credits` key too (SB23-2462), and reading it as xAI's is the mistake
 * `isXaiData` in the dashboard was rewritten to stop making.
 */
export function usagePauseWindowsForProvider(
	provider: string | null | undefined,
): ReadonlyArray<UsagePauseWindow> {
	if (provider === "xai") return ["weekly"];
	return ["five_hour", "weekly"];
}

/**
 * The thresholds with every window the provider cannot report switched off.
 *
 * A window that can never be read evaluates as `unknown` on every snapshot, and
 * an `unknown` window blocks a resume, so a stale setting on such a window (an
 * xAI 5-hour window switched on before SB23-3686, or by a raw API call) would
 * keep an account benched forever once its real window had paused it. Switching
 * it off here keeps its numbers in the database and drops it from the decision.
 */
export function restrictToReportedWindows(
	thresholds: UsagePauseThresholds,
	provider: string | null | undefined,
): UsagePauseThresholds {
	const reported = usagePauseWindowsForProvider(provider);
	const keep = (window: UsagePauseWindow, setting: UsagePauseSetting) =>
		reported.includes(window) ? setting : { ...setting, enabled: false };
	return {
		fiveHour: keep("five_hour", thresholds.fiveHour),
		weekly: keep("weekly", thresholds.weekly),
	};
}

/**
 * Utilization for the two windows as of the latest poll, 0–100. `null` means
 * the usage API did not report that window on this snapshot — distinct from 0,
 * which is a genuine reading of a freshly reset window.
 */
export interface UsageUtilization {
	fiveHour: number | null;
	weekly: number | null;
}

/**
 * When each window resets, as epoch milliseconds, read off the same payload key
 * its utilization came from. `null` means the payload carried no reset time for
 * that window, which Anthropic reports for a window that has not started yet.
 */
export interface UsageResets {
	fiveHour: number | null;
	weekly: number | null;
}

/** What the caller should do with the account, given the latest snapshot. */
export type UsagePauseDecision =
	| {
			action: "pause";
			window: UsagePauseWindow;
			/**
			 * The reading and the percent it reached, both null when the window
			 * has no percent condition and paused on its reset alone.
			 */
			utilization: number | null;
			threshold: number | null;
			/**
			 * How far away the reset was and the minimum it met, both null when
			 * the window has no reset condition.
			 */
			resetRemainingMs: number | null;
			minResetRemainingMs: number | null;
	  }
	| { action: "resume" }
	| { action: "none" };

/** Everything the decision depends on: the settings, the reading, the state. */
export interface UsagePauseInput {
	thresholds: UsagePauseThresholds;
	utilization: UsageUtilization;
	resets: UsageResets;
	paused: boolean;
	pauseReason: string | null;
	now: number;
}

/** The windows in the order they are reported when both are over. */
const WINDOWS: ReadonlyArray<{
	window: UsagePauseWindow;
	key: keyof UsagePauseThresholds;
}> = [
	{ window: "five_hour", key: "fiveHour" },
	{ window: "weekly", key: "weekly" },
];

/**
 * One configured window's state against its own snapshot.
 *
 * Three outcomes, not a boolean, because pausing and resuming need different
 * answers from the same "we cannot tell": a window that cannot be read must not
 * pause an account, and must not hand a benched one back to traffic either.
 */
type WindowState = "holds" | "clear" | "unknown";

/**
 * Evaluate one configured window. Mirrors `isSlotThrottled` in
 * packages/proxy/src/handlers/account-selector.ts, which is the rule this one
 * was asked to match:
 *
 * - A window the payload did not report at all (no utilization and no reset)
 *   is `unknown`, so a partial payload cannot resume an exhausted account.
 * - A reset already in the past means the reading describes the previous
 *   window, which has since rolled over, so the window is `clear` whatever its
 *   utilization says. For pausing that is the slot rule's staleness guard; for
 *   resuming it is the honest reading, since a rolled-over window has nothing
 *   left to protect.
 * - The percent clause holds at or above the percent; a missing utilization is
 *   `unknown` rather than a pass or a fail.
 * - The reset clause holds while the reset is at least the minimum away. An
 *   absent reset does not hold, which is the slot rule's "an absent `resetMs`
 *   ignores the reset clause" read for a rule that has one: nothing establishes
 *   the window is far from resetting. It is `clear` rather than `unknown`
 *   because Anthropic reports a window that has rolled over and not restarted
 *   as 0% with no reset (the `#443` shape `onStaleWeeklyReset` detects), and a
 *   paused account sends no traffic to restart it: `unknown` there would bench
 *   a reset-only account forever.
 * - Any configured clause failing makes the window `clear`; otherwise any
 *   `unknown` clause makes it `unknown`; otherwise it `holds`.
 */
function evaluateWindow(
	setting: UsagePauseSetting,
	utilization: number | null,
	resetMs: number | null,
	now: number,
): WindowState {
	const percent = effectiveThreshold(setting);
	const minReset = effectiveMinResetRemainingMs(setting);

	if (utilization === null && resetMs === null) return "unknown";
	if (resetMs !== null && resetMs <= now) return "clear";

	let unknown = false;
	if (percent !== null) {
		if (utilization === null) unknown = true;
		else if (utilization < percent) return "clear";
	}
	if (minReset !== null) {
		if (resetMs === null) return "clear";
		if (resetMs - now < minReset) return "clear";
	}
	return unknown ? "unknown" : "holds";
}

/**
 * Decide whether a usage snapshot should pause or resume an account.
 *
 * Pauses when a configured window holds (every condition it has set is met)
 * and the account is running. Resumes only an account this rule paused, and
 * only once every configured window is `clear`: a window the snapshot did not
 * report is "still unknown", never "recovered", so a partial payload cannot
 * hand an exhausted account back to traffic. A reset condition that stops
 * holding because the reset is now near is a recovery like any other. Manual,
 * overage and failure pauses are left entirely alone.
 */
export function evaluateUsagePause(input: UsagePauseInput): UsagePauseDecision {
	const { thresholds, utilization, resets, paused, pauseReason, now } = input;

	const configured = WINDOWS.filter(({ key }) =>
		isUsagePauseWindowConfigured(thresholds[key]),
	).map(({ window, key }) => ({
		window,
		setting: thresholds[key],
		utilization: utilization[key],
		resetMs: resets[key],
		state: evaluateWindow(thresholds[key], utilization[key], resets[key], now),
	}));

	if (paused) {
		// Only this rule's own pauses are ours to lift.
		if (pauseReason !== USAGE_THRESHOLD_PAUSE_REASON) return { action: "none" };

		const everyWindowRecovered = configured.every(
			(entry) => entry.state === "clear",
		);
		return everyWindowRecovered ? { action: "resume" } : { action: "none" };
	}

	for (const entry of configured) {
		if (entry.state !== "holds") continue;
		const threshold = effectiveThreshold(entry.setting);
		const minReset = effectiveMinResetRemainingMs(entry.setting);
		return {
			action: "pause",
			window: entry.window,
			utilization: threshold === null ? null : entry.utilization,
			threshold,
			resetRemainingMs:
				minReset === null || entry.resetMs === null
					? null
					: entry.resetMs - now,
			minResetRemainingMs: minReset,
		};
	}

	return { action: "none" };
}

/**
 * Read a nested numeric field (e.g. `payload.tokens_limit.percentage`) off an
 * object, returning `null` when the parent is missing/not an object or the
 * field is missing/non-numeric.
 */
function readNestedNumber(
	data: Record<string, unknown>,
	parentKey: string,
	childKey: string,
): number | null {
	const parent = data[parentKey];
	if (typeof parent !== "object" || parent === null) return null;
	const value = (parent as Record<string, unknown>)[childKey];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * zai payload shape: `{ tokens_limit: {percentage}|null, tokens_limit_weekly:
 * {percentage}|null, time_limit: ... }`. `time_limit` caps the web tools, not
 * model traffic, so it is never read into either window — mirrors the
 * exclusion `tokenWindows()` in the zai usage fetcher already applies.
 * `tokens_limit_weekly` is legitimately absent on single-window plans, which
 * reads back as `null`, not an error.
 */
function readZaiUtilization(data: Record<string, unknown>): UsageUtilization {
	return {
		fiveHour: readNestedNumber(data, "tokens_limit", "percentage"),
		weekly: readNestedNumber(data, "tokens_limit_weekly", "percentage"),
	};
}

/**
 * nanogpt payload shape: `{ active: boolean, daily: {percentUsed}, monthly:
 * {percentUsed}, ... }`, with `percentUsed` a 0-1 decimal. An inactive
 * (pay-as-you-go) account has no usage window at all, matching
 * `getRepresentativeNanoGPTUtilization`'s null-on-inactive precedent
 * elsewhere in the codebase.
 *
 * The two-slot fiveHour/weekly schema is reused to mean "daily" and
 * "monthly" for nanogpt specifically — an intentional mapping, not a
 * mismatch with the window names.
 */
function readNanoGptUtilization(
	data: Record<string, unknown>,
): UsageUtilization {
	if (data.active === false) {
		return { fiveHour: null, weekly: null };
	}

	const toPercent = (parentKey: string): number | null => {
		const raw = readNestedNumber(data, parentKey, "percentUsed");
		return raw === null ? null : raw * 100;
	};

	return {
		fiveHour: toPercent("daily"),
		weekly: toPercent("monthly"),
	};
}

/**
 * xai payload shape: `{ credits: { utilization, resets_at } }`
 * (`XaiUsageData`), one window for Grok Build credits. It fills the weekly
 * slot, the long one, because it is plainly not a 5-hour window: the fetcher
 * takes the reset from a protobuf timestamp and decodes no period field, and
 * the only resets on record are days ahead (SB23-3686). What the code does
 * not establish is the exact period, so the dashboard labels the slot "Grok
 * credits" rather than "Weekly". The 5-hour slot reads null because xAI has no
 * such window, and {@link usagePauseWindowsForProvider} keeps it out of the
 * decision.
 */
function readXaiUtilization(data: Record<string, unknown>): UsageUtilization {
	return {
		fiveHour: null,
		weekly: readNestedNumber(data, "credits", "utilization"),
	};
}

/**
 * Read the 5-hour and weekly utilization out of a usage payload.
 *
 * `provider` selects the payload shape to parse. Anthropic, codex, minimax and
 * any unrecognized/omitted provider all fall through to the Anthropic-shaped
 * parsing below: codex reports in that shape, and minimax's fetcher
 * (`parseMinimaxTokenPlanResponse`) normalizes its response to the same
 * `five_hour`/`seven_day` flat fields before it reaches this function. zai,
 * nanogpt and xai have their own payload shapes and get dedicated parsing.
 * xai is chosen by the provider, never by the presence of a `credits` key,
 * which a Codex payload carries too.
 *
 * Anthropic is moving the flat `five_hour` / `seven_day` fields into a generic
 * `limits[]` array, and a payload can carry either shape (or both, mid
 * migration). The flat fields win when present; `limits[]` fills in whatever
 * they leave out, mapping `kind: "session"` to the 5-hour window and
 * `kind: "weekly_all"` to the weekly one. Per-model weekly caps
 * (`kind: "weekly_scoped"`) are deliberately ignored — a threshold on "the
 * weekly window" means the all-models window, not the Opus sub-cap.
 *
 * Anything missing or non-numeric reads back as `null`, which
 * {@link evaluateUsagePause} treats as "unknown", never as "recovered".
 */
export function readUsageUtilization(
	payload: unknown,
	provider?: string | null,
): UsageUtilization {
	if (typeof payload !== "object" || payload === null) {
		return { fiveHour: null, weekly: null };
	}
	const data = payload as Record<string, unknown>;

	if (provider === "zai") return readZaiUtilization(data);
	if (provider === "nanogpt") return readNanoGptUtilization(data);
	if (provider === "xai") return readXaiUtilization(data);

	const flat = (key: string): number | null => {
		const window = data[key];
		if (typeof window !== "object" || window === null) return null;
		const value = (window as { utilization?: unknown }).utilization;
		return typeof value === "number" && Number.isFinite(value) ? value : null;
	};

	const fromLimits = (kind: string): number | null => {
		const limits = data.limits;
		if (!Array.isArray(limits)) return null;
		for (const entry of limits) {
			if (typeof entry !== "object" || entry === null) continue;
			const limit = entry as { kind?: unknown; percent?: unknown };
			if (limit.kind !== kind) continue;
			return typeof limit.percent === "number" && Number.isFinite(limit.percent)
				? limit.percent
				: null;
		}
		return null;
	};

	return {
		fiveHour: flat("five_hour") ?? fromLimits("session"),
		weekly: flat("seven_day") ?? fromLimits("weekly_all"),
	};
}

/**
 * A reset timestamp as epoch milliseconds, from either shape the providers use:
 * an ISO string (`resets_at`, Anthropic/Codex) or epoch milliseconds already
 * (`resetAt`, zai/nanogpt/minimax). Mirrors `extractUsageResetMs` in
 * packages/providers/src/usage-fetcher.ts, which core cannot import.
 */
function toResetMs(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string") {
		const ms = new Date(value).getTime();
		return Number.isFinite(ms) ? ms : null;
	}
	return null;
}

function readWindowReset(window: unknown): number | null {
	if (typeof window !== "object" || window === null) return null;
	const w = window as { resets_at?: unknown; resetAt?: unknown };
	return toResetMs(w.resets_at) ?? toResetMs(w.resetAt);
}

/**
 * Read when the 5-hour and weekly windows reset, off the SAME payload key each
 * window's utilization is read from in {@link readUsageUtilization}. Pairing a
 * utilization with a reset from a different window is the defect
 * `getRepresentativeUsageSnapshotForProvider` exists to prevent, so the two
 * readers share their key choices line for line: zai `tokens_limit` and
 * `tokens_limit_weekly` (never `time_limit`), nanogpt `daily` and `monthly`,
 * xai `credits` for the weekly window only, and otherwise the flat `five_hour` / `seven_day` with `limits[]` kinds
 * `session` / `weekly_all` filling in what they leave out.
 *
 * The flat-or-limits choice is made per window by where the UTILIZATION came
 * from, not by which one carries a reset, so a flat window with no reset never
 * borrows the limits entry's.
 */
export function readUsageResets(
	payload: unknown,
	provider?: string | null,
): UsageResets {
	if (typeof payload !== "object" || payload === null) {
		return { fiveHour: null, weekly: null };
	}
	const data = payload as Record<string, unknown>;

	if (provider === "zai") {
		return {
			fiveHour: readWindowReset(data.tokens_limit),
			weekly: readWindowReset(data.tokens_limit_weekly),
		};
	}
	if (provider === "nanogpt") {
		if (data.active === false) return { fiveHour: null, weekly: null };
		return {
			fiveHour: readWindowReset(data.daily),
			weekly: readWindowReset(data.monthly),
		};
	}
	if (provider === "xai") {
		return { fiveHour: null, weekly: readWindowReset(data.credits) };
	}

	const hasFlatUtilization = (key: string): boolean => {
		const window = data[key];
		if (typeof window !== "object" || window === null) return false;
		const value = (window as { utilization?: unknown }).utilization;
		return typeof value === "number" && Number.isFinite(value);
	};

	const fromLimits = (kind: string): number | null => {
		const limits = data.limits;
		if (!Array.isArray(limits)) return null;
		for (const entry of limits) {
			if (typeof entry !== "object" || entry === null) continue;
			const limit = entry as { kind?: unknown };
			if (limit.kind !== kind) continue;
			return readWindowReset(entry);
		}
		return null;
	};

	return {
		fiveHour: hasFlatUtilization("five_hour")
			? readWindowReset(data.five_hour)
			: fromLimits("session"),
		weekly: hasFlatUtilization("seven_day")
			? readWindowReset(data.seven_day)
			: fromLimits("weekly_all"),
	};
}

/**
 * Normalize a reset minimum coming from an API body or a CLI argument into
 * whole milliseconds between 0 and `MAX_MIN_RESET_REMAINING_MS`, or `null` for
 * "condition off". The same bound and the same message shape as the combo slot
 * field's handler (packages/http-api/src/handlers/combos.ts), because the two
 * are the same setting on two surfaces.
 *
 * 0 is legal, as it is on the slot: it holds for any reset still ahead. Like the
 * percent parser, anything else throws rather than being clamped.
 */
export function parseUsagePauseMinResetMs(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const parsed = typeof value === "string" ? Number(value) : value;
	if (
		typeof parsed !== "number" ||
		!Number.isInteger(parsed) ||
		parsed < 0 ||
		parsed > MAX_MIN_RESET_REMAINING_MS
	) {
		throw new Error(
			`minResetRemainingMs must be an integer between 0 and ${MAX_MIN_RESET_REMAINING_MS}, or null`,
		);
	}
	return parsed;
}

/**
 * Normalize a threshold coming from an API body, a CLI argument or a form
 * field into a whole percentage between 1 and 100, or `null` for "unset".
 *
 * Throws on anything else rather than silently clamping: a typo that turns
 * into a 100 would quietly disable the very protection the caller asked for,
 * and one that turns into a 1 would bench the account immediately.
 */
export function parseUsagePauseThreshold(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;

	const parsed = typeof value === "string" ? Number(value) : value;
	if (typeof parsed !== "number" || !Number.isInteger(parsed)) {
		throw new Error(
			"Usage pause threshold must be a whole number between 1 and 100",
		);
	}
	if (parsed < 1 || parsed > 100) {
		throw new Error(
			"Usage pause threshold must be a whole number between 1 and 100",
		);
	}
	return parsed;
}

/**
 * Providers whose usage poller actually evaluates pause thresholds today
 * (`applyUsagePauseThresholds` in apps/server/src/server.ts, wired into
 * `startUsagePollingWithRefresh`'s `onSnapshot` callback).
 *
 * `readUsageUtilization` now understands anthropic and codex (the shared
 * flat `five_hour`/`seven_day`/`limits[]` shape), zai, nanogpt and xai (their
 * own dedicated payload shapes; xai's single `credits` window is the weekly
 * slot, see {@link usagePauseWindowsForProvider}), and minimax (whose fetcher
 * already normalizes its response to the same flat shape before it reaches
 * `readUsageUtilization`, so it rides the anthropic/codex path with no
 * dedicated branch).
 *
 * Two providers remain excluded, for different reasons:
 *   - `kilo` reports a dollar-credits balance, not a percentage window —
 *     there is no "utilization" to compare a threshold against.
 *   - `alibaba-coding-plan` has no pollable usage API at all; reading its
 *     usage would require session-cookie auth against Alibaba's website,
 *     which has never been implemented.
 *
 * Not to be confused with `supportsRefreshBackedUsagePolling` in
 * apps/server/src/server.ts, which gates a strict subset of this list — only
 * anthropic/codex/xai are polled through the OAuth-refresh-backed path.
 * zai/nanogpt/minimax support pause thresholds too, but are polled through
 * their own dedicated bootstrap blocks with their own `onSnapshot` wiring.
 */
export function supportsUsagePauseThreshold(
	provider: string | null | undefined,
): boolean {
	return (
		provider === "anthropic" ||
		provider === "codex" ||
		provider === "xai" ||
		provider === "zai" ||
		provider === "nanogpt" ||
		provider === "minimax"
	);
}
