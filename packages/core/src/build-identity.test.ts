import { describe, expect, it } from "bun:test";
import {
	formatBuildIdentity,
	normalizeBuildCommit,
	normalizeBuildVersion,
} from "./build-identity";

describe("build identity", () => {
	it("formats the exact Hextap native verification line", () => {
		expect(
			formatBuildIdentity(
				"3.8.2-rc.1",
				"0123456789abcdef0123456789abcdef01234567",
			),
		).toBe(
			"better-ccflare 3.8.2-rc.1 (commit 0123456789abcdef0123456789abcdef01234567)",
		);
	});

	it.each([
		"3.8.2",
		"3.8.2-rc.1",
	])("accepts normalized release version %s", (version) => {
		expect(normalizeBuildVersion(version)).toBe(version);
	});

	it.each([
		"v3.8.2",
		"03.8.2",
		"3.8.2+build",
		"3.8",
	])("rejects noncanonical release version %s", (version) => {
		expect(() => normalizeBuildVersion(version)).toThrow();
	});

	it("requires a full lowercase source commit", () => {
		const commit = "0123456789abcdef0123456789abcdef01234567";
		expect(normalizeBuildCommit(commit)).toBe(commit);
		expect(() => normalizeBuildCommit("abc1234")).toThrow();
		expect(() => normalizeBuildCommit(commit.toUpperCase())).toThrow();
	});
});
