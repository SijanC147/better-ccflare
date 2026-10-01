/**
 * Turns dashboard data into notification transitions (SB23-2598).
 *
 * Each category is reduced to an observation: a map from a stable key (an
 * account id, an alert id, the service) to that key's current problem state.
 * A key that is absent is healthy. The dispatcher compares an observation
 * with the baseline stored for its category and notifies only on a
 * difference, so a reload, a refetch returning the same data, or a second tab
 * reading the same baseline sends nothing.
 *
 * Everything here is pure apart from the storage and notifier it is handed.
 */
import type {
	AccountResponse,
	AlertEvent,
	RateLimitReason,
} from "@better-ccflare/types";
import type { ServiceStatusResponse } from "../api";
import {
	baselineStorageKey,
	type KeyValueStorage,
	type NotificationCategory,
	type NotificationMessage,
	type NotificationPrefs,
	type Notifier,
	readJson,
	removeKey,
	writeJson,
} from "./notifications";

/** One key's problem state. `label` names it in a message. */
export interface ObservedEntry {
	state: string;
	label: string;
	/** Extra words for the message body, such as a reset time. */
	detail?: string;
}

/**
 * A category's reading. `null` means there is no usable reading at all, which
 * is different from "nothing is wrong": evaluation is skipped and the stored
 * baseline kept, so a monitoring gap neither notifies nor erases what the
 * next good reading should be compared with.
 */
export type Observation = Record<string, ObservedEntry> | null;

export type Baseline = Record<string, { state: string; label: string }>;

/**
 * How old a stored baseline may be and still count. A baseline is rewritten on
 * every evaluation, so one older than this means no tab was watching: the
 * page was closed, or notifications could not run. Diffing a fresh reading
 * against it would announce, on page load, whatever changed while nobody was
 * looking, such as an outage that ended overnight. Ten minutes is several
 * cadences of the slowest source (2 minutes) with room for a hidden tab's
 * timers being throttled to once a minute.
 */
export const BASELINE_MAX_AGE_MS = 10 * 60_000;

interface StoredBaseline {
	at: number;
	entries: Baseline;
}

/**
 * The stored baseline, or undefined when there is none, it is unreadable, or
 * it is older than `BASELINE_MAX_AGE_MS` at `now`.
 */
export function loadBaseline(
	storage: KeyValueStorage | null,
	category: NotificationCategory,
	now: number = Date.now(),
): Baseline | undefined {
	const stored = readJson(storage, baselineStorageKey(category));
	if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
		return undefined;
	}
	const { at, entries } = stored as Partial<StoredBaseline>;
	if (typeof at !== "number" || now - at > BASELINE_MAX_AGE_MS) {
		return undefined;
	}
	if (
		typeof entries !== "object" ||
		entries === null ||
		Array.isArray(entries)
	) {
		return undefined;
	}
	const baseline: Baseline = {};
	for (const [key, value] of Object.entries(entries)) {
		if (
			typeof value === "object" &&
			value !== null &&
			typeof (value as { state?: unknown }).state === "string" &&
			typeof (value as { label?: unknown }).label === "string"
		) {
			baseline[key] = {
				state: (value as { state: string }).state,
				label: (value as { label: string }).label,
			};
		}
	}
	return baseline;
}

export function clearBaseline(
	storage: KeyValueStorage | null,
	category: NotificationCategory,
): void {
	removeKey(storage, baselineStorageKey(category));
}

export interface Transition {
	key: string;
	label: string;
	from: string | null;
	to: string | null;
	detail?: string;
}

export interface TransitionSet {
	/** Healthy, or unseen, to a problem state. */
	entered: Transition[];
	/** One problem state to another. */
	changed: Transition[];
	/** A problem state to healthy. */
	recovered: Transition[];
}

export function diffObservation(
	previous: Baseline,
	next: Record<string, ObservedEntry>,
): TransitionSet {
	const set: TransitionSet = { entered: [], changed: [], recovered: [] };
	for (const key of Object.keys(next).sort()) {
		const entry = next[key];
		const before = previous[key];
		if (!before) {
			set.entered.push({
				key,
				label: entry.label,
				from: null,
				to: entry.state,
				detail: entry.detail,
			});
		} else if (before.state !== entry.state) {
			set.changed.push({
				key,
				label: entry.label,
				from: before.state,
				to: entry.state,
				detail: entry.detail,
			});
		}
	}
	for (const key of Object.keys(previous).sort()) {
		if (!(key in next)) {
			set.recovered.push({
				key,
				label: previous[key].label,
				from: previous[key].state,
				to: null,
			});
		}
	}
	return set;
}

