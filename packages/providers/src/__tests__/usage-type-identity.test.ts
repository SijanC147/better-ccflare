/**
 * SB23-2453. Every per-provider usage payload is declared once, in
 * `@better-ccflare/types`, and the fetcher modules here re-export it. Before
 * that, eleven names were declared in both packages, and two structurally
 * identical declarations compile cleanly while they drift apart: one had
 * already drifted, `NanoGPTUsageData.period` existing only on this side.
 *
 * These assertions are compile-time. At runtime `expectTypeOf` does nothing, so
 * the `it` blocks pass whatever the types say; the gate is
 * `bun run typecheck:providers`, which fails here if a fetcher declares its own
 * copy again and that copy differs from the types declaration in any field.
 */
import { describe, expectTypeOf, it } from "bun:test";
import type * as Types from "@better-ccflare/types";
import type * as Alibaba from "../alibaba-coding-plan-usage-fetcher";
import type * as Kilo from "../kilo-usage-fetcher";
import type * as Minimax from "../minimax-usage-fetcher";
import type * as NanoGPT from "../nanogpt-usage-fetcher";
import type * as Usage from "../usage-fetcher";
import type * as Xai from "../xai-usage-fetcher";
import type * as Zai from "../zai-usage-fetcher";

describe("usage payload types are the @better-ccflare/types declarations", () => {
	it("re-exports each payload unchanged", () => {
		expectTypeOf<Zai.ZaiUsageData>().toEqualTypeOf<Types.ZaiUsageData>();
		expectTypeOf<Zai.ZaiUsageWindow>().toEqualTypeOf<Types.ZaiUsageWindow>();
		expectTypeOf<NanoGPT.NanoGPTUsageData>().toEqualTypeOf<Types.NanoGPTUsageData>();
		expectTypeOf<NanoGPT.NanoGPTUsageWindow>().toEqualTypeOf<Types.NanoGPTUsageWindow>();
		expectTypeOf<Kilo.KiloUsageData>().toEqualTypeOf<Types.KiloUsageData>();
		expectTypeOf<Alibaba.AlibabaCodingPlanUsageData>().toEqualTypeOf<Types.AlibabaCodingPlanUsageData>();
		expectTypeOf<Alibaba.AlibabaCodingPlanQuotaWindow>().toEqualTypeOf<Types.AlibabaCodingPlanQuotaWindow>();
		expectTypeOf<Minimax.MinimaxUsageData>().toEqualTypeOf<Types.MinimaxUsageData>();
		expectTypeOf<Minimax.MinimaxUsageWindow>().toEqualTypeOf<Types.MinimaxUsageWindow>();
		expectTypeOf<Xai.XaiUsageData>().toEqualTypeOf<Types.XaiUsageData>();
		expectTypeOf<Xai.XaiUsageWindow>().toEqualTypeOf<Types.XaiUsageWindow>();
		expectTypeOf<Usage.UsageLimit>().toEqualTypeOf<Types.UsageLimit>();
	});

	it("derives UsageSpend, differing only in an unvalidated limit", () => {
		// Deliberately not an equality with the types copy: that one narrows
		// `limit` for the dashboard, which validates it, and nothing on this side
		// does (SB23-3266). Every other field must still match.
		expectTypeOf<Usage.UsageSpend>().toEqualTypeOf<
			Omit<Types.UsageSpend, "limit"> & { limit?: unknown }
		>();
		expectTypeOf<Usage.UsageSpend["limit"]>().toEqualTypeOf<unknown>();
	});
});
