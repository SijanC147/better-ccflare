import { describe, expect, it } from "bun:test";
import { isUsageExhausted } from "@better-ccflare/core";
import type { AnyUsageData, UsageData } from "../../../usage-fetcher";
import {
	getRankingUtilizationForProvider,
	getRepresentativeUsageSnapshotForProvider,
	getRepresentativeUtilizationForProvider,
} from "../../../usage-fetcher";
import {
	CODEX_CREDITS_MAX_AGE_MS,
	CODEX_CREDITS_NOT_OBSERVED,
	carryCodexCredits,
	codexCreditsCoverExhaustedWeekly,
} from "../credits";

/**
 * SB23-2289. Sean ruled on 2026-09-21 that a Codex account whose weekly window
 * reads 100 but which still holds credits stays eligible, because those credits
 * are paid for and upstream would keep serving on them.
 *
 * The ruling names the failure mode it accepts: a bad or stale balance reading
 * now routes real traffic at an account that then 429s upstream. What it
 * demands in exchange is that an absent, zero, malformed or unparseable balance
 * benches exactly as before. Most of this file is those negative cases, and
 * they are the reason this is not a routing regression.
 */

const FIVE_HOUR_RESET = "2030-01-01T05:00:00.000Z";
const WEEKLY_RESET = "2030-01-05T00:00:00.000Z";
/** Comfortably inside both windows above, so neither reset reads as stale. */
const NOW = Date.parse("2030-01-01T00:00:00.000Z");

/**
 * The shape a live 429 leaves behind: weekly spent, five-hour barely touched
 * and resetting within the hour. `credits` is spelled exactly as
 * `parseCodexCreditsHeaders` produces it.
 */
function weeklyExhausted(credits?: UsageData["credits"]): UsageData {
	const usage: UsageData = {
		five_hour: { utilization: 12, resets_at: FIVE_HOUR_RESET },
		seven_day: { utilization: 100, resets_at: WEEKLY_RESET },
	};
	if (credits !== undefined) usage.credits = credits;
	return usage;
}

/** The admission verdict every gate in the tree reaches, via the one chokepoint. */
function benched(usage: AnyUsageData, provider = "codex"): boolean {
	const snapshot = getRepresentativeUsageSnapshotForProvider(usage, provider);
	return isUsageExhausted(
		snapshot?.utilization ?? null,
		snapshot?.resetMs,
		NOW,
	);
}

describe("codexCreditsCoverExhaustedWeekly", () => {
	it("accepts a positive decimal balance", () => {
		expect(
			codexCreditsCoverExhaustedWeekly({
				has_credits: true,
				unlimited: false,
				balance: "9.99",
			}),
		).toBe(true);
	});

	it("accepts unlimited with no balance at all", () => {
		expect(
			codexCreditsCoverExhaustedWeekly({
				has_credits: true,
				unlimited: true,
				balance: null,
			}),
		).toBe(true);
	});

	it("refuses a zero balance", () => {
		for (const balance of ["0", "0.00", "+0.0", "-0"]) {
			expect(
				codexCreditsCoverExhaustedWeekly({
					has_credits: true,
					unlimited: false,
					balance,
				}),
			).toBe(false);
		}
	});

	it("refuses a negative balance", () => {
		expect(
			codexCreditsCoverExhaustedWeekly({
				has_credits: true,
				unlimited: false,
				balance: "-5.00",
			}),
		).toBe(false);
	});

	it("refuses every balance it cannot read strictly, including the comma form", () => {
		// "1,234.50" is SB23-2257's own example of a format we did not expect,
		// and parseFloat would read it as 1. Unparseable benches: an idle
		// account is today's behaviour, a wrongly routed one costs a live 429.
		for (const balance of [
			"1,234.50",
			"9.99 USD",
			"$9.99",
			"abc",
			"",
			"   ",
			"1e3",
			"Infinity",
			"NaN",
			"0x10",
			".5",
		]) {
			expect(
				codexCreditsCoverExhaustedWeekly({
					has_credits: true,
					unlimited: false,
					balance,
				}),
			).toBe(false);
		}
	});

	it("refuses has_credits false however large the balance", () => {
		// The gate codex-rs parse_credits_snapshot uses. A balance beside a
		// false flag is not upstream saying the account can spend it.
		expect(
			codexCreditsCoverExhaustedWeekly({
				has_credits: false,
				unlimited: false,
				balance: "9.99",
			}),
		).toBe(false);
	});

	it("refuses unlimited when has_credits is false", () => {
		expect(
			codexCreditsCoverExhaustedWeekly({
				has_credits: false,
				unlimited: true,
				balance: null,
			}),
		).toBe(false);
	});

	it("refuses has_credits true with no balance and not unlimited", () => {
		// Upstream said there are credits and never said how many. That is not
		// something to route traffic on.
		expect(
			codexCreditsCoverExhaustedWeekly({
				has_credits: true,
				unlimited: false,
				balance: null,
			}),
		).toBe(false);
	});

	it("refuses absent credits", () => {
		expect(codexCreditsCoverExhaustedWeekly(undefined)).toBe(false);
	});
});