/** Turns a category's transitions into the messages to show. */
export type MessageBuilder = (
	transitions: TransitionSet,
) => NotificationMessage[];

export interface EvaluateOptions {
	category: NotificationCategory;
	observation: Observation;
	prefs: NotificationPrefs;
	storage: KeyValueStorage | null;
	notify: Notifier;
	build: MessageBuilder;
	/** Defaults to `Date.now()`; passed by tests that age a baseline. */
	now?: number;
}

/**
 * Compare one observation with the stored baseline, notify on transitions,
 * and store the observation as the new baseline. Returns the messages sent.
 *
 * - The category off, or the master switch off: nothing is sent and the
 *   baseline is left alone. It is NOT cleared here: another tab may have the
 *   category on and depend on it. Clearing happens at the toggle, in the
 *   provider, which is what makes switching back on start from a fresh
 *   reading rather than replaying whatever happened while it was off.
 * - No usable reading: nothing is sent and the baseline's entries are kept,
 *   with its age refreshed, because a tab was watching and saw a gap.
 * - No stored baseline, or one older than `BASELINE_MAX_AGE_MS`: this
 *   reading becomes the baseline and nothing is sent, which is what keeps a
 *   page load quiet, including after the page was closed for hours.
 *
 * The baseline is read from storage on every call rather than held in memory,
 * so a reload resumes from it and two open tabs share it.
 */
export function evaluateCategory(
	options: EvaluateOptions,
): NotificationMessage[] {
	const { category, observation, prefs, storage, notify, build } = options;
	const now = options.now ?? Date.now();
	if (!prefs.enabled || !prefs.categories[category]) return [];
	const previous = loadBaseline(storage, category, now);
	if (observation === null) {
		if (previous !== undefined) {
			const kept: StoredBaseline = { at: now, entries: previous };
			writeJson(storage, baselineStorageKey(category), kept);
		}
		return [];
	}
	const nextBaseline: Baseline = {};
	for (const [key, entry] of Object.entries(observation)) {
		nextBaseline[key] = { state: entry.state, label: entry.label };
	}
	const stored: StoredBaseline = { at: now, entries: nextBaseline };
	writeJson(storage, baselineStorageKey(category), stored);
	if (previous === undefined) return [];
	const messages = build(diffObservation(previous, observation));
	for (const message of messages) notify(message);
	return messages;
}

const timeFormatter = new Intl.DateTimeFormat(undefined, {
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
});

/** A reset time as the viewer's local 24-hour clock. */
export function formatClock(ms: number): string {
	return timeFormatter.format(new Date(ms));
}

function tagFor(
	category: NotificationCategory,
	kind: string,
	transitions: Transition[],
): string {
	const parts = transitions.map((t) => `${t.key}=${t.to ?? "ok"}`);
	return `better-ccflare:${category}:${kind}:${parts.join(",")}`;
}

function listLabels(transitions: Transition[]): string {
	return transitions.map((t) => t.label).join(", ");
}

function describeEach(
	transitions: Transition[],
	describe: (state: string) => string,
): string {
	return transitions
		.map((t) => {
			const what = describe(t.to ?? "");
			return t.detail
				? `${t.label}: ${what} ${t.detail}`
				: `${t.label}: ${what}`;
		})
		.join("; ");
}

// ---------------------------------------------------------------------------
// Service outage
// ---------------------------------------------------------------------------

const SERVICE_KEY = "claude";

export function observeServiceStatus(
	response: ServiceStatusResponse | undefined,
): Observation {
	const snapshot = response?.snapshot ?? null;
	// `unknown` means the watched components could not be read, and a null
	// snapshot means the page has been unreachable since startup. Both are a
	// gap in monitoring, which the banner already shows; neither is an outage,
	// and treating either as "operational" would announce a recovery that did
	// not happen.
	if (snapshot === null || snapshot.level === "unknown") return null;
	if (snapshot.level === "operational") return {};
	const affected = snapshot.affected.map((c) => c.name).join(", ");
	return {
		[SERVICE_KEY]: {
			state: snapshot.level,
			label: "Claude",
			detail: affected || undefined,
		},
	};
}

