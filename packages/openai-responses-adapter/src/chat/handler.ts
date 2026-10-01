import crypto from "node:crypto";
import { Logger } from "@better-ccflare/logger";
import {
	type OpenAIGateways,
	REPORT_UPSTREAM_MODEL_HEADER,
	UPSTREAM_CONTENT_TYPE_HEADER,
} from "@better-ccflare/types";
import {
	applyGatewayExclusions,
	type OpenAIGatewayOptions,
	resolveGatewayModel,
} from "../gateway";
import { handleResponsesRequest } from "../handler";
import type { HandleProxyFn } from "../types";
import { translateChatRequestToAnthropic } from "./request-translator";
import {
	toOpenAIError,
	translateAnthropicMessageToChat,
} from "./response-translator";
import { translateAnthropicStreamToChat } from "./stream-translator";
import type {
	AnthropicMessageResponse,
	ChatCompletion,
	ChatCompletionChunk,
	ChatCompletionRequest,
	ResponseTranslationContext,
} from "./types";

const log = new Logger("openai-chat-gateway");

const JSON_HEADERS = { "content-type": "application/json" };
const SSE_HEADERS = {
	"content-type": "text/event-stream; charset=utf-8",
	"cache-control": "no-cache",
	connection: "keep-alive",
};

function jsonResponse(
	status: number,
	body: unknown,
	extraHeaders?: Record<string, string>,
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...JSON_HEADERS, ...extraHeaders },
	});
}

function invalidRequest(status: number, message: string): Response {
	return jsonResponse(status, {
		error: {
			message,
			type: "invalid_request_error",
			param: null,
			code: null,
		},
	});
}

/**
 * Status carried by a throw from `handleProxy`, read the way the server's own
 * catch reads it. Pool exhaustion arrives this way (`ServiceUnavailableError`,
 * 503), and the server's catch would answer it in the Anthropic shape, which
 * an OpenAI client cannot parse (SB23-2570).
 */
function statusOfThrow(err: unknown): number {
	return typeof err === "object" &&
		err !== null &&
		"statusCode" in err &&
		typeof (err as { statusCode: unknown }).statusCode === "number"
		? (err as { statusCode: number }).statusCode
		: 500;
}

/**
 * Applies a gateway model set to a Chat Completions body: the shared resolver
 * sets the routing headers, and the body's model becomes the entry's upstream
 * id. Returns a refusal when the gateway has a model set and the request names
 * none of it.
 */
function applyModelSet(
	body: ChatCompletionRequest,
	headers: Headers,
	options: OpenAIGatewayOptions | undefined,
): Response | null {
	const resolved = resolveGatewayModel(body.model, headers, options);
	if ("refusal" in resolved) return resolved.refusal;
	if (resolved.entry) body.model = resolved.entry.model;
	return null;
}

/** A throw from `handleProxy`, answered in the OpenAI shape. */
function thrownAsOpenAIError(err: unknown): Response {
	const status = statusOfThrow(err);
	const message =
		status === 503
			? "Service temporarily unavailable. Please try again later."
			: "Proxy request failed";
	return jsonResponse(
		status,
		toOpenAIError(status, {
			type: "error",
			error: {
				type: status === 503 ? "service_unavailable_error" : "proxy_error",
				message,
			},
		}),
	);
}

/** A non-ok `handleProxy` answer: same status, OpenAI shape, retry-after kept. */
async function upstreamAsOpenAIError(upstream: Response): Promise<Response> {
	const text = await upstream.text().catch(() => "");
	let parsed: unknown = text;
	try {
		parsed = JSON.parse(text);
	} catch {
		// Not JSON; pass the text through.
	}
	const kept: Record<string, string> = {};
	const retryAfter = upstream.headers.get("retry-after");
	if (retryAfter) kept["retry-after"] = retryAfter;
	// Set by handleProxy when it wrapped an upstream error page (SB23-3494).
	const upstreamType = upstream.headers.get(UPSTREAM_CONTENT_TYPE_HEADER);
	if (upstreamType) kept[UPSTREAM_CONTENT_TYPE_HEADER] = upstreamType;
	return jsonResponse(
		upstream.status,
		toOpenAIError(upstream.status, parsed),
		Object.keys(kept).length > 0 ? kept : undefined,
	);
}

