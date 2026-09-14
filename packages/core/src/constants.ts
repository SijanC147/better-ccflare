/**
 * Centralized constants for the better-ccflare application
 * All magic numbers should be defined here to improve maintainability
 */

import type { RateLimitReason } from "@better-ccflare/types";

// Time constants (all in milliseconds)
export const TIME_CONSTANTS = {
	// Base units
	SECOND: 1000,
	MINUTE: 60 * 1000,
	HOUR: 60 * 60 * 1000,
	DAY: 24 * 60 * 60 * 1000,

	// Session durations - specifically for Anthropic usage windows
	ANTHROPIC_SESSION_DURATION_DEFAULT: 5 * 60 * 60 * 1000, // 5 hours - default for Anthropic provider session tracking
	ANTHROPIC_SESSION_DURATION_FALLBACK: 1 * 60 * 60 * 1000, // 1 hour - fallback for Anthropic provider
	/**
	 * @deprecated Use ANTHROPIC_SESSION_DURATION_DEFAULT instead.
	 * This constant is kept for backward compatibility only and should not be used in new code.
	 */
	SESSION_DURATION_DEFAULT: 5 * 60 * 60 * 1000, // 5 hours - kept for backward compatibility - new code should use ANTHROPIC_SESSION_DURATION_DEFAULT

	// Timeouts
	STREAM_TIMEOUT_DEFAULT: 1000 * 60 * 1, // 1 minute
	STREAM_READ_TIMEOUT_MS: 60000, // 60 seconds - overall timeout for stream reads
	STREAM_OPERATION_TIMEOUT_MS: 30000, // 30 seconds - timeout per read operation

	OAUTH_STATE_TTL: 10, // 10 minutes (stored separately as minutes)
	RETRY_DELAY_DEFAULT: 1000, // 1 second
	PROXY_REQUEST_TIMEOUT_MS: 30 * 60 * 1000, // 30 minutes — covers long agent calls

	// Cache durations
	CACHE_YEAR: 31536000, // 365 days in seconds for HTTP cache headers

	// Token expiration durations
	API_KEY_TOKEN_EXPIRY_MS: 365 * 24 * 60 * 60 * 1000, // 1 year - for API keys that don't expire
	GOOGLE_TOKEN_EXPIRY_MS: 60 * 60 * 1000, // 1 hour - Google Cloud access tokens

	// Default cooldown applied when an upstream returns 429 *without* a
	// reset hint (no `retry-after`, no rate-limit-reset header, no SSE
	// reset frame, no usage-cache window reset). Treats the cooldown
	// as a probe interval rather than a hard ban: the account is
	// excluded for a short window, then the next request re-probes.
	// Real upstream rate-limit replies ship a retry-after / reset
	// header and use the precise value from the header — those flows
	// are unaffected by this default.
	// Override at runtime via CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS.
	DEFAULT_RATE_LIMIT_NO_RESET_COOLDOWN_MS: 60 * 1000, // 60s

	// Adaptive rate-limit cooldown with exponential backoff.
	// Cooldown for streak of n consecutive 429s = BASE * 2^(n-1), capped at MAX.
	// Override at runtime via CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS /
	// CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS / CCFLARE_RATE_LIMIT_RESET_STABILITY_MS.
	RATE_LIMIT_BACKOFF_BASE_MS: 30 * 1000, // 30s: cooldown for the 1st 429 in a streak
	RATE_LIMIT_BACKOFF_MAX_MS: 5 * 60 * 1000, // 5min: ceiling for the exponential ramp
	RATE_LIMIT_RESET_STABILITY_MS: 5 * 60 * 1000, // 5min: healthy operation needed to reset the streak counter

	// Fixed cooldown applied when an upstream returns 529 (overloaded_error)
	// with NO retry-after / reset hint. A 529 is a transient upstream SERVER
	// state, not a signal about the account's own quota — it says nothing
	// about how much capacity the account has left. Unlike 429 cooldowns it
	// never ramps with a streak and never touches consecutive_rate_limits:
	// that counter is reserved for genuine 429 quota exhaustion.
	//
	// This is deliberately much shorter than the reset-less 429 default
	// (DEFAULT_RATE_LIMIT_NO_RESET_COOLDOWN_MS, 60s, above): that 60s cooldown
	// is UNGATED — once it expires, full concurrency returns to the account
	// immediately, so a long cooldown is the only thing limiting request rate.
	// This 10s cooldown pairs with the single-flight probe gate
	// (getRateLimitProbeAdmission in rate-limit-cooldown.ts), but what the
	// gate actually does for a suppressed request depends on whether ANY
	// other candidate is available, not on pool size:
	// - At least one other candidate is not suppressed: once the cooldown
	//   expires, the gate admits exactly one probe request for THIS account
	//   and suppresses the rest — a suppressed request does not wait for
	//   that probe, it moves on to the next candidate account in the same
	//   selection (proxy.ts's account loop), so concurrent requests spread
	//   across the pool instead of piling onto the one recovering account.
	// - EVERY candidate is suppressed (a single-account pool, or a
	//   pool-wide overload storm where every account's probe lease happens
	//   to be held): there is no other candidate to defer to, so the
	//   request runs the highest-priority candidate ungated instead of
	//   failing outright (proxy.ts's "every candidate suppressed"
	//   fallback). The gate suppresses nothing in that case; the short 10s
	//   value is the only thing bounding how often that ungated path
	//   re-hits the account during an overload storm.
	// Override at runtime via CCFLARE_OVERLOAD_COOLDOWN_MS.
	OVERLOAD_COOLDOWN_MS: 10 * 1000, // 10s

	// Cap on a 529-with-reset cooldown duration. A 529-with-reset honors
	// Anthropic's own retry-after value (min(resetTime, now + cap)), but that
	// resetTime can come from the anthropic-ratelimit-unified-reset header —
	// a quota-window reset that can be hours away (see provider.ts:368-380) —
	// rather than a short, per-request retry-after. A quota-window timestamp
	// carries no information about how long the *overload* itself lasts, so
	// this caps at OVERLOAD scale, not the 429 ramp ceiling: deliberately
	// identical to DEFAULT_RATE_LIMIT_NO_RESET_COOLDOWN_MS (60s, above) — the
	// repo's established "no usable signal" answer. A real, short retry-after
	// (≤ 60s) is still honored literally; only a multi-hour unified-reset
	// value gets capped down to this bound.
	// Override at runtime via CCFLARE_OVERLOAD_WITH_RESET_MAX_MS.
	OVERLOAD_WITH_RESET_MAX_MS: 60 * 1000, // 60s
} as const;