export function buildServiceMessages(
	transitions: TransitionSet,
): NotificationMessage[] {
	const messages: NotificationMessage[] = [];
	for (const t of [...transitions.entered, ...transitions.changed]) {
		const outage = t.to === "outage";
		messages.push({
			title: outage
				? "Claude service outage reported"
				: "Claude service degraded",
			body: t.detail
				? `status.claude.com reports a problem with ${t.detail}.`
				: "status.claude.com reports a problem with a component better-ccflare depends on.",
			tag: tagFor("serviceOutage", "state", [t]),
			path: "/",
		});
	}
	for (const t of transitions.recovered) {
		messages.push({
			title: "Claude service recovered",
			body: "status.claude.com reports every watched component operational again.",
			tag: tagFor("serviceOutage", "recovered", [t]),
			path: "/",
		});
	}
	return messages;
}

// ---------------------------------------------------------------------------
// Accounts: rate limits and health
// ---------------------------------------------------------------------------

/**
 * What a `rateLimitedUntil` lock means, by the reason the proxy recorded.
 *
 * A `Record` over the whole union rather than a list of strings, so a reason
 * added to `RateLimitReason` fails the typecheck here instead of silently
 * landing in no category.
 *
 * - `quota`: the account ran out of capacity (a 429 family reason).
 * - `bench`: the account was set aside after an upstream failure that says
 *   nothing about its quota (overload, server error, an org-level refusal).
 */
export const RATE_LIMIT_REASON_KIND: Record<
	RateLimitReason,
	"quota" | "bench"
> = {
	upstream_429_with_reset: "quota",
	upstream_429_no_reset_default_5h: "quota",
	upstream_429_no_reset_probe_cooldown: "quota",
	model_fallback_429: "quota",
	all_models_exhausted_429: "quota",
	out_of_credits: "quota",
	extra_usage_exhausted: "quota",
	windowless_429: "quota",
	upstream_529_overloaded_with_reset: "bench",
	upstream_529_overloaded_no_reset: "bench",
	org_permission_denied: "bench",
	upstream_5xx_server_error: "bench",
};

/**
 * Hard-limit prefixes of `rateLimitStatus`, the same list the account card
 * uses to decide an account is actually blocked rather than warned.
 */
const HARD_LIMIT_PREFIXES = [
	"rate_limited",
	"blocked",
	"queueing_hard",
	"payment_required",
];

/** Pause reasons that mean quota is spent rather than the account broken. */
const QUOTA_PAUSE_REASONS = new Set(["usage_threshold", "overage"]);

/**
 * Pause reasons that are an operator or a schedule acting on purpose, not a
 * degradation. Every other pause, `failure_threshold` and any reason added
 * later, is reported as health.
 */
const DELIBERATE_PAUSE_REASONS = new Set(["manual", "peak_hours"]);

type AccountForNotifications = Pick<
	AccountResponse,
	| "id"
	| "name"
	| "paused"
	| "pauseReason"
	| "requiresReauth"
	| "rateLimitStatus"
	| "rateLimitReset"
	| "rateLimitedUntil"
	| "rateLimitedReason"
	| "usageUtilization"
	| "usageThrottledUntil"
>;

function lockKind(
	account: AccountForNotifications,
	now: number,
): "quota" | "bench" | null {
	const locked =
		typeof account.rateLimitedUntil === "number" &&
		account.rateLimitedUntil > now;
	if (!locked) return null;
	// A lock with no recorded reason predates the reason column; the proxy
	// only ever set one for a rate limit then.
	if (account.rateLimitedReason === null) return "quota";
	return RATE_LIMIT_REASON_KIND[account.rateLimitedReason] ?? "quota";
}

/**
 * A hard-limit `rateLimitStatus`, while it is still current.
 *
 * The server copies the status column verbatim, and that column changes only
 * on the account's next upstream response. An account limited and then not
 * routed to keeps `rate_limited` long after its limit lifted, which would
 * hold back the recovery notification until it next served a request. So the
 * status counts only while nothing says it has lapsed: not after its own
 * `rateLimitReset`, and not after the lock that came with it expired.
 */
function isHardLimited(account: AccountForNotifications, now: number): boolean {
	const status = (account.rateLimitStatus ?? "").toLowerCase();
	if (!HARD_LIMIT_PREFIXES.some((prefix) => status.startsWith(prefix))) {
		return false;
	}
	if (account.rateLimitReset) {
		const reset = Date.parse(account.rateLimitReset);
		if (Number.isFinite(reset) && reset <= now) return false;
	}
	if (
		typeof account.rateLimitedUntil === "number" &&
		account.rateLimitedUntil <= now
	) {
		return false;
	}
	return true;
}