function sseEvent(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Replays a complete, non-streaming completion as a chunk stream. Used when
 * the client asked to stream and the upstream answered JSON anyway.
 */
function completionAsStream(
	completion: ChatCompletion,
	includeUsage: boolean,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const choice = completion.choices[0];
	const message = choice?.message;
	const usageField = includeUsage ? { usage: null } : {};
	const chunk = (
		delta: ChatCompletionChunk["choices"][0]["delta"],
		finishReason: ChatCompletionChunk["choices"][0]["finish_reason"] = null,
	): ChatCompletionChunk => ({
		id: completion.id,
		object: "chat.completion.chunk",
		created: completion.created,
		model: completion.model,
		choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
		...usageField,
	});

	const events: string[] = [
		sseEvent(chunk({ role: "assistant", content: "" })),
	];
	if (message?.reasoning_content) {
		events.push(
			sseEvent(chunk({ reasoning_content: message.reasoning_content })),
		);
	}
	if (message?.content) {
		events.push(sseEvent(chunk({ content: message.content })));
	}
	for (const [index, call] of (message?.tool_calls ?? []).entries()) {
		events.push(
			sseEvent(
				chunk({
					tool_calls: [
						{
							index,
							id: call.id,
							type: "function",
							function: {
								name: call.function.name,
								arguments: call.function.arguments,
							},
						},
					],
				}),
			),
		);
	}
	events.push(sseEvent(chunk({}, choice?.finish_reason ?? "stop")));
	if (includeUsage) {
		const usageChunk: ChatCompletionChunk = {
			id: completion.id,
			object: "chat.completion.chunk",
			created: completion.created,
			model: completion.model,
			choices: [],
			usage: completion.usage,
		};
		events.push(sseEvent(usageChunk));
	}
	events.push("data: [DONE]\n\n");

	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) controller.enqueue(encoder.encode(event));
			controller.close();
		},
	});
}

/**
 * True for the default gateway's one route. The server intercepts this before
 * its `handleProxy` fallthrough; without the intercept the path reaches the
 * SB23-2570 refusal instead of the gateway.
 */
export function isOpenAIChatCompletionsRequest(
	method: string,
	pathname: string,
): boolean {
	return method === "POST" && pathname === "/v1/chat/completions";
}

/**
 * Inbound OpenAI Chat Completions gateway (SB23-2720). Translates the request
 * to Anthropic Messages, runs it through `handleProxy` as a synthetic
 * `POST /v1/messages` so combos, failover and every provider in the pool
 * apply, and translates the answer back. Every error leaves in the OpenAI
 * shape, including a throw from `handleProxy`.
 */
