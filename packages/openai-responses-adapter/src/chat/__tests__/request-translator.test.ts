import { describe, expect, test } from "bun:test";
import { translateChatRequestToAnthropic } from "../request-translator";
import {
	type AnthropicMessagesRequest,
	type ChatCompletionRequest,
	type ChatRequestError,
	DEFAULT_MAX_TOKENS,
} from "../types";

const MODEL = "claude-sonnet-5";
const HI = { role: "user", content: "hi" } as const;

/**
 * The translator reads untrusted JSON, so refusal fixtures deliberately break
 * the request type. One cast, here, rather than one per test.
 */
function malformed(body: unknown): ChatCompletionRequest {
	return body as ChatCompletionRequest;
}

function translated(req: ChatCompletionRequest): AnthropicMessagesRequest {
	const result = translateChatRequestToAnthropic(req);
	if (!result.ok) {
		throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
	}
	return result.body;
}

function refused(req: ChatCompletionRequest): ChatRequestError {
	const result = translateChatRequestToAnthropic(req);
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error("expected a refusal");
	expect(result.error.status).toBe(400);
	expect(result.error.type).toBe("invalid_request_error");
	return result.error;
}

describe("1. system and developer messages", () => {
	test("every system and developer message, at any position, joins into one system string", () => {
		const body = translated({
			model: MODEL,
			messages: [
				{ role: "system", content: "Be brief." },
				HI,
				{
					role: "developer",
					content: [
						{ type: "text", text: "Use British spelling." },
						{ type: "text", text: "" },
						{ type: "text", text: "No emoji." },
					],
				},
				{ role: "assistant", content: "hello" },
			],
		});
		expect(body).toEqual({
			model: MODEL,
			max_tokens: DEFAULT_MAX_TOKENS,
			system: "Be brief.\n\nUse British spelling.\n\nNo emoji.",
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: [{ type: "text", text: "hello" }] },
			],
		});
	});

	test("a non-text part in a system message is refused", () => {
		const error = refused(
			malformed({
				model: MODEL,
				messages: [
					{
						role: "system",
						content: [
							{ type: "image_url", image_url: { url: "https://x/y.png" } },
						],
					},
					HI,
				],
			}),
		);
		expect(error.param).toBe("messages[0].content[0]");
		expect(error.code).toBe("unsupported_content_type");
	});
});

describe("2. user messages", () => {
	test("string content stays a string", () => {
		expect(translated({ model: MODEL, messages: [HI] }).messages).toEqual([
			{ role: "user", content: "hi" },
		]);
	});

	test("text, data-URL image and http image parts become blocks", () => {
		const body = translated({
			model: MODEL,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "what is this" },
						{
							type: "image_url",
							image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
						},
						{
							type: "image_url",
							image_url: { url: "https://example.com/a.jpg", detail: "high" },
						},
					],
				},
			],
		});
		expect(body.messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "what is this" },
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/png",
							data: "iVBORw0KGgo=",
						},
					},
					{
						type: "image",
						source: { type: "url", url: "https://example.com/a.jpg" },
					},
				],
			},
		]);
	});

	test("an unsupported part type is refused with its position", () => {
		const error = refused({
			model: MODEL,
			messages: [
				{ role: "system", content: "s" },
				{
					role: "user",
					content: [
						{ type: "text", text: "listen" },
						{
							type: "input_audio",
							input_audio: { data: "AAAA", format: "wav" },
						},
					],
				},
			],
		});
		expect(error.param).toBe("messages[1].content[1]");
		expect(error.code).toBe("unsupported_content_type");
	});

	test("a malformed data URL is refused", () => {
		const error = refused({
			model: MODEL,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "image_url",
							image_url: { url: "data:image/png,notbase64" },
						},
					],
				},
			],
		});
		expect(error.param).toBe("messages[0].content[0]");
		expect(error.code).toBe("invalid_image_url");
	});

	test("an image URL that is neither http(s) nor data is refused", () => {
		const error = refused({
			model: MODEL,
			messages: [
				{
					role: "user",
					content: [{ type: "image_url", image_url: { url: "ftp://x/y.png" } }],
				},
			],
		});
		expect(error.param).toBe("messages[0].content[0]");
	});
});

