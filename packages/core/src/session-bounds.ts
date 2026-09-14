/**
 * Bounds for `session_duration_ms` (`SESSION_DURATION_MS`), the window that
 * decides when an account's request counter starts a new session (SB23-2040).
 *
 * This lives in `packages/core` for the same reason `RETRY_BOUNDS` does: the
 * value is resolved in `packages/config` and consumed in `packages/database`
 * and `packages/load-balancer`, and none of those may import from each other.
 *
 * # The floor is 0, and 0 is honoured rather than refused
 *
 * The only place the value decides anything is the SQL in
 * `packages/database/src/repositories/account.repository.ts:219`:
 *
 *     session_start = CASE
 *       WHEN session_start IS NULL OR ? - COALESCE(session_start, 0) >= ? THEN ?
 *       ELSE session_start
 *     END
 *
 * bound with `now` and `sessionDurationMs`, so the test is
 * `now - session_start >= sessionDurationMs`. The session strategies apply the
 * same comparison (`packages/load-balancer/src/strategies/index.ts:48`).
 *
 * At 0 every request satisfies the condition, so every request opens a new
 * session and `session_request_count` is always 1. That is coherent behaviour,
 * "no session grouping", not a crash and not nonsense. So 0 is a legitimate
 * configuration and must reach the consumer, which is exactly what the `||` at
 * `packages/database/src/database-operations.ts` used to discard in favour of
 * five hours.
 *
 * A negative value is behaviourally identical to 0, since the comparison is
 * also always true. Clamping a negative to 0 therefore moves it toward what was
 * asked and changes nothing about what the operator gets.
 *
 * # There is deliberately no ceiling
 *
 * The obvious candidate was seven days, on the grounds that the longest
 * rate-limit window this proxy models is `seven_day`. It is the wrong bound. An
 * operator setting a very large value is asking for sessions that effectively
 * never reset, which is a legitimate configuration, and nothing in the SQL
 * misbehaves at any magnitude: the comparison is integer arithmetic on
 * millisecond timestamps. Clamping it would be a false refusal of a working
 * setup, which is a worse failure than the one this bound exists to prevent.
 *
 * `max` is therefore absent rather than set to a large number. A large ceiling
 * would still refuse something, and would read as measured when it was picked.
 */
export const SESSION_DURATION_BOUNDS = {
	min: 0,
} as const;
