import { describe, expect, it } from "bun:test";
import { inboundLabel, inboundPath } from "../inbound";

describe("inboundLabel", () => {
	it("names the plain Chat Completions endpoint", () => {
		expect(inboundLabel("openai-chat")).toBe("OpenAI chat");
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
		expect(inboundPath("openai-responses")).toBe("/v1/responses");
		expect(inboundPath("openai-chat", "work")).toBe(
			"/v1/gateways/work/chat/completions",
		);
		expect(inboundPath("openai-responses", "gpt")).toBe(
			"/v1/gateways/gpt/responses",
		);
	});

	it("is null without a known format", () => {
		expect(inboundPath(undefined, "work")).toBeNull();
	});
});