export async function handleChatCompletionsRequest(
	req: Request,
	url: URL,
	handleProxy: HandleProxyFn,
	ctx: unknown,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
	options?: OpenAIGatewayOptions,
): Promise<Response> {
	// 1. Parse the body.
	let body: ChatCompletionRequest;
	try {
		const parsed: unknown = await req.json();
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			Array.isArray(parsed)
		) {
			return invalidRequest(400, "Request body must be a JSON object.");
		}
		body = parsed as ChatCompletionRequest;
	} catch {
		return invalidRequest(400, "Request body is not valid JSON.");
	}

	// 2. Resolve the gateway's model set, then translate, or refuse before
	// anything is sent upstream. The client's name is kept for the response
	// id; the answering model is reported separately (SB23-2781).
	const requestedModel = typeof body.model === "string" ? body.model : null;
	const syntheticHeaders = new Headers(req.headers);
	const modelSetRefusal = applyModelSet(body, syntheticHeaders, options);
	if (modelSetRefusal) return modelSetRefusal;
	const translated = translateChatRequestToAnthropic(body);
	if (!translated.ok) {
		const { status, message, type, param, code } = translated.error;
		return jsonResponse(status, { error: { message, type, param, code } });
	}
	const anthropicBody = translated.body;
	const wantsStream = body.stream === true;

	// 3. Build the synthetic request. Header handling follows the Responses
	// adapter: keep the client's headers (auth, session and routing hints),
	// drop the length and encoding of the body we replaced, and supply what
	// the Messages API requires. The Responses adapter's Codex-only headers
	// and its anthropic-oauth exclusion are deliberately not copied.
	const messagesUrl = new URL(url.toString());
	messagesUrl.pathname = "/v1/messages";
	syntheticHeaders.set("content-type", "application/json");
	syntheticHeaders.delete("content-length");
	syntheticHeaders.delete("content-encoding");
	if (!syntheticHeaders.has("anthropic-version")) {
		syntheticHeaders.set("anthropic-version", "2023-06-01");
	}
	applyGatewayExclusions(syntheticHeaders, options);
	// Report the model that answered, not the requested name (SB23-2781).
	syntheticHeaders.set(REPORT_UPSTREAM_MODEL_HEADER, "1");
	const syntheticReq = new Request(messagesUrl.toString(), {
		method: "POST",
		headers: syntheticHeaders,
		body: JSON.stringify(anthropicBody),
		// Keep the client's disconnect wired to the upstream call.
		signal: req.signal,
	});

	const translationCtx: ResponseTranslationContext = {
		id: `chatcmpl-${crypto.randomBytes(12).toString("hex")}`,
		created: Math.floor(Date.now() / 1000),
		model: requestedModel ?? anthropicBody.model,
	};
	const includeUsage = body.stream_options?.include_usage === true;

	// 4. Forward. A throw is how pool exhaustion arrives.
	log.info(`Forwarding chat completions request to ${messagesUrl.pathname}`);
	let upstream: Response;
	try {
		upstream = await handleProxy(
			syntheticReq,
			messagesUrl,
			ctx,
			apiKeyId,
			apiKeyName,
		);
	} catch (err) {
		log.error("Chat completions proxy request failed:", err);
		return thrownAsOpenAIError(err);
	}

	// 5. Upstream error: same status, OpenAI shape, retry-after kept.
	if (!upstream.ok) return upstreamAsOpenAIError(upstream);

	const upstreamType = upstream.headers.get("content-type") ?? "";

	// 6. Streaming.
	if (wantsStream) {
		if (upstreamType.includes("text/event-stream") && upstream.body) {
			return new Response(
				translateAnthropicStreamToChat(upstream.body, {
					...translationCtx,
					includeUsage,
				}),
				{ status: 200, headers: SSE_HEADERS },
			);
		}
		const message = await readAnthropicMessage(upstream);
		if (message instanceof Response) return message;
		return new Response(
			completionAsStream(
				translateAnthropicMessageToChat(message, translationCtx),
				includeUsage,
			),
			{ status: 200, headers: SSE_HEADERS },
		);
	}

	// 7. Non-streaming.
	const message = await readAnthropicMessage(upstream);
	if (message instanceof Response) return message;
	return jsonResponse(
		200,
		translateAnthropicMessageToChat(message, translationCtx),
	);
}

async function readAnthropicMessage(
	upstream: Response,
): Promise<AnthropicMessageResponse | Response> {
	const text = await upstream.text();
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed !== null && typeof parsed === "object") {
			return parsed as AnthropicMessageResponse;
		}
	} catch {
		// Fall through to the 502 below.
	}
	log.error("Upstream answered 200 with a body that is not a message");
	return jsonResponse(
		502,
		toOpenAIError(502, {
			type: "error",
			error: {
				type: "api_error",
				message: "Upstream returned an unparseable response.",
			},
		}),
	);
}

/**
 * `GET <gateway>/models`: a synthetic `GET /v1/models` carrying the gateway's
 * exclusions, answered by `handleProxy`. Errors leave in the OpenAI shape.
 */
