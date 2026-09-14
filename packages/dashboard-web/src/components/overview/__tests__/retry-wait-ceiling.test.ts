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
import { retryWaitCeilingMs } from "../RetryCard";

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