describe("3. assistant messages", () => {
	test("text plus tool_calls become text and tool_use blocks; empty strings dropped; empty arguments become {}", () => {
		const body = translated({
			model: MODEL,
			messages: [
				HI,
				{
					role: "assistant",
					content: [
						{ type: "text", text: "" },
						{ type: "text", text: "Checking." },
					],
					tool_calls: [
						{
							id: "call_a",
							type: "function",
							function: { name: "weather", arguments: '{"city":"Valletta"}' },
						},
						{
							id: "call_b",
							type: "function",
							function: { name: "time", arguments: "" },
						},
					],
				},
			],
		});
		expect(body.messages[1]).toEqual({
			role: "assistant",
			content: [
				{ type: "text", text: "Checking." },
				{
					type: "tool_use",
					id: "call_a",
					name: "weather",
					input: { city: "Valletta" },
				},
				{ type: "tool_use", id: "call_b", name: "time", input: {} },
			],
		});
	});

	test("invalid JSON arguments are refused at their position", () => {
		const error = refused({
			model: MODEL,
			messages: [
				HI,
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_a",
							type: "function",
							function: { name: "a", arguments: "{}" },
						},
						{
							id: "call_b",
							type: "function",
							function: { name: "b", arguments: "{not json" },
						},
					],
				},
			],
		});
		expect(error.param).toBe("messages[1].tool_calls[1].function.arguments");
	});

	test("arguments that parse to a non-object are refused, including 'null'", () => {
		for (const args of ["null", "[1]", "3"]) {
			const error = refused({
				model: MODEL,
				messages: [
					HI,
					{
						role: "assistant",
						tool_calls: [
							{
								id: "c",
								type: "function",
								function: { name: "f", arguments: args },
							},
						],
					},
				],
			});
			expect(error.param).toBe("messages[1].tool_calls[0].function.arguments");
		}
	});

	test("legacy function_call gets a synthesized id that the following function message answers", () => {
		const body = translated({
			model: MODEL,
			messages: [
				HI,
				{
					role: "assistant",
					content: null,
					function_call: { name: "lookup", arguments: '{"q":"x"}' },
				},
				{ role: "function", name: "lookup", content: "found" },
			],
		});
		expect(body.messages).toEqual([
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "call_legacy_1",
						name: "lookup",
						input: { q: "x" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call_legacy_1",
						content: "found",
					},
				],
			},
		]);
	});

	test("a function message with no matching function_call is refused", () => {
		const error = refused({
			model: MODEL,
			messages: [HI, { role: "function", name: "lookup", content: "found" }],
		});
		expect(error.param).toBe("messages[1]");
	});

	test("an assistant message with no blocks is omitted", () => {
		const body = translated({
			model: MODEL,
			messages: [
				{ role: "user", content: "a" },
				{ role: "assistant", content: "" },
				{ role: "assistant", content: null },
			],
		});
		expect(body.messages).toEqual([{ role: "user", content: "a" }]);
	});
});

describe("4. tool messages", () => {
	test("become a tool_result inside a user message, text parts joined into a string", () => {
		const body = translated({
			model: MODEL,
			messages: [
				HI,
				{
					role: "assistant",
					tool_calls: [
						{
							id: "call_a",
							type: "function",
							function: { name: "f", arguments: "{}" },
						},
					],
				},
				{
					role: "tool",
					tool_call_id: "call_a",
					content: [
						{ type: "text", text: "line one" },
						{ type: "text", text: "line two" },
					],
				},
			],
		});
		expect(body.messages[2]).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "call_a",
					content: "line one\n\nline two",
				},
			],
		});
	});

	test("a missing tool_call_id is refused", () => {
		const error = refused(
			malformed({
				model: MODEL,
				messages: [HI, { role: "tool", content: "x" }],
			}),
		);
		expect(error.param).toBe("messages[1].tool_call_id");
	});
});

describe("5. adjacent same-role messages merge", () => {
	// Fails if mergeAdjacentSameRole is removed: without it the output has
	// three separate user messages, and the tool_result blocks no longer lead
	// one user turn.
	test("a multi-turn tool conversation folds two tool results and the next user turn into one user message", () => {
		const body = translated({
			model: MODEL,
			messages: [
				{ role: "user", content: "weather and time in Valletta?" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_w",
							type: "function",
							function: { name: "weather", arguments: '{"city":"Valletta"}' },
						},
						{
							id: "call_t",
							type: "function",
							function: { name: "time", arguments: '{"city":"Valletta"}' },
						},
					],
				},
				{ role: "tool", tool_call_id: "call_w", content: "22C" },
				{ role: "tool", tool_call_id: "call_t", content: "21:00" },
				{ role: "user", content: "thanks, and tomorrow?" },
			],
		});
		expect(body.messages).toEqual([
			{ role: "user", content: "weather and time in Valletta?" },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "call_w",
						name: "weather",
						input: { city: "Valletta" },
					},
					{
						type: "tool_use",
						id: "call_t",
						name: "time",
						input: { city: "Valletta" },
					},
				],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "call_w", content: "22C" },
					{ type: "tool_result", tool_use_id: "call_t", content: "21:00" },
					{ type: "text", text: "thanks, and tomorrow?" },
				],
			},
		]);
	});

	test("two user strings separated by a hoisted system message merge into text blocks", () => {
		const body = translated({
			model: MODEL,
			messages: [
				{ role: "user", content: "one" },
				{ role: "system", content: "s" },
				{ role: "user", content: "two" },
			],
		});
		expect(body.messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "one" },
					{ type: "text", text: "two" },
				],
			},
		]);
	});

	test("nothing but system messages is refused", () => {
		const error = refused({
			model: MODEL,
			messages: [{ role: "system", content: "s" }],
		});
		expect(error.param).toBe("messages");
	});

	test("an empty messages array is refused", () => {
		expect(refused({ model: MODEL, messages: [] }).param).toBe("messages");
	});
});

