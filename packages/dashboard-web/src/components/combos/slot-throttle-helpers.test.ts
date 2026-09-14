import { describe, expect, test } from "bun:test";
import type { ComboSlot } from "@better-ccflare/types";
import {
	buildSlotUpdate,
	describeSlotThrottle,
	draftFromSlot,
	formatHoursForSummary,
	isDirty,
	MAX_RESET_HOURS,
	msToHoursInput,
	parseHoursField,
	parseIntegerField,
	parsePercentField,
	validateDraft,
} from "./slot-throttle-helpers";

function slot(overrides: Partial<ComboSlot> = {}): ComboSlot {
	return {
		id: "slot-1",
		combo_id: "combo-1",
		account_id: "account-1",
		model: "claude-opus-5",
		priority: 0,
		enabled: true,
		max_utilization_percent: null,
		min_reset_remaining_ms: null,
		...overrides,
	};
}

describe("parseIntegerField", () => {
	test("a blank field clears the threshold", () => {
		expect(parseIntegerField("")).toBe(null);
		expect(parseIntegerField("   ")).toBe(null);
	});

	// The defect this guards: Number("") and Number("   ") are both 0, so a
	// coercion that runs before the blank check turns "clear this" into
	// "skip whenever utilization is at or above 0", which disables the slot.
	test("a blank field is not zero", () => {
		expect(parseIntegerField("")).not.toBe(0);
		expect(parseIntegerField("   ")).not.toBe(0);
	});

	test("typing zero yields zero, not null", () => {
		expect(parseIntegerField("0")).toBe(0);
	});

	test("a fractional value is invalid", () => {
		expect(parseIntegerField("50.5")).toBe("invalid");
	});

	test("a non-numeric value is invalid", () => {
		expect(parseIntegerField("abc")).toBe("invalid");
	});
});

describe("parsePercentField", () => {
	test("accepts the ends of the range", () => {
		expect(parsePercentField("0")).toBe(0);
		expect(parsePercentField("100")).toBe(100);
	});

	test("rejects outside 0-100", () => {
		expect(parsePercentField("101")).toBe("invalid");
		expect(parsePercentField("-1")).toBe("invalid");
	});

	test("a blank field still clears", () => {
		expect(parsePercentField("")).toBe(null);
	});
});

describe("parseHoursField", () => {
	test("a blank field clears", () => {
		expect(parseHoursField("")).toBe(null);
		expect(parseHoursField("")).not.toBe(0);
	});

	test("typing zero yields zero milliseconds", () => {
		expect(parseHoursField("0")).toBe(0);
	});

	test("converts hours to milliseconds", () => {
		expect(parseHoursField("1")).toBe(3_600_000);
		expect(parseHoursField("2.5")).toBe(9_000_000);
	});

	// The handler rejects a non-integer millisecond value, so a fractional hour
	// that does not divide evenly has to be rounded here or the PUT 400s.
	test("rounds a fractional hour to an integer millisecond value", () => {
		const result = parseHoursField("0.0000001");
		expect(Number.isInteger(result as number)).toBe(true);
		expect(result).toBe(0);
	});

	test("rejects a negative value", () => {
		expect(parseHoursField("-1")).toBe("invalid");
	});

	// Without a ceiling, 1e20 hours is 3.6e26, Number.isInteger(3.6e26) is true,
	// and the handler only checks Number.isInteger and >= 0, so the value would
	// pass validation and reach the database far above int64.
	test("rejects a value beyond the safe integer range", () => {
		expect(parseHoursField("1e20")).toBe("invalid");
		expect(parseHoursField(String(MAX_RESET_HOURS + 1))).toBe("invalid");
	});

	test("accepts the largest value it advertises", () => {
		const result = parseHoursField(String(MAX_RESET_HOURS));
		expect(result).not.toBe("invalid");
		expect(Number.isSafeInteger(result as number)).toBe(true);
	});
});

// Whatever msToHoursInput renders into the field, parseHoursField must read
// back as the same stored value, or reopening the popover and saving would
// write a different number than the one already stored.
describe("the hours field round trip", () => {
	const values = [
		0, 1, 999, 1000, 3_599_999, 3_600_000, 3_600_001, 7_200_000, 18_000_000,
		86_400_000, 604_800_000, 123_456_789, 2_147_483_647,
	];
	for (const ms of values) {
		test(`${ms}ms renders and parses back unchanged`, () => {
			expect(parseHoursField(msToHoursInput(ms))).toBe(ms);
		});
	}
});

