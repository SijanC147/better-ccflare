import { describe, expect, test } from "bun:test";
import {
	mapStopReason,
	toOpenAIError,
	translateAnthropicMessageToChat,
} from "../response-translator";
import type { AnthropicMessageResponse } from "../types";

const ctx = { id: "chatcmpl-test", created: 1_700_000_000, model: "gpt-4o" };

function message(
	overrides: Partial<AnthropicMessageResponse>,
): AnthropicMessageResponse {
	return {
		id: "msg_upstream",
		type: "message",
		role: "assistant",
		model: "claude-upstream-model",
		content: [],
		stop_reason: "end_turn",
		usage: { input_tokens: 10, output_tokens: 5 },
		...overrides,
	};
}

describe("mapStopReason", () => {
	test.each([
		["end_turn", "stop"],
		["stop_sequence", "stop"],
		["max_tokens", "length"],
		["model_context_window_exceeded", "length"],
		["tool_use", "tool_calls"],
		["refusal", "content_filter"],
		["pause_turn", "stop"],
		["something_new", "stop"],
	])("%s maps to %s", (input, expected) => {
		expect(mapStopReason(input)).toBe(expected as never);
	});

	test("null and undefined map to null", () => {
		expect(mapStopReason(null)).toBeNull();
		expect(mapStopReason(undefined)).toBeNull();
	});
});

describe("translateAnthropicMessageToChat", () => {
	test("text only, with id, created and model from the context", () => {
		const out = translateAnthropicMessageToChat(
			message({
				content: [
					{ type: "text", text: "Hello, " },
					{ type: "text", text: "world" },
				],
			}),
			ctx,
		);
		expect(out.id).toBe("chatcmpl-test");
		expect(out.object).toBe("chat.completion");
		expect(out.created).toBe(1_700_000_000);
		expect(out.model).toBe("gpt-4o");
		expect(out.choices).toHaveLength(1);
		const choice = out.choices[0];
		expect(choice.index).toBe(0);
		expect(choice.finish_reason).toBe("stop");
		expect(choice.logprobs).toBeNull();
		expect(choice.message).toEqual({
			role: "assistant",
			content: "Hello, world",
			refusal: null,
		});
		expect("tool_calls" in choice.message).toBe(false);
		expect("reasoning_content" in choice.message).toBe(false);
	});

	test("tool calls with no text give null content", () => {
		const out = translateAnthropicMessageToChat(
			message({
				stop_reason: "tool_use",
				content: [
					{
						type: "tool_use",
						id: "toolu_1",
						name: "get_weather",
						input: { city: "Valletta", units: "c" },
					},
					{ type: "tool_use", id: "toolu_2", name: "now", input: undefined },
				],
			}),
			ctx,
		);
		const msg = out.choices[0].message;
		expect(msg.content).toBeNull();
		expect(out.choices[0].finish_reason).toBe("tool_calls");
		expect(msg.tool_calls).toEqual([
			{
				id: "toolu_1",
				type: "function",
				function: {
					name: "get_weather",
					arguments: JSON.stringify({ city: "Valletta", units: "c" }),
				},
			},
			{
				id: "toolu_2",
				type: "function",
				function: { name: "now", arguments: "{}" },
			},
		]);
		expect(JSON.parse(msg.tool_calls?.[0]?.function.arguments ?? "")).toEqual({
			city: "Valletta",
			units: "c",
		});
	});

	test("text and tool calls together keep the text", () => {
		const out = translateAnthropicMessageToChat(
			message({
				content: [
					{ type: "text", text: "Checking." },
					{ type: "tool_use", id: "t", name: "f", input: {} },
				],
			}),
			ctx,
		);
		expect(out.choices[0].message.content).toBe("Checking.");
		expect(out.choices[0].message.tool_calls).toHaveLength(1);
	});

	test("an empty answer gives empty-string content", () => {
		const out = translateAnthropicMessageToChat(message({ content: [] }), ctx);
		expect(out.choices[0].message.content).toBe("");
	});

	test("thinking becomes reasoning_content; redacted and unknown blocks are dropped", () => {
		const out = translateAnthropicMessageToChat(
			message({
				content: [
					{ type: "thinking", thinking: "First, ", signature: "sig" },
					{ type: "redacted_thinking", data: "opaque" },
					{ type: "thinking", thinking: "then." },
					{ type: "server_tool_use", whatever: true },
					{ type: "text", text: "Answer" },
				],
			}),
			ctx,
		);
		const msg = out.choices[0].message;
		expect(msg.reasoning_content).toBe("First, then.");
		expect(msg.content).toBe("Answer");
		expect(JSON.stringify(msg)).not.toContain("opaque");
	});

	test("usage adds both cache counts into prompt_tokens", () => {
		const out = translateAnthropicMessageToChat(
			message({
				usage: {
					input_tokens: 100,
					output_tokens: 40,
					cache_read_input_tokens: 1000,
					cache_creation_input_tokens: 200,
				},
			}),
			ctx,
		);
		expect(out.usage).toEqual({
			prompt_tokens: 1300,
			completion_tokens: 40,
			total_tokens: 1340,
			prompt_tokens_details: { cached_tokens: 1000 },
		});
	});

	test("usage with null cache counts treats them as zero", () => {
		const out = translateAnthropicMessageToChat(
			message({
				usage: {
					input_tokens: 7,
					output_tokens: 3,
					cache_read_input_tokens: null,
					cache_creation_input_tokens: null,
				},
			}),
			ctx,
		);
		expect(out.usage).toEqual({
			prompt_tokens: 7,
			completion_tokens: 3,
			total_tokens: 10,
			prompt_tokens_details: { cached_tokens: 0 },
		});
	});

	test.each([
		["end_turn", "stop"],
		["stop_sequence", "stop"],
		["max_tokens", "length"],
		["model_context_window_exceeded", "length"],
		["tool_use", "tool_calls"],
		["refusal", "content_filter"],
		["pause_turn", "stop"],
		["unheard_of", "stop"],
		// A completed message always carries a finish_reason.
		[null, "stop"],
	])("stop_reason %p gives finish_reason %p", (stop, finish) => {
		const out = translateAnthropicMessageToChat(
			message({ stop_reason: stop, content: [{ type: "text", text: "x" }] }),
			ctx,
		);
		expect(out.choices[0].finish_reason).toBe(finish as never);
	});
});