describe("admission — the ruling", () => {
	it("admits a Codex account at weekly 100 with a positive balance", () => {
		expect(
			benched(
				weeklyExhausted({
					has_credits: true,
					unlimited: false,
					balance: "9.99",
				}),
			),
		).toBe(false);
	});

	it("pairs the admitted utilization with the FIVE-HOUR reset, not the weekly one", () => {
		// The lockstep this change could most easily get wrong. If
		// representativeWindow kept the weekly window while the fold dropped it,
		// the snapshot would read 12% against a reset four days out, and
		// isUsageExhausted's staleness guard would be judging a recovery time
		// belonging to a window nobody gated on. Asserting only the verdict
		// above cannot see that; the resetMs is what pins it.
		const snapshot = getRepresentativeUsageSnapshotForProvider(
			weeklyExhausted({
				has_credits: true,
				unlimited: false,
				balance: "9.99",
			}),
			"codex",
		);

		expect(snapshot).toEqual({
			utilization: 12,
			resetMs: Date.parse(FIVE_HOUR_RESET),
		});
	});

	it("keeps the weekly reset when there are no credits", () => {
		// The control for the assertion above: same payload, no credits, and
		// the snapshot is the pre-ruling one.
		expect(
			getRepresentativeUsageSnapshotForProvider(weeklyExhausted(), "codex"),
		).toEqual({ utilization: 100, resetMs: Date.parse(WEEKLY_RESET) });
	});

	it("drops a weekly_all limits[] cap too, not only the flat property", () => {
		// accountLevelLimitWindows folds a weekly_all limit into the same
		// synthetic seven_day name. Skipping only the flat window would let the
		// identical 100 back in through the limits[] door.
		const limitsShaped = {
			five_hour: { utilization: 12, resets_at: FIVE_HOUR_RESET },
			limits: [
				{ kind: "session", percent: 12, resets_at: FIVE_HOUR_RESET },
				{ kind: "weekly_all", percent: 100, resets_at: WEEKLY_RESET },
			],
			credits: { has_credits: true, unlimited: false, balance: "9.99" },
		} as unknown as UsageData;

		expect(getRepresentativeUtilizationForProvider(limitsShaped, "codex")).toBe(
			12,
		);
		expect(benched(limitsShaped)).toBe(false);
		// And the reset must come from the session limit, not the weekly one.
		// The utilization assertion above cannot see this: representativeWindow
		// has its OWN limits[] fold, so dropping the exclusion there alone leaves
		// the number at 12 while the reset slides four days out. Found by
		// mutation M7, which survived until this line existed.
		expect(
			getRepresentativeUsageSnapshotForProvider(limitsShaped, "codex"),
		).toEqual({ utilization: 12, resetMs: Date.parse(FIVE_HOUR_RESET) });
	});

	it("has no opinion when the weekly window was the only window", () => {
		// Dropping the only window must return null, never 0. A null snapshot
		// means "no telemetry" and is skipped; a 0 would be a real reading that
		// feeds the pool average and claims the account is empty.
		const weeklyOnly = {
			seven_day: { utilization: 100, resets_at: WEEKLY_RESET },
			credits: { has_credits: true, unlimited: false, balance: "9.99" },
		} as unknown as UsageData;

		expect(getRepresentativeUtilizationForProvider(weeklyOnly, "codex")).toBe(
			null,
		);
		expect(
			getRepresentativeUsageSnapshotForProvider(weeklyOnly, "codex"),
		).toBeNull();
	});
});

