import { describe, expect, it } from "bun:test";
import { formatHistoryTime, inboundLabel, inboundPath } from "../inbound";

describe("inboundLabel", () => {
	it("names the plain Chat Completions endpoint", () => {
		expect(inboundLabel("openai-chat")).toBe("OpenAI chat");
	});

	it("names the legacy Completions endpoint", () => {
		expect(inboundLabel("openai-completions")).toBe("OpenAI completions");
		expect(inboundLabel("openai-completions", "work")).toBe(
			"OpenAI completions · work",
		);
	});

	it("names the plain Responses endpoint", () => {
		expect(inboundLabel("openai-responses", null)).toBe("OpenAI responses");
	});

	it("adds the gateway name", () => {
		expect(inboundLabel("openai-chat", "work")).toBe("OpenAI chat · work");
		expect(inboundLabel("openai-responses", "gpt")).toBe(
			"OpenAI responses · gpt",
		);
	});

	it("is null for Claude Code traffic and unknown values", () => {
		expect(inboundLabel(undefined)).toBeNull();
		expect(inboundLabel(null, "work")).toBeNull();
		expect(inboundLabel("[redacted]", "work")).toBeNull();
	});
});

describe("inboundPath", () => {
	it("gives the path the client called", () => {
		expect(inboundPath("openai-chat")).toBe("/v1/chat/completions");
		expect(inboundPath("openai-responses")).toBe(
			"/v1/responses or /v1/responses/compact",
		);
		expect(inboundPath("openai-completions")).toBe("/v1/completions");
		expect(inboundPath("openai-completions", "work")).toBe(
			"/v1/gateways/work/completions",
		);
		expect(inboundPath("openai-chat", "work")).toBe(
			"/v1/gateways/work/chat/completions",
		);
		expect(inboundPath("openai-responses", "gpt")).toBe(
			"/v1/gateways/gpt/responses or /v1/gateways/gpt/responses/compact",
		);
	});

	it("is null without a known format", () => {
		expect(inboundPath(undefined, "work")).toBeNull();
	});
});

describe("formatHistoryTime", () => {
	it("uses the 24-hour clock, midnight as 00", () => {
		const midnight = new Date(2026, 9, 1, 0, 5, 9).getTime();
		const afternoon = new Date(2026, 9, 1, 16, 10, 37).getTime();
		expect(formatHistoryTime(midnight)).toBe("00:05:09");
		expect(formatHistoryTime(afternoon)).toBe("16:10:37");
		expect(formatHistoryTime(afternoon)).not.toMatch(/AM|PM/i);
	});
});