function untilDetail(
	account: AccountForNotifications,
	now: number,
): string | undefined {
	return typeof account.rateLimitedUntil === "number" &&
		account.rateLimitedUntil > now
		? `until ${formatClock(account.rateLimitedUntil)}`
		: undefined;
}

/** The quota state of one account, or null when it has capacity. */
export function rateLimitState(
	account: AccountForNotifications,
	now: number,
): string | null {
	if (account.paused && QUOTA_PAUSE_REASONS.has(account.pauseReason ?? "")) {
		return "quota_paused";
	}
	if (account.paused || account.requiresReauth) return null;
	if (lockKind(account, now) === "quota" || isHardLimited(account, now)) {
		return "rate_limited";
	}
	if (
		typeof account.usageUtilization === "number" &&
		account.usageUtilization >= 100
	) {
		return "quota_exhausted";
	}
	return null;
}

/** The health state of one account, or null when it is healthy. */
export function accountHealthState(
	account: AccountForNotifications,
	now: number,
): string | null {
	if (account.requiresReauth) return "requires_reauth";
	if (account.paused) {
		const reason = account.pauseReason ?? "";
		if (DELIBERATE_PAUSE_REASONS.has(reason)) return null;
		if (QUOTA_PAUSE_REASONS.has(reason)) return null;
		return "paused";
	}
	if (lockKind(account, now) === "bench") return "benched";
	return null;
}

export const POOL_KEY = "__pool__";

export function observeRateLimits(
	accounts: AccountForNotifications[] | undefined,
	now: number,
): Observation {
	if (!accounts) return null;
	const observation: Record<string, ObservedEntry> = {};
	let considered = 0;
	let limited = 0;
	for (const account of accounts) {
		const state = rateLimitState(account, now);
		const quotaPaused = state === "quota_paused";
		// The pool is the accounts the selector could route to were it not for
		// quota: not awaiting re-authentication, not paused for any other
		// reason, not benched for a server error.
		const inPool =
			!account.requiresReauth &&
			(!account.paused || quotaPaused) &&
			lockKind(account, now) !== "bench";
		if (inPool) considered += 1;
		// Proactive usage throttling is pacing, not exhaustion, so it does not
		// notify per account. But the selector skips a throttled account, and a
		// pool where every account is throttled answers the client with a 529,
		// so it counts toward the pool being exhausted.
		const throttled =
			typeof account.usageThrottledUntil === "number" &&
			account.usageThrottledUntil > now;
		if (inPool && (state !== null || throttled)) limited += 1;
		if (state === null) continue;
		observation[account.id] = {
			state,
			label: account.name,
			detail: state === "rate_limited" ? untilDetail(account, now) : undefined,
		};
	}
	if (considered > 0 && limited === considered) {
		observation[POOL_KEY] = {
			state: "exhausted",
			label: "Every routable account",
		};
	}
	return observation;
}

export function observeAccountHealth(
	accounts: AccountForNotifications[] | undefined,
	now: number,
): Observation {
	if (!accounts) return null;
	const observation: Record<string, ObservedEntry> = {};
	for (const account of accounts) {
		const state = accountHealthState(account, now);
		if (state === null) continue;
		observation[account.id] = {
			state,
			label: account.name,
			detail: state === "benched" ? untilDetail(account, now) : undefined,
		};
	}
	return observation;
}

const RATE_LIMIT_WORDS: Record<string, string> = {
	rate_limited: "rate-limited",
	quota_exhausted: "usage quota exhausted",
	quota_paused: "paused at its usage limit",
};

