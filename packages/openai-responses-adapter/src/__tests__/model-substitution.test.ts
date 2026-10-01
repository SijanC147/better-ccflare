/**
 * SB23-2781 (C). An OpenAI-shaped answer from a different model than the one
 * requested says so in `x-better-ccflare-model-substituted`, on chat (JSON,
 * stream, stream replayed from JSON) and on gateway responses (translated and
 * native, JSON and stream). Every test stubs `handleProxy`, so nothing leaves
 * the process.
 */
import { describe, expect, test } from "bun:test";
import {
	MODEL_SUBSTITUTED_HEADER,
	matchOpenAIGatewayPath,
	type OpenAIGateways,
} from "@better-ccflare/types";
import { handleChatCompletionsRequest } from "../chat/handler";
import { dispatchOpenAIGatewayRequest } from "../gateway-dispatch";
import { handleResponsesRequest } from "../handler";
import {
	anthropicMessageStartModel,
	modelSubstitution,
	peekSseModel,
} from "../model-substitution";
import type { HandleProxyFn } from "../types";

const encoder = new TextEncoder();

function message(model: string) {
	return {
		id: "msg_1",
		type: "message",
		role: "assistant",
		model,
		content: [{ type: "text", text: "Hello" }],
		stop_reason: "end_turn",
		stop_sequence: null,
		usage: { input_tokens: 3, output_tokens: 1 },
	};
}

function sse(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function anthropicStream(model: string): string {
	return [
		sse("message_start", {
			type: "message_start",
			message: { ...message(model), content: [], stop_reason: null },
		}),
		sse("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
		sse("content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "Hello" },
		}),
		sse("content_block_stop", { type: "content_block_stop", index: 0 }),
		sse("message_delta", {
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 1 },
		}),
		sse("message_stop", { type: "message_stop" }),
	].join("");
}

/** A stream of `text` cut into `size`-byte chunks. */
function chunked(text: string, size: number): ReadableStream<Uint8Array> {
	const bytes = encoder.encode(text);
	let offset = 0;
	return new ReadableStream({
		pull(controller) {
			if (offset >= bytes.length) {
				controller.close();
				return;
			}
			controller.enqueue(bytes.slice(offset, offset + size));
			offset += size;
		},
	});
}

/**
 * `handleProxy` answering as `model`: JSON, or SSE when the synthetic body
 * asks to stream, or SSE always when `forceSse`.
 */
function proxyAnswering(
	model: string,
	options: { jsonForStream?: boolean } = {},
): HandleProxyFn {
	return async (req) => {
		const body = (await req.clone().json()) as { stream?: boolean };
		if (body.stream === true && !options.jsonForStream) {
			return new Response(chunked(anthropicStream(model), 7), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}
		return Response.json(message(model));
	};
}

function chatRequest(model: string, stream = false): Request {
	return new Request("http://localhost/v1/chat/completions", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model,
			stream,
			messages: [{ role: "user", content: "Hi" }],
		}),
	});
}

function chat(proxy: HandleProxyFn, model: string, stream = false) {
	const req = chatRequest(model, stream);
	return handleChatCompletionsRequest(req, new URL(req.url), proxy, {});
}

const GATEWAYS: OpenAIGateways = {
	gpt: {
		models: [
			{ name: "gpt-5.5", model: "gpt-5.5" },
			{ name: "standard", model: "gpt-5.6-terra" },
		],
	},
	open: {},
};

function dispatch(path: string, proxy: HandleProxyFn, body: unknown) {
	const req = new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const url = new URL(req.url);
	const match = matchOpenAIGatewayPath(url.pathname);
	if (!match) throw new Error(`no gateway match for ${path}`);
	return dispatchOpenAIGatewayRequest(req, url, match, GATEWAYS, proxy, {});
}