describe("admission — the cases that must bench exactly as before", () => {
	it("benches with no credits key at all", () => {
		expect(benched(weeklyExhausted())).toBe(true);
	});

	it("benches on a zero balance", () => {
		expect(
			benched(
				weeklyExhausted({
					has_credits: true,
					unlimited: false,
					balance: "0.00",
				}),
			),
		).toBe(true);
	});

	it("benches on a balance it cannot parse", () => {
		expect(
			benched(
				weeklyExhausted({
					has_credits: true,
					unlimited: false,
					balance: "1,234.50",
				}),
			),
		).toBe(true);
	});

	it("benches when has_credits is false", () => {
		expect(
			benched(
				weeklyExhausted({
					has_credits: false,
					unlimited: false,
					balance: "9.99",
				}),
			),
		).toBe(true);
	});

	it("benches a five-hour exhaustion however large the balance", () => {
		// The ruling names the weekly window and only the weekly window. This is
		// what proves the exclusion is weekly-scoped rather than a blanket
		// "credits mean never benched".
		const bothSpent: UsageData = {
			five_hour: { utilization: 100, resets_at: FIVE_HOUR_RESET },
			seven_day: { utilization: 100, resets_at: WEEKLY_RESET },
			credits: { has_credits: true, unlimited: true, balance: "500.00" },
		};

		expect(benched(bothSpent)).toBe(true);
		expect(
			getRepresentativeUsageSnapshotForProvider(bothSpent, "codex"),
		).toEqual({ utilization: 100, resetMs: Date.parse(FIVE_HOUR_RESET) });
	});

	it("benches an anthropic account carrying an identical credits key", () => {
		// The #219 mutation. The gate is provider === PROVIDER_NAMES.CODEX, so a
		// shared field name appearing on another provider's payload must change
		// nothing. A `"credits" in data` guard passes every other test in this
		// file and fails this one.
		const anthropic = weeklyExhausted({
			has_credits: true,
			unlimited: true,
			balance: "500.00",
		});

		expect(
			getRepresentativeUtilizationForProvider(anthropic, "anthropic"),
		).toBe(100);
		expect(benched(anthropic, "anthropic")).toBe(true);
	});
});

describe("ranking is deliberately unmoved", () => {
	it("keeps the spent weekly window in the ranking number", () => {
		// SB23-2289 ruled on admission alone and pointed at extra_usage as the
		// precedent: folded into ranking, excluded from admission. An account
		// serving off paid credits has less headroom than one inside its plan
		// quota, so it should be the later pick among equals.
		const usage = weeklyExhausted({
			has_credits: true,
			unlimited: true,
			balance: "500.00",
		});

		expect(getRankingUtilizationForProvider(usage, "codex")).toBe(100);
		expect(getRepresentativeUtilizationForProvider(usage, "codex")).toBe(12);
	});
});