describe("toOpenAIError", () => {
	test("Anthropic error envelope", () => {
		expect(
			toOpenAIError(429, {
				type: "error",
				error: { type: "rate_limit_error", message: "Slow down" },
			}),
		).toEqual({
			error: {
				message: "Slow down",
				type: "rate_limit_error",
				param: null,
				code: "rate_limit_error",
			},
		});
	});

	test("OpenAI error passes through", () => {
		expect(
			toOpenAIError(400, {
				error: {
					message: "Bad param",
					type: "invalid_request_error",
					code: "bad_value",
					param: "temperature",
				},
			}),
		).toEqual({
			error: {
				message: "Bad param",
				type: "invalid_request_error",
				param: "temperature",
				code: "bad_value",
			},
		});
	});

	test("OpenAI error with missing fields is filled", () => {
		expect(toOpenAIError(404, { error: { message: "Nope" } })).toEqual({
			error: {
				message: "Nope",
				type: "not_found_error",
				param: null,
				code: null,
			},
		});
	});

	test("an HTML string is collapsed and capped at 500 characters", () => {
		const html = `<html>\n  <body>\n\t<h1>Bad   Gateway</h1>\n${"x".repeat(1000)}</body></html>`;
		const out = toOpenAIError(502, html);
		expect(
			out.error.message.startsWith("<html> <body> <h1>Bad Gateway</h1>"),
		).toBe(true);
		expect(out.error.message).toHaveLength(500);
		expect(out.error.message).not.toMatch(/\s{2,}|\n|\t/);
		expect(out.error.type).toBe("api_error");
		expect(out.error.code).toBeNull();
		expect(out.error.param).toBeNull();
	});

	test("an empty or whitespace string falls back to the status message", () => {
		expect(toOpenAIError(503, "  \n ").error.message).toBe(
			"Upstream returned HTTP 503",
		);
	});

	test.each([
		[400, "invalid_request_error"],
		[401, "authentication_error"],
		[403, "permission_error"],
		[404, "not_found_error"],
		[413, "invalid_request_error"],
		[429, "rate_limit_error"],
		[500, "api_error"],
		[503, "api_error"],
		[529, "api_error"],
	])("status %d defaults type to %s", (status, type) => {
		const out = toOpenAIError(status, undefined);
		expect(out.error.type).toBe(type);
		expect(out.error.message).toBe(`Upstream returned HTTP ${status}`);
		expect(out.error.code).toBeNull();
		expect(out.error.param).toBeNull();
	});

	test.each([
		[null],
		[42],
		[[1, 2]],
		[{}],
		[{ error: { message: "" } }],
		[{ error: "a string, not an object" }],
	])("never returns an empty message for %p", (body) => {
		const out = toOpenAIError(500, body);
		expect(out.error.message).toBe("Upstream returned HTTP 500");
		expect(out.error.type).toBe("api_error");
	});
});
