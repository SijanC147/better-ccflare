import { describe, expect, test } from "bun:test";
import { LATEST_SONNET_MODEL } from "@better-ccflare/core";
import {
	GATEWAY_COMBO_HEADER,
	GATEWAY_REQUIRE_MODEL_HEADER,
	matchOpenAIGatewayAliasPath,
	matchOpenAIGatewayPath,
	type OpenAIGateways,
	REPORT_UPSTREAM_MODEL_HEADER,
} from "@better-ccflare/types";
import { dispatchOpenAIGatewayRequest } from "../../gateway-dispatch";
import { handleResponsesRequest } from "../../handler";
import type { HandleProxyFn } from "../../types";

// SB23-3469: named gateways serve POST /responses and /responses/compact.
// Every test stubs handleProxy, so no request leaves the process.

const EXCLUDE = "x-better-ccflare-exclude-providers";
const FORCED_ACCOUNT = "x-better-ccflare-account-id";
const PASSTHROUGH = "__better_ccflare_codex_passthrough";

/** What the upstream says answered, distinct from every requested id. */
const ANSWERING_MODEL = "gpt-5.5-2026-09-01";

const ANTHROPIC_MESSAGE = {
	id: "msg_1",
	type: "message",
	role: "assistant",
	model: ANSWERING_MODEL,
	content: [{ type: "text", text: "Hello" }],
	stop_reason: "end_turn",
	stop_sequence: null,
	usage: { input_tokens: 3, output_tokens: 1 },
};

