import { describe, expect, test } from "bun:test";
import { matchOpenAIGatewayPath } from "@better-ccflare/types";
import type { HandleProxyFn } from "../../types";
import {
	dispatchOpenAIGatewayRequest,
	handleChatCompletionsRequest,
	handleOpenAIModelsRequest,
	isOpenAIChatCompletionsRequest,
	isOpenAIGatewayPath,
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

const ANTHROPIC_TOOL_MESSAGE = {
	...ANTHROPIC_MESSAGE,
	content: [
		{ type: "text", text: "Checking" },
		{
			type: "tool_use",
			id: "toolu_1",
			name: "get_weather",
			input: { city: "Valletta" },
		},
	],
	stop_reason: "tool_use",
};

function sse(events: Array<{ event: string; data: unknown }>): string {
	return events
		.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
		.join("");
}

const ANTHROPIC_SSE = sse([
	{
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
	},
	{
		event: "content_block_start",
		data: {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		},
	},
	{
		event: "content_block_delta",
		data: {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "Hello there" },
		},
	},
	{
		event: "content_block_stop",
		data: { type: "content_block_stop", index: 0 },
	},
	{
		event: "message_delta",
		data: {
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
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

function chatRequest(body: unknown, raw?: string): Request {
	return new Request("http://localhost/v1/chat/completions?beta=true", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: "Bearer test-key",
		},
		body: raw ?? JSON.stringify(body),
	});
}

async function call(req: Request, proxy: HandleProxyFn): Promise<Response> {
	return handleChatCompletionsRequest(req, new URL(req.url), proxy, {});
}

function dataLines(text: string): string[] {
	return text
		.split("\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => line.slice("data: ".length));
}

const BASIC = {
	model: "claude-haiku-4-5",
	messages: [
		{ role: "system", content: "Be brief." },
		{ role: "user", content: "Hi" },
	],
};

describe("handleChatCompletionsRequest", () => {
	test("builds a synthetic POST /v1/messages carrying the translated body", async () => {
		const [proxy, captured] = stubProxy(() => Response.json(ANTHROPIC_MESSAGE));
		await call(chatRequest(BASIC), proxy);

		expect(captured.calls).toBe(1);
		expect(captured.req?.method).toBe("POST");
		expect(captured.url?.pathname).toBe("/v1/messages");
		expect(new URL(captured.req?.url ?? "").pathname).toBe("/v1/messages");
		expect(captured.url?.search).toBe("?beta=true");
		expect(captured.req?.headers.get("content-type")).toBe("application/json");
		expect(captured.req?.headers.get("anthropic-version")).toBe("2023-06-01");
		expect(captured.req?.headers.get("authorization")).toBe("Bearer test-key");
		expect(captured.body?.model).toBe("claude-haiku-4-5");
		expect(typeof captured.body?.max_tokens).toBe("number");
		expect(captured.body?.system).toBe("Be brief.");
		expect(captured.body?.messages).toEqual([{ role: "user", content: "Hi" }]);
	});

	test("non-streaming: answers a chat.completion as JSON", async () => {
		const [proxy] = stubProxy(() => Response.json(ANTHROPIC_MESSAGE));
		const resp = await call(chatRequest(BASIC), proxy);

		expect(resp.status).toBe(200);
		expect(resp.headers.get("content-type")).toContain("application/json");
		const body = (await resp.json()) as Record<string, unknown> & {
			choices: Array<{ message: { content: string }; finish_reason: string }>;
		};
		expect(body.object).toBe("chat.completion");
		expect(String(body.id)).toMatch(/^chatcmpl-[0-9a-f]+$/);
		expect(typeof body.created).toBe("number");
		expect(body.model).toBe("claude-haiku-4-5");
		expect(body.choices[0]?.message.content).toBe("Hello there");
		expect(body.choices[0]?.finish_reason).toBe("stop");
	});

	test("streaming: translates an upstream SSE body into chunks ending in [DONE]", async () => {
		const [proxy, captured] = stubProxy(
			() =>
				new Response(ANTHROPIC_SSE, {
					headers: { "content-type": "text/event-stream" },
				}),
		);
		const resp = await call(chatRequest({ ...BASIC, stream: true }), proxy);

		expect(captured.body?.stream).toBe(true);
		expect(resp.status).toBe(200);
		expect(resp.headers.get("content-type")).toBe(
			"text/event-stream; charset=utf-8",
		);
		expect(resp.headers.get("cache-control")).toBe("no-cache");
		const lines = dataLines(await resp.text());
		expect(lines.at(-1)).toBe("[DONE]");
		const chunks = lines.slice(0, -1).map((l) => JSON.parse(l));
		expect(chunks.length).toBeGreaterThan(0);
		for (const chunk of chunks) {
			expect(chunk.object).toBe("chat.completion.chunk");
		}
		const text = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
		expect(text).toBe("Hello there");
		expect(chunks.some((c) => c.choices[0]?.finish_reason === "stop")).toBe(
			true,
		);
	});

	test("a throw from handleProxy (pool exhaustion) becomes a 503 in the OpenAI shape", async () => {
		const proxy: HandleProxyFn = async () => {
			throw Object.assign(new Error("All accounts failed"), {
				statusCode: 503,
			});
		};
		const resp = await call(chatRequest(BASIC), proxy);

		expect(resp.status).toBe(503);
		expect(resp.headers.get("content-type")).toContain("application/json");
		const body = (await resp.json()) as Record<string, unknown> & {
			error: { message: unknown };
		};
		expect(typeof body.error.message).toBe("string");
		expect(body.type).toBeUndefined();
	});

	test("a throw with no statusCode becomes a 500 in the OpenAI shape", async () => {
		const proxy: HandleProxyFn = async () => {
			throw new Error("boom");
		};
		const resp = await call(chatRequest(BASIC), proxy);

		expect(resp.status).toBe(500);
		const body = (await resp.json()) as Record<string, unknown> & {
			error: { message: unknown };
		};
		expect(typeof body.error.message).toBe("string");
		expect(body.type).toBeUndefined();
	});

	test("an upstream 429 Anthropic body becomes an OpenAI 429 with retry-after kept", async () => {
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
		const resp = await call(chatRequest(BASIC), proxy);

		expect(resp.status).toBe(429);
		expect(resp.headers.get("retry-after")).toBe("7");
		const body = (await resp.json()) as Record<string, unknown> & {
			error: { message: string };
		};
		expect(body.error.message).toContain("Slow down");
		expect(body.type).toBeUndefined();
	});

	test("invalid JSON → 400 without calling handleProxy", async () => {
		const [proxy, captured] = stubProxy(() => Response.json(ANTHROPIC_MESSAGE));
		const resp = await call(chatRequest(undefined, "{not json"), proxy);

		expect(resp.status).toBe(400);
		const body = (await resp.json()) as { error: { type: string } };
		expect(body.error.type).toBe("invalid_request_error");
		expect(captured.calls).toBe(0);
	});

	test("a translator refusal (n: 2) → 400 without calling handleProxy", async () => {
		const [proxy, captured] = stubProxy(() => Response.json(ANTHROPIC_MESSAGE));
		const resp = await call(chatRequest({ ...BASIC, n: 2 }), proxy);

		expect(resp.status).toBe(400);
		const body = (await resp.json()) as Record<string, unknown> & {
			error: { message: string; type: string };
		};
		expect(body.error.type).toBe("invalid_request_error");
		expect(typeof body.error.message).toBe("string");
		expect(body.type).toBeUndefined();
		expect(captured.calls).toBe(0);
	});

	test("stream requested but upstream answered JSON → a well-formed stream ending in [DONE]", async () => {
		const [proxy] = stubProxy(() => Response.json(ANTHROPIC_TOOL_MESSAGE));
		const resp = await call(
			chatRequest({
				...BASIC,
				stream: true,
				stream_options: { include_usage: true },
			}),
			proxy,
		);

		expect(resp.status).toBe(200);
		expect(resp.headers.get("content-type")).toBe(
			"text/event-stream; charset=utf-8",
		);
		const lines = dataLines(await resp.text());
		expect(lines.at(-1)).toBe("[DONE]");
		const chunks = lines.slice(0, -1).map((l) => JSON.parse(l));
		expect(chunks[0].choices[0].delta.role).toBe("assistant");
		const ids = new Set(chunks.map((c) => c.id));
		expect(ids.size).toBe(1);
		const text = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
		expect(text).toBe("Checking");
		const toolDelta = chunks.find((c) => c.choices[0]?.delta?.tool_calls);
		expect(toolDelta.choices[0].delta.tool_calls[0]).toMatchObject({
			index: 0,
			id: "toolu_1",
			type: "function",
			function: { name: "get_weather" },
		});
		expect(
			JSON.parse(toolDelta.choices[0].delta.tool_calls[0].function.arguments),
		).toEqual({ city: "Valletta" });
		expect(
			chunks.some((c) => c.choices[0]?.finish_reason === "tool_calls"),
		).toBe(true);
		const usageChunk = chunks.at(-1);
		expect(usageChunk.choices).toEqual([]);
		expect(usageChunk.usage).toMatchObject({
			prompt_tokens: 10,
			completion_tokens: 5,
			total_tokens: 15,
		});
	});
});

const EXCLUDE = "x-better-ccflare-exclude-providers";

describe("gateway exclusions", () => {
	test("the chat handler sets the exclusion header when options carry it", async () => {
		const [proxy, captured] = stubProxy(() => Response.json(ANTHROPIC_MESSAGE));
		const req = chatRequest(BASIC);
		await handleChatCompletionsRequest(
			req,
			new URL(req.url),
			proxy,
			{},
			null,
			null,
			{ excludeProviders: ["anthropic-oauth", "codex"] },
		);
		expect(captured.req?.headers.get(EXCLUDE)).toBe("anthropic-oauth,codex");
	});

	test("the header is absent without options, even when the client sends it", async () => {
		const [proxy, captured] = stubProxy(() => Response.json(ANTHROPIC_MESSAGE));
		const req = new Request("http://localhost/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json", [EXCLUDE]: "codex" },
			body: JSON.stringify(BASIC),
		});
		await call(req, proxy);
		expect(captured.calls).toBe(1);
		expect(captured.req?.headers.has(EXCLUDE)).toBe(false);
	});

	test("the models handler forwards GET /v1/models with the header", async () => {
		let seen: Request | undefined;
		let seenUrl: URL | undefined;
		const proxy: HandleProxyFn = async (req, url) => {
			seen = req;
			seenUrl = url;
			return Response.json({ object: "list", data: [] });
		};
		const req = new Request("http://localhost/v1/gateways/no-oauth/models");
		const resp = await handleOpenAIModelsRequest(
			req,
			new URL(req.url),
			proxy,
			{},
			null,
			null,
			{ excludeProviders: ["anthropic-oauth"] },
		);
		expect(resp.status).toBe(200);
		expect(seen?.method).toBe("GET");
		expect(seenUrl?.pathname).toBe("/v1/models");
		expect(new URL(seen?.url ?? "").pathname).toBe("/v1/models");
		expect(seen?.headers.get(EXCLUDE)).toBe("anthropic-oauth");
	});

	test("the models handler answers a throw in the OpenAI shape", async () => {
		const proxy: HandleProxyFn = async () => {
			throw Object.assign(new Error("exhausted"), { statusCode: 503 });
		};
		const req = new Request("http://localhost/v1/gateways/no-oauth/models");
		const resp = await handleOpenAIModelsRequest(
			req,
			new URL(req.url),
			proxy,
			{},
		);
		expect(resp.status).toBe(503);
		const body = (await resp.json()) as Record<string, unknown> & {
			error: { message: unknown };
		};
		expect(typeof body.error.message).toBe("string");
		expect(body.type).toBeUndefined();
	});
});

describe("dispatchOpenAIGatewayRequest", () => {
	const GATEWAYS = {
		"no-oauth": { exclude_providers: ["anthropic-oauth"] },
		open: {},
	};

	async function dispatch(
		method: string,
		path: string,
		proxy: HandleProxyFn,
		body?: unknown,
	): Promise<Response> {
		const req = new Request(`http://localhost${path}`, {
			method,
			headers: { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const url = new URL(req.url);
		const match = matchOpenAIGatewayPath(url.pathname);
		if (!match) throw new Error(`no gateway match for ${path}`);
		return dispatchOpenAIGatewayRequest(req, url, match, GATEWAYS, proxy, {});
	}

	test("an unknown gateway name is a 404 gateway_not_found", async () => {
		const [proxy, captured] = stubProxy(() => Response.json(ANTHROPIC_MESSAGE));
		const resp = await dispatch(
			"POST",
			"/v1/gateways/nope/chat/completions",
			proxy,
			BASIC,
		);
		expect(resp.status).toBe(404);
		const body = (await resp.json()) as { error: { code: string } };
		expect(body.error.code).toBe("gateway_not_found");
		expect(captured.calls).toBe(0);
	});

	test("an inherited property name is not a gateway", async () => {
		const [proxy, captured] = stubProxy(() => Response.json(ANTHROPIC_MESSAGE));
		const resp = await dispatch(
			"POST",
			"/v1/gateways/constructor/chat/completions",
			proxy,
			BASIC,
		);
		expect(resp.status).toBe(404);
		expect(captured.calls).toBe(0);
	});

	test("an unserved path or method under a known gateway is a 404 unknown_endpoint", async () => {
		const [proxy, captured] = stubProxy(() => Response.json(ANTHROPIC_MESSAGE));
		for (const [method, path] of [
			["POST", "/v1/gateways/open/embeddings"],
			["GET", "/v1/gateways/open/chat/completions"],
			["POST", "/v1/gateways/open/models"],
			["GET", "/v1/gateways/open"],
		] as const) {
			const resp = await dispatch(
				method,
				path,
				proxy,
				method === "POST" ? BASIC : undefined,
			);
			expect(resp.status).toBe(404);
			const body = (await resp.json()) as { error: { code: string } };
			expect(body.error.code).toBe("unknown_endpoint");
		}
		expect(captured.calls).toBe(0);
	});

	test("chat on a gateway carries that gateway's exclusions", async () => {
		const [proxy, captured] = stubProxy(() => Response.json(ANTHROPIC_MESSAGE));
		const resp = await dispatch(
			"POST",
			"/v1/gateways/no-oauth/chat/completions",
			proxy,
			BASIC,
		);
		expect(resp.status).toBe(200);
		expect(captured.url?.pathname).toBe("/v1/messages");
		expect(captured.req?.headers.get(EXCLUDE)).toBe("anthropic-oauth");
	});

	test("a gateway with no rules sends no exclusion header", async () => {
		const [proxy, captured] = stubProxy(() => Response.json(ANTHROPIC_MESSAGE));
		await dispatch("POST", "/v1/gateways/open/chat/completions", proxy, BASIC);
		expect(captured.calls).toBe(1);
		expect(captured.req?.headers.has(EXCLUDE)).toBe(false);
	});

	test("models on a gateway forwards GET /v1/models with its exclusions", async () => {
		let seen: Request | undefined;
		const proxy: HandleProxyFn = async (req) => {
			seen = req;
			return Response.json({ object: "list", data: [] });
		};
		const resp = await dispatch("GET", "/v1/gateways/no-oauth/models", proxy);
		expect(resp.status).toBe(200);
		expect(new URL(seen?.url ?? "").pathname).toBe("/v1/models");
		expect(seen?.headers.get(EXCLUDE)).toBe("anthropic-oauth");
	});
});

describe("client disconnect", () => {
	test("the chat handler hands handleProxy a request carrying the client's signal", async () => {
		const [proxy, captured] = stubProxy(() => Response.json(ANTHROPIC_MESSAGE));
		const controller = new AbortController();
		const req = new Request("http://localhost/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(BASIC),
			signal: controller.signal,
		});
		await call(req, proxy);
		expect(captured.req?.signal.aborted).toBe(false);
		controller.abort();
		expect(captured.req?.signal.aborted).toBe(true);
	});

	test("the models handler hands handleProxy a request carrying the client's signal", async () => {
		let seen: Request | undefined;
		const proxy: HandleProxyFn = async (req) => {
			seen = req;
			return Response.json({ object: "list", data: [] });
		};
		const controller = new AbortController();
		const req = new Request("http://localhost/v1/gateways/open/models", {
			signal: controller.signal,
		});
		await handleOpenAIModelsRequest(req, new URL(req.url), proxy, {});
		expect(seen?.signal.aborted).toBe(false);
		controller.abort();
		expect(seen?.signal.aborted).toBe(true);
	});
});

describe("isOpenAIChatCompletionsRequest", () => {
	test("matches POST /v1/chat/completions only", () => {
		expect(isOpenAIChatCompletionsRequest("POST", "/v1/chat/completions")).toBe(
			true,
		);
		expect(isOpenAIChatCompletionsRequest("GET", "/v1/chat/completions")).toBe(
			false,
		);
		expect(isOpenAIChatCompletionsRequest("POST", "/chat/completions")).toBe(
			false,
		);
		expect(isOpenAIChatCompletionsRequest("POST", "/v1/messages")).toBe(false);
	});
});

describe("gateway escape", () => {
	test("isOpenAIGatewayPath covers the whole prefix and nothing else", () => {
		expect(isOpenAIGatewayPath("/v1/gateways")).toBe(true);
		expect(isOpenAIGatewayPath("/v1/gateways/")).toBe(true);
		expect(isOpenAIGatewayPath("/v1/gateways/Work/chat/completions")).toBe(
			true,
		);
		expect(isOpenAIGatewayPath("/v1/gateways/work/models")).toBe(true);
		expect(isOpenAIGatewayPath("/v1/gatewaysx")).toBe(false);
		expect(isOpenAIGatewayPath("/v1/chat/completions")).toBe(false);
		expect(isOpenAIGatewayPath("/v1/messages")).toBe(false);
	});

	test("an invalid gateway name is a 404 that never reaches handleProxy", async () => {
		const [proxy, captured] = stubProxy(() => Response.json(ANTHROPIC_MESSAGE));
		const gateways = { work: { exclude_providers: ["anthropic-oauth"] } };
		for (const path of [
			"/v1/gateways/Work/chat/completions",
			"/v1/gateways/%77ork/chat/completions",
			"/v1/gateways/_x/chat/completions",
			"/v1/gateways//chat/completions",
			"/v1/gateways/",
			"/v1/gateways",
		]) {
			const req = new Request(`http://localhost${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(BASIC),
			});
			const url = new URL(req.url);
			expect(isOpenAIGatewayPath(url.pathname)).toBe(true);
			const match = matchOpenAIGatewayPath(url.pathname);
			expect(match).toBeNull();
			const resp = await dispatchOpenAIGatewayRequest(
				req,
				url,
				match,
				gateways,
				proxy,
				{},
			);
			expect(resp.status).toBe(404);
			const body = (await resp.json()) as Record<string, unknown> & {
				error: { code: string; message: string };
			};
			expect(body.error.code).toBe("gateway_not_found");
			expect(body.type).toBeUndefined();
		}
		expect(captured.calls).toBe(0);
	});
});

describe("forced account on a gateway", () => {
	const FORCED = "x-better-ccflare-account-id";

	function forcedChat(): Request {
		return new Request("http://localhost/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json", [FORCED]: "acct-1" },
			body: JSON.stringify(BASIC),
		});
	}

	function forcedModels(): Request {
		return new Request("http://localhost/v1/gateways/work/models", {
			headers: { [FORCED]: "acct-1" },
		});
	}

	test("chat with exclusions drops the forced account id", async () => {
		const [proxy, captured] = stubProxy(() => Response.json(ANTHROPIC_MESSAGE));
		const req = forcedChat();
		await handleChatCompletionsRequest(
			req,
			new URL(req.url),
			proxy,
			{},
			null,
			null,
			{
				excludeProviders: ["anthropic-oauth"],
			},
		);
		expect(captured.calls).toBe(1);
		expect(captured.req?.headers.has(FORCED)).toBe(false);
	});

	test("chat without exclusions keeps the forced account id", async () => {
		const [proxy, captured] = stubProxy(() => Response.json(ANTHROPIC_MESSAGE));
		await call(forcedChat(), proxy);
		expect(captured.req?.headers.get(FORCED)).toBe("acct-1");
	});

	test("models with exclusions drops the forced account id", async () => {
		let seen: Request | undefined;
		const proxy: HandleProxyFn = async (req) => {
			seen = req;
			return Response.json({ object: "list", data: [] });
		};
		const req = forcedModels();
		await handleOpenAIModelsRequest(
			req,
			new URL(req.url),
			proxy,
			{},
			null,
			null,
			{
				excludeProviders: ["codex"],
			},
		);
		expect(seen).toBeDefined();
		expect(seen?.headers.has(FORCED)).toBe(false);
	});

	test("models without exclusions keeps the forced account id", async () => {
		let seen: Request | undefined;
		const proxy: HandleProxyFn = async (req) => {
			seen = req;
			return Response.json({ object: "list", data: [] });
		};
		const req = forcedModels();
		await handleOpenAIModelsRequest(req, new URL(req.url), proxy, {});
		expect(seen?.headers.get(FORCED)).toBe("acct-1");
	});
});
