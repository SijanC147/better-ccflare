import type {
	AnyUsageData,
	CodexCredits,
	UsageData,
} from "../../usage-fetcher";

/**
 * A credit balance older than this is treated as absent.
 *
 * It is the same bound the usage cache already applies to a usage reading
 * (`cleanupStaleEntries`'s default and the two age checks in
 * `usage-fetcher.ts`), chosen so a carried balance can never be older than an
 * entry the cache would still serve. Picking a second, larger number here
 * would mean admission trusting a balance the cache itself considers stale.
 */
export const CODEX_CREDITS_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Strict decimal balance parse: `"9.99"` yes, `"1,234.50"` no.
 *
 * Never `parseFloat`. SB23-2257 keeps `balance` as the upstream string for one
 * reason, recorded in `CodexCredits`' own docstring: a format we did not expect
 * becomes a confident `0` under `parseFloat`, and `parseFloat("1,234.50")` is
 * `1` rather than either the right answer or a refusal. Here the direction of
 * the error is the other way round and worse: this number decides whether an
 * account that upstream would refuse gets routed real traffic.
 *
 * So the grammar is the narrow one, and every string outside it reads as
 * unparseable, which benches. That includes the comma-grouped form SB23-2257's
 * own test uses as its example of an unexpected format. Erring that way costs
 * an idle account, which is exactly today's behaviour; erring the other way
 * costs a 429 on a live request.
 */
function parseBalance(balance: string | null): number | null {
	if (balance === null) return null;
	const trimmed = balance.trim();
	if (!/^[+-]?\d+(\.\d+)?$/.test(trimmed)) return null;
	const value = Number(trimmed);
	return Number.isFinite(value) ? value : null;
}

/**
 * Whether a credit balance is good enough to keep an account eligible once its
 * weekly window reads 100.
 *
 * Sean's ruling of 2026-09-21 on SB23-2289: those credits are already paid for
 * and upstream would keep serving on them, so benching the account idles a
 * usable one at the moment every other window is full.
 *
 * Both halves are required. `has_credits` is the gate codex-rs
 * `parse_credits_snapshot` uses and the one `parseCodexCreditsHeaders` already
 * mirrors, and on top of it there has to be something positive to spend:
 * either `unlimited`, or a balance that parses strictly above zero.
 *
 * Everything else is false, which benches exactly as the code did before this
 * function existed: credits absent, `has_credits: false`, a zero balance, a
 * balance in a format this cannot read, and `has_credits: true` with no balance
 * at all. The ruling names that fail-closed set and the negative tests around
 * this function are what stop it being a routing regression.
 */
export function codexCreditsCoverExhaustedWeekly(
	credits: CodexCredits | undefined,
): boolean {
	if (!credits || credits.has_credits !== true) return false;
	if (credits.unlimited === true) return true;
	const balance = parseBalance(credits.balance);
	return balance !== null && balance > 0;
}

/** The moment the `credits` in a cache entry were read off a live response. */
export interface CodexCreditsAge {
	/**
	 * When this entry's credits were observed. `undefined` means the entry was
	 * never stamped, in which case its credits are exactly as old as the entry
	 * itself: every writer other than the poller takes its credits off the same
	 * response as the windows beside them.
	 */
	creditsObservedAt?: number;
	timestamp: number;
	data: AnyUsageData;
}

/** What {@link carryCodexCredits} decided, ready to hand to `install`. */
export interface CarriedCodexCredits {
	data: UsageData;
	creditsObservedAt: number | undefined;
}

/**
 * Keep a recently observed credit balance across a poll that did not report
 * one.
 *
 * The background poller reads `wham/usage`, whose JSON body carries the
 * rate-limit windows and nothing about credits, and `install` replaces the
 * cache entry wholesale. Without this, a balance written by the traffic path
 * is erased at the next poll and an admission rule keyed on it would flip the
 * account between admitted and benched once per poll interval, which reads as
 * flakiness rather than as a design gap.
 *
 * The carry is **age-bounded, and bounded on the credits' own age rather than
 * on the entry's**. That distinction is the whole correctness argument: each
 * `install` stamps a fresh entry timestamp, so a carry measured against the
 * entry would re-stamp itself on every poll and the balance would live
 * forever. `creditsObservedAt` travels with the value it describes, so a
 * carried balance ages out at {@link CODEX_CREDITS_MAX_AGE_MS} from when it
 * was actually read, however many polls happen in between.
 *
 * A payload that carries its own credits always wins, including one saying
 * `has_credits: false`: that is upstream speaking now, and it must be able to
 * revoke a balance this function would otherwise keep alive.
 */
export function carryCodexCredits(
	next: UsageData,
	previous: CodexCreditsAge | undefined,
	now: number,
): CarriedCodexCredits {
	if (next.credits !== undefined) {
		return { data: next, creditsObservedAt: now };
	}
	const previousData = previous?.data as UsageData | undefined;
	const previousCredits = previousData?.credits;
	if (previousCredits === undefined || previous === undefined) {
		return { data: next, creditsObservedAt: undefined };
	}
	const observedAt = previous.creditsObservedAt ?? previous.timestamp;
	if (now - observedAt > CODEX_CREDITS_MAX_AGE_MS) {
		return { data: next, creditsObservedAt: undefined };
	}
	return {
		data: { ...next, credits: previousCredits },
		creditsObservedAt: observedAt,
	};
}