export async function handleOpenAIModelsRequest(
	req: Request,
	url: URL,
	handleProxy: HandleProxyFn,
	ctx: unknown,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
	options?: OpenAIGatewayOptions,
): Promise<Response> {
	// A gateway with a model set lists exactly that set, whatever the pool
	// holds, so a client's model picker shows what the gateway will accept.
	if (options?.models) {
		const created = Math.floor(Date.now() / 1000);
		return jsonResponse(200, {
			object: "list",
			data: options.models.map((entry) => ({
				id: entry.name,
				object: "model",
				created,
				owned_by: "better-ccflare",
			})),
		});
	}
	const modelsUrl = new URL(url.toString());
	modelsUrl.pathname = "/v1/models";
	const syntheticHeaders = new Headers(req.headers);
	syntheticHeaders.delete("content-length");
	syntheticHeaders.delete("content-encoding");
	applyGatewayExclusions(syntheticHeaders, options);
	const syntheticReq = new Request(modelsUrl.toString(), {
		method: "GET",
		headers: syntheticHeaders,
		signal: req.signal,
	});

	let upstream: Response;
	try {
		upstream = await handleProxy(
			syntheticReq,
			modelsUrl,
			ctx,
			apiKeyId,
			apiKeyName,
		);
	} catch (err) {
		log.error("Models proxy request failed:", err);
		return thrownAsOpenAIError(err);
	}
	if (!upstream.ok) return upstreamAsOpenAIError(upstream);
	return upstream;
}

function notFound(message: string, code: string): Response {
	return jsonResponse(404, {
		error: { message, type: "invalid_request_error", param: null, code },
	});
}

/**
 * True for every path under the gateway prefix, including ones whose name
 * fails validation. The server answers all of them in the gateway branch:
 * letting an invalid name such as `Work` fall through to `handleProxy` would
 * route it with normal selection and none of the gateway's exclusions.
 */
export function isOpenAIGatewayPath(pathname: string): boolean {
	return pathname === "/v1/gateways" || pathname.startsWith("/v1/gateways/");
}

/**
 * Serves a path for which `isOpenAIGatewayPath` is true, given what
 * `matchOpenAIGatewayPath` made of it. A null match (an invalid or empty name)
 * is a 404 and never reaches `handleProxy`. Pure over its inputs so the
 * routing is testable without the server.
 */
export async function dispatchOpenAIGatewayRequest(
	req: Request,
	url: URL,
	match: { name: string; rest: string } | null,
	gateways: OpenAIGateways,
	handleProxy: HandleProxyFn,
	ctx: unknown,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
): Promise<Response> {
	if (!match) {
		return notFound(
			"Gateway names are lowercase letters, digits, - and _, starting with a letter or digit.",
			"gateway_not_found",
		);
	}
	const gateway = Object.hasOwn(gateways, match.name)
		? gateways[match.name]
		: undefined;
	if (!gateway) {
		return notFound(
			`No OpenAI gateway named "${match.name}" is configured.`,
			"gateway_not_found",
		);
	}
	const options: OpenAIGatewayOptions = {
		excludeProviders: gateway.exclude_providers ?? [],
		models: gateway.models,
	};
	const isResponsesPath =
		match.rest === "/responses" || match.rest === "/responses/compact";
	// Codex tries WebSocket transport first. Refused exactly as on the plain
	// /v1/responses path (server.ts), so the client falls back to HTTPS.
	if (
		isResponsesPath &&
		req.headers.get("upgrade")?.toLowerCase() === "websocket"
	) {
		return jsonResponse(503, {
			type: "error",
			error: {
				type: "not_supported_error",
				message:
					"WebSocket transport is not supported. Codex will retry over HTTPS automatically.",
			},
		});
	}
	// The Responses API, which is all Codex speaks (SB23-3469). Compact is
	// served by the same handler, as on the plain path.
	if (req.method === "POST" && isResponsesPath) {
		return handleResponsesRequest(
			req,
			url,
			handleProxy,
			ctx,
			apiKeyId,
			apiKeyName,
			options,
		);
	}
	if (req.method === "POST" && match.rest === "/chat/completions") {
		return handleChatCompletionsRequest(
			req,
			url,
			handleProxy,
			ctx,
			apiKeyId,
			apiKeyName,
			options,
		);
	}
	if (req.method === "GET" && match.rest === "/models") {
		return handleOpenAIModelsRequest(
			req,
			url,
			handleProxy,
			ctx,
			apiKeyId,
			apiKeyName,
			options,
		);
	}
	return notFound(
		`${req.method} ${match.rest || "/"} is not served by gateway "${match.name}". Use POST /chat/completions, POST /responses, POST /responses/compact or GET /models.`,
		"unknown_endpoint",
	);
}
