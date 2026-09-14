import { RETRY_BOUNDS } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";

const log = new Logger("Config");

/**
 * Range validation for the upstream retry family, applied to the resolved
 * values after both the environment and the config file have had their say
 * (SB23-1980).
 *
 * # Why this is a separate pass and not a check at each parse site
 *
 * There are two ways into `defaults.retry`: `RETRY_ATTEMPTS` and friends
 * through `parseInt`, and `retry_attempts` and friends through a `typeof`
 * check on the parsed config file. Validating the resolved object once covers
 * both, and cannot be half-applied the way two parallel checks can. It also
 * catches what neither parse site catches today: `parseInt("abc", 10)` is
 * `NaN`, and `typeof NaN === "number"` is `true`, so both paths admit `NaN`.
 *
 * # Why this clamps and warns where the HTTP handler rejects with a 400
 *
 * The asymmetry is deliberate. `POST /api/config/retry` answers an interactive
 * caller who can read the error and send a corrected value. This function runs
 * while the server is starting, where the only stronger response is to refuse
 * to boot. Refusing would turn a bad tuning number into an outage of the proxy
 * that the retry setting is merely tuning, so the retry family clamps.
 *
 * `db_retry_*` still throws out of `validateDatabaseConfig`, and that stays as
 * it is: a database whose contention handling is misconfigured is a different
 * risk from a retry count, and changing it is a behaviour change to a family
 * this issue did not find broken. The difference is now stated rather than
 * accidental.
 *
 * # Why clamping, specifically, and not falling back to the default
 *
 * A rejected value must never silently become the default when the default
 * sits at the aggressive end of the range. That is the defect this family
 * already produced once: `retry_attempts: 0` became 3, so an operator asking
 * for no retries got the most retries (SB23-1959, PR #113).
 *
 * Clamping cannot reproduce it, because clamping only ever moves a value to
 * the nearest legal point in the direction it was already heading.
 * `retry_attempts: -1` becomes 0, which is no retries, the nearest legal
 * reading of what was asked. `retry_attempts: 99` becomes 5. Neither becomes
 * the default.
 *
 * `NaN` is the one input with no direction to clamp toward, so it keeps the
 * default. That is the substitution the rule warns about, so it is the loudest
 * case: the warning names the key, the value that arrived and the value
 * applied.
 */

type RetryRuntime = { attempts: number; delayMs: number; backoff: number };

/**
 * The runtime field, the config-file key and the environment variable for each
 * setting. A warning names all three because the operator who has to fix the
 * value does not know which of the two sources this process read it from, and
 * the message is printed at startup where there is no dashboard to check.
 */
const FIELDS = [
	{
		field: "attempts",
		fileKey: "retry_attempts",
		envKey: "RETRY_ATTEMPTS",
		integer: true,
	},
	{
		field: "delayMs",
		fileKey: "retry_delay_ms",
		envKey: "RETRY_DELAY_MS",
		integer: true,
	},
	{
		field: "backoff",
		fileKey: "retry_backoff",
		envKey: "RETRY_BACKOFF",
		integer: false,
	},
] as const;

function describe(fileKey: string, envKey: string): string {
	return `${fileKey} (${envKey})`;
}

function warnOnce(dedupeKey: string, message: string): void {
	if (warned.has(dedupeKey)) return;
	warned.add(dedupeKey);
	log.warn(message);
}

/**
 * Warnings already emitted, keyed by the setting, the value that arrived and
 * the value applied.
 *
 * `getRuntime()` is NOT called once at startup. `apps/server/src/server.ts`
 * builds its RuntimeConfig from it once, but `packages/http-api` calls it per
 * request in the OAuth handlers and on every read of the retry config card. A
 * warning emitted unconditionally would therefore repeat for the life of the
 * process on a misconfigured install, which buries the one line the operator
 * needs under thousands of copies of itself.
 *
 * The key includes the values, not just the setting, so correcting a bad value
 * to a different bad value warns again rather than being swallowed by the
 * first. Process-wide by design: the point is one warning per distinct
 * misconfiguration, and a second Config instance reading the same bad file has
 * nothing new to tell anyone.
 */
const warned = new Set<string>();

/** Test seam: forget what has been warned about, so a case can assert the log. */
export function resetRetryWarningsForTest(): void {
	warned.clear();
}

/**
 * Clamps `retry` in place and returns the adjustments made, newest last.
 *
 * The return value is the contract, not the log. It exists so a test can assert
 * what happened without reading the log, and so a caller that wants to report
 * the adjustments somewhere else can. Every adjustment is returned on every
 * call; only the warning is deduplicated.
 */
export function validateRuntimeRetry(
	retry: RetryRuntime,
	defaults: RetryRuntime,
): Array<{ key: string; received: number; applied: number; reason: string }> {
	const adjustments: Array<{
		key: string;
		received: number;
		applied: number;
		reason: string;
	}> = [];

	for (const { field, fileKey, envKey, integer } of FIELDS) {
		const bounds = RETRY_BOUNDS[field];
		const received = retry[field];
		const key = describe(fileKey, envKey);

		// Not a number at all, or NaN. `parseInt("abc", 10)` reaches here, and so
		// does a config file holding a JSON value that survived the `typeof`
		// check only because `typeof NaN` is "number".
		if (typeof received !== "number" || Number.isNaN(received)) {
			retry[field] = defaults[field];
			adjustments.push({
				key,
				received: Number.NaN,
				applied: defaults[field],
				reason: "not a number",
			});
			warnOnce(
				`${key}:nan:${defaults[field]}`,
				`${key} is not a number; applying the default ${defaults[field]}. ` +
					`Set a number between ${bounds.min} and ${bounds.max}.`,
			);
			continue;
		}

		let applied = received;
		const reasons: string[] = [];

		// Integer first, then range: rounding cannot push a value out of a range
		// whose ends are whole numbers, while clamping first and rounding after
		// could, if a bound were ever fractional.
		// FLOOR, not round. Rounding 1.6 up to 2 would be more aggressive than
		// both the operator's value and the old behaviour: the consumer floors
		// with `Math.max(1, Math.floor(resolved.attempts))`
		// (`packages/core/src/constants.ts:273`), so `retry_attempts: 1.6` used to
		// mean one attempt with `enabled = false`, and rounding would flip
		// transport retry from off to on. That is the inversion this issue exists
		// to prevent, so the direction is load-bearing rather than cosmetic.
		//
		// Both integer fields floor. `delayMs` has no competing argument: a
		// sub-millisecond fraction is below `setTimeout` granularity either way.
		if (integer && !Number.isInteger(applied)) {
			applied = Math.floor(applied);
			reasons.push("truncated to a whole number");
		}

		if (applied < bounds.min) {
			applied = bounds.min;
			reasons.push(`raised to the minimum ${bounds.min}`);
		} else if (applied > bounds.max) {
			applied = bounds.max;
			reasons.push(`lowered to the maximum ${bounds.max}`);
		}

		if (applied === received) continue;

		retry[field] = applied;
		adjustments.push({
			key,
			received,
			applied,
			reason: reasons.join(", "),
		});
		warnOnce(
			`${key}:${received}:${applied}`,
			`${key} was ${received}, ${reasons.join(", ")}: applying ${applied}. ` +
				`The accepted range is ${bounds.min} to ${bounds.max}.`,
		);
	}

	return adjustments;
}
