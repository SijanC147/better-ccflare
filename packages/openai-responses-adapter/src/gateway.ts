import {
	GATEWAY_COMBO_HEADER,
	GATEWAY_INTERNAL_HEADERS,
	GATEWAY_REQUIRE_MODEL_HEADER,
	INBOUND_FORMAT_HEADER,
	INBOUND_GATEWAY_HEADER,
	type InboundFormat,
	type OpenAIGatewayModelEntry,
} from "@better-ccflare/types";

/**
 * What a named gateway imposes on one request. Shared by the Chat Completions
 * and Responses handlers, which both serve under `/v1/gateways/<name>`.
 */
export interface OpenAIGatewayOptions {
	/** The gateway's name, recorded on the request's history row. */
	name?: string;
	/**
	 * Providers this request never routes to, in the vocabulary of
	 * `x-better-ccflare-exclude-providers` (account-selector.ts), which
	 * request-handler.ts strips before anything goes upstream.
	 */
	excludeProviders?: string[];
	/**
	 * The gateway's model set. When present, a request must name one of these
	 * entries; the entry decides the upstream model and, through its combo,
	 * the fallback ladder.
	 */
	models?: OpenAIGatewayModelEntry[];
}

export const EXCLUDE_PROVIDERS_HEADER = "x-better-ccflare-exclude-providers";
export const FORCED_ACCOUNT_HEADER = "x-better-ccflare-account-id";

/** The ids a gateway model set exposes, for an error message. */
function modelSetNames(models: OpenAIGatewayModelEntry[]): string {
	return models.map((entry) => entry.name).join(", ");
}

/** The refusal for a model outside a gateway's set, in the OpenAI shape. */
function modelNotServed(
	requested: string,
	models: OpenAIGatewayModelEntry[],
): Response {
	return new Response(
		JSON.stringify({
			error: {
				message: `The model "${requested}" is not served by this gateway. Use one of: ${modelSetNames(models)}.`,
				type: "invalid_request_error",
				param: "model",
				code: "model_not_found",
			},
		}),
		{ status: 404, headers: { "content-type": "application/json" } },
	);
}

export type GatewayModelResolution =
	| { refusal: Response }
	/** `entry` is null when the gateway has no model set. */
	| { entry: OpenAIGatewayModelEntry | null };

/**
 * Resolves the client's model against a gateway's model set and sets the
 * internal routing headers from the entry alone. Both headers are removed
 * first on every path, so a client can neither pick a ladder nor lift the
 * model filter by sending them itself. Refuses when the gateway has a model
 * set and the request names none of it. The caller rewrites the body's model
 * to `entry.model`; the shape of that body differs between the two APIs.
 */
export function resolveGatewayModel(
	requestedModel: unknown,
	headers: Headers,
	options: OpenAIGatewayOptions | undefined,
): GatewayModelResolution {
	headers.delete(GATEWAY_COMBO_HEADER);
	headers.delete(GATEWAY_REQUIRE_MODEL_HEADER);
	const models = options?.models;
	if (!models) return { entry: null };
	const requested = typeof requestedModel === "string" ? requestedModel : "";
	const entry = models.find((candidate) => candidate.name === requested);
	if (!entry) return { refusal: modelNotServed(requested, models) };
	if (entry.combo) {
		headers.set(GATEWAY_COMBO_HEADER, entry.combo);
	} else {
		headers.set(GATEWAY_REQUIRE_MODEL_HEADER, "1");
	}
	// A forced account would route around the entry's ladder and filter.
	headers.delete(FORCED_ACCOUNT_HEADER);
	return { entry };
}

/**
 * Sets the exclusion header from the gateway's rules plus any the handler
 * always applies, and otherwise removes it, so a client cannot widen or
 * narrow a gateway's rules by sending the header itself.
 */
export function applyGatewayExclusions(
	headers: Headers,
	options: OpenAIGatewayOptions | undefined,
	always: readonly string[] = [],
): void {
	const own = options?.excludeProviders ?? [];
	const excluded = [...new Set([...always, ...own])];
	if (excluded.length > 0) {
		headers.set(EXCLUDE_PROVIDERS_HEADER, excluded.join(","));
	} else {
		headers.delete(EXCLUDE_PROVIDERS_HEADER);
	}
	if (own.length > 0) {
		// account-selector.ts returns a forced account before it reads the
		// exclusions, so a forced id would route around the gateway's rules.
		// Only a gateway with rules of its own drops it; on a gateway without
		// them it stays the documented test-routing header.
		headers.delete(FORCED_ACCOUNT_HEADER);
	}
}

/**
 * Labels a synthetic request with the API it arrived on and the gateway it
 * came through, for its history row (SB23-2727). Both values come from the
 * handler alone: any copy already on the headers is removed first, and the
 * server drops a client's copy before routing.
 */
export function setInboundMarker(
	headers: Headers,
	format: InboundFormat,
	options: OpenAIGatewayOptions | undefined,
): void {
	headers.set(INBOUND_FORMAT_HEADER, format);
	headers.delete(INBOUND_GATEWAY_HEADER);
	if (options?.name) headers.set(INBOUND_GATEWAY_HEADER, options.name);
}

/**
 * The client request with every internal gateway header removed, or the same
 * request when it carries none. Only the gateway and translation handlers may
 * set these, on their own synthetic request, so the server applies this to
 * every inbound request before any path reads it: a direct `/v1/messages`
 * request then cannot pick a ladder, lift the model filter (SB23-3389 review,
 * finding 1) or label its own history row as OpenAI traffic (SB23-2727).
 */
export function dropClientGatewayHeaders(req: Request): Request {
	if (!GATEWAY_INTERNAL_HEADERS.some((name) => req.headers.has(name))) {
		return req;
	}
	const headers = new Headers(req.headers);
	for (const name of GATEWAY_INTERNAL_HEADERS) headers.delete(name);
	return new Request(req, { headers });
}
