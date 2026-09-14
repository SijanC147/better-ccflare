import { describe, expect, test } from "bun:test";
import { CircuitBreaker, type CircuitKey } from "../circuit-breaker";

/**
 * SB23-1903. The failure mode this file exists to catch is a reporter that
 * always reports healthy: every key starts closed, so a snapshot builder that
 * drops entries, hard-codes a state, or never recomputes `wideOpen` looks
 * identical to a working one on a healthy install. Every test below therefore
 * drives real keys to `open` first and asserts the report CHANGES.
 */

const key = (provider: string, accountId: string): CircuitKey => ({
	provider,
	accountId,
});

/** Trip a key by recording `threshold` account-wide failures. */
function open(breaker: CircuitBreaker, k: CircuitKey, threshold: number): void {
	for (let i = 0; i < threshold; i++) {
		breaker.recordFailure(k, "upstream_429_with_reset");
	}
}

/**
 * Make a key tracked but still closed. One sub-threshold failure is the only
 * way: `recordSuccess` on an untracked key creates no entry, so an account
 * that has never failed is absent from the report rather than listed closed.
 */
function track(breaker: CircuitBreaker, k: CircuitKey): void {
	breaker.recordFailure(k, "upstream_429_with_reset");
}

function makeBreaker(): CircuitBreaker {
	return new CircuitBreaker({ failureThreshold: 2, enabled: true });
}

describe("CircuitBreaker.healthSnapshot — reports open state, never hides it", () => {
	test("an untouched breaker reports nothing tracked", () => {
		const snap = makeBreaker().healthSnapshot();
		expect(snap.enabled).toBe(true);
		expect(snap.accounts).toEqual([]);
		expect(snap.providers).toEqual([]);
	});

	test("a tripped key is reported open, with its failure count", () => {
		const breaker = makeBreaker();
		open(breaker, key("anthropic", "acct-a"), 2);

		const snap = breaker.healthSnapshot();
		const entry = snap.accounts.find((a) => a.accountId === "acct-a");
		expect(entry).toBeDefined();
		expect(entry?.state).toBe("open");
		expect(entry?.failureCount).toBe(2);
		expect(entry?.cooldownEndsAt).not.toBeNull();
	});

	test("the provider rollup counts open and closed separately", () => {
		const breaker = makeBreaker();
		open(breaker, key("anthropic", "acct-a"), 2);
		track(breaker, key("anthropic", "acct-b"));

		const anthropic = breaker
			.healthSnapshot()
			.providers.find((p) => p.provider === "anthropic");
		expect(anthropic).toEqual({
			provider: "anthropic",
			tracked: 2,
			open: 1,
			halfOpen: 0,
			closed: 1,
			wideOpen: false,
		});
	});

	test("wideOpen flips to true only once every tracked account is open", () => {
		const breaker = makeBreaker();
		open(breaker, key("anthropic", "acct-a"), 2);
		track(breaker, key("anthropic", "acct-b"));

		const before = breaker
			.healthSnapshot()
			.providers.find((p) => p.provider === "anthropic");
		expect(before?.wideOpen).toBe(false);

		open(breaker, key("anthropic", "acct-b"), 2);

		const after = breaker
			.healthSnapshot()
			.providers.find((p) => p.provider === "anthropic");
		expect(after?.open).toBe(2);
		expect(after?.wideOpen).toBe(true);
	});

	test("one provider going wide open leaves the other provider's rollup alone", () => {
		const breaker = makeBreaker();
		open(breaker, key("anthropic", "acct-a"), 2);
		open(breaker, key("anthropic", "acct-b"), 2);
		track(breaker, key("openai", "acct-c"));
		track(breaker, key("openai", "acct-d"));

		const snap = breaker.healthSnapshot();
		expect(snap.providers.map((p) => p.provider)).toEqual([
			"anthropic",
			"openai",
		]);
		expect(snap.providers[0]).toMatchObject({ open: 2, wideOpen: true });
		expect(snap.providers[1]).toMatchObject({
			open: 0,
			closed: 2,
			wideOpen: false,
		});
	});

	test("a half-open key is reported half-open and keeps the provider out of wideOpen", () => {
		const breaker = new CircuitBreaker({
			failureThreshold: 2,
			openCooldownMs: 1,
			enabled: true,
		});
		const a = key("anthropic", "acct-a");
		open(breaker, a, 2);
		open(breaker, key("anthropic", "acct-b"), 2);
		expect(
			breaker.healthSnapshot().providers.find((p) => p.provider === "anthropic")
				?.wideOpen,
		).toBe(true);

		// Admission is what promotes open to half-open. Nothing in the request
		// path calls it, so this test drives it directly to prove the reporter
		// distinguishes the third state at all.
		expect(breaker.shouldAllow(a, Date.now() + 10_000)).toBe(true);

		const anthropic = breaker
			.healthSnapshot()
			.providers.find((p) => p.provider === "anthropic");
		expect(anthropic).toMatchObject({
			tracked: 2,
			open: 1,
			halfOpen: 1,
			closed: 0,
			wideOpen: false,
		});
		expect(
			breaker.healthSnapshot().accounts.find((e) => e.accountId === "acct-a")
				?.halfOpenProbeInFlight,
		).toBe(true);
	});

	test("healthSnapshot does not promote an open circuit by observing it", () => {
		const breaker = new CircuitBreaker({
			failureThreshold: 2,
			openCooldownMs: 1,
			enabled: true,
		});
		const a = key("anthropic", "acct-a");
		open(breaker, a, 2);

		// Report repeatedly, well past the cooldown, without any admission call.
		for (let i = 0; i < 5; i++) breaker.healthSnapshot();

		expect(
			breaker.healthSnapshot().accounts.find((e) => e.accountId === "acct-a")
				?.state,
		).toBe("open");
		expect(breaker.getState(a)).toBe("open");
	});

	test("a disabled breaker says so, and records nothing to report", () => {
		const breaker = new CircuitBreaker({
			failureThreshold: 2,
			enabled: false,
		});
		open(breaker, key("anthropic", "acct-a"), 5);

		const snap = breaker.healthSnapshot();
		expect(snap.enabled).toBe(false);
		expect(snap.accounts).toEqual([]);
		expect(snap.providers).toEqual([]);
	});
});