describe("modelSubstitution", () => {
	test("a different answering model is reported as requested -> answered", () => {
		expect(
			modelSubstitution("claude-opus-5-5", "claude-opus-5-5", "gpt-5.6-sol"),
		).toBe("claude-opus-5-5 -> gpt-5.6-sol");
	});

	test("a dated snapshot or -latest alias of the requested model is not a substitution", () => {
		expect(
			modelSubstitution(
				"claude-sonnet-4-5",
				null,
				"claude-sonnet-4-5-20250929",
			),
		).toBeNull();
		expect(modelSubstitution("gpt-5.5", null, "gpt-5.5-2026-09-01")).toBeNull();
		expect(
			modelSubstitution(
				"claude-3-5-sonnet-latest",
				null,
				"claude-3-5-sonnet-20241022",
			),
		).toBeNull();
	});

	test("an answer from the model a gateway entry routes to is not a substitution", () => {
		expect(
			modelSubstitution("standard", "gpt-5.6-terra", "gpt-5.6-terra"),
		).toBeNull();
		expect(modelSubstitution("standard", "gpt-5.6-terra", "gpt-5.5")).toBe(
			"standard -> gpt-5.5",
		);
	});

	test("an answer that names no model reports nothing", () => {
		expect(modelSubstitution("claude-opus-5-5", null, undefined)).toBeNull();
		expect(modelSubstitution("claude-opus-5-5", null, "")).toBeNull();
	});
});

describe("peekSseModel", () => {
	test("finds message_start across chunk boundaries and replays every byte", async () => {
		const text = anthropicStream("gpt-5.6-sol");
		const peeked = await peekSseModel(
			chunked(text, 5),
			anthropicMessageStartModel,
		);
		expect(peeked.model).toBe("gpt-5.6-sol");
		expect(await new Response(peeked.body).text()).toBe(text);
	});

	test("stops at the byte bound with no model and still replays every byte", async () => {
		const filler = sse("ping", { type: "ping" }).repeat(50);
		const text = filler + anthropicStream("gpt-5.6-sol");
		const peeked = await peekSseModel(
			chunked(text, 64),
			anthropicMessageStartModel,
			256,
		);
		expect(peeked.model).toBeNull();
		expect(await new Response(peeked.body).text()).toBe(text);
	});

	test("a stream that ends without the event reports no model", async () => {
		const text = sse("ping", { type: "ping" });
		const peeked = await peekSseModel(
			chunked(text, 4),
			anthropicMessageStartModel,
		);
		expect(peeked.model).toBeNull();
		expect(await new Response(peeked.body).text()).toBe(text);
	});
});

/** The first SSE frame of `anthropicStream(model)`, its `message_start`. */
function messageStartFrame(model: string): string {
	return `${anthropicStream(model).split("\n\n")[0]}\n\n`;
}

describe("peekSseModel error and cancel propagation", () => {
	test("an upstream error during the peek is replayed after the bytes read", async () => {
		const boom = new Error("boom");
		// Erroring a stream resets its queue, so the chunk is pulled before the
		// error: the first pull enqueues a ping, the second errors.
		let pulls = 0;
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				if (pulls === 1) {
					controller.enqueue(encoder.encode(sse("ping", { type: "ping" })));
					return;
				}
				controller.error(boom);
			},
		});
		const peeked = await peekSseModel(source, anthropicMessageStartModel);
		expect(peeked.model).toBeNull();
		const reader = peeked.body.getReader();
		const first = await reader.read();
		expect(first.done).toBe(false);
		expect(new TextDecoder().decode(first.value)).toBe(
			sse("ping", { type: "ping" }),
		);
		await expect(reader.read()).rejects.toBe(boom);
	});

	test("an upstream error after the peek reaches the replay reader", async () => {
		const boom = new Error("later");
		let pulls = 0;
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				if (pulls === 1) {
					controller.enqueue(encoder.encode(messageStartFrame("m-1")));
					return;
				}
				controller.error(boom);
			},
		});
		const peeked = await peekSseModel(source, anthropicMessageStartModel);
		expect(peeked.model).toBe("m-1");
		const reader = peeked.body.getReader();
		expect((await reader.read()).done).toBe(false);
		await expect(reader.read()).rejects.toBe(boom);
	});

	test("cancelling the replay cancels the upstream with the same reason, model found", async () => {
		let cancelledWith: unknown = "not called";
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(encoder.encode(messageStartFrame("m-1")));
			},
			cancel(reason) {
				cancelledWith = reason;
			},
		});
		const peeked = await peekSseModel(source, anthropicMessageStartModel);
		expect(peeked.model).toBe("m-1");
		await peeked.body.cancel("client gone");
		expect(cancelledWith).toBe("client gone");
	});

	test("cancelling the replay cancels the upstream, model not found and reader still live", async () => {
		let cancelledWith: unknown = "not called";
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(encoder.encode(sse("ping", { type: "ping" })));
			},
			cancel(reason) {
				cancelledWith = reason;
			},
		});
		const peeked = await peekSseModel(source, anthropicMessageStartModel, 64);
		expect(peeked.model).toBeNull();
		await peeked.body.cancel("client gone");
		expect(cancelledWith).toBe("client gone");
	});

	test("cancel after the peek consumed the upstream to its end resolves", async () => {
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse("ping", { type: "ping" })));
				controller.close();
			},
		});
		const peeked = await peekSseModel(source, anthropicMessageStartModel);
		expect(peeked.model).toBeNull();
		await expect(peeked.body.cancel("client gone")).resolves.toBeUndefined();
	});
});

