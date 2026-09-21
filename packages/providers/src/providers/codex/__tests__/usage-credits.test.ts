import { describe, expect, it } from "bun:test";
import { isUsageExhausted } from "@better-ccflare/core";
import {
	getRankingUtilizationForProvider,
	getRepresentativeUtilizationForProvider,
} from "../../../usage-fetcher";
import { parseCodexCreditsHeaders, parseCodexUsageHeaders } from "../usage";

/**
 * Codex reports a credit balance on the same response headers the weekly window
 * arrives on. An account whose weekly quota is spent can keep serving on those
 * credits, so the dashboard has to be able to tell "exhausted and stuck" from
 * "exhausted and paying". Header names measured against a live Codex account on
 * 2026-09-18; see SB23-2257.
 */

/** A response that reports a spent weekly window, as a live 429 does. */
function exhaustedWindows(): Record<string, string> {
	return {
		"x-codex-primary-window-minutes": "300",
		"x-codex-primary-used-percent": "0",
		"x-codex-primary-reset-at": String(Math.floor(Date.now() / 1000) + 3600),
		"x-codex-secondary-window-minutes": "10080",
		"x-codex-secondary-used-percent": "100",
		"x-codex-secondary-reset-at": String(
			Math.floor(Date.now() / 1000) + 129_600,
		),
	};
}

describe("parseCodexCreditsHeaders", () => {
	it("reads the three credit headers when has-credits is present", () => {
		const credits = parseCodexCreditsHeaders(
			new Headers({
				"x-codex-credits-has-credits": "true",
				"x-codex-credits-unlimited": "false",
				"x-codex-credits-balance": "9.99",
			}),
		);

		expect(credits).toEqual({
			has_credits: true,
			unlimited: false,
			balance: "9.99",
		});
	});

	it("keeps the balance as the upstream string", () => {
		// Never parseFloat: a format we did not expect would become 0, and a zero
		// balance is the one reading that makes an operator abandon the account.
		const credits = parseCodexCreditsHeaders(
			new Headers({
				"x-codex-credits-has-credits": "true",
				"x-codex-credits-balance": "1,234.50",
			}),
		);

		expect(credits?.balance).toBe("1,234.50");
		expect(typeof credits?.balance).toBe("string");
	});

	it("returns null when has-credits is absent, even if a balance was sent", () => {
		// Mirrors codex-rs parse_credits_snapshot: the gate is has-credits alone.
		// A balance without it is not enough to claim the account has credits.
		expect(
			parseCodexCreditsHeaders(
				new Headers({ "x-codex-credits-balance": "9.99" }),
			),
		).toBeNull();
	});

	it("returns null for a header it cannot read, rather than defaulting to false", () => {
		expect(
			parseCodexCreditsHeaders(
				new Headers({ "x-codex-credits-has-credits": "yes" }),
			),
		).toBeNull();
		expect(
			parseCodexCreditsHeaders(
				new Headers({ "x-codex-credits-has-credits": "" }),
			),
		).toBeNull();
	});

	it("accepts the booleans case-insensitively and with surrounding space", () => {
		const credits = parseCodexCreditsHeaders(
			new Headers({
				"x-codex-credits-has-credits": " TRUE ",
				"x-codex-credits-unlimited": "True",
			}),
		);

		expect(credits?.has_credits).toBe(true);
		expect(credits?.unlimited).toBe(true);
	});

	it("reports unlimited with no balance, which is a real upstream state", () => {
		const credits = parseCodexCreditsHeaders(
			new Headers({
				"x-codex-credits-has-credits": "true",
				"x-codex-credits-unlimited": "true",
			}),
		);

		expect(credits).toEqual({
			has_credits: true,
			unlimited: true,
			balance: null,
		});
	});

	it("treats an unreadable unlimited flag as bounded, never as unlimited", () => {
		const credits = parseCodexCreditsHeaders(
			new Headers({
				"x-codex-credits-has-credits": "true",
				"x-codex-credits-unlimited": "maybe",
				"x-codex-credits-balance": "2.00",
			}),
		);

		expect(credits?.unlimited).toBe(false);
	});

	it("reports has_credits false when upstream says so", () => {
		const credits = parseCodexCreditsHeaders(
			new Headers({
				"x-codex-credits-has-credits": "false",
				"x-codex-credits-unlimited": "false",
			}),
		);

		expect(credits).toEqual({
			has_credits: false,
			unlimited: false,
			balance: null,
		});
	});

	it("treats a blank balance as no balance, not the empty string", () => {
		const credits = parseCodexCreditsHeaders(
			new Headers({
				"x-codex-credits-has-credits": "true",
				"x-codex-credits-balance": "   ",
			}),
		);

		expect(credits?.balance).toBeNull();
	});
});