describe("2b. empty user content", () => {
	test("an empty string is refused", () => {
		const error = refused({
			model: MODEL,
			messages: [
				HI,
				{ role: "assistant", content: "ok" },
				{ role: "user", content: "" },
			],
		});
		expect(error.param).toBe("messages[2].content");
		expect(error.code).toBe("empty_content");
	});

	test("an empty text part is refused", () => {
		const error = refused({
			model: MODEL,
			messages: [{ role: "user", content: [{ type: "text", text: "" }] }],
		});
		expect(error.param).toBe("messages[0].content");
		expect(error.code).toBe("empty_content");
	});

	// Review pass 2, mutation D2: dropping `&& turn.content.length === 0`
	// refused this request while all 138 tests stayed green. A blank user turn
	// that opens a merged group which the next turn gives content is valid.
	test("a blank first user turn merged with a following user turn is accepted", () => {
		const body = translated({
			model: MODEL,
			messages: [
				{ role: "user", content: "" },
				{ role: "user", content: "hi" },
			],
		});
		expect(body.messages).toHaveLength(1);
		expect(body.messages[0].role).toBe("user");
		expect(JSON.stringify(body.messages[0].content)).toContain("hi");
	});

	test("a whitespace-only string is refused", () => {
		const error = refused({
			model: MODEL,
			messages: [{ role: "user", content: " \n\t " }],
		});
		expect(error.param).toBe("messages[0].content");
		expect(error.code).toBe("empty_content");
	});

	test("an image plus an empty text part keeps the image and drops the text", () => {
		const body = translated({
			model: MODEL,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "image_url",
							image_url: { url: "https://example.com/a.jpg" },
						},
						{ type: "text", text: "  " },
					],
				},
			],
		});
		expect(body.messages).toEqual([
			{
				role: "user",
				content: [
					{
						type: "image",
						source: { type: "url", url: "https://example.com/a.jpg" },
					},
				],
			},
		]);
	});

	test("an empty user turn merging into tool results still produces a valid request", () => {
		const body = translated({
			model: MODEL,
			messages: [
				HI,
				{
					role: "assistant",
					tool_calls: [
						{
							id: "call_a",
							type: "function",
							function: { name: "f", arguments: "{}" },
						},
					],
				},
				{ role: "tool", tool_call_id: "call_a", content: "done" },
				{ role: "user", content: "" },
			],
		});
		expect(body.messages).toEqual([
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call_a", name: "f", input: {} }],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "call_a", content: "done" },
				],
			},
		]);
	});

	test("two adjacent empty user turns are refused at the first", () => {
		const error = refused({
			model: MODEL,
			messages: [
				HI,
				{ role: "assistant", content: "ok" },
				{ role: "user", content: "" },
				{ role: "user", content: [] },
			],
		});
		expect(error.param).toBe("messages[2].content");
	});
});

describe("6. max_tokens", () => {
	test("max_completion_tokens wins over max_tokens", () => {
		expect(
			translated({
				model: MODEL,
				messages: [HI],
				max_completion_tokens: 100,
				max_tokens: 50,
			}).max_tokens,
		).toBe(100);
	});

	test("max_tokens is used when max_completion_tokens is absent or null", () => {
		expect(
			translated({
				model: MODEL,
				messages: [HI],
				max_completion_tokens: null,
				max_tokens: 50,
			}).max_tokens,
		).toBe(50);
	});

	test("the default applies when neither is set", () => {
		expect(translated({ model: MODEL, messages: [HI] }).max_tokens).toBe(
			DEFAULT_MAX_TOKENS,
		);
	});

	test("non-positive or non-integer values are refused against the field that carried them", () => {
		expect(refused({ model: MODEL, messages: [HI], max_tokens: 0 }).param).toBe(
			"max_tokens",
		);
		expect(
			refused({ model: MODEL, messages: [HI], max_tokens: -5 }).param,
		).toBe("max_tokens");
		expect(
			refused({ model: MODEL, messages: [HI], max_completion_tokens: 1.5 })
				.param,
		).toBe("max_completion_tokens");
		expect(
			refused(malformed({ model: MODEL, messages: [HI], max_tokens: "10" }))
				.param,
		).toBe("max_tokens");
	});
});

