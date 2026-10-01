import { describe, expect, it } from "bun:test";
import { formatTimestamp } from "../formatters";

describe("formatTimestamp", () => {
	// Built from local components so the hour reads 15 in any timezone.
	const afternoon = new Date(2026, 0, 1, 15, 4, 5).getTime();

	it("prints the 24-hour clock whatever the locale (SB23-3521)", () => {
		const text = formatTimestamp(afternoon);

		// Left to an en-US locale this was "1/1/2026, 3:04:05 PM".
		expect(text).toContain("15:04:05");
		expect(text).not.toMatch(/\b(AM|PM)\b/i);
	});

	it("formats an ISO string the same as its epoch", () => {
		expect(formatTimestamp(new Date(afternoon).toISOString())).toBe(
			formatTimestamp(afternoon),
		);
	});
});
