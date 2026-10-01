import type { OpenAIGateways } from "@better-ccflare/types";
import {
	handleChatCompletionsRequest,
	handleOpenAIModelsRequest,
	jsonResponse,
} from "./chat/handler";
import { handleCompletionsRequest } from "./completions/handler";
import type { OpenAIGatewayOptions } from "./gateway";
import { handleResponsesRequest } from "./handler";
import type { HandleProxyFn } from "./types";

// The dispatcher lives apart from chat/handler.ts so the completions handler,
// which runs the chat core, and the chat handler do not import each other.

function notFound(message: string, code: string): Response {
	return jsonResponse(404, {
		error: { message, type: "invalid_request_error", param: null, code },
	});
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
		name: match.name,
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
	if (req.method === "POST" && match.rest === "/completions") {
		return handleCompletionsRequest(
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
		`${req.method} ${match.rest || "/"} is not served by gateway "${match.name}". Use POST /chat/completions, POST /completions, POST /responses, POST /responses/compact or GET /models.`,
		"unknown_endpoint",
	);
}
