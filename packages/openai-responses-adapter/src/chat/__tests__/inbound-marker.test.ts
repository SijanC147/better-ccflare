import { describe, expect, test } from "bun:test";
import {
	GATEWAY_INTERNAL_HEADERS,
	INBOUND_FORMAT_HEADER,
	INBOUND_GATEWAY_HEADER,
	matchOpenAIGatewayPath,
	type OpenAIGateways,
} from "@better-ccflare/types";
import { dropClientGatewayHeaders } from "../../gateway";
import { dispatchOpenAIGatewayRequest } from "../../gateway-dispatch";
import { handleResponsesRequest } from "../../handler";
import type { HandleProxyFn } from "../../types";
import { handleChatCompletionsRequest } from "../handler";

// SB23-2727. Every translated request is labelled with the API it arrived on
// and the gateway it came through, for its history row, whatever the client
// sent in those headers. handleProxy is stubbed, so nothing leaves the process.

const ANTHROPIC_MESSAGE = {
	id: "msg_1",
	type: "message",
	role: "assistant",
	model: "claude-sonnet-5",
	content: [{ type: "text", text: "Hello" }],
	stop_reason: "end_turn",
	stop_sequence: null,
	usage: { input_tokens: 3, output_tokens: 1 },
};

const GATEWAYS: OpenAIGateways = { work: {} };

function stubProxy(): [HandleProxyFn, { req?: Request }] {
	const captured: { req?: Request } = {};
	const fn: HandleProxyFn = async (req) => {
		captured.req = req;
		return Response.json(ANTHROPIC_MESSAGE);
	};
	return [fn, captured];
}

/** A client trying to label its own request; the handler must overwrite it. */
const FORGED = {
	[INBOUND_FORMAT_HEADER]: "openai-responses",
	[INBOUND_GATEWAY_HEADER]: "someone-else",
};

function post(path: string, body: unknown): Request {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...FORGED },
		body: JSON.stringify(body),
	});
}

const chatBody = {
	model: "claude-sonnet-5",
	messages: [{ role: "user", content: "Hi" }],
};
const responsesBody = { model: "claude-sonnet-5", input: "Hi" };

function marker(req: Request | undefined) {
	return {
		format: req?.headers.get(INBOUND_FORMAT_HEADER) ?? null,
		gateway: req?.headers.get(INBOUND_GATEWAY_HEADER) ?? null,
	};
}

async function viaGateway(rest: string, body: unknown) {
	const [proxy, captured] = stubProxy();
	const req = post(`/v1/gateways/work${rest}`, body);
	const url = new URL(req.url);
	const match = matchOpenAIGatewayPath(url.pathname);
	if (!match) throw new Error("no gateway match");
	const resp = await dispatchOpenAIGatewayRequest(
		req,
		url,
		match,
		GATEWAYS,
		proxy,
		{},
	);
	expect(resp.status).toBe(200);
	return marker(captured.req);
}

describe("inbound marker on the synthetic request", () => {
	test("plain /v1/chat/completions: openai-chat, no gateway", async () => {
		const [proxy, captured] = stubProxy();
		const req = post("/v1/chat/completions", chatBody);
		const resp = await handleChatCompletionsRequest(
			req,
			new URL(req.url),
			proxy,
			{},
		);
		expect(resp.status).toBe(200);
		expect(marker(captured.req)).toEqual({
			format: "openai-chat",
			gateway: null,
		});
	});

	test("plain /v1/responses: openai-responses, no gateway", async () => {
		const [proxy, captured] = stubProxy();
		const req = post("/v1/responses", responsesBody);
		const resp = await handleResponsesRequest(req, new URL(req.url), proxy, {});
		expect(resp.status).toBe(200);
		expect(marker(captured.req)).toEqual({
			format: "openai-responses",
			gateway: null,
		});
	});

	test("gateway /chat/completions: openai-chat and the gateway name", async () => {
		expect(await viaGateway("/chat/completions", chatBody)).toEqual({
			format: "openai-chat",
			gateway: "work",
		});
	});

	test("gateway /responses: openai-responses and the gateway name", async () => {
		expect(await viaGateway("/responses", responsesBody)).toEqual({
			format: "openai-responses",
			gateway: "work",
		});
	});
});

describe("dropClientGatewayHeaders", () => {
	test("removes every internal gateway header a client sent", () => {
		const req = new Request("http://localhost/v1/messages", {
			method: "POST",
			headers: {
				...FORGED,
				"x-better-ccflare-gateway-combo": "GptStandard",
				"x-better-ccflare-gateway-require-model": "1",
				authorization: "Bearer token",
			},
		});
		const cleaned = dropClientGatewayHeaders(req);
		for (const name of GATEWAY_INTERNAL_HEADERS) {
			expect(cleaned.headers.get(name)).toBeNull();
		}
		expect(cleaned.headers.get("authorization")).toBe("Bearer token");
	});

	test("returns the same request when there is nothing to drop", () => {
		const req = new Request("http://localhost/v1/messages");
		expect(dropClientGatewayHeaders(req)).toBe(req);
	});
});
