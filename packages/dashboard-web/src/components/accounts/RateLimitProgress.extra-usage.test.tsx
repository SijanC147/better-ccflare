import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	AnthropicUsageData,
	ExtraUsageData,
	UsageSpend,
} from "@better-ccflare/types";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account } from "../../api";
import { AccountListItem } from "./AccountListItem";
import { RateLimitProgress } from "./RateLimitProgress";

/**
 * The "Extra usage" block on an Anthropic card (SB23-3266). It replaced an
 * "Overage credits" row that printed the amount SPENT, so a fresh account read
 * "USD 0.00" as though nothing were left, and that rendered nothing at all
 * unless `spend.enabled` was true. That row had no test.
 *
 * Every assertion that denies a digit reads the block's visible text alone,
 * because the rest of the card is full of digits (window percentages, reset
 * times) and so is the block's own markup (`space-y-2`). A whole-card
 * `not.toMatch(/\d/)` could never pass, and a whole-card `toContain("0")`
 * could never fail.
 */

const RESET = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();

function usage(
	extra?: Partial<ExtraUsageData> | null,
	spend?: UsageSpend,
): AnthropicUsageData {
	return {
		five_hour: { utilization: 12, resets_at: RESET },
		seven_day: { utilization: 34, resets_at: RESET },
		...(extra
			? {
					extra_usage: {
						is_enabled: false,
						monthly_limit: null,
						used_credits: null,
						utilization: null,
						...extra,
					},
				}
			: {}),
		...(spend ? { spend } : {}),
	};
}

function render(
	usageData: AnthropicUsageData,
	provider = "anthropic",
	renewalDay: number | null = null,
): string {
	return renderToStaticMarkup(
		<RateLimitProgress
			provider={provider}
			resetIso={RESET}
			usageUtilization={12}
			usageWindow="five_hour"
			usageData={usageData}
			showWeekly
			renewalDay={renewalDay}
		/>,
	);
}

/**
 * The block's own markup, or null when there is none: the element carrying
 * `data-extra-usage`, out to its matching close tag.
 */
function block(html: string): string | null {
	const marker = html.indexOf("data-extra-usage=");
	if (marker === -1) return null;
	const start = html.lastIndexOf("<div", marker);
	let depth = 0;
	const tag = /<\/?div\b[^>]*>/g;
	tag.lastIndex = start;
	for (let m = tag.exec(html); m !== null; m = tag.exec(html)) {
		depth += m[0].startsWith("</") ? -1 : 1;
		if (depth === 0) return html.slice(start, m.index + m[0].length);
	}
	throw new Error("unbalanced markup around data-extra-usage");
}

/** The remaining-balance text, exactly as rendered, or null when absent. */
function remaining(html: string): string | null {
	const m = /data-extra-usage-remaining="">([^<]*)</.exec(html);
	return m ? m[1] : null;
}

/** Visible text of a markup slice, tags removed. */
function text(markup: string): string {
	return markup.replace(/<[^>]*>/g, "");
}