describe("parseCodexUsageHeaders — credits", () => {
	it("attaches credits alongside the windows", () => {
		const usage = parseCodexUsageHeaders(
			new Headers({
				...exhaustedWindows(),
				"x-codex-credits-has-credits": "true",
				"x-codex-credits-unlimited": "false",
				"x-codex-credits-balance": "9.99",
			}),
		);

		expect(usage?.seven_day?.utilization).toBe(100);
		expect(usage?.credits).toEqual({
			has_credits: true,
			unlimited: false,
			balance: "9.99",
		});
	});

	it("omits the credits KEY entirely when no credit header was sent", () => {
		// Absent is omitted, not zeroed: `"credits" in usage` must be false, so a
		// consumer checking for the key cannot see an explicit undefined and
		// render an empty credits line.
		const usage = parseCodexUsageHeaders(new Headers(exhaustedWindows()));

		expect(usage).not.toBeNull();
		expect(usage && "credits" in usage).toBe(false);
	});

	it("still returns null when there are credits but no window at all", () => {
		// Credits alone do not make an account "has usage data". That bucket feeds
		// admission and the pool average; widening it is a routing change.
		expect(
			parseCodexUsageHeaders(
				new Headers({ "x-codex-credits-has-credits": "true" }),
			),
		).toBeNull();
	});
});

describe("credits move admission, and ranking is deliberately left alone", () => {
	// This block used to be called "credits do not move admission" and encoded
	// the SB23-2257 decision that a displayed balance changes no routing. Sean
	// reversed the admission half on 2026-09-21 in SB23-2289: those credits are
	// paid for and upstream would keep serving on them, so benching idles a
	// usable account at the moment every other window is full.
	//
	// TWO assertions below were rewritten, and they are named here rather than
	// edited quietly, because they are the record of the old decision:
	//
	//   - "leaves getRepresentativeUtilizationForProvider unchanged" now asserts
	//     the two DIFFER, and that the credit-bearing payload reads as the
	//     five-hour window instead of the spent weekly one.
	//   - "leaves isUsageExhausted unchanged" now asserts the credit-bearing
	//     account is admitted where the credit-free one is benched. Its old
	//     `expect(verdict(withCredits)).toBe(true)` line is exactly the ruling's
	//     verdict inverted.
	//
	// The ranking assertion below is NOT rewritten. It is load-bearing for the
	// new behaviour rather than left over from the old one: SB23-2289 ruled on
	// admission alone and named `extra_usage` as the precedent, so a spent
	// weekly window still counts when sorting among admitted accounts and an
	// account burning paid credits is the later pick.
	const withoutCredits = parseCodexUsageHeaders(
		new Headers(exhaustedWindows()),
	);
	const withCredits = parseCodexUsageHeaders(
		new Headers({
			...exhaustedWindows(),
			"x-codex-credits-has-credits": "true",
			"x-codex-credits-unlimited": "true",
			"x-codex-credits-balance": "500.00",
		}),
	);

	it("drops the credit-covered weekly window from the admission utilization", () => {
		// exhaustedWindows() is weekly 100 over five-hour 0, so the admission
		// number falling to the five-hour reading is the whole change: the
		// account is judged on the window it can still serve from.
		expect(
			getRepresentativeUtilizationForProvider(withoutCredits, "codex"),
		).toBe(100);
		expect(getRepresentativeUtilizationForProvider(withCredits, "codex")).toBe(
			0,
		);
	});

	it("leaves the ranking utilization unchanged too", () => {
		// Ranking folds in extra_usage; credits must not sneak in beside it and
		// reorder the pool as a side effect of a display change.
		expect(getRankingUtilizationForProvider(withCredits, "codex")).toBe(
			getRankingUtilizationForProvider(withoutCredits, "codex"),
		);
	});

	it("still ranks the credit-burning account as the fuller one", () => {
		// The negative half of the assertion above. "Unchanged" alone is also
		// satisfied if BOTH readings broke together, so pin the value: an
		// account serving off credits has genuinely less headroom than one
		// inside its plan quota and must not sort as though it were empty.
		expect(getRankingUtilizationForProvider(withCredits, "codex")).toBe(100);
	});

	it("admits the credit-bearing account and benches the credit-free one", () => {
		const now = Date.now();
		const verdict = (usage: typeof withCredits) =>
			isUsageExhausted(
				getRepresentativeUtilizationForProvider(usage, "codex"),
				usage?.seven_day?.resets_at
					? new Date(usage.seven_day.resets_at).getTime()
					: null,
				now,
			);

		expect(verdict(withoutCredits)).toBe(true);
		expect(verdict(withCredits)).toBe(false);
	});
});
