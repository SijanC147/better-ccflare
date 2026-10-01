import { describe, expect, test } from "bun:test";
import {
	INBOUND_FORMAT_HEADER,
	INBOUND_GATEWAY_HEADER,
	matchOpenAIGatewayPath,
	parseOpenAIGateways,
} from "@better-ccflare/types";
import { dispatchOpenAIGatewayRequest } from "../../chat/handler";
import type { HandleProxyFn } from "../../types";
import {
	handleCompletionsRequest,
	isOpenAICompletionsRequest,
} from "../handler";

const ANTHROPIC_MESSAGE = {
	id: "msg_1",
	type: "message",
	role: "assistant",
	model: "claude-haiku-4-5",
	content: [{ type: "text", text: "Hello there" }],
	stop_reason: "end_turn",
	stop_sequence: null,
	usage: { input_tokens: 10, output_tokens: 5 },
};

function sse(events: Array<{ event: string; data: unknown }>): string {
	return events
		.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
		.join("");
}

const START = {
	event: "message_start",
	data: {
		type: "message_start",
		message: {
			...ANTHROPIC_MESSAGE,
			content: [],
			stop_reason: null,
			usage: { input_tokens: 10, output_tokens: 0 },
		},
	},
};

function textDelta(text: string) {
	return {
		event: "content_block_delta",
		data: {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text },
		},
	};
}

const ANTHROPIC_SSE = sse([
	START,
	{
		event: "content_block_start",
		data: {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		},
	},
	textDelta("Hello"),
	textDelta(" there"),
	{
		event: "content_block_stop",
		data: { type: "content_block_stop", index: 0 },
	},
	{
		event: "message_delta",
		data: {
			type: "message_delta",
			delta: { stop_reason: "max_tokens", stop_sequence: null },
			usage: { output_tokens: 5 },
		},
	},
	{ event: "message_stop", data: { type: "message_stop" } },
]);

interface Captured {
	calls: number;
	req?: Request;
	url?: URL;
	body?: Record<string, unknown>;
}

function stubProxy(
	respond: () => Response | Promise<Response>,
): [HandleProxyFn, Captured] {
	const captured: Captured = { calls: 0 };
	const fn: HandleProxyFn = async (req, url) => {
		captured.calls++;
		captured.req = req;
		captured.url = url;
		captured.body = (await req.clone().json()) as Record<string, unknown>;
		return respond();
	};
	return [fn, captured];
}

function sseResponse(body: string): Response {
	return new Response(body, {
		headers: { "content-type": "text/event-stream" },
	});
}

function completionRequest(body: unknown, path = "/v1/completions"): Request {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: "Bearer test-key",
		},
		body: JSON.stringify(body),
	});
}

function call(req: Request, proxy: HandleProxyFn): Promise<Response> {
	return handleCompletionsRequest(req, new URL(req.url), proxy, {});
}