describe("RateLimitProgress, Anthropic extra usage", () => {
	it("renders nothing when the payload carries neither extra_usage nor spend", () => {
		const html = render(usage());

		expect(html).not.toContain("Extra usage");
		expect(block(html)).toBeNull();
		// The card itself still renders: the absence is the block's, not the card's.
		expect(html).toContain("5-hour");
	});

	it("reads Off with no number when extra usage was never configured", () => {
		const html = render(
			usage({
				is_enabled: false,
				monthly_limit: null,
				used_credits: null,
				utilization: null,
			}),
		);
		const b = block(html);

		expect(b).not.toBeNull();
		expect(text(b ?? "")).toBe("Extra usageOff");
		// Null is not zero: no digit anywhere in the block.
		expect(text(b ?? "")).not.toMatch(/\d/);
	});

	it("reads Off when spend.enabled is false, whatever extra_usage says", () => {
		// The router reads the same precedence (`resolveOverageStatus`), so a card
		// that said "on" here would contradict routing. The numbers are present so
		// a resolver that ignored the precedence would render them.
		const html = render(
			usage(
				{
					is_enabled: true,
					monthly_limit: 1000,
					used_credits: 400,
					utilization: 40,
				},
				{ enabled: false },
			),
		);
		const b = block(html) ?? "";

		expect(text(b)).toBe("Extra usageOff");
		expect(text(b ?? "")).not.toMatch(/\d/);
		expect(remaining(html)).toBeNull();
	});

	it("names the upstream reason when extra usage is off", () => {
		const html = render(
			usage(
				{ is_enabled: false, disabled_reason: "user_disabled" },
				{ enabled: false, disabled_reason: "user_disabled" },
			),
		);

		expect(text(block(html) ?? "")).toBe("Extra usageOff · user disabled");
	});

	it("shows remaining, used and limit as bare credits when no unit was sent", () => {
		const html = render(
			usage({
				is_enabled: true,
				monthly_limit: 1000,
				used_credits: 750,
				utilization: 75,
			}),
		);
		const b = block(html) ?? "";

		expect(remaining(html)).toBe("250");
		expect(text(b)).toContain("250 credits left");
		// Headroom left: nothing is marked as reached.
		expect(b).not.toContain("text-red-600");
		expect(b).not.toContain("bg-red-500");
		expect(text(b)).toContain("750 of 1000 credits used");
		// No unit was reported, so none is invented.
		expect(b).not.toContain("$");
		expect(b).not.toContain("USD");
	});

	it("reads exactly 0 when the pool is spent to the limit", () => {
		const html = render(
			usage({
				is_enabled: true,
				monthly_limit: 1000,
				used_credits: 1000,
				utilization: 100,
			}),
		);

		expect(remaining(html)).toBe("0");
	});

	it("clamps an overspent pool at 0 and keeps the raw pair visible", () => {
		// The real-shape fixture in usage-fetcher-extra-usage.test.ts: 1123 of 1000.
		const html = render(
			usage({
				is_enabled: true,
				monthly_limit: 1000,
				used_credits: 1123,
				utilization: 100,
			}),
		);
		const b = block(html) ?? "";

		expect(remaining(html)).toBe("0");
		expect(text(b)).toContain("1123");
		expect(text(b)).toContain("1000");
		expect(b).not.toContain("-123");
		// The reached limit is marked on the figure and on the bar.
		expect(b).toContain("text-red-600");
		expect(b).toContain("bg-red-500");
	});

	it("renders currency from spend when spend carries money objects", () => {
		const html = render(
			usage(
				{
					is_enabled: true,
					monthly_limit: 5000,
					used_credits: 1250,
					utilization: 25,
				},
				{
					enabled: true,
					percent: 25,
					used: { amount_minor: 1250, currency: "USD", exponent: 2 },
					limit: { amount_minor: 5000, currency: "USD", exponent: 2 },
				},
			),
		);
		const b = block(html) ?? "";

		expect(remaining(html)).toBe("USD 37.50");
		expect(text(b)).toContain("USD 12.50 of USD 50.00 used");
		expect(text(b)).not.toContain("credits");
	});

	it("renders currency from extra_usage's own unit when spend has none", () => {
		const html = render(
			usage({
				is_enabled: true,
				monthly_limit: 2000,
				used_credits: 500,
				utilization: 25,
				currency: "EUR",
				decimal_places: 2,
			}),
		);

		expect(remaining(html)).toBe("EUR 15.00");
		expect(text(block(html) ?? "")).toContain("EUR 5.00 of EUR 20.00 used");
	});

	it("says On and invents no number when extra usage is on with nothing reported", () => {
		const html = render(
			usage({
				is_enabled: true,
				monthly_limit: null,
				used_credits: null,
				utilization: null,
			}),
		);
		const b = block(html) ?? "";

		expect(text(b)).toBe("Extra usageOn");
		expect(text(b ?? "")).not.toMatch(/\d/);
	});

	it("shows an unreported spend as unknown, never as zero", () => {
		const html = render(
			usage({ is_enabled: true, monthly_limit: 1000, used_credits: null }),
		);
		const b = text(block(html) ?? "");

		expect(b).toBe("Extra usageOn? of 1000 credits used");
		expect(b).not.toMatch(/\b0 of/);
		expect(remaining(html)).toBeNull();
	});

	it("clamps the bar to 0..100 whatever percent upstream sends", () => {
		const over = block(
			render(
				usage({
					is_enabled: true,
					monthly_limit: 100,
					used_credits: 1,
					utilization: 250,
				}),
			),
		);
		const under = block(
			render(
				usage({
					is_enabled: true,
					monthly_limit: 100,
					used_credits: 1,
					utilization: -40,
				}),
			),
		);

		expect(over).toContain("translateX(-0%)");
		expect(under).toContain("translateX(-100%)");
	});

	it("renders no extra-usage block on a Codex card that carries the key", () => {
		// Gate on the provider, never on the key (SB23-2462). The fixture is
		// on-shaped with numbers, so a key-presence gate would render digits here.
		const html = render(
			usage(
				{
					is_enabled: true,
					monthly_limit: 1000,
					used_credits: 100,
					utilization: 10,
				},
				{ enabled: true, percent: 10 },
			),
			"codex",
		);

		expect(html).not.toContain("Extra usage");
		expect(block(html)).toBeNull();
		expect(html).not.toContain("Overage credits");
	});

	it("no longer renders the spent-amount Overage row", () => {
		const html = render(
			usage(undefined, {
				enabled: true,
				percent: 0,
				used: { amount_minor: 0, currency: "USD", exponent: 2 },
			}),
		);

		expect(html).not.toContain("Overage credits");
		// The spend is still shown, as what it is.
		expect(text(block(html) ?? "")).toBe(
			"Extra usageOnUSD 0.00 of no limit used",
		);
	});

	it("labels the renewal date as operator-set when one is configured", () => {
		const html = render(
			usage({
				is_enabled: true,
				monthly_limit: 1000,
				used_credits: 10,
				utilization: 1,
			}),
			"anthropic",
			15,
		);
		const b = text(block(html) ?? "");

		expect(b).toMatch(/renews .+ \(operator-set\)/);
	});

	it("shows no renewal date when none is configured, or when extra usage is off", () => {
		const on = render(
			usage({
				is_enabled: true,
				monthly_limit: 1000,
				used_credits: 10,
				utilization: 1,
			}),
		);
		const off = render(usage({ is_enabled: false }), "anthropic", 15);

		expect(on).not.toContain("renews");
		expect(off).not.toContain("renews");
	});
});

