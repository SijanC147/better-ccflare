import { describe, expect, test } from "bun:test";
import type { PoolUsageResult } from "../../lib/pool-usage";
import { kioskHeadlinePct, kioskUsageTone } from "../KioskTab";

/*
 * PR #85 shipped these two exported helpers without direct tests, disclosed as
 * cut for its ceiling rather than implied as covered.
 *
 * They decide what colour a display left on a wall shows. A wrong boundary is a
 * kiosk that reads "fine" at 90% capacity — the one number the view exists to
 * make obvious from across a room.
 */

describe("kioskUsageTone", () => {
	test("null is idle, not ok", () => {
		// null means no account contributes to this window. That is a real state,
		// nothing is limited, and colouring it green would claim headroom that was
		// never measured.
		expect(kioskUsageTone(null)).toBe("idle");
	});

	test("the 70 and 90 boundaries are inclusive", () => {
		// Inclusive matters: at exactly 90 the display must already be red. An
		// off-by-one here is invisible in review and wrong only at the moment it
		// matters most.
		expect(kioskUsageTone(69.9)).toBe("ok");
		expect(kioskUsageTone(70)).toBe("warn");
		expect(kioskUsageTone(89.9)).toBe("warn");
		expect(kioskUsageTone(90)).toBe("hot");
	});

	test("covers both ends of the range", () => {
		expect(kioskUsageTone(0)).toBe("ok");
		expect(kioskUsageTone(100)).toBe("hot");
	});
});

describe("kioskHeadlinePct", () => {
	test("leads with the pool-wide average, matching the dashboard section", () => {
		const result = { average: 42 } as PoolUsageResult;
		expect(kioskHeadlinePct(result)).toBe(42);
	});

	test("passes null through rather than coercing it to zero", () => {
		// Zero would render as a green 0%, which reads as "no usage" instead of
		// "no measurement". kioskUsageTone relies on null reaching it intact.
		const result = { average: null } as unknown as PoolUsageResult;
		expect(kioskHeadlinePct(result)).toBeNull();
	});
});