describe("7. temperature and top_p", () => {
	test("temperature is clamped into [0, 1]", () => {
		expect(
			translated({ model: MODEL, messages: [HI], temperature: 1.7 })
				.temperature,
		).toBe(1);
		expect(
			translated({ model: MODEL, messages: [HI], temperature: -0.5 })
				.temperature,
		).toBe(0);
		expect(
			translated({ model: MODEL, messages: [HI], temperature: 0.3 })
				.temperature,
		).toBe(0.3);
	});

	test("when both are set only temperature is sent", () => {
		const body = translated({
			model: MODEL,
			messages: [HI],
			temperature: 0.2,
			top_p: 0.9,
		});
		expect(body).toEqual({
			model: MODEL,
			max_tokens: DEFAULT_MAX_TOKENS,
			messages: [{ role: "user", content: "hi" }],
			temperature: 0.2,
		});
	});

	test("top_p alone is passed through", () => {
		const body = translated({ model: MODEL, messages: [HI], top_p: 0.9 });
		expect(body.top_p).toBe(0.9);
		expect("temperature" in body).toBe(false);
	});
});

describe("8. stop", () => {
	test("a string becomes a one-element list", () => {
		expect(
			translated({ model: MODEL, messages: [HI], stop: "END" }).stop_sequences,
		).toEqual(["END"]);
	});

	test("an array is kept with empty strings dropped", () => {
		expect(
			translated({ model: MODEL, messages: [HI], stop: ["a", "", "b"] })
				.stop_sequences,
		).toEqual(["a", "b"]);
	});

	test("an empty result is omitted", () => {
		expect(
			"stop_sequences" in
				translated({ model: MODEL, messages: [HI], stop: ["", ""] }),
		).toBe(false);
		expect(
			"stop_sequences" in
				translated({ model: MODEL, messages: [HI], stop: "" }),
		).toBe(false);
	});
});

describe("9. n and logprobs", () => {
	test("n > 1 is refused", () => {
		const error = refused({ model: MODEL, messages: [HI], n: 2 });
		expect(error.param).toBe("n");
	});

	test("n = 1 is accepted", () => {
		expect(translated({ model: MODEL, messages: [HI], n: 1 }).model).toBe(
			MODEL,
		);
	});

	test("logprobs true is refused", () => {
		expect(
			refused({ model: MODEL, messages: [HI], logprobs: true }).param,
		).toBe("logprobs");
	});

	test("top_logprobs is refused", () => {
		expect(
			refused({ model: MODEL, messages: [HI], top_logprobs: 3 }).param,
		).toBe("top_logprobs");
	});

	test("logprobs false is accepted", () => {
		expect(
			translated({ model: MODEL, messages: [HI], logprobs: false }).model,
		).toBe(MODEL);
	});
});

describe("10. tools", () => {
	test("function tools map to name, description and input_schema; strict is dropped; missing parameters default", () => {
		const body = translated({
			model: MODEL,
			messages: [HI],
			tools: [
				{
					type: "function",
					function: {
						name: "weather",
						description: "Get the weather",
						parameters: {
							type: "object",
							properties: { city: { type: "string" } },
							required: ["city"],
						},
						strict: true,
					},
				},
				{ type: "function", function: { name: "now" } },
			],
		});
		expect(body.tools).toEqual([
			{
				name: "weather",
				description: "Get the weather",
				input_schema: {
					type: "object",
					properties: { city: { type: "string" } },
					required: ["city"],
				},
			},
			{ name: "now", input_schema: { type: "object", properties: {} } },
		]);
	});

	test("any other tool type is refused", () => {
		const error = refused(
			malformed({
				model: MODEL,
				messages: [HI],
				tools: [
					{ type: "function", function: { name: "a" } },
					{ type: "web_search" },
				],
			}),
		);
		expect(error.param).toBe("tools[1].type");
	});
});