describe("AccountListItem, extra usage", () => {
	const account: Account = {
		id: "account-1",
		name: "test-account",
		provider: "anthropic",
		requestCount: 0,
		totalRequests: 0,
		lastUsed: null,
		created: new Date(0).toISOString(),
		paused: false,
		requiresReauth: false,
		pauseReason: null,
		tokenStatus: "valid",
		tokenExpiresAt: null,
		rateLimitStatus: "OK",
		rateLimitReset: null,
		rateLimitRemaining: null,
		rateLimitedUntil: null,
		rateLimitedReason: null,
		rateLimitedAt: null,
		sessionInfo: "No active session",
		priority: 1,
		autoFallbackEnabled: true,
		autoRefreshEnabled: true,
		customEndpoint: null,
		modelMappings: null,
		requestTransformer: null,
		usageUtilization: 12,
		usageWindow: "five_hour",
		usageData: usage({
			is_enabled: true,
			monthly_limit: 1000,
			used_credits: 10,
			utilization: 1,
		}),
		usageRateLimitedUntil: null,
		usageThrottledUntil: null,
		usageThrottledWindows: [],
		hasRefreshToken: true,
		sessionStats: null,
		isPrimary: false,
		lastManualReauthAt: null,
		reauthDeadlineStatus: null,
		daysUntilReauthRequired: null,
		hoursUntilReauthRequired: null,
		renewalDay: 15,
		nextRenewalAt: null,
		daysUntilRenewal: null,
		usagePauseFiveHourThreshold: null,
		usagePauseWeeklyThreshold: null,
		usagePauseFiveHourEnabled: false,
		usagePauseWeeklyEnabled: false,
	};

	function renderItem(a: Account): string {
		return renderToStaticMarkup(
			<AccountListItem
				account={a}
				onPauseToggle={() => {}}
				onForceResetRateLimit={() => {}}
				onRefreshUsage={async () => {}}
				onRemove={() => {}}
				onRename={() => {}}
				onPriorityChange={() => {}}
				onAutoFallbackToggle={() => {}}
				onAutoRefreshToggle={() => {}}
				onBillingTypeToggle={() => {}}
			/>,
		);
	}

	it("passes the account's balance and renewal day through to the card", () => {
		// Covers the call site, not only the component: a card that is never
		// handed `renewalDay` passes every test above.
		const b = text(block(renderItem(account)) ?? "");

		expect(b).toContain("990 credits left");
		expect(b).toMatch(/renews .+ \(operator-set\)/);
	});
});