/**
 * Read a duration (ms) override from the environment, falling back to the
 * compiled-in default unless the value is a finite, positive number.
 *
 * Only a positive finite value is a usable duration. The other outcomes are
 * not weaker settings but broken state: a negative duration puts every
 * cooldown computed from it in the past, so it expires the moment it is
 * written (silently disabling the mechanism), and Infinity benches the
 * account forever — and throws RangeError where the resulting timestamp is
 * rendered via `new Date(...).toISOString()` for the audit log. Unset,
 * unparseable and 0 keep their previous meaning of "use the default".
 */
function readDurationOverrideMs(
	raw: string | undefined,
	fallback: number,
): number {
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Compute exponential-backoff cooldown (ms) for a given streak depth.
 *   backoff = BASE * 2^(consecutiveCount - 1), capped at MAX.
 * Reads BASE/MAX from env (CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS /
 * CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS), falling back to TIME_CONSTANTS
 * for anything that is not a positive finite duration.
 */
export function computeRateLimitBackoffMs(consecutiveCount: number): number {
	const count = Math.max(1, consecutiveCount);
	const base = readDurationOverrideMs(
		process.env.CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS,
		TIME_CONSTANTS.RATE_LIMIT_BACKOFF_BASE_MS,
	);
	const max = readDurationOverrideMs(
		process.env.CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS,
		TIME_CONSTANTS.RATE_LIMIT_BACKOFF_MAX_MS,
	);
	// Guard against overflow: 2^53 is JS safe-integer limit.
	const exponent = Math.min(count - 1, 52);
	return Math.min(base * 2 ** exponent, max);
}

/**
 * Read the stability-reset window (ms) for the consecutive_rate_limits counter.
 * Reads CCFLARE_RATE_LIMIT_RESET_STABILITY_MS from env.
 */
export function getRateLimitResetStabilityMs(): number {
	return readDurationOverrideMs(
		process.env.CCFLARE_RATE_LIMIT_RESET_STABILITY_MS,
		TIME_CONSTANTS.RATE_LIMIT_RESET_STABILITY_MS,
	);
}

/**
 * Read the fixed 529-overload cooldown (ms).
 * Reads CCFLARE_OVERLOAD_COOLDOWN_MS from env.
 */
export function computeOverloadCooldownMs(): number {
	return readDurationOverrideMs(
		process.env.CCFLARE_OVERLOAD_COOLDOWN_MS,
		TIME_CONSTANTS.OVERLOAD_COOLDOWN_MS,
	);
}

/**
 * Read the cap (ms) on a 529-with-reset cooldown duration.
 * Reads CCFLARE_OVERLOAD_WITH_RESET_MAX_MS from env.
 *
 * This value is applied as `min(resetTime, now + cap)`, so it is the only
 * clamp standing between a 529 that carries an anthropic-ratelimit-unified-reset
 * header (a quota window hours out) and an hours-long bench — a non-finite
 * override would not widen the cap but remove it.
 */
export function computeOverloadWithResetCapMs(): number {
	return readDurationOverrideMs(
		process.env.CCFLARE_OVERLOAD_WITH_RESET_MAX_MS,
		TIME_CONSTANTS.OVERLOAD_WITH_RESET_MAX_MS,
	);
}

/**
 * True for RateLimitReason values that represent an Anthropic 529
 * (overloaded_error) — a transient upstream state, not account quota
 * exhaustion. Used to route cooldown handling to the fixed overload
 * cooldown instead of the exponential 429 backoff ramp.
 */
export function isOverloadReason(reason: RateLimitReason): boolean {
	return (
		reason === "upstream_529_overloaded_with_reset" ||
		reason === "upstream_529_overloaded_no_reset"
	);
}

/**
 * The retry settings as the rest of the system states them: the three keys
 * `retry_attempts`, `retry_delay_ms` and `retry_backoff`, resolved by
 * packages/config from the config file, then the environment, then defaults.
 */
export interface RetrySettings {
	/** Total attempts for one upstream request, the first attempt included. */
	attempts: number;
	/** Base delay in milliseconds before the first retry. */
	delayMs: number;
	/** Multiplier applied per attempt. */
	backoff: number;
}

/** Fallbacks used when no resolved RetrySettings is supplied. */
export const RETRY_DEFAULTS: RetrySettings = {
	attempts: 3,
	delayMs: 1000,
	backoff: 2,
};

/** Jitter ceiling, in milliseconds, when CCFLARE_OVERLOAD_RETRY_MAX_MS is unset. */
const RETRY_MAX_DELAY_MS_DEFAULT = 3000;

/**
 * Resolves the retry policy actually applied on the proxy path.
 *
 * The documented keys drive it. `retry_attempts` counts the first attempt, so
 * `attempts: 1` disables retry; the loops below run `attempts - 1` retries.
 *
 * The `CCFLARE_OVERLOAD_RETRY_*` variables predate the documented keys and stay
 * honoured. They are deprecated: each one overrides the documented key it
 * shadows.
 *
 * Setting them pins the old behaviour across an upgrade. Leaving them unset
 * does NOT, and that is a deliberate widening rather than an oversight. This
 * function previously hardcoded `maxAttempts: 2` and `baseMs: 750`, so the
 * reset-less 529 in-place loop on a default install moves to 3 attempts at a
 * 1000ms base, which are the documented defaults. The jitter formula and the
 * 3000ms ceiling are unchanged, so the effect is one extra 529 attempt and a
 * slightly larger cap before the ceiling bites. Preserving the old numbers
 * would need a distinction between "key absent" and "key at its default",
 * which packages/config does not expose. One documented widening beats a
 * fourth knob.
 *
 *   CCFLARE_OVERLOAD_RETRY_ENABLED      set to "false" to disable retry entirely
 *   CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS overrides retry_attempts
 *   CCFLARE_OVERLOAD_RETRY_BASE_MS      overrides retry_delay_ms
 *   CCFLARE_OVERLOAD_RETRY_MAX_MS       jitter backoff ceiling ms (default: 3000)
 *
 * @param settings resolved retry settings, normally `ctx.runtime.retry`. Omitted
 *   only by callers with no access to the runtime config, which then get
 *   RETRY_DEFAULTS.
 */
export function getOverloadRetryConfig(settings?: RetrySettings): {
	enabled: boolean;
	maxAttempts: number;
	baseMs: number;
	backoff: number;
	maxMs: number;
} {
	const resolved = settings ?? RETRY_DEFAULTS;

	// An out-of-range value is CLAMPED to the nearest legal one, never replaced by
	// the default. The distinction matters: `retry_attempts: 0` is an operator
	// asking for no retries, and treating it as unset would hand them 3, the
	// largest value in play and the opposite of the request. Same for a negative
	// delay and for a backoff below 1. Nothing upstream catches these; the
	// config layer accepts the three keys on a bare `typeof === "number"`, unlike
	// `db_retry_*`, which is range-validated.
	const maxAttempts =
		Number(process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS) ||
		(Number.isFinite(resolved.attempts)
			? Math.max(1, Math.floor(resolved.attempts))
			: RETRY_DEFAULTS.attempts);

	// baseMs/maxMs: 0 is valid (zero delay for tests), so use explicit finite check.
	const rawBase = Number(process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS);
	const rawMax = Number(process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS);
	const baseMs =
		Number.isFinite(rawBase) && rawBase >= 0
			? rawBase
			: Number.isFinite(resolved.delayMs)
				? Math.max(0, resolved.delayMs)
				: RETRY_DEFAULTS.delayMs;
	const maxMs =
		Number.isFinite(rawMax) && rawMax >= 0
			? rawMax
			: RETRY_MAX_DELAY_MS_DEFAULT;

	// A backoff below 1 would shrink the delay on every attempt, which defeats
	// the point of backing off. Clamped to 1, a constant delay, rather than
	// silently restored to 2.
	const backoff = Number.isFinite(resolved.backoff)
		? Math.max(1, resolved.backoff)
		: RETRY_DEFAULTS.backoff;

	const enabled =
		process.env.CCFLARE_OVERLOAD_RETRY_ENABLED !== "false" && maxAttempts > 1;

	return { enabled, maxAttempts, baseMs, backoff, maxMs };
}

/**
 * The delay before retry attempt `attempt` (1-based), with full jitter.
 *
 * Full jitter, meaning a uniform draw from [0, cap], rather than the cap
 * itself: several accounts failing at the same instant must not all wake at the
 * same instant and rebuild the spike they are backing off from.
 */
export function retryDelayMs(
	cfg: { baseMs: number; backoff: number; maxMs: number },
	attempt: number,
): number {
	const cap = Math.min(cfg.baseMs * cfg.backoff ** attempt, cfg.maxMs);
	return Math.random() * cap;
}

/**
 * Error codes that prove the upstream connection never carried the request
 * body, so the model cannot have seen it.
 *
 * This is an allowlist, not a denylist, and that is the whole point. Every
 * request through this proxy is a non-idempotent POST and /v1/messages carries
 * no idempotency key, so a retry that reaches a model twice can bill twice and,
 * on a stream, deliver two answers. An unrecognised failure is therefore not
 * retried: the cost of missing a safe retry is one failed request, and the cost
 * of retrying an unsafe one is a double charge or a duplicated answer.
 *
 * Measured on 2026-09-14 on BOTH Bun versions in play, because they disagree.
 * 1.4.2 is local; 1.3.14 is the CI and release pin (.github/workflows/ci.yml).
 * `err.code` is top level in every case; `err.cause` is undefined.
 *
 *   case                                 1.4.2              1.3.14
 *   fetch("http://127.0.0.1:1")          ConnectionRefused  ConnectionRefused
 *   fetch("http://<nxdomain>/")          ENOTFOUND          ConnectionRefused
 *   fetch("https://expired.badssl.com")  CERT_HAS_EXPIRED   CERT_HAS_EXPIRED
 *   fetch("https://self-signed...")      DEPTH_ZERO_SELF_SIGNED_CERT (both)
 *
 * Note the DNS row. On the pinned version a name that does not resolve reports
 * ConnectionRefused, so measuring only on 1.3.14 would make ENOTFOUND look dead
 * and invite someone to tidy it out of the set. Both spellings are needed. The
 * error class also differs, TypeError on 1.4.2 and Error on 1.3.14, which is why
 * the check below is `instanceof Error` rather than `instanceof TypeError`.
 *
 * Also measured, the case that decides the exclusions: a socket accepted, the
 * full request body received, then RST. Both versions report ECONNRESET, which
 * is not in the set. The non-idempotency argument is empirical, not asserted.
 *
 * Deliberately absent: ECONNRESET, EPIPE and ETIMEDOUT. A reset or a broken
 * pipe can arrive after the body was fully sent, so they do not prove the
 * model never saw the request.
 */
const RETRYABLE_UPSTREAM_ERROR_CODES = new Set([
	// Connect phase refused outright.
	"ConnectionRefused",
	"ECONNREFUSED",
	// Name resolution never produced an address.
	"ENOTFOUND",
	"EAI_AGAIN",
	"DNSException",
	// Route to the host does not exist.
	"EHOSTUNREACH",
	"ENETUNREACH",
]);

/** TLS handshake failures. The handshake precedes the request body. */
const RETRYABLE_TLS_ERROR_CODE_PREFIXES = [
	"CERT_",
	"ERR_TLS_",
	"UNABLE_TO_",
	"SELF_SIGNED_",
	"DEPTH_ZERO_",
];

/**
 * Whether a thrown upstream failure may be retried.
 *
 * Only a throw ever reaches this function, and only a throw is retried, so a
 * response of any status is out of scope by construction: 429 stays with the
 * account selector and 529 keeps its own in-place retry.
 *
 * A throw alone is not enough, though. The call this guards wraps observation
 * and header handling as well as the fetch, so a ProviderError or an ordinary
 * bug can surface here on a request that did reach the model. Only a recognised
 * connect-phase or handshake-phase error code is retried.
 *
 * An abort is never retried. The caller aborts when the client disconnects, and
 * the header-phase timeout aborts on a request that may already be generating,
 * so neither proves that no tokens were produced.
 */
export function isRetryableUpstreamError(
	err: unknown,
	signal?: AbortSignal,
): boolean {
	if (signal?.aborted) return false;
	if (!(err instanceof Error)) return false;
	if (err.name === "AbortError" || err.name === "TimeoutError") return false;

	const code = (err as { code?: unknown }).code;
	if (typeof code !== "string") return false;
	if (RETRYABLE_UPSTREAM_ERROR_CODES.has(code)) return true;
	return RETRYABLE_TLS_ERROR_CODE_PREFIXES.some((prefix) =>
		code.startsWith(prefix),
	);
}

// Buffer sizes (in bytes unless specified)
export const BUFFER_SIZES = {
	// Stream usage buffer size in KB (multiplied by 1024 to get bytes)
	STREAM_USAGE_BUFFER_KB: 64,
	STREAM_USAGE_BUFFER_BYTES: 64 * 1024,

	// Stream body max size
	STREAM_BODY_MAX_KB: 256,
	STREAM_BODY_MAX_BYTES: 256 * 1024, // 256KB default

	// Anthropic provider stream cap
	ANTHROPIC_STREAM_CAP_BYTES: 32768, // 32KB

	// Stream tee default max bytes
	STREAM_TEE_MAX_BYTES: 1024 * 1024, // 1MB

	// Log file size
	LOG_FILE_MAX_SIZE: 10 * 1024 * 1024, // 10MB
} as const;

// Network constants
export const NETWORK = {
	// Ports
	DEFAULT_PORT: 8080,

	// Timeouts
	IDLE_TIMEOUT_MAX: 255, // Max allowed by Bun
} as const;

// Cache control headers
export const CACHE = {
	// HTTP cache control max-age values (in seconds)
	STATIC_ASSETS_MAX_AGE: 31536000, // 1 year
	CACHE_CONTROL_IMMUTABLE: "public, max-age=31536000, immutable",
	CACHE_CONTROL_STATIC: "public, max-age=31536000",
	CACHE_CONTROL_NO_CACHE: "no-cache, no-store, must-revalidate",
} as const;

// Request/Response limits
export const LIMITS = {
	// Request history limits
	REQUEST_HISTORY_DEFAULT: 50,
	REQUEST_DETAILS_DEFAULT: 100,
	REQUEST_HISTORY_MAX: 1000,
	LOG_READ_DEFAULT: 1000,

	// Account name constraints
	ACCOUNT_NAME_MIN_LENGTH: 1,
	ACCOUNT_NAME_MAX_LENGTH: 100,

	// UI formatting
	CONSOLE_SEPARATOR_LENGTH: 100,
	CONSOLE_COLUMN_PADDING: {
		NAME: 20,
		TYPE: 10,
		REQUESTS: 12,
		TOKEN: 10,
		STATUS: 20,
	},
} as const;

// HTTP status codes
export const HTTP_STATUS = {
	OK: 200,
	NOT_FOUND: 404,
	TOO_MANY_REQUESTS: 429,
	INTERNAL_SERVER_ERROR: 500,
	SERVICE_UNAVAILABLE: 503,
} as const;

// Account tiers - removed unused ACCOUNT_TIERS export
// Statistical calculations - removed unused STATS export