describe("msToHoursInput", () => {
	test("null renders as a blank field", () => {
		expect(msToHoursInput(null)).toBe("");
	});

	test("renders exactly rather than rounding", () => {
		expect(msToHoursInput(3_600_000)).toBe("1");
		// A value set through the API that is not a whole number of hours must
		// not render as 0.00, or a save without an edit would write it back as 0
		// and skip the slot whenever its window is at least 0ms from resetting.
		expect(msToHoursInput(1000)).not.toBe("0");
		expect(parseHoursField(msToHoursInput(1000))).toBe(1000);
	});
});

describe("buildSlotUpdate", () => {
	test("an untouched draft sends nothing", () => {
		const s = slot({
			max_utilization_percent: 80,
			min_reset_remaining_ms: 1000,
		});
		const update = buildSlotUpdate(s, draftFromSlot(s));
		expect(update).toEqual({});
		expect(isDirty(update)).toBe(false);
	});

	test("clearing a threshold sends null", () => {
		const s = slot({ max_utilization_percent: 80 });
		const update = buildSlotUpdate(s, {
			...draftFromSlot(s),
			maxUtilizationPercent: "",
		});
		expect(update).toEqual({ max_utilization_percent: null });
	});

	// The acceptance criterion: clearing a field and typing 0 must produce
	// different payloads.
	test("clearing is distinguishable from setting zero", () => {
		const s = slot({ max_utilization_percent: 80 });
		const cleared = buildSlotUpdate(s, {
			...draftFromSlot(s),
			maxUtilizationPercent: "",
		});
		const zeroed = buildSlotUpdate(s, {
			...draftFromSlot(s),
			maxUtilizationPercent: "0",
		});
		expect(cleared).toEqual({ max_utilization_percent: null });
		expect(zeroed).toEqual({ max_utilization_percent: 0 });
		expect(cleared).not.toEqual(zeroed);
	});

	test("the same holds for the reset threshold", () => {
		const s = slot({ min_reset_remaining_ms: 3_600_000 });
		const cleared = buildSlotUpdate(s, {
			...draftFromSlot(s),
			minResetRemainingHours: "",
		});
		const zeroed = buildSlotUpdate(s, {
			...draftFromSlot(s),
			minResetRemainingHours: "0",
		});
		expect(cleared).toEqual({ min_reset_remaining_ms: null });
		expect(zeroed).toEqual({ min_reset_remaining_ms: 0 });
	});

	// #107 shipped a version requiring both columns before the rule fired at
	// all; #112 corrected it. A UI that only ever sends the pair re-encodes it.
	test("either threshold can be set alone", () => {
		const s = slot();
		const percentOnly = buildSlotUpdate(s, {
			...draftFromSlot(s),
			maxUtilizationPercent: "80",
		});
		expect(percentOnly).toEqual({ max_utilization_percent: 80 });
		expect(percentOnly).not.toHaveProperty("min_reset_remaining_ms");

		const resetOnly = buildSlotUpdate(s, {
			...draftFromSlot(s),
			minResetRemainingHours: "2",
		});
		expect(resetOnly).toEqual({ min_reset_remaining_ms: 7_200_000 });
		expect(resetOnly).not.toHaveProperty("max_utilization_percent");
	});

	test("either threshold can be cleared alone", () => {
		const s = slot({
			max_utilization_percent: 80,
			min_reset_remaining_ms: 7_200_000,
		});
		const update = buildSlotUpdate(s, {
			...draftFromSlot(s),
			maxUtilizationPercent: "",
		});
		expect(update).toEqual({ max_utilization_percent: null });
		expect(update).not.toHaveProperty("min_reset_remaining_ms");
	});

	test("both can move in one save", () => {
		const s = slot();
		const update = buildSlotUpdate(s, {
			enabled: true,
			maxUtilizationPercent: "90",
			minResetRemainingHours: "1",
		});
		expect(update).toEqual({
			max_utilization_percent: 90,
			min_reset_remaining_ms: 3_600_000,
		});
	});

	test("enabled travels on its own", () => {
		const s = slot({ enabled: true });
		const update = buildSlotUpdate(s, { ...draftFromSlot(s), enabled: false });
		expect(update).toEqual({ enabled: false });
	});

	test("an invalid field produces no payload at all", () => {
		const s = slot();
		const update = buildSlotUpdate(s, {
			enabled: false,
			maxUtilizationPercent: "abc",
			minResetRemainingHours: "1",
		});
		expect(update).toBe(null);
		expect(isDirty(update)).toBe(false);
	});
});