/**
 * Every hour-bearing date formatter in RateLimitProgress.tsx, each paired with
 * whether it pins the 24-hour clock. A formatter left to the locale prints
 * "3:04 PM" for one viewer and "15:04" for the next.
 *
 * It reads the call's own argument text, so it sees `toLocale*String(...)` and
 * `new Intl.DateTimeFormat(...)` with inline options. Options passed by
 * reference (`clockOptions` for the peak labels) carry no `hour:` in the call
 * and are not seen; SB23-3521 covers those and the dashboard-wide toggle.
 */
function hourFormatterCalls(
	source: string,
): { call: string; pinned: boolean }[] {
	const out: { call: string; pinned: boolean }[] = [];
	const opener =
		/\.toLocale(?:Time|Date)?String\(|\bnew\s+Intl\.DateTimeFormat\(/g;
	for (let m = opener.exec(source); m !== null; m = opener.exec(source)) {
		let depth = 1;
		let i = m.index + m[0].length;
		for (; i < source.length && depth > 0; i++) {
			if (source[i] === "(") depth++;
			else if (source[i] === ")") depth--;
		}
		const call = source.slice(m.index, i);
		if (!/\bhour\s*:/.test(call)) continue;
		out.push({
			call,
			pinned: /hourCycle:\s*"h23"/.test(call) && !/\bhour12\s*:/.test(call),
		});
	}
	return out;
}

describe("RateLimitProgress, 24-hour clock", () => {
	it("pins hourCycle h23 on every hour-bearing formatter", () => {
		const source = readFileSync(
			join(import.meta.dir, "RateLimitProgress.tsx"),
			"utf8",
		);
		const calls = hourFormatterCalls(source);

		// Four when this was written; fewer means the scan stopped matching.
		expect(calls.length).toBeGreaterThanOrEqual(4);
		expect(calls.filter((c) => !c.pinned).map((c) => c.call)).toEqual([]);
	});

	it("flags a formatter that leaves the hour to the locale", () => {
		// The scan has to be able to return the other answer.
		const calls = hourFormatterCalls(
			'd.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });\n' +
				'd.toLocaleString(undefined, { hour: "2-digit", hour12: false, hourCycle: "h23" });\n' +
				'd.toLocaleDateString(undefined, { month: "short" });\n' +
				'new Intl.DateTimeFormat(undefined, { hour: "2-digit" }).format(d);\n' +
				'new Intl.DateTimeFormat(undefined, { hour: "2-digit", hourCycle: "h23" });',
		);

		expect(calls.map((c) => c.pinned)).toEqual([false, false, false, true]);
	});
});