function sse(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const ANTHROPIC_STREAM = [
	sse("message_start", {
		type: "message_start",
		message: { ...ANTHROPIC_MESSAGE, content: [], stop_reason: null },
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

const GATEWAYS: OpenAIGateways = {
	gpt: {
		models: [
			{ name: "gpt-5.5", model: "gpt-5.5" },
			{ name: "standard", model: "gpt-5.6-terra", combo: "GptStandard" },
		],
	},
	open: {},
	"no-codex": { exclude_providers: ["codex"] },
};

interface Captured {
	calls: number;
	req?: Request;
	url?: URL;
	body?: Record<string, unknown>;
}

function stubProxy(): [HandleProxyFn, Captured] {
	const captured: Captured = { calls: 0 };
	const fn: HandleProxyFn = async (req, url) => {
		captured.calls++;
		captured.req = req;
		captured.url = url;
		captured.body = (await req.clone().json()) as Record<string, unknown>;
		if (captured.body.stream === true) {
			return new Response(ANTHROPIC_STREAM, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}
		return Response.json(ANTHROPIC_MESSAGE);
	};
	return [fn, captured];
}

async function dispatch(
	path: string,
	proxy: HandleProxyFn,
	body: unknown,
	headers: Record<string, string> = {},
	method = "POST",
): Promise<Response> {
	const req = new Request(`http://localhost${path}`, {
		method,
		headers: { "content-type": "application/json", ...headers },
		body: method === "POST" ? JSON.stringify(body) : null,
	});
	const url = new URL(req.url);
	// server.ts rewrites the short form to the long one before dispatching.
	const alias = matchOpenAIGatewayAliasPath(url.pathname);
	if (alias) url.pathname = `/v1/gateways/${alias.name}${alias.rest}`;
	const match = matchOpenAIGatewayPath(url.pathname);
	if (!match) throw new Error(`no gateway match for ${path}`);
	return dispatchOpenAIGatewayRequest(req, url, match, GATEWAYS, proxy, {});
}

const responsesBody = (model: string, extra: Record<string, unknown> = {}) => ({
	model,
	input: "Hi",
	...extra,
});

function passthrough(captured: Captured): Record<string, unknown> | undefined {
	return captured.body?.[PASSTHROUGH] as Record<string, unknown> | undefined;
}

describe("gateway POST /responses with a model set", () => {
	test("an entry without a combo routes its upstream id with the model filter", async () => {
		const [proxy, captured] = stubProxy();
		const resp = await dispatch(
			"/v1/gateways/gpt/responses",
			proxy,
			responsesBody("gpt-5.5"),
		);
		expect(resp.status).toBe(200);
		expect(captured.calls).toBe(1);
		expect(captured.url?.pathname).toBe("/v1/messages");
		// The entry's id, not the Claude family the translator maps gpt-* to:
		// the selector routes on this field.
		expect(captured.body?.model).toBe("gpt-5.5");
		expect(captured.req?.headers.get(GATEWAY_REQUIRE_MODEL_HEADER)).toBe("1");
		expect(captured.req?.headers.get(GATEWAY_COMBO_HEADER)).toBeNull();
		expect(captured.req?.headers.get(REPORT_UPSTREAM_MODEL_HEADER)).toBe("1");
		expect(captured.req?.headers.get(EXCLUDE)).toBe("anthropic-oauth");
		expect(captured.req?.headers.get("x-better-ccflare-native-responses")).toBe(
			"true",
		);
		// Codex reads the model from body.model, so a slot override applies.
		expect(passthrough(captured)?.model).toBeUndefined();
		expect(passthrough(captured)?.native_input).toBeDefined();
	});

	test("an entry with a combo sends its upstream model and names its ladder", async () => {
		const [proxy, captured] = stubProxy();
		const resp = await dispatch(
			"/v1/gateways/gpt/responses",
			proxy,
			responsesBody("standard"),
		);
		expect(resp.status).toBe(200);
		expect(captured.body?.model).toBe("gpt-5.6-terra");
		expect(captured.req?.headers.get(GATEWAY_COMBO_HEADER)).toBe("GptStandard");
		expect(captured.req?.headers.get(GATEWAY_REQUIRE_MODEL_HEADER)).toBeNull();
		expect(passthrough(captured)?.model).toBeUndefined();
	});

	test("a model outside the set is refused before anything reaches the proxy", async () => {
		const [proxy, captured] = stubProxy();
		const resp = await dispatch(
			"/v1/gateways/gpt/responses",
			proxy,
			responsesBody("claude-opus-5-5"),
		);
		expect(resp.status).toBe(404);
		const body = (await resp.json()) as {
			error: { code: string; message: string; param: string };
		};
		expect(body.error.code).toBe("model_not_found");
		expect(body.error.param).toBe("model");
		expect(body.error.message).toContain("gpt-5.5, standard");
		expect(captured.calls).toBe(0);
	});

	test("a missing model is refused too, not routed on the family default", async () => {
		const [proxy, captured] = stubProxy();
		const resp = await dispatch("/v1/gateways/gpt/responses", proxy, {
			input: "Hi",
		});
		expect(resp.status).toBe(404);
		expect(captured.calls).toBe(0);
	});

	test("a client cannot choose a ladder, lift the filter or force an account", async () => {
		const [proxy, captured] = stubProxy();
		await dispatch(
			"/v1/gateways/gpt/responses",
			proxy,
			responsesBody("gpt-5.5"),
			{
				[GATEWAY_COMBO_HEADER]: "SomeOtherCombo",
				[FORCED_ACCOUNT]: "acct-1",
			},
		);
		expect(captured.req?.headers.get(GATEWAY_COMBO_HEADER)).toBeNull();
		expect(captured.req?.headers.get(GATEWAY_REQUIRE_MODEL_HEADER)).toBe("1");
		expect(captured.req?.headers.get(FORCED_ACCOUNT)).toBeNull();

		const [comboProxy, comboCaptured] = stubProxy();
		await dispatch(
			"/v1/gateways/gpt/responses",
			comboProxy,
			responsesBody("standard"),
			{
				[GATEWAY_COMBO_HEADER]: "SomeOtherCombo",
				[GATEWAY_REQUIRE_MODEL_HEADER]: "1",
			},
		);
		expect(comboCaptured.req?.headers.get(GATEWAY_COMBO_HEADER)).toBe(
			"GptStandard",
		);
		expect(
			comboCaptured.req?.headers.get(GATEWAY_REQUIRE_MODEL_HEADER),
		).toBeNull();
	});

	test("the short form /<name>/v1/responses reaches the same route", async () => {
		const [proxy, captured] = stubProxy();
		const resp = await dispatch(
			"/gpt/v1/responses",
			proxy,
			responsesBody("standard"),
		);
		expect(resp.status).toBe(200);
		expect(captured.body?.model).toBe("gpt-5.6-terra");
		expect(captured.req?.headers.get(GATEWAY_COMBO_HEADER)).toBe("GptStandard");

		const [refusedProxy, refused] = stubProxy();
		const refusal = await dispatch(
			"/gpt/v1/responses",
			refusedProxy,
			responsesBody("gpt-4o"),
		);
		expect(refusal.status).toBe(404);
		expect(refused.calls).toBe(0);
	});

	test("/responses/compact is routed with the model set applied", async () => {
		for (const path of [
			"/v1/gateways/gpt/responses/compact",
			"/gpt/v1/responses/compact",
		]) {
			const [proxy, captured] = stubProxy();
			const resp = await dispatch(path, proxy, responsesBody("standard"));
			expect(resp.status).toBe(200);
			expect(captured.body?.model).toBe("gpt-5.6-terra");
			expect(captured.req?.headers.get(GATEWAY_COMBO_HEADER)).toBe(
				"GptStandard",
			);

			const [refusedProxy, refused] = stubProxy();
			const refusal = await dispatch(
				path,
				refusedProxy,
				responsesBody("not-listed"),
			);
			expect(refusal.status).toBe(404);
			expect(refused.calls).toBe(0);
		}
	});

	test("a non-streaming answer reports the model that answered", async () => {
		const [proxy] = stubProxy();
		const resp = await dispatch(
			"/v1/gateways/gpt/responses",
			proxy,
			responsesBody("gpt-5.5"),
		);
		const body = (await resp.json()) as { object: string; model: string };
		expect(body.object).toBe("response");
		expect(body.model).toBe(ANSWERING_MODEL);
	});

	test("a streamed answer is routed and reports the model that answered", async () => {
		const [proxy, captured] = stubProxy();
		const resp = await dispatch(
			"/v1/gateways/gpt/responses",
			proxy,
			responsesBody("standard", { stream: true }),
		);
		expect(resp.status).toBe(200);
		expect(resp.headers.get("content-type")).toContain("text/event-stream");
		expect(captured.body?.stream).toBe(true);
		expect(captured.body?.model).toBe("gpt-5.6-terra");
		const text = await resp.text();
		const created = text
			.split("\n\n")
			.find((frame) => frame.startsWith("event: response.created"));
		expect(created).toBeDefined();
		const data = JSON.parse(
			(created ?? "")
				.split("\n")
				.find((l) => l.startsWith("data: "))
				?.slice(6) ?? "{}",
		) as { response: { model: string } };
		expect(data.response.model).toBe(ANSWERING_MODEL);
		expect(text).toContain("response.completed");
	});
});

describe("gateway answer label fallback", () => {
	test("an upstream answer naming no model is labelled with the client's name", async () => {
		const { model: _omitted, ...withoutModel } = ANTHROPIC_MESSAGE;
		const proxy: HandleProxyFn = async () => Response.json(withoutModel);
		const resp = await dispatch(
			"/v1/gateways/gpt/responses",
			proxy,
			responsesBody("standard"),
		);
		const body = (await resp.json()) as { model: string };
		// The client's alias, as the chat path reports it, not the entry's id.
		expect(body.model).toBe("standard");
	});

	test("a streamed answer whose message_start names no model is labelled with the client's name", async () => {
		const stream = ANTHROPIC_STREAM.replace(
			`"model":"${ANSWERING_MODEL}",`,
			"",
		);
		expect(stream).not.toContain(ANSWERING_MODEL);
		const proxy: HandleProxyFn = async () =>
			new Response(stream, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		const resp = await dispatch(
			"/v1/gateways/gpt/responses",
			proxy,
			responsesBody("standard", { stream: true }),
		);
		const text = await resp.text();
		const created = text
			.split("\n\n")
			.find((frame) => frame.startsWith("event: response.created"));
		expect(created).toBeDefined();
		const data = JSON.parse(
			(created ?? "")
				.split("\n")
				.find((l) => l.startsWith("data: "))
				?.slice(6) ?? "{}",
		) as { response: { model: string } };
		expect(data.response.model).toBe("standard");
	});
});

describe("gateway POST /responses without a model set", () => {
	test("passes the client's model through and keeps Codex's raw id", async () => {
		const [proxy, captured] = stubProxy();
		const resp = await dispatch(
			"/v1/gateways/open/responses",
			proxy,
			responsesBody("gpt-5.5"),
			{
				[GATEWAY_COMBO_HEADER]: "SomeOtherCombo",
				[GATEWAY_REQUIRE_MODEL_HEADER]: "1",
			},
		);
		expect(resp.status).toBe(200);
		// Unchanged from the plain path: family mapping plus the raw id.
		expect(captured.body?.model).toBe(LATEST_SONNET_MODEL);
		expect(passthrough(captured)?.model).toBe("gpt-5.5");
		expect(captured.req?.headers.get(GATEWAY_COMBO_HEADER)).toBeNull();
		expect(captured.req?.headers.get(GATEWAY_REQUIRE_MODEL_HEADER)).toBeNull();
		expect(captured.req?.headers.get(REPORT_UPSTREAM_MODEL_HEADER)).toBe("1");
	});

	test("the gateway's exclusions join the anthropic-oauth exclusion", async () => {
		const [proxy, captured] = stubProxy();
		await dispatch(
			"/v1/gateways/no-codex/responses",
			proxy,
			responsesBody("gpt-5.5"),
			{ [EXCLUDE]: "", [FORCED_ACCOUNT]: "acct-1" },
		);
		const excluded = captured.req?.headers.get(EXCLUDE)?.split(",") ?? [];
		expect(excluded.sort()).toEqual(["anthropic-oauth", "codex"]);
		// A forced account would route around the gateway's own rules.
		expect(captured.req?.headers.get(FORCED_ACCOUNT)).toBeNull();
	});

	test("a client cannot widen or narrow the exclusions by sending the header", async () => {
		const [proxy, captured] = stubProxy();
		await dispatch(
			"/v1/gateways/open/responses",
			proxy,
			responsesBody("gpt-5.5"),
			{ [EXCLUDE]: "codex,zai" },
		);
		expect(captured.req?.headers.get(EXCLUDE)).toBe("anthropic-oauth");
	});
});

describe("gateway responses transport and endpoints", () => {
	test("a WebSocket upgrade is refused the way the plain path refuses it", async () => {
		for (const path of [
			"/v1/gateways/gpt/responses",
			"/gpt/v1/responses/compact",
		]) {
			const [proxy, captured] = stubProxy();
			const resp = await dispatch(
				path,
				proxy,
				undefined,
				{ upgrade: "websocket", connection: "Upgrade" },
				"GET",
			);
			expect(resp.status).toBe(503);
			const body = (await resp.json()) as { error: { type: string } };
			expect(body.error.type).toBe("not_supported_error");
			expect(captured.calls).toBe(0);
		}
	});

	test("GET /responses is not served, and the 404 names the endpoints", async () => {
		const [proxy, captured] = stubProxy();
		const resp = await dispatch(
			"/v1/gateways/gpt/responses",
			proxy,
			undefined,
			{},
			"GET",
		);
		expect(resp.status).toBe(404);
		const body = (await resp.json()) as {
			error: { code: string; message: string };
		};
		expect(body.error.code).toBe("unknown_endpoint");
		expect(body.error.message).toContain("POST /responses");
		expect(body.error.message).toContain("POST /responses/compact");
		expect(captured.calls).toBe(0);
	});
});

describe("plain POST /v1/responses is unchanged", () => {
	test("keeps the requested label, the family mapping and the fixed exclusion", async () => {
		const [proxy, captured] = stubProxy();
		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[FORCED_ACCOUNT]: "acct-1",
			},
			body: JSON.stringify(responsesBody("gpt-5.5")),
		});
		const resp = await handleResponsesRequest(req, new URL(req.url), proxy, {});
		const body = (await resp.json()) as { model: string };
		expect(body.model).toBe("gpt-5.5");
		expect(captured.body?.model).toBe(LATEST_SONNET_MODEL);
		expect(passthrough(captured)?.model).toBe("gpt-5.5");
		expect(captured.req?.headers.get(EXCLUDE)).toBe("anthropic-oauth");
		expect(captured.req?.headers.get(REPORT_UPSTREAM_MODEL_HEADER)).toBeNull();
		expect(captured.req?.headers.get(FORCED_ACCOUNT)).toBe("acct-1");
	});
});

describe("plain POST /v1/responses SSE label", () => {
	test("a streamed answer keeps the requested label even when message_start names another model", async () => {
		const [proxy] = stubProxy();
		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(responsesBody("gpt-5.5", { stream: true })),
		});
		const resp = await handleResponsesRequest(req, new URL(req.url), proxy, {});
		const text = await resp.text();
		const created = text
			.split("\n\n")
			.find((frame) => frame.startsWith("event: response.created"));
		expect(created).toBeDefined();
		const data = JSON.parse(
			(created ?? "")
				.split("\n")
				.find((l) => l.startsWith("data: "))
				?.slice(6) ?? "{}",
		) as { response: { model: string } };
		// message_start names ANSWERING_MODEL; the plain path does not report it.
		expect(data.response.model).toBe("gpt-5.5");
	});
});