describe("carryCodexCredits — the poll that reports no credits", () => {
	const CREDITS = {
		has_credits: true,
		unlimited: false,
		balance: "9.99",
	} as const;

	/** A poller payload: windows only, as parseCodexUsagePayload builds it. */
	function pollPayload(): UsageData {
		return {
			five_hour: { utilization: 20, resets_at: FIVE_HOUR_RESET },
			seven_day: { utilization: 100, resets_at: WEEKLY_RESET },
		};
	}

	it("keeps a fresh balance across a poll that carries none", () => {
		// Without this the poller erases the traffic path's reading and the
		// account flips between admitted and benched once per poll interval.
		const carried = carryCodexCredits(
			pollPayload(),
			{
				data: weeklyExhausted(CREDITS),
				timestamp: NOW,
				creditsObservedAt: NOW,
			},
			NOW + 60_000,
		);

		expect(carried.data.credits).toEqual(CREDITS);
		expect(carried.creditsObservedAt).toBe(NOW);
		expect(benched(carried.data)).toBe(false);
	});

	it("drops a balance older than the bound, and the account benches", () => {
		const carried = carryCodexCredits(
			pollPayload(),
			{
				data: weeklyExhausted(CREDITS),
				timestamp: NOW,
				creditsObservedAt: NOW,
			},
			NOW + CODEX_CREDITS_MAX_AGE_MS + 1,
		);

		expect(carried.data.credits).toBeUndefined();
		expect(carried.creditsObservedAt).toBeNull();
		expect(benched(carried.data)).toBe(true);
	});

	it("ages the carry on the credits' own clock, not the entry's", () => {
		// The correctness argument for the whole helper. Every install stamps a
		// fresh entry timestamp, so a carry measured against the entry would
		// re-stamp itself on each poll and the balance would live forever —
		// which is precisely the unbounded carry the ruling forbids. Simulate
		// polls at one-minute intervals and check the balance dies on its own
		// schedule rather than being renewed.
		let previous: {
			data: AnyUsageData;
			timestamp: number;
			creditsObservedAt: number;
		} = {
			data: weeklyExhausted(CREDITS),
			timestamp: NOW,
			creditsObservedAt: NOW,
		};

		for (let minute = 1; minute <= 9; minute++) {
			const at = NOW + minute * 60_000;
			const carried = carryCodexCredits(pollPayload(), previous, at);
			expect(carried.creditsObservedAt).toBe(NOW);
			previous = {
				data: carried.data,
				// install() always stamps the entry with the moment of the write.
				timestamp: at,
				creditsObservedAt: carried.creditsObservedAt ?? 0,
			};
		}
		expect((previous.data as UsageData).credits).toEqual(CREDITS);

		const expired = carryCodexCredits(
			pollPayload(),
			previous,
			NOW + CODEX_CREDITS_MAX_AGE_MS + 1,
		);
		expect(expired.data.credits).toBeUndefined();
	});

	it("lets upstream revoke a balance, even to has_credits false", () => {
		// A payload that speaks about credits always wins. Upstream saying the
		// account has none now must not be overridden by a reading from before.
		const revoked = {
			has_credits: false,
			unlimited: false,
			balance: null,
		} as const;
		const next: UsageData = { ...pollPayload(), credits: revoked };

		const carried = carryCodexCredits(
			next,
			{
				data: weeklyExhausted(CREDITS),
				timestamp: NOW,
				creditsObservedAt: NOW,
			},
			NOW + 60_000,
		);

		expect(carried.data.credits).toEqual(revoked);
		expect(carried.creditsObservedAt).toBe(NOW + 60_000);
		expect(benched(carried.data)).toBe(true);
	});

	it("refuses a balance stamped NOT_OBSERVED rather than re-dating it", () => {
		// CODEX_CREDITS_NOT_OBSERVED is 0, which is FALSY, so any `||` reached
		// with that stamp silently falls through to the entry timestamp and
		// renews the balance — the exact mechanism the `??` fallback was removed
		// for. Today no writer produces credits beside that stamp, so a mutation
		// swapping the plain read for `|| previous.timestamp` is equivalent and
		// survives. This pins the invariant directly instead of relying on that
		// reachability argument staying true.
		const carried = carryCodexCredits(
			{ five_hour: { utilization: 20, resets_at: FIVE_HOUR_RESET } },
			{
				data: weeklyExhausted(CREDITS),
				timestamp: NOW,
				creditsObservedAt: CODEX_CREDITS_NOT_OBSERVED,
			},
			NOW,
		);

		expect(carried.data.credits).toBeUndefined();
		expect(carried.creditsObservedAt).toBeNull();
	});

	it("carries nothing when there was no previous entry", () => {
		const carried = carryCodexCredits(pollPayload(), undefined, NOW);

		expect(carried.data.credits).toBeUndefined();
		expect(carried.creditsObservedAt).toBeNull();
	});

	it("falls back to the entry timestamp when the stamp is absent", () => {
		// Every writer except the poller takes its credits off the same response
		// as the windows beside them, so an unstamped entry's credits are exactly
		// as old as the entry. An entry older than the bound with no stamp must
		// therefore expire, not read as age zero.
		const stale = carryCodexCredits(
			pollPayload(),
			{
				data: weeklyExhausted(CREDITS),
				timestamp: NOW,
				creditsObservedAt: NOW,
			},
			NOW + CODEX_CREDITS_MAX_AGE_MS + 1,
		);
		expect(stale.data.credits).toBeUndefined();
	});

	it("does not mutate the payload it was handed", () => {
		const next = pollPayload();
		carryCodexCredits(
			next,
			{
				data: weeklyExhausted(CREDITS),
				timestamp: NOW,
				creditsObservedAt: NOW,
			},
			NOW,
		);
		expect(next.credits).toBeUndefined();
	});
});