describe("chat completions report a substituted model (SB23-2781)", () => {
	test("JSON: the header and the body both name the answering model", async () => {
		const resp = await chat(proxyAnswering("gpt-5.6-sol"), "claude-opus-5-5");
		expect(resp.status).toBe(200);
		expect(resp.headers.get(MODEL_SUBSTITUTED_HEADER)).toBe(
			"claude-opus-5-5 -> gpt-5.6-sol",
		);
		const body = (await resp.json()) as { model: string };
		expect(body.model).toBe("gpt-5.6-sol");
	});

	test("JSON: a dated snapshot of the requested model sets no header", async () => {
		const resp = await chat(
			proxyAnswering("claude-opus-5-5-20260901"),
			"claude-opus-5-5",
		);
		expect(resp.status).toBe(200);
		expect(resp.headers.has(MODEL_SUBSTITUTED_HEADER)).toBe(false);
	});

	test("stream: the header is on the response before any chunk is read", async () => {
		const resp = await chat(
			proxyAnswering("gpt-5.6-sol"),
			"claude-opus-5-5",
			true,
		);
		expect(resp.status).toBe(200);
		expect(resp.headers.get(MODEL_SUBSTITUTED_HEADER)).toBe(
			"claude-opus-5-5 -> gpt-5.6-sol",
		);
		const text = await resp.text();
		expect(text).toContain('"model":"gpt-5.6-sol"');
		expect(text).toContain('"content":"Hello"');
		expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
	});

	test("stream: the requested model answering sets no header", async () => {
		const resp = await chat(
			proxyAnswering("claude-opus-5-5"),
			"claude-opus-5-5",
			true,
		);
		expect(resp.headers.has(MODEL_SUBSTITUTED_HEADER)).toBe(false);
		expect(await resp.text()).toContain('"content":"Hello"');
	});

	test("stream replayed from a JSON answer carries the header too", async () => {
		const resp = await chat(
			proxyAnswering("gpt-5.6-sol", { jsonForStream: true }),
			"claude-opus-5-5",
			true,
		);
		expect(resp.headers.get(MODEL_SUBSTITUTED_HEADER)).toBe(
			"claude-opus-5-5 -> gpt-5.6-sol",
		);
		expect(resp.headers.get("content-type")).toContain("text/event-stream");
	});

	test("a gateway model-set entry answered by its own upstream id sets no header", async () => {
		const resp = await dispatch(
			"/v1/gateways/gpt/chat/completions",
			proxyAnswering("gpt-5.6-terra"),
			{ model: "standard", messages: [{ role: "user", content: "Hi" }] },
		);
		expect(resp.status).toBe(200);
		expect(resp.headers.has(MODEL_SUBSTITUTED_HEADER)).toBe(false);
	});

	test("a gateway model-set entry answered by another model names the client's id", async () => {
		const resp = await dispatch(
			"/v1/gateways/gpt/chat/completions",
			proxyAnswering("claude-sonnet-4-5"),
			{ model: "standard", messages: [{ role: "user", content: "Hi" }] },
		);
		expect(resp.headers.get(MODEL_SUBSTITUTED_HEADER)).toBe(
			"standard -> claude-sonnet-4-5",
		);
	});
});

