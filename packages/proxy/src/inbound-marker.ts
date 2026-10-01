/**
 * The OpenAI-shaped API and named gateway a translated request arrived
 * through (SB23-2727).
 *
 * The Chat Completions and Responses handlers in
 * `@better-ccflare/openai-responses-adapter` turn every request into a
 * synthetic `POST /v1/messages`, so the history row's path cannot tell that
 * traffic from Claude Code's. The handlers label their synthetic request with
 * `INBOUND_FORMAT_HEADER` and, under a named gateway, `INBOUND_GATEWAY_HEADER`.
 * The server drops a client's copy of both before routing, and
 * `stripInternalControlHeaders` removes them before anything goes upstream.
 *
 * Read from the request's own header map, which `sanitizeRequestHeaders`
 * leaves intact. The storage redaction that turns every `x-better-ccflare-*`
 * value into `[redacted]` runs later, on the payload copy only.
 *
 * Every path that persists a request row carries the marker: the usage
 * collector from the `StartMessage` header map, and the direct `saveRequest`
 * audit sites in `proxy-operations.ts` from `req.headers`, the same two routes
 * the gateway hint headers take (see gateway-hint-headers.ts).
 */
import {
	INBOUND_FORMAT_HEADER,
	INBOUND_GATEWAY_HEADER,
	type InboundFormat,
	isInboundFormat,
	isValidOpenAIGatewayName,
} from "@better-ccflare/types";
import type { HeaderGetter } from "./gateway-hint-headers";

export interface InboundMarker {
	format: InboundFormat | null;
	/** Null for the plain `/v1/chat/completions` and `/v1/responses`. */
	gateway: string | null;
}

/**
 * A value that is not a known format or a valid gateway name records null:
 * the server already dropped any client copy, so an unexpected value means a
 * bug rather than input, and a row must never claim a format it did not have.
 */
export function extractInboundMarker(getHeader: HeaderGetter): InboundMarker {
	const format = getHeader(INBOUND_FORMAT_HEADER)?.trim();
	if (!isInboundFormat(format)) return { format: null, gateway: null };
	const gateway = getHeader(INBOUND_GATEWAY_HEADER)?.trim();
	return {
		format,
		gateway: isValidOpenAIGatewayName(gateway) ? gateway : null,
	};
}

/** For a real `Headers` instance (the proxy request path). */
export function extractInboundMarkerFromRequest(
	headers: Headers,
): InboundMarker {
	return extractInboundMarker((name) => headers.get(name));
}

/** For the usage collector's `StartMessage` header record. */
export function extractInboundMarkerFromParts(
	requestHeaders: Record<string, string> | null | undefined,
): InboundMarker {
	const headerMap: Record<string, string> = {};
	if (requestHeaders) {
		for (const [key, value] of Object.entries(requestHeaders)) {
			headerMap[key.toLowerCase()] = value;
		}
	}
	return extractInboundMarker((name) => headerMap[name.toLowerCase()]);
}
