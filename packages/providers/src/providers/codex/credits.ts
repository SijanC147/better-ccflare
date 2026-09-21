import type {
	AnyUsageData,
	CodexCredits,
	UsageData,
} from "../../usage-fetcher";

/**
 * A credit balance older than this is treated as absent.
 *
 * It is the same bound the usage cache already applies to a usage reading
 * (`UsageCache.ENTRY_MAX_AGE_MS`), chosen so a carried balance can never be
 * older than an entry the cache would still serve. Picking a second, larger
 * number here would mean admission trusting a balance the cache itself
 * considers stale.
 *
 * **Lowering it below `UsageCache.ENTRY_MAX_AGE_MS` breaks something that is
 * not obvious from here.** A writer that takes `usageCache.set`'s default stamp
 * is safe only because credits then age at the same rate as the entry, so the
 * entry is discarded before this bound can fire. Drop this below the entry TTL
 * and the strip starts withholding fields from entries that are not stale at
 * all. PR #236's second reviewer measured it at five minutes.
 */
export const CODEX_CREDITS_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * The stamp for an entry where no Codex credit balance was observed: every
 * provider other than Codex, and Codex responses upstream said nothing about
 * credits on.
 *
 * `null`, not `0`, and the difference is load-bearing twice over. A stamp has
 * to be able to say "there is no balance here to date", which is a different
 * statement from any instant, and `0` cannot make it: the epoch is a real
 * instant that reads as infinitely old. PR #236's second reviewer found what
 * that cost. `usageCache.get` withheld a field it judged stale, `XaiUsageData`
 * is `{ credits: XaiUsageWindow }` whose ONLY field is `credits`, and an xAI
 * entry stamped `0` therefore came back as `{}` — xAI ranking, throttling, the
 * health counter and the dashboard card all broken by a Codex feature.
 *
 * `null` makes "no Codex balance was dated into this entry" unmistakable, so
 * the strip can key on THAT rather than on a field name that two providers
 * happen to share. Being falsy also made `0` a trap for `||`, which is what
 * mutation MF3 was about.
 */
export const CODEX_CREDITS_NOT_OBSERVED = null;

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
	 * When this entry's credits were observed.
	 *
	 * **Required, and it used to be optional.** PR #236's reviewer found both
	 * defects that came of that: a writer that supplied nothing got `undefined`,
	 * which this file then read as "as old as the entry", and an entry timestamp
	 * is refreshed by every write. So an omitted stamp did not mean "unknown
	 * age", it meant "brand new", which is the one reading that admits an
	 * account. Dropping the argument at the poller's call site made a balance
	 * survive 1000 polls over 16 hours, and the persisted-payload path in
	 * `handlers/accounts.ts` installed a balance of arbitrary age as though it
	 * had just been read.
	 *
	 * Required is the construction that cannot express either one: a caller has
	 * to say when it observed the balance, and omitting it is a type error
	 * rather than a silent claim of freshness.
	 */
	creditsObservedAt: number | null;
	timestamp: number;
	data: AnyUsageData;
}

/** What {@link carryCodexCredits} decided, ready to hand to `install`. */
export interface CarriedCodexCredits {
	data: UsageData;
	/** `null` when nothing was carried, so there is no balance to date. */
	creditsObservedAt: number | null;
}

/**
 * Whether a balance observed at `observedAt` is still young enough to act on.
 *
 * One predicate, used by the carry, by the cache's read path and by anything
 * else that has to date a balance, so there is exactly one answer to "is this
 * too old" rather than a comparison rewritten at each site.
 */
export function codexCreditsAreFresh(
	observedAt: number | null | undefined,
	now: number,
): boolean {
	if (observedAt == null) return false;
	return now - observedAt <= CODEX_CREDITS_MAX_AGE_MS;
}

/**
 * Remove a credit balance from a payload, returning the same object when there
 * was nothing to remove.
 *
 * **Call this only for an entry that actually carries a Codex balance**, which
 * `usageCache.get` establishes by the entry's `creditsObservedAt` being non-null
 * rather than by looking at the payload.
 *
 * An earlier version of this docstring claimed the field name was safe because
 * "a payload from a provider that has no such field is returned untouched".
 * That was **false**, and PR #236's second reviewer measured the cost:
 * `XaiUsageData` is `{ credits: XaiUsageWindow }`, where `credits` is the ONLY
 * field, so an xAI payload run through here comes back as `{}` and xAI ranking,
 * throttling, the health counter and the dashboard card all break. It is the
 * same collision as `#219`, where `"credits" in usageData` made every Codex card
 * render "Grok credits", arriving from the opposite direction. See
 * `mem:detect-the-provider-not-the-key`.
 *
 * The field name is shared. Only the stamp says whose balance it is.
 */
export function stripCodexCredits(data: AnyUsageData): AnyUsageData {
	if (!data || typeof data !== "object") return data;
	if ((data as UsageData).credits === undefined) return data;
	const { credits: _dropped, ...rest } = data as UsageData;
	return rest as AnyUsageData;
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
	if (previous === undefined) {
		return { data: next, creditsObservedAt: null };
	}
	const previousCredits = (previous.data as UsageData | undefined)?.credits;
	if (previousCredits === undefined) {
		return { data: next, creditsObservedAt: null };
	}
	// The previous entry's OWN stamp, never its timestamp. There is no `??`
	// fallback here any more and there must not be one: the entry timestamp was
	// refreshed by the write that produced this entry, so falling back to it
	// renews the balance on every poll and it never ages out.
	const observedAt = previous.creditsObservedAt;
	if (!codexCreditsAreFresh(observedAt, now)) {
		return { data: next, creditsObservedAt: null };
	}
	return {
		data: { ...next, credits: previousCredits },
		creditsObservedAt: observedAt,
	};
}