describe("11. tool_choice", () => {
	const tools: ChatCompletionRequest["tools"] = [
		{ type: "function", function: { name: "f" } },
	];

	test("each string choice maps", () => {
		expect(
			translated({ model: MODEL, messages: [HI], tools, tool_choice: "none" })
				.tool_choice,
		).toEqual({ type: "none" });
		expect(
			translated({ model: MODEL, messages: [HI], tools, tool_choice: "auto" })
				.tool_choice,
		).toEqual({ type: "auto" });
		expect(
			translated({
				model: MODEL,
				messages: [HI],
				tools,
				tool_choice: "required",
			}).tool_choice,
		).toEqual({ type: "any" });
	});

	test("a named function maps to a tool choice", () => {
		expect(
			translated({
				model: MODEL,
				messages: [HI],
				tools,
				tool_choice: { type: "function", function: { name: "f" } },
			}).tool_choice,
		).toEqual({ type: "tool", name: "f" });
	});

	test("parallel_tool_calls false disables parallel use, on auto when no choice was given", () => {
		expect(
			translated({
				model: MODEL,
				messages: [HI],
				tools,
				parallel_tool_calls: false,
			}).tool_choice,
		).toEqual({
			type: "auto",
			disable_parallel_tool_use: true,
		});
		expect(
			translated({
				model: MODEL,
				messages: [HI],
				tools,
				tool_choice: "required",
				parallel_tool_calls: false,
			}).tool_choice,
		).toEqual({ type: "any", disable_parallel_tool_use: true });
	});

	test("parallel_tool_calls true or absent sets nothing", () => {
		expect(
			"tool_choice" in
				translated({
					model: MODEL,
					messages: [HI],
					tools,
					parallel_tool_calls: true,
				}),
		).toBe(false);
	});

	test("tool_choice is dropped when there are no tools", () => {
		const body = translated({
			model: MODEL,
			messages: [HI],
			tool_choice: "required",
			parallel_tool_calls: false,
		});
		expect("tool_choice" in body).toBe(false);
		expect("tools" in body).toBe(false);
	});
});

describe("12. user", () => {
	test("becomes metadata.user_id", () => {
		expect(
			translated({ model: MODEL, messages: [HI], user: "u-42" }).metadata,
		).toEqual({ user_id: "u-42" });
	});
});

describe("13. response_format", () => {
	test("json_object appends the JSON instruction to system", () => {
		expect(
			translated({
				model: MODEL,
				messages: [{ role: "system", content: "Be brief." }, HI],
				response_format: { type: "json_object" },
			}).system,
		).toBe(
			"Be brief.\n\nRespond with a single valid JSON object and nothing else.",
		);
	});

	test("json_schema appends the instruction and the serialized schema", () => {
		const schema = { type: "object", properties: { a: { type: "number" } } };
		expect(
			translated({
				model: MODEL,
				messages: [HI],
				response_format: {
					type: "json_schema",
					json_schema: { name: "s", schema },
				},
			}).system,
		).toBe(
			`Respond with a single valid JSON object and nothing else.\nThe object must conform to this JSON Schema:\n${JSON.stringify(schema)}`,
		);
	});

	test("text adds nothing", () => {
		expect(
			"system" in
				translated({
					model: MODEL,
					messages: [HI],
					response_format: { type: "text" },
				}),
		).toBe(false);
	});
});

describe("14. stream and ignored keys", () => {
	test("stream true is forwarded; reasoning_effort, seed and penalties are ignored", () => {
		expect(
			translated({
				model: MODEL,
				messages: [HI],
				stream: true,
				reasoning_effort: "high",
				seed: 7,
				presence_penalty: 1,
				frequency_penalty: 1,
			}),
		).toEqual({
			model: MODEL,
			max_tokens: DEFAULT_MAX_TOKENS,
			messages: [{ role: "user", content: "hi" }],
			stream: true,
		});
	});

	test("stream false is omitted", () => {
		expect(
			"stream" in translated({ model: MODEL, messages: [HI], stream: false }),
		).toBe(false);
	});
});

describe("15. model and messages presence", () => {
	test("model passes through unchanged", () => {
		expect(translated({ model: "gpt-4o", messages: [HI] }).model).toBe(
			"gpt-4o",
		);
	});

	test("a missing or non-string model is refused", () => {
		expect(refused(malformed({ messages: [HI] })).param).toBe("model");
		expect(refused(malformed({ model: 4, messages: [HI] })).param).toBe(
			"model",
		);
	});

	test("non-array messages are refused", () => {
		expect(refused(malformed({ model: MODEL, messages: "hi" })).param).toBe(
			"messages",
		);
		expect(refused(malformed({ model: MODEL })).param).toBe("messages");
	});

	test("a non-object body is refused rather than thrown", () => {
		expect(refused(malformed(null)).param).toBe(null);
	});
});
