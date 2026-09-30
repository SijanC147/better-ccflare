import { describe, expect, test } from "bun:test";
import { CLAUDE_CODE_BIN_ENV } from "@better-ccflare/types";
import { resolveClaudeCodeBin } from "../handler";

const none = () => null;
const nothingExists = () => false;

describe("resolveClaudeCodeBin", () => {
	test("the explicit override wins over PATH and known locations", () => {
		expect(
			resolveClaudeCodeBin(
				{ [CLAUDE_CODE_BIN_ENV]: "/custom/claude" },
				() => "/on/path/claude",
				() => true,
				"/home/u",
			),
		).toBe("/custom/claude");
	});

	test("PATH wins over known locations", () => {
		expect(
			resolveClaudeCodeBin(
				{},
				() => "/on/path/claude",
				() => true,
				"/home/u",
			),
		).toBe("/on/path/claude");
	});

	test("under launchd's PATH, the installer location is found", () => {
		const exists = (p: string) => p === "/home/u/.local/bin/claude";
		expect(resolveClaudeCodeBin({}, none, exists, "/home/u")).toBe(
			"/home/u/.local/bin/claude",
		);
	});

	test("~/bin is the last known location before the bare name", () => {
		const exists = (p: string) => p === "/home/u/bin/claude";
		expect(resolveClaudeCodeBin({}, none, exists, "/home/u")).toBe(
			"/home/u/bin/claude",
		);
		expect(resolveClaudeCodeBin({}, none, nothingExists, "/home/u")).toBe(
			"claude",
		);
	});
});
