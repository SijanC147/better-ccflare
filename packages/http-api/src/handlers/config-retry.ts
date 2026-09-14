import type { Config } from "@better-ccflare/config";
import { RETRY_BOUNDS } from "@better-ccflare/core";
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
 * The bounds are `RETRY_BOUNDS` from `@better-ccflare/core`, which is also what
 * `packages/config` clamps the config-file and environment values against
 * (SB23-1980). The two layers share one definition on purpose: a second set of
 * numbers here would let the dashboard reject a value the config file accepts.
 *
 * What the two layers do NOT share is the response to an out-of-range value.
 * This endpoint rejects with a 400, because an interactive caller can be told
 * it is wrong and can try again. The config layer clamps and warns, because a
 * boot-time value must not take the proxy down. That asymmetry is deliberate
 * and is argued in `validateRuntimeRetry` in `packages/config`.
 */

const { attempts: ATTEMPTS, delayMs: DELAY, backoff: BACKOFF } = RETRY_BOUNDS;
const { min: ATTEMPTS_MIN, max: ATTEMPTS_MAX } = ATTEMPTS;
const { min: DELAY_MIN_MS, max: DELAY_MAX_MS } = DELAY;
const { min: BACKOFF_MIN, max: BACKOFF_MAX } = BACKOFF;

export { RETRY_BOUNDS };

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
			// `null`, a bare number and a bare string all parse, and reading a
			// field off them throws outside the try, which the router turns into a
			// 500. A malformed body is the caller's mistake, so it gets a 400.
			if (typeof body !== "object" || body === null) {
				return errorResponse(BadRequest("Body must be a JSON object"));
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
