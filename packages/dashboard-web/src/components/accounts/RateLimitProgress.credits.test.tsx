import { describe, expect, it } from "bun:test";
import type { AnthropicUsageData } from "@better-ccflare/types";
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