export function buildRateLimitMessages(
	transitions: TransitionSet,
): NotificationMessage[] {
	const messages: NotificationMessage[] = [];
	const isPool = (t: Transition) => t.key === POOL_KEY;
	const poolEntered = [...transitions.entered, ...transitions.changed].filter(
		isPool,
	);
	const poolRecovered = transitions.recovered.filter(isPool);
	const entered = [...transitions.entered, ...transitions.changed].filter(
		(t) => !isPool(t),
	);
	const recovered = transitions.recovered.filter((t) => !isPool(t));
	if (poolEntered.length > 0) {
		messages.push({
			title: "Every account is rate-limited",
			body: "No routable account has capacity left; requests will fail until a limit resets.",
			tag: tagFor("rateLimit", "pool", poolEntered),
			path: "/accounts",
		});
	}
	if (entered.length > 0) {
		messages.push({
			title:
				entered.length === 1
					? `Account rate-limited: ${entered[0].label}`
					: `${entered.length} accounts rate-limited`,
			body: describeEach(entered, (s) => RATE_LIMIT_WORDS[s] ?? s),
			tag: tagFor("rateLimit", "entered", entered),
			path: "/accounts",
		});
	}
	if (poolRecovered.length > 0) {
		messages.push({
			title: "Accounts available again",
			body: "At least one routable account has capacity again.",
			tag: tagFor("rateLimit", "pool-recovered", poolRecovered),
			path: "/accounts",
		});
	}
	if (recovered.length > 0) {
		messages.push({
			title:
				recovered.length === 1
					? `Rate limit cleared: ${recovered[0].label}`
					: `${recovered.length} rate limits cleared`,
			body: `${listLabels(recovered)} ${recovered.length === 1 ? "has" : "have"} capacity again.`,
			tag: tagFor("rateLimit", "recovered", recovered),
			path: "/accounts",
		});
	}
	return messages;
}

const HEALTH_WORDS: Record<string, string> = {
	requires_reauth: "needs re-authentication",
	paused: "paused automatically",
	benched: "benched after upstream errors",
};

export function buildAccountHealthMessages(
	transitions: TransitionSet,
): NotificationMessage[] {
	const messages: NotificationMessage[] = [];
	const degraded = [...transitions.entered, ...transitions.changed];
	if (degraded.length > 0) {
		messages.push({
			title:
				degraded.length === 1
					? `Account ${HEALTH_WORDS[degraded[0].to ?? ""] ?? "degraded"}: ${degraded[0].label}`
					: `${degraded.length} accounts need attention`,
			body: describeEach(degraded, (s) => HEALTH_WORDS[s] ?? s),
			tag: tagFor("accountHealth", "degraded", degraded),
			path: "/accounts",
		});
	}
	if (transitions.recovered.length > 0) {
		const recovered = transitions.recovered;
		messages.push({
			title:
				recovered.length === 1
					? `Account healthy again: ${recovered[0].label}`
					: `${recovered.length} accounts healthy again`,
			body: `${listLabels(recovered)} ${recovered.length === 1 ? "is" : "are"} back in rotation.`,
			tag: tagFor("accountHealth", "recovered", recovered),
			path: "/accounts",
		});
	}
	return messages;
}

// ---------------------------------------------------------------------------
// Error bursts
// ---------------------------------------------------------------------------

type AlertForNotifications = Pick<
	AlertEvent,
	"id" | "type" | "title" | "message" | "acknowledged"
>;

/**
 * Open upstream error alerts, keyed by alert id.
 *
 * The server decides what a burst is and how often it may fire again (one id
 * per cooldown bucket), so a new id is exactly one new burst and the client
 * adds no threshold of its own. An alert acknowledged before this tab saw it
 * is not news, and an alert that leaves the list is not a recovery: bursts
 * are events, not states, and the message builder sends nothing for them.
 */
export function observeErrorBursts(
	alerts: AlertForNotifications[] | undefined,
): Observation {
	if (!alerts) return null;
	const observation: Record<string, ObservedEntry> = {};
	for (const alert of alerts) {
		if (alert.type !== "upstream_error" || alert.acknowledged) continue;
		observation[alert.id] = {
			state: "open",
			label: alert.title,
			detail: alert.message,
		};
	}
	return observation;
}

export function buildErrorBurstMessages(
	transitions: TransitionSet,
): NotificationMessage[] {
	const fresh = transitions.entered;
	if (fresh.length === 0) return [];
	return [
		{
			title:
				fresh.length === 1
					? fresh[0].label
					: `${fresh.length} upstream error bursts`,
			body: fresh.map((t) => t.detail ?? t.label).join(" "),
			tag: tagFor("errorBurst", "new", fresh),
			path: "/insights",
		},
	];
}

export const MESSAGE_BUILDERS: Record<NotificationCategory, MessageBuilder> = {
	serviceOutage: buildServiceMessages,
	rateLimit: buildRateLimitMessages,
	accountHealth: buildAccountHealthMessages,
	errorBurst: buildErrorBurstMessages,
};
