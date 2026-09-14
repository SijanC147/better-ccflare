import type { Config } from "@better-ccflare/config";
import {
	BadRequest,
	errorResponse,
	jsonResponse,
} from "@better-ccflare/http-common";

/**
 * Upstream retry settings (`/api/config/retry`).
 *
 * The three documented keys `retry_attempts`, `retry_delay_ms` and
 * `retry_backoff`. `db_retry_*` is a separate chain with its own consumers and
 * is deliberately not surfaced here.
 *
 * Two things this endpoint has to be careful about.
 *
 * The values reach the proxy through `apps/server/src/server.ts`, which builds
 * RuntimeConfig once at startup from `config.getRuntime()`. Nothing re-reads
 * it per request, so a value written here takes effect on the next restart and
 * the read below says so. That is the opposite of the OpenObserve settings,
 * which are read through a getter on every decision.
 *
 * The bounds are enforced HERE and nowhere else. `packages/config` accepts the
 * three keys on a bare `typeof value === "number"`, unlike the adjacent
 * `db_retry_*`, which is range-validated (SB23-1980). So this handler is the
 * only thing between an interactive caller and a value the retry loop will
 * clamp silently or, worse, attempt.
 */

/**
 * Total attempts for one upstream request, the first attempt included, so 1
 * means no retry and 0 also resolves to a single attempt. The ceiling is 5
 * because two retry layers read these keys and can stack on one request: the
 * transport retry in `forwardWithTransportRetry` and the in-place 529 loop.
 * The worst case is attempts squared, so 5 allows 25 upstream fetches for one
 * client request. 10 would allow 100, which is a spike turned into a storm.
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

/**
 * Reads one numeric field. Absent leaves the stored value alone, the same
 * posture as the OpenObserve token and log level: a client written before this
 * field existed must not reset what it does not know about.
 */
function readNumber(
	value: unknown,
	field: string,
	min: number,
	max: number,
	integer: boolean,
): { ok: true; value: number | undefined } | { ok: false; message: string } {
	if (value === undefined) return { ok: true, value: undefined };
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return { ok: false, message: `${field} must be a finite number` };
	}
	if (integer && !Number.isInteger(value)) {
		return { ok: false, message: `${field} must be a whole number` };
	}
	if (value < min || value > max) {
		return {
			ok: false,
			message: `${field} must be between ${min} and ${max}`,
		};
	}
	return { ok: true, value };
}

export function createRetryConfigHandlers(config: Config) {
	return {
		/**
		 * GET /api/config/retry
		 * The resolved values, the bounds the POST enforces, and the restart note.
		 */
		getRetryConfig: (): Response => {
			const retry = config.getRuntime().retry;
			return jsonResponse({
				attempts: retry.attempts,
				delayMs: retry.delayMs,
				backoff: retry.backoff,
				bounds: RETRY_BOUNDS,
				// Read once at startup, so a save is inert until the server restarts.
				restartRequired: true,
				// The config file outranks these, so a value saved here wins. The
				// card says so rather than leaving the precedence to be discovered.
				environmentKeys: config.getRetryEnvironmentKeys(),
				// The opposite direction: these override a saved value inside
				// getOverloadRetryConfig(), for the in-place 529 loop and the ZAI
				// 1305 loop. Reported as their own list because merging the two
				// would say "in force" about variables that lose and variables
				// that win, in one sentence.
				overloadEnvironmentKeys: config.getOverloadRetryEnvironmentKeys(),
			});
		},

		/**
		 * POST /api/config/retry
		 * Body: { attempts?: number, delayMs?: number, backoff?: number }
		 */
		setRetryConfig: async (req: Request): Promise<Response> => {
			let body: { attempts?: unknown; delayMs?: unknown; backoff?: unknown };
			try {
				body = (await req.json()) as typeof body;
			} catch {
				return errorResponse(BadRequest("Invalid JSON body"));
			}

			const attempts = readNumber(
				body.attempts,
				"attempts",
				ATTEMPTS_MIN,
				ATTEMPTS_MAX,
				true,
			);
			if (!attempts.ok) return errorResponse(BadRequest(attempts.message));

			const delayMs = readNumber(
				body.delayMs,
				"delayMs",
				DELAY_MIN_MS,
				DELAY_MAX_MS,
				true,
			);
			if (!delayMs.ok) return errorResponse(BadRequest(delayMs.message));

			const backoff = readNumber(
				body.backoff,
				"backoff",
				BACKOFF_MIN,
				BACKOFF_MAX,
				false,
			);
			if (!backoff.ok) return errorResponse(BadRequest(backoff.message));

			// The current resolved values fill in whatever the caller omitted, so a
			// partial post cannot reset the other two keys.
			const current = config.getRuntime().retry;
			config.setRetrySettings({
				attempts: attempts.value ?? current.attempts,
				delayMs: delayMs.value ?? current.delayMs,
				backoff: backoff.value ?? current.backoff,
			});

			return new Response(null, { status: 204 });
		},
	};
}
