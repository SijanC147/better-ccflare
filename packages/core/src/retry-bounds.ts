/**
 * Bounds for the upstream retry family: `retry_attempts`, `retry_delay_ms` and
 * `retry_backoff`.
 *
 * This lives in `packages/core` rather than beside either consumer because it
 * has two of them and they sit on opposite sides of a dependency edge.
 * `packages/http-api` enforces it on `POST /api/config/retry`;
 * `packages/config` enforces it on the values read from the config file and the
 * environment. `packages/config` cannot import from `packages/http-api`, and
 * both already import `validateNumber` from here, so this is the one place both
 * can reach.
 *
 * A second set of bounds that disagreed with this one would be worse than no
 * bounds at all: the dashboard would reject a value the config file accepts, or
 * the reverse, and neither error message would mention the other.
 *
 * The numbers and their reasoning came from PR #121 (SB23-1972) and are
 * unchanged by the move (SB23-1980).
 */

/**
 * Total attempts for one upstream request, the first attempt included, so 1
 * means no retry and 0 also resolves to a single attempt. The ceiling is 5
 * because two retry layers read these keys and can stack on one request: the
 * transport retry in `forwardWithTransportRetry` and the in-place 529 loop.
 * The worst case is attempts squared, so 5 allows 25 upstream fetches for one
 * client request. 10 would allow 100, which is a spike turned into a storm.
 *
 * 0 is deliberately inside the range. It is how an operator asks for no
 * retries, and `getOverloadRetryConfig` already reads it correctly through
 * `Math.max(1, ...)` with `enabled = maxAttempts > 1`. The adjacent
 * `db_retry_attempts` uses `min: 1`, so its bounds must not be copied here.
 */
const ATTEMPTS_MIN = 0;
const ATTEMPTS_MAX = 5;

/**
 * Base delay in milliseconds before the first retry. The ceiling is 30000
 * because a larger value holds a client request open with nothing to show for
 * it; the jittered per-attempt delay is separately capped by
 * CCFLARE_OVERLOAD_RETRY_MAX_MS, 3000 by default.
 */
const DELAY_MIN_MS = 0;
const DELAY_MAX_MS = 30_000;

/**
 * Multiplier applied per attempt, NOT a duration. Below 1 would shrink the
 * delay on each retry, which is the opposite of backing off, so 1 is the floor
 * and means a constant delay.
 */
const BACKOFF_MIN = 1;
const BACKOFF_MAX = 5;

export const RETRY_BOUNDS = {
	attempts: { min: ATTEMPTS_MIN, max: ATTEMPTS_MAX },
	delayMs: { min: DELAY_MIN_MS, max: DELAY_MAX_MS },
	backoff: { min: BACKOFF_MIN, max: BACKOFF_MAX },
} as const;
