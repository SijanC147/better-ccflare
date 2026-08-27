import { describe, expect, it } from "bun:test";
import { dashboardBuildIdentity, displayVersion } from "./version";

describe("dashboard build identity", () => {
	it("keeps the visible v prefix while carrying the exact commit", () => {
		expect(
			dashboardBuildIdentity(
				"3.8.2-rc.1",
				"0123456789abcdef0123456789abcdef01234567",
			),
		).toEqual({
			version: "v3.8.2-rc.1",
			commit: "0123456789abcdef0123456789abcdef01234567",
		});
	});

	it("normalizes an optional source v prefix for display", () => {
		expect(displayVersion("3.8.2")).toBe("v3.8.2");
		expect(displayVersion("v3.8.2")).toBe("v3.8.2");
	});
});
