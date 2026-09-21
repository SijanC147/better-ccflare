import { describe, expect, it } from "bun:test";
import type { AnthropicUsageData, XaiUsageData } from "@better-ccflare/types";
import { renderToStaticMarkup } from "react-dom/server";
import { RateLimitProgress } from "./RateLimitProgress";

/**
 * A weekly-exhausted Codex card must keep its usage bar and its reset countdown
 * and gain the credits line beside them. The Kilo credits branch above returns
 * early and therefore replaces the bar, which is the wrong shape here: the
 * balance only means something read against the window it outlives. SB23-2257.
 */

const WEEKLY_RESET = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString();

function renderCodex(
	credits?: AnthropicUsageData["credits"],
	utilization = 100,
) {
	const usageData: AnthropicUsageData = {
		five_hour: { utilization: 0, resets_at: null },
		seven_day: { utilization, resets_at: WEEKLY_RESET },
		...(credits ? { credits } : {}),
	};
	return renderToStaticMarkup(
		<RateLimitProgress
			provider="codex"
			resetIso={WEEKLY_RESET}
			usageUtilization={utilization}
			usageWindow="seven_day"
			usageData={usageData}
		/>,
	);
}

describe("RateLimitProgress — Codex credits", () => {
	it("renders the balance beside the weekly bar and the countdown", () => {
		const html = renderCodex({
			has_credits: true,
			unlimited: false,
			balance: "9.99",
		});

		expect(html).toContain("Credits");
		expect(html).toContain("9.99");
		// The bar and the countdown are the point: a credits line that replaced
		// them would pass a naive "contains 9.99" assertion while removing the
		// information the operator came for.
		expect(html).toContain("Weekly");
		expect(html).toMatch(/until refresh|Resets/);
	});

	it("renders nothing about credits when the field is absent", () => {
		const html = renderCodex(undefined);

		expect(html).not.toContain("Credits");
		// Absent is not zero: no invented balance of any shape.
		expect(html).not.toContain("$0.00");
		expect(html).not.toContain("0 credits");
		// The card is otherwise unchanged.
		expect(html).toContain("Weekly");
	});

	it("renders Unlimited rather than a missing balance", () => {
		const html = renderCodex({
			has_credits: true,
			unlimited: true,
			balance: null,
		});

		expect(html).toContain("Credits");
		expect(html).toContain("Unlimited");
	});

	it("says Available when upstream reported credits but no amount", () => {
		const html = renderCodex({
			has_credits: true,
			unlimited: false,
			balance: null,
		});

		expect(html).toContain("Available");
		expect(html).not.toContain("Unlimited");
	});

	it("says Available for a credits object carrying no balance key at all", () => {
		// The object crosses a JSON boundary and is cast loosely in the component,
		// so `balance` can be missing rather than null. A strict `!== null` would
		// take the balance branch and render an empty value beside the label.
		const html = renderToStaticMarkup(
			<RateLimitProgress
				provider="codex"
				resetIso={WEEKLY_RESET}
				usageUtilization={100}
				usageWindow="seven_day"
				usageData={
					{
						five_hour: { utilization: 0, resets_at: null },
						seven_day: { utilization: 100, resets_at: WEEKLY_RESET },
						credits: { has_credits: true, unlimited: false },
					} as unknown as AnthropicUsageData
				}
			/>,
		);

		expect(html).toContain("Available");
	});

	it("renders a zero balance as the number, never as Available", () => {
		// The single most consequential decision in this feature: `balance` stays
		// the upstream string. "0.00" is a truthy string, so it renders as itself.
		// Convert it to a number anywhere upstream of here and a real zero becomes
		// falsy, falls through to the has_credits ladder, and an account with
		// nothing left reads as "Available". That is the exact false reading the
		// string was chosen to prevent, and nothing else in the suite catches it.
		const html = renderCodex({
			has_credits: true,
			unlimited: false,
			balance: "0.00",
		});

		expect(html).toContain("0.00");
		expect(html).not.toContain("Available");
	});

	it("says None when upstream explicitly reported no credits", () => {
		const html = renderCodex({
			has_credits: false,
			unlimited: false,
			balance: null,
		});

		expect(html).toContain("None");
	});

	it("shows the line below 100% too, not only when the window is spent", () => {
		// A balance next to a 40% bar is also information, and a line that only
		// ever appears in one state is a line nobody learns to look for.
		const html = renderCodex(
			{ has_credits: true, unlimited: false, balance: "3.25" },
			40,
		);

		expect(html).toContain("Credits");
		expect(html).toContain("3.25");
	});

	// The cases above all leave `showWeekly` at its default of false, which is
	// how SB23-2462 shipped: the real card passes `showWeekly` (AccountListItem
	// reads providerShowsWeeklyUsage("codex") === true), and only with it set
	// does the render reach the window-selection chain where the provider
	// detectors live. Everything below renders the card the way the dashboard
	// renders it.
	function renderCodexWithWeekly(
		credits?: AnthropicUsageData["credits"],
		utilization = 100,
	) {
		const usageData: AnthropicUsageData = {
			five_hour: { utilization: 0, resets_at: null },
			seven_day: { utilization, resets_at: WEEKLY_RESET },
			...(credits ? { credits } : {}),
		};
		return renderToStaticMarkup(
			<RateLimitProgress
				provider="codex"
				resetIso={WEEKLY_RESET}
				usageUtilization={utilization}
				usageWindow="seven_day"
				usageData={usageData}
				showWeekly
			/>,
		);
	}

	it("keeps the weekly window and never reads as Grok when credits are present", () => {
		// SB23-2462. `isXaiData` detected xAI by the presence of a `credits` key,
		// and `AnthropicUsageData.credits` (Codex, #154/#156) is the second and
		// only other member of FullUsageData carrying that key. A Codex account
		// whose usage refresh populated credits therefore took the xAI arm, which
		// reads `credits.utilization`; CodexCreditsData has no such field, so the
		// bar rendered "undefined%" under the label "Grok credits", and because
		// the chain is `else if`, the Codex weekly window was never reached.
		const html = renderCodexWithWeekly({
			has_credits: true,
			unlimited: false,
			balance: "9.99",
		});

		expect(html).not.toContain("Grok");
		expect(html).not.toContain("undefined");
		// The weekly bar is a Codex account's only quota bar. Asserting it is
		// present is what pins the fall-through to the Anthropic-style arm.
		expect(html).toContain("Weekly");
		// The credits line is beside the bar, not instead of it.
		expect(html).toContain("9.99");
	});

	it("still renders the weekly window when credits are absent", () => {
		// The negative half: the label and the bar must not depend on credits.
		const html = renderCodexWithWeekly(undefined);

		expect(html).not.toContain("Grok");
		expect(html).toContain("Weekly");
	});

	it("reads the utilization out of credits for an actual xAI account", () => {
		// The positive direction for the detector this fix rewrites. Without it a
		// typo in the provider string passes every other case in the file, because
		// every other case asserts the xAI arm does NOT run.
		//
		// `usageUtilization` is deliberately null and `usageWindow` deliberately
		// absent: the generic `providerShowsWeeklyUsage` fallback further down the
		// chain also accepts provider "xai" and would render an identical "Grok
		// credits" row from those two props. Measured — with them supplied, a
		// mutation changing PROVIDER_NAMES.XAI to a typo survived this case. Left
		// null, the fallback's own guards reject it and the only path that can
		// produce a row is the xAI arm reading `credits.utilization`.
		const html = renderToStaticMarkup(
			<RateLimitProgress
				provider="xai"
				resetIso={WEEKLY_RESET}
				usageUtilization={null}
				usageData={{ credits: { utilization: 42, resets_at: WEEKLY_RESET } }}
				showWeekly
			/>,
		);

		expect(html).toContain("Grok credits");
		expect(html).toContain("42%");
		expect(html).not.toContain("undefined");
	});

	it("says Data unavailable when an xAI credits object carries no utilization", () => {
		// The second defect on the same path, independent of the discriminator.
		// `usage.utilization` is declared `number | null`, but every value reaching
		// it has crossed a JSON boundary through a cast, so a credits object that
		// predates the field yields `undefined`. The row's availability test was
		// `percentage !== null`, and `undefined !== null` is true, so the row was
		// treated as available and formatted the missing number as "undefined%".
		// Fixing the discriminator removes the Codex producer of that value; this
		// asserts the row itself no longer prints one from any producer.
		const html = renderToStaticMarkup(
			<RateLimitProgress
				provider="xai"
				resetIso={WEEKLY_RESET}
				usageUtilization={null}
				usageData={
					{ credits: { resets_at: WEEKLY_RESET } } as unknown as XaiUsageData
				}
				showWeekly
			/>,
		);

		expect(html).not.toContain("undefined");
		// The row is still rendered, saying so: a vanished bar reads as "no limit".
		expect(html).toContain("Grok credits");
		expect(html).toContain("N/A");
	});

	it("does not render a credits line for a non-Codex provider", () => {
		const html = renderToStaticMarkup(
			<RateLimitProgress
				provider="anthropic"
				resetIso={WEEKLY_RESET}
				usageUtilization={100}
				usageWindow="seven_day"
				usageData={
					{
						five_hour: { utilization: 0, resets_at: null },
						seven_day: { utilization: 100, resets_at: WEEKLY_RESET },
						credits: { has_credits: true, unlimited: false, balance: "9.99" },
					} as AnthropicUsageData
				}
			/>,
		);

		expect(html).not.toContain("9.99");
	});
});
