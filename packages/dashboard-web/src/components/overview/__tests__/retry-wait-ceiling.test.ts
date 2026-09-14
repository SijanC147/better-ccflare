/**
 * The retry card prints one number an operator acts on: how long a request
 * that keeps failing can spend waiting. It has to match the loop that runs.
 *
 * The first version of this arithmetic summed `delayMs * backoff ** retry`
 * with no ceiling, which is wrong in both directions. The real per-delay cap
 * is `Math.min(baseMs * backoff ** attempt, maxMs)` from `retryDelayMs` in
 * packages/core, called as `retryDelayMs(cfg, attempt + 1)`, so the first cap
 * is `delayMs * backoff` and every cap is clipped.
 *
 * The expectations below are computed from that formula rather than copied
 * from the card, so a change to either side has to be reconciled.
 */

import { describe, expect, it } from "bun:test";
import { retryWaitCeilingMs, retryWaitFromConfig } from "../RetryCard";

/** The cap `retryDelayMs` computes, restated independently of the card. */
function capMs(
	delayMs: number,
	backoff: number,
	attempt: number,
	maxMs = 3000,
) {
	return Math.min(delayMs * backoff ** attempt, maxMs);
}

function expectedCeiling(
	attempts: number,
	delayMs: number,
	backoff: number,
	maxMs = 3000,
) {
	let total = 0;
	for (let attempt = 1; attempt <= attempts - 1; attempt++) {
		total += capMs(delayMs, backoff, attempt, maxMs);
	}
	return total;
}

describe("retryWaitCeilingMs", () => {
	it("starts at delayMs * backoff, not at delayMs", () => {
		// The off-by-one that shipped first: with two attempts there is exactly
		// one retry, and its cap is 2000, not 1000.
		expect(retryWaitCeilingMs(2, 1000, 2)).toBe(2000);
	});

	it("clips each delay at the 3000ms jitter ceiling", () => {
		// Without the ceiling this would be 2000 + 4000 = 6000.
		expect(retryWaitCeilingMs(3, 1000, 2)).toBe(2000 + 3000);
		expect(retryWaitCeilingMs(3, 1000, 2)).toBe(expectedCeiling(3, 1000, 2));
	});

	it("matches the loop's cap sum at the documented settings", () => {
		// 5 attempts at a 1000ms base with backoff 2. The card first claimed 15
		// seconds here; the real ceiling is 11.
		expect(retryWaitCeilingMs(5, 1000, 2)).toBe(11_000);
		expect(retryWaitCeilingMs(5, 1000, 2)).toBe(expectedCeiling(5, 1000, 2));
	});

	it("matches below the ceiling too, where clipping never bites", () => {
		// 200 + 400 + 800 + 1600. The uncapped version would give 1500 here, so
		// this case fails on the old formula for the off-by-one alone.
		expect(retryWaitCeilingMs(5, 100, 2)).toBe(3000);
		expect(retryWaitCeilingMs(5, 100, 2)).toBe(expectedCeiling(5, 100, 2));
	});

	it("is zero when retry is disabled", () => {
		expect(retryWaitCeilingMs(1, 1000, 2)).toBe(0);
		expect(retryWaitCeilingMs(0, 1000, 2)).toBe(0);
	});

	it("keeps the delay constant at backoff 1", () => {
		expect(retryWaitCeilingMs(4, 500, 1)).toBe(1500);
	});

	it("returns null rather than NaN for a half-typed field", () => {
		expect(retryWaitCeilingMs(Number.NaN, 1000, 2)).toBeNull();
		expect(retryWaitCeilingMs(3, Number.NaN, 2)).toBeNull();
		expect(retryWaitCeilingMs(3, 1000, Number.NaN)).toBeNull();
	});

	it("honours a different ceiling, which the proxy takes from an env var", () => {
		expect(retryWaitCeilingMs(5, 1000, 2, 60_000)).toBe(
			expectedCeiling(5, 1000, 2, 60_000),
		);
		expect(retryWaitCeilingMs(5, 1000, 2, 60_000)).toBe(
			2000 + 4000 + 8000 + 16_000,
		);
	});
});

/**
 * SB23-2018. The ceiling is a parameter because it is not a constant in
 * practice: CCFLARE_OVERLOAD_RETRY_MAX_MS moves it, and the browser cannot
 * read an environment variable, so the card takes the resolved value from
 * GET /api/config/retry.
 *
 * Expectations here are computed from retryDelayMs's own formula restated
 * below, never copied from what the card prints. Copying its output would pin
 * whatever it currently does, including a bug.
 */
describe("retryWaitCeilingMs honours a non-default ceiling", () => {
	/** `Math.min(baseMs * backoff ** attempt, maxMs)`, summed over the retries. */
	function expected(
		attempts: number,
		delayMs: number,
		backoff: number,
		maxMs: number,
	): number {
		let total = 0;
		for (let retry = 1; retry <= Math.max(0, attempts - 1); retry++) {
			total += Math.min(delayMs * backoff ** retry, maxMs);
		}
		return total;
	}

	it("differs from the default-ceiling answer when the ceiling moves", () => {
		// The property that matters: a host with a raised ceiling must not be
		// shown the default-ceiling number.
		const raised = retryWaitCeilingMs(5, 1000, 2, 60_000);
		const withDefault = retryWaitCeilingMs(5, 1000, 2);

		expect(raised).toBe(expected(5, 1000, 2, 60_000));
		expect(raised).not.toBe(withDefault);
	});

	it("clips at a lowered ceiling", () => {
		expect(retryWaitCeilingMs(5, 1000, 2, 1500)).toBe(
			expected(5, 1000, 2, 1500),
		);
	});

	it("still uses 3000 when no ceiling is supplied", () => {
		// Pins the parameter default, so dropping it would fail rather than
		// silently changing every wait the card shows.
		expect(retryWaitCeilingMs(5, 1000, 2)).toBe(expected(5, 1000, 2, 3000));
	});
});

/**
 * The wiring, which is the part that broke silently.
 *
 * A mutation replacing the server's ceiling with this file's default SURVIVED
 * every test above, because those cover the pure function and nothing covered
 * the argument handed to it.
 */
describe("retryWaitFromConfig uses the server's ceiling", () => {
	it("uses jitterCeilingMs from the config, not the local default", () => {
		const withServer = retryWaitFromConfig(
			{ jitterCeilingMs: 60_000 },
			5,
			1000,
			2,
		);

		expect(withServer).toBe(retryWaitCeilingMs(5, 1000, 2, 60_000));
		// The assertion that kills the mutation: it must NOT equal the answer
		// computed with the 3000ms default.
		expect(withServer).not.toBe(retryWaitCeilingMs(5, 1000, 2));
	});

	it("falls back to the default only while the config is absent", () => {
		expect(retryWaitFromConfig(undefined, 5, 1000, 2)).toBe(
			retryWaitCeilingMs(5, 1000, 2, 3000),
		);
	});
});
