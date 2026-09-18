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

describe("credits do not move admission", () => {
	// The acceptance line for SB23-2257: displaying a balance must not bench or
	// unbench anything. Same reasoning that keeps extra_usage out of admission.
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

	it("leaves getRepresentativeUtilizationForProvider unchanged", () => {
		const withoutValue = getRepresentativeUtilizationForProvider(
			withoutCredits,
			"codex",
		);
		expect(getRepresentativeUtilizationForProvider(withCredits, "codex")).toBe(
			withoutValue,
		);
		expect(withoutValue).toBe(100);
	});

	it("leaves the ranking utilization unchanged too", () => {
		// Ranking folds in extra_usage; credits must not sneak in beside it and
		// reorder the pool as a side effect of a display change.
		expect(getRankingUtilizationForProvider(withCredits, "codex")).toBe(
			getRankingUtilizationForProvider(withoutCredits, "codex"),
		);
	});

	it("leaves isUsageExhausted unchanged", () => {
		const now = Date.now();
		const verdict = (usage: typeof withCredits) =>
			isUsageExhausted(
				getRepresentativeUtilizationForProvider(usage, "codex"),
				usage?.seven_day?.resets_at
					? new Date(usage.seven_day.resets_at).getTime()
					: null,
				now,
			);

		expect(verdict(withCredits)).toBe(verdict(withoutCredits));
		// And it is still exhausted: unlimited credits must not unbench it here.
		expect(verdict(withCredits)).toBe(true);
	});
});