describe("gateway responses report a substituted model (SB23-2781)", () => {
	const body = (model: string, stream = false) => ({
		model,
		input: "Hi",
		stream,
	});

	test("translated JSON", async () => {
		const resp = await dispatch(
			"/v1/gateways/open/responses",
			proxyAnswering("claude-sonnet-4-5"),
			body("gpt-5.5"),
		);
		expect(resp.status).toBe(200);
		expect(resp.headers.get(MODEL_SUBSTITUTED_HEADER)).toBe(
			"gpt-5.5 -> claude-sonnet-4-5",
		);
	});

	test("a model-set entry answered by its own upstream id sets no header", async () => {
		const resp = await dispatch(
			"/v1/gateways/gpt/responses",
			proxyAnswering("gpt-5.6-terra"),
			body("standard"),
		);
		expect(resp.status).toBe(200);
		expect(resp.headers.has(MODEL_SUBSTITUTED_HEADER)).toBe(false);
	});

	test("translated stream", async () => {
		const resp = await dispatch(
			"/v1/gateways/open/responses",
			proxyAnswering("claude-sonnet-4-5"),
			body("gpt-5.5", true),
		);
		expect(resp.status).toBe(200);
		expect(resp.headers.get(MODEL_SUBSTITUTED_HEADER)).toBe(
			"gpt-5.5 -> claude-sonnet-4-5",
		);
		expect(await resp.text()).toContain("response.completed");
	});

	test("native passthrough JSON and stream", async () => {
		const native = {
			id: "resp_1",
			object: "response",
			model: "gpt-5.6-sol",
			output: [],
			status: "completed",
		};
		const nativeProxy =
			(stream: boolean): HandleProxyFn =>
			async () =>
				stream
					? new Response(
							chunked(
								sse("response.created", {
									type: "response.created",
									response: native,
								}) +
									sse("response.completed", {
										type: "response.completed",
										response: native,
									}),
								9,
							),
							{
								status: 200,
								headers: {
									"content-type": "text/event-stream",
									"x-better-ccflare-codex-response-format": "responses-api",
								},
							},
						)
					: new Response(JSON.stringify(native), {
							status: 200,
							headers: {
								"content-type": "application/json",
								"x-better-ccflare-codex-response-format": "responses-api",
							},
						});

		const json = await dispatch(
			"/v1/gateways/open/responses",
			nativeProxy(false),
			body("gpt-5.5"),
		);
		expect(json.headers.get(MODEL_SUBSTITUTED_HEADER)).toBe(
			"gpt-5.5 -> gpt-5.6-sol",
		);

		const stream = await dispatch(
			"/v1/gateways/open/responses",
			nativeProxy(true),
			body("gpt-5.5", true),
		);
		expect(stream.headers.get(MODEL_SUBSTITUTED_HEADER)).toBe(
			"gpt-5.5 -> gpt-5.6-sol",
		);
		expect(await stream.text()).toContain("response.completed");
	});

	test("plain /v1/responses carries no header: its body is aliased to the client's name upstream of the handler", async () => {
		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body("gpt-5.5")),
		});
		const resp = await handleResponsesRequest(
			req,
			new URL(req.url),
			proxyAnswering("claude-sonnet-4-5"),
			{},
		);
		expect(resp.status).toBe(200);
		expect(resp.headers.has(MODEL_SUBSTITUTED_HEADER)).toBe(false);
	});
});
