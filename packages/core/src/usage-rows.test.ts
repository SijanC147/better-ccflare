import { describe, expect, it } from "bun:test";
import type { AnthropicUsageData, UsageLimit } from "@better-ccflare/types";
import {
	collectAnthropicLimitRows,
	collectAnthropicUsageRows,
	displayLabel,
} from "./usage-rows";

/**
 * The full behavioural suite for these helpers stays in
 * `packages/dashboard-web/src/components/accounts/rate-limit-helpers.test.ts`,
 * which exercises them through the dashboard's re-export. These cases pin the
 * rows the CLI's `tui overview` depends on, against core directly, so a core
 * change cannot pass on the strength of the dashboard suite alone.
 */
describe("usage rows in core", () => {
	const limits: UsageLimit[] = [
		{
			kind: "weekly_scoped",
			percent: 80,
			severity: "warning",
			resets_at: "2026-10-05T00:00:00Z",
			is_active: false,
			scope: { model: { display_name: "Fable", id: "claude-fable-5" } },
		},
		{
			kind: "weekly_all",
			percent: 17,
			severity: "normal",
			resets_at: "2026-10-05T00:00:00Z",
			is_active: false,
		},
		{
			kind: "session",
			percent: 42,
			severity: "normal",
			resets_at: "2026-10-01T10:00:00Z",
			is_active: true,
		},
	];

	it("builds 5-hour, Weekly and Fable (Weekly) rows, session first", () => {
		const rows = collectAnthropicLimitRows(limits);
		// Session moves first; weekly rows keep the order limits[] gave them.
		expect(rows.map(displayLabel)).toEqual([
			"5-hour",
			"Fable (Weekly)",
			"Weekly",
		]);
		expect(rows.map((r) => r.utilization)).toEqual([42, 80, 17]);
		expect(rows.map((r) => r.window)).toEqual([
			"five_hour",
			"seven_day_fable",
			"seven_day",
		]);
	});

	it("prefers limits[] and falls back to the legacy flat windows without it", () => {
		const fromLimits = collectAnthropicUsageRows(
			{ limits } as unknown as AnthropicUsageData,
			{ utilization: null, resetTime: null },
		);
		expect(fromLimits.map(displayLabel)).toContain("Fable (Weekly)");

		const legacy = collectAnthropicUsageRows(
			{
				five_hour: { utilization: 12, resets_at: "2026-10-01T10:00:00Z" },
				seven_day: { utilization: 34, resets_at: "2026-10-05T00:00:00Z" },
			} as unknown as AnthropicUsageData,
			{ utilization: null, resetTime: null },
		);
		expect(legacy.map((r) => [displayLabel(r), r.utilization])).toEqual([
			["5-hour", 12],
			["Weekly", 34],
		]);
	});
});