describe("validateDraft", () => {
	test("flags an invalid percent", () => {
		const result = validateDraft({
			enabled: true,
			maxUtilizationPercent: "200",
			minResetRemainingHours: "",
		});
		expect(result.hasInvalidField).toBe(true);
		expect(result.percent).toBe("invalid");
		expect(result.resetMs).toBe(null);
	});

	test("a pair of blanks is valid and means no rule", () => {
		const result = validateDraft({
			enabled: true,
			maxUtilizationPercent: "",
			minResetRemainingHours: "",
		});
		expect(result.hasInvalidField).toBe(false);
		expect(result.percent).toBe(null);
		expect(result.resetMs).toBe(null);
	});
});

describe("describeSlotThrottle", () => {
	test("no configured threshold means no rule to describe", () => {
		expect(describeSlotThrottle(slot())).toBe(null);
	});

	test("describes each threshold alone", () => {
		expect(describeSlotThrottle(slot({ max_utilization_percent: 80 }))).toBe(
			"skip when usage >= 80%",
		);
		expect(
			describeSlotThrottle(slot({ min_reset_remaining_ms: 7_200_000 })),
		).toBe("skip when reset >= 2h away");
	});

	test("joins both with and", () => {
		expect(
			describeSlotThrottle(
				slot({
					max_utilization_percent: 80,
					min_reset_remaining_ms: 3_600_000,
				}),
			),
		).toBe("skip when usage >= 80% and reset >= 1h away");
	});

	// The comparison is resetMs - now >= min: a slot is skipped because its
	// quota will NOT refresh soon. The wording must not invert that.
	test("the reset clause reads as far away, not soon", () => {
		const described = describeSlotThrottle(
			slot({ min_reset_remaining_ms: 3_600_000 }),
		) as string;
		expect(described).toContain("away");
		expect(described).not.toContain("within");
	});

	test("a zero percent threshold is described rather than treated as unset", () => {
		expect(describeSlotThrottle(slot({ max_utilization_percent: 0 }))).toBe(
			"skip when usage >= 0%",
		);
	});

	// The summary is one line on a collapsed row. msToHoursInput is exact so the
	// input field round-trips, which puts 0.016666666666666666 and
	// 2.7777777777777776e-7 on screen; the summary must not show those.
	test("rounds an awkward duration rather than showing its exact form", () => {
		expect(describeSlotThrottle(slot({ min_reset_remaining_ms: 60_000 }))).toBe(
			"skip when reset >= <0.1h away",
		);
		expect(describeSlotThrottle(slot({ min_reset_remaining_ms: 1 }))).toBe(
			"skip when reset >= <0.1h away",
		);
		expect(
			describeSlotThrottle(slot({ min_reset_remaining_ms: 5_400_000 })),
		).toBe("skip when reset >= 1.5h away");
	});

	test("a zero reset threshold reads as 0, not as less than 0.1", () => {
		expect(describeSlotThrottle(slot({ min_reset_remaining_ms: 0 }))).toBe(
			"skip when reset >= 0h away",
		);
	});
});

describe("formatHoursForSummary", () => {
	test("a whole number of hours has no decimal", () => {
		expect(formatHoursForSummary(3_600_000)).toBe("1");
		expect(formatHoursForSummary(18_000_000)).toBe("5");
	});

	test("zero is exact, not a floor marker", () => {
		expect(formatHoursForSummary(0)).toBe("0");
	});

	test("anything under a tenth of an hour collapses to a floor marker", () => {
		expect(formatHoursForSummary(1)).toBe("<0.1");
		expect(formatHoursForSummary(60_000)).toBe("<0.1");
	});

	test("never renders exponent notation", () => {
		expect(formatHoursForSummary(1)).not.toContain("e");
	});
});