/** Each `data:` payload, parsed, with `[DONE]` kept as the string. */
function frames(text: string): unknown[] {
	return text
		.split("\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => line.slice("data: ".length))
		.map((data) => (data === "[DONE]" ? data : JSON.parse(data)));
}

const BASIC = { model: "claude-haiku-4-5", prompt: "Say hello" };

describe("isOpenAICompletionsRequest", () => {
	test("matches POST /v1/completions only", () => {
		expect(isOpenAICompletionsRequest("POST", "/v1/completions")).toBe(true);
		expect(isOpenAICompletionsRequest("GET", "/v1/completions")).toBe(false);
		expect(isOpenAICompletionsRequest("POST", "/v1/chat/completions")).toBe(
			false,
		);
		expect(isOpenAICompletionsRequest("POST", "/v1/completions/x")).toBe(false);
	});
});

describe("handleCompletionsRequest", () => {
	test("sends the prompt as one user turn on a synthetic POST /v1/messages", async () => {
		const [proxy, captured] = stubProxy(() => Response.json(ANTHROPIC_MESSAGE));
		await call(completionRequest(BASIC), proxy);

		expect(captured.calls).toBe(1);
		expect(captured.url?.pathname).toBe("/v1/messages");
		expect(captured.req?.method).toBe("POST");
		expect(captured.req?.headers.get("anthropic-version")).toBe("2023-06-01");
		expect(captured.req?.headers.get("authorization")).toBe("Bearer test-key");
		expect(captured.req?.headers.get(INBOUND_FORMAT_HEADER)).toBe(
			"openai-completions",
		);
		expect(captured.req?.headers.get(INBOUND_GATEWAY_HEADER)).toBeNull();
		expect(captured.body).toEqual({
			model: "claude-haiku-4-5",
			max_tokens: 16,
			messages: [{ role: "user", content: "Say hello" }],
		});
	});

	test("non-streaming: answers text_completion with choices[].text, not message", async () => {
		const [proxy] = stubProxy(() => Response.json(ANTHROPIC_MESSAGE));
		const resp = await call(completionRequest(BASIC), proxy);

		expect(resp.status).toBe(200);
		expect(resp.headers.get("content-type")).toContain("application/json");
		const body = (await resp.json()) as Record<string, unknown>;
		expect(String(body.id)).toMatch(/^cmpl-[0-9a-f]{24}$/);
		expect(typeof body.created).toBe("number");
		expect(body).toEqual({
			id: body.id,
			object: "text_completion",
			created: body.created,
			model: "claude-haiku-4-5",
			choices: [
				{
					text: "Hello there",
					index: 0,
					logprobs: null,
					finish_reason: "stop",
				},
			],
			usage: {
				prompt_tokens: 10,
				completion_tokens: 5,
				total_tokens: 15,
				prompt_tokens_details: { cached_tokens: 0 },
			},
		});
	});

	test("non-streaming echo: the prompt leads the text", async () => {
		const [proxy] = stubProxy(() => Response.json(ANTHROPIC_MESSAGE));
		const resp = await call(
			completionRequest({ ...BASIC, prompt: "Say: ", echo: true }),
			proxy,
		);
		const body = (await resp.json()) as {
			choices: Array<{ text: string }>;
		};
		expect(body.choices[0]?.text).toBe("Say: Hello there");
	});

	test("streaming: text_completion chunks, finish_reason on the last, then [DONE]", async () => {
		const [proxy, captured] = stubProxy(() => sseResponse(ANTHROPIC_SSE));
		const resp = await call(
			completionRequest({ ...BASIC, stream: true }),
			proxy,
		);

		expect(captured.body?.stream).toBe(true);
		expect(resp.status).toBe(200);
		expect(resp.headers.get("content-type")).toBe(
			"text/event-stream; charset=utf-8",
		);
		const all = frames(await resp.text());
		expect(all.at(-1)).toBe("[DONE]");
		const chunks = all.slice(0, -1) as Array<Record<string, unknown>>;
		const id = chunks[0]?.id;
		expect(String(id)).toMatch(/^cmpl-[0-9a-f]{24}$/);
		const created = chunks[0]?.created;
		const chunk = (text: string, finish_reason: string | null) => ({
			id,
			object: "text_completion",
			created,
			model: "claude-haiku-4-5",
			choices: [{ text, index: 0, logprobs: null, finish_reason }],
		});
		// The role chunk carries no text and no finish reason, so it is dropped.
		expect(chunks).toEqual([
			chunk("Hello", null),
			chunk(" there", null),
			chunk("", "length"),
		]);
	});

	test("streaming with include_usage: usage: null on each chunk, then a usage-only chunk", async () => {
		const [proxy] = stubProxy(() => sseResponse(ANTHROPIC_SSE));
		const resp = await call(
			completionRequest({
				...BASIC,
				stream: true,
				stream_options: { include_usage: true },
			}),
			proxy,
		);
		const chunks = frames(await resp.text()).slice(0, -1) as Array<
			Record<string, unknown> & { choices: unknown[] }
		>;
		const last = chunks.at(-1);
		expect(last?.choices).toEqual([]);
		expect(last?.object).toBe("text_completion");
		expect(last?.usage).toEqual({
			prompt_tokens: 10,
			completion_tokens: 5,
			total_tokens: 15,
			prompt_tokens_details: { cached_tokens: 0 },
		});
		for (const chunk of chunks.slice(0, -1)) {
			expect(chunk.usage).toBeNull();
		}
	});

	test("streaming echo: the prompt is the first chunk", async () => {
		const [proxy] = stubProxy(() => sseResponse(ANTHROPIC_SSE));
		const resp = await call(
			completionRequest({
				...BASIC,
				prompt: "Say: ",
				stream: true,
				echo: true,
			}),
			proxy,
		);
		const chunks = frames(await resp.text()).slice(0, -1) as Array<{
			choices: Array<{ text: string; finish_reason: string | null }>;
		}>;
		expect(chunks.map((c) => c.choices[0]?.text)).toEqual([
			"Say: ",
			"Hello",
			" there",
			"",
		]);
		expect(chunks[0]?.choices[0]?.finish_reason).toBeNull();
	});

	test("streaming requested, upstream answered JSON: still text_completion chunks", async () => {
		const [proxy] = stubProxy(() => Response.json(ANTHROPIC_MESSAGE));
		const resp = await call(
			completionRequest({ ...BASIC, stream: true }),
			proxy,
		);
		expect(resp.headers.get("content-type")).toBe(
			"text/event-stream; charset=utf-8",
		);
		const all = frames(await resp.text());
		expect(all.at(-1)).toBe("[DONE]");
		const chunks = all.slice(0, -1) as Array<{
			object: string;
			choices: Array<{ text: string; finish_reason: string | null }>;
		}>;
		expect(chunks.every((c) => c.object === "text_completion")).toBe(true);
		expect(chunks.map((c) => c.choices[0]?.text).join("")).toBe("Hello there");
		expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
	});

	test("a mid-stream upstream error passes through as the OpenAI error frame", async () => {
		const [proxy] = stubProxy(() =>
			sseResponse(
				sse([
					START,
					textDelta("Hel"),
					{
						event: "error",
						data: {
							type: "error",
							error: { type: "overloaded_error", message: "Overloaded" },
						},
					},
				]),
			),
		);
		const resp = await call(
			completionRequest({ ...BASIC, stream: true }),
			proxy,
		);
		const all = frames(await resp.text());
		expect(all.at(-1)).toBe("[DONE]");
		expect(all.at(-2)).toEqual({
			error: {
				message: "Overloaded",
				type: "overloaded_error",
				param: null,
				code: "overloaded_error",
			},
		});
	});

	test("an upstream error keeps its status and retry-after, in the OpenAI shape", async () => {
		const [proxy] = stubProxy(
			() =>
				new Response(
					JSON.stringify({
						type: "error",
						error: { type: "rate_limit_error", message: "Slow down" },
					}),
					{
						status: 429,
						headers: { "content-type": "application/json", "retry-after": "7" },
					},
				),
		);
		const resp = await call(completionRequest(BASIC), proxy);
		expect(resp.status).toBe(429);
		expect(resp.headers.get("retry-after")).toBe("7");
		expect(await resp.json()).toEqual({
			error: {
				message: "Slow down",
				type: "rate_limit_error",
				param: null,
				code: "rate_limit_error",
			},
		});
	});

	test("a refusal never reaches handleProxy", async () => {
		const [proxy, captured] = stubProxy(() => Response.json(ANTHROPIC_MESSAGE));
		const array = await call(
			completionRequest({ ...BASIC, prompt: ["a", "b"] }),
			proxy,
		);
		expect(array.status).toBe(400);
		expect(
			((await array.json()) as { error: { param: string } }).error.param,
		).toBe("prompt");
		// Refused by the chat translator the core shares, in the same shape.
		const noModel = await call(completionRequest({ prompt: "x" }), proxy);
		expect(noModel.status).toBe(400);
		expect(await noModel.json()).toEqual({
			error: {
				message: "model is required.",
				type: "invalid_request_error",
				param: "model",
				code: "missing_required_parameter",
			},
		});
		const notJson = await handleCompletionsRequest(
			new Request("http://localhost/v1/completions", {
				method: "POST",
				body: "{",
			}),
			new URL("http://localhost/v1/completions"),
			proxy,
			{},
		);
		expect(notJson.status).toBe(400);
		expect(captured.calls).toBe(0);
	});
});

describe("POST /v1/gateways/<name>/completions", () => {
	const { gateways } = parseOpenAIGateways({
		work: {
			exclude_providers: ["anthropic-oauth"],
			models: [{ name: "fast", model: "claude-haiku-4-5" }],
		},
	});

	function dispatch(
		body: unknown,
		path: string,
		proxy: HandleProxyFn,
	): Promise<Response> {
		const req = completionRequest(body, path);
		const url = new URL(req.url);
		return dispatchOpenAIGatewayRequest(
			req,
			url,
			matchOpenAIGatewayPath(url.pathname),
			gateways,
			proxy,
			{},
		);
	}

	test("routes through the gateway's model set, exclusions and label", async () => {
		const [proxy, captured] = stubProxy(() => Response.json(ANTHROPIC_MESSAGE));
		const resp = await dispatch(
			{ model: "fast", prompt: "Hi" },
			"/v1/gateways/work/completions",
			proxy,
		);
		expect(resp.status).toBe(200);
		expect(((await resp.json()) as { object: string }).object).toBe(
			"text_completion",
		);
		expect(captured.body?.model).toBe("claude-haiku-4-5");
		expect(captured.req?.headers.get(INBOUND_FORMAT_HEADER)).toBe(
			"openai-completions",
		);
		expect(captured.req?.headers.get(INBOUND_GATEWAY_HEADER)).toBe("work");
		expect(
			captured.req?.headers.get("x-better-ccflare-exclude-providers"),
		).toBe("anthropic-oauth");
	});

	test("a model outside the set is refused before anything is sent", async () => {
		const [proxy, captured] = stubProxy(() => Response.json(ANTHROPIC_MESSAGE));
		const resp = await dispatch(
			{ model: "gpt-3.5-turbo-instruct", prompt: "Hi" },
			"/v1/gateways/work/completions",
			proxy,
		);
		expect(resp.status).toBe(404);
		expect(captured.calls).toBe(0);
	});

	test("an unknown path names /completions among the served routes", async () => {
		const [proxy] = stubProxy(() => Response.json(ANTHROPIC_MESSAGE));
		const resp = await dispatch({}, "/v1/gateways/work/edits", proxy);
		expect(resp.status).toBe(404);
		expect(
			((await resp.json()) as { error: { message: string } }).error.message,
		).toBe(
			'POST /edits is not served by gateway "work". Use POST /chat/completions, POST /completions, POST /responses, POST /responses/compact or GET /models.',
		);
	});
});
