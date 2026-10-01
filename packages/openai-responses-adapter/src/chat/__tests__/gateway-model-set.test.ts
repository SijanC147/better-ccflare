import { describe, expect, test } from "bun:test";
import {
	GATEWAY_COMBO_HEADER,
	GATEWAY_REQUIRE_MODEL_HEADER,
	matchOpenAIGatewayAliasPath,
	matchOpenAIGatewayPath,
	type OpenAIGateways,
	validateOpenAIGatewayConfig,
} from "@better-ccflare/types";
import { dispatchOpenAIGatewayRequest } from "../../gateway-dispatch";
import type { HandleProxyFn } from "../../types";

const ANTHROPIC_MESSAGE = {
	id: "msg_1",
	type: "message",
	role: "assistant",
	model: "gpt-5.5",
	content: [{ type: "text", text: "Hello" }],
	stop_reason: "end_turn",
	stop_sequence: null,
	usage: { input_tokens: 3, output_tokens: 1 },
};

const GATEWAYS: OpenAIGateways = {
	gpt: {
		models: [
			{ name: "gpt-5.5", model: "gpt-5.5" },
			{ name: "standard", model: "gpt-5.6-terra", combo: "GptStandard" },
		],
	},
	open: {},
};

interface Captured {
	calls: number;
	req?: Request;
	body?: Record<string, unknown>;
}

function stubProxy(): [HandleProxyFn, Captured] {
	const captured: Captured = { calls: 0 };
	const fn: HandleProxyFn = async (req) => {
		captured.calls++;
		captured.req = req;
		if (req.method === "POST") {
			captured.body = (await req.clone().json()) as Record<string, unknown>;
		}
		return Response.json(ANTHROPIC_MESSAGE);
	};
	return [fn, captured];
}

async function dispatch(
	method: string,
	path: string,
	proxy: HandleProxyFn,
	body?: unknown,
	headers: Record<string, string> = {},
): Promise<Response> {
	const req = new Request(`http://localhost${path}`, {
		method,
		headers: { "content-type": "application/json", ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const url = new URL(req.url);
	const match = matchOpenAIGatewayPath(url.pathname);
	if (!match) throw new Error(`no gateway match for ${path}`);
	return dispatchOpenAIGatewayRequest(req, url, match, GATEWAYS, proxy, {});
}

const chat = (model: string) => ({
	model,
	messages: [{ role: "user", content: "Hi" }],
	max_tokens: 5,
});

describe("gateway model set", () => {
	test("an entry without a combo asks for the model filter and names no ladder", async () => {
		const [proxy, captured] = stubProxy();
		const resp = await dispatch(
			"POST",
			"/v1/gateways/gpt/chat/completions",
			proxy,
			chat("gpt-5.5"),
		);
		expect(resp.status).toBe(200);
		expect(captured.body?.model).toBe("gpt-5.5");
		expect(captured.req?.headers.get(GATEWAY_REQUIRE_MODEL_HEADER)).toBe("1");
		expect(captured.req?.headers.get(GATEWAY_COMBO_HEADER)).toBeNull();
	});

	test("an entry with a combo sends the upstream model and names the combo", async () => {
		const [proxy, captured] = stubProxy();
		const resp = await dispatch(
			"POST",
			"/v1/gateways/gpt/chat/completions",
			proxy,
			chat("standard"),
		);
		expect(resp.status).toBe(200);
		// The client's name is not what goes upstream; the entry's model is.
		expect(captured.body?.model).toBe("gpt-5.6-terra");
		expect(captured.req?.headers.get(GATEWAY_COMBO_HEADER)).toBe("GptStandard");
		expect(captured.req?.headers.get(GATEWAY_REQUIRE_MODEL_HEADER)).toBeNull();
	});

	test("a model outside the set is refused before anything reaches the proxy", async () => {
		const [proxy, captured] = stubProxy();
		const resp = await dispatch(
			"POST",
			"/v1/gateways/gpt/chat/completions",
			proxy,
			chat("claude-opus-5-5"),
		);
		expect(resp.status).toBe(404);
		const body = (await resp.json()) as {
			error: { code: string; message: string };
		};
		expect(body.error.code).toBe("model_not_found");
		expect(body.error.message).toContain("gpt-5.5, standard");
		expect(captured.calls).toBe(0);
	});

	test("a client cannot choose a ladder or lift the filter by sending the headers", async () => {
		const [proxy, captured] = stubProxy();
		await dispatch(
			"POST",
			"/v1/gateways/gpt/chat/completions",
			proxy,
			chat("gpt-5.5"),
			{
				[GATEWAY_COMBO_HEADER]: "SomeOtherCombo",
				"x-better-ccflare-account-id": "acct-1",
			},
		);
		expect(captured.req?.headers.get(GATEWAY_COMBO_HEADER)).toBeNull();
		expect(captured.req?.headers.get("x-better-ccflare-account-id")).toBeNull();

		const [openProxy, openCaptured] = stubProxy();
		await dispatch(
			"POST",
			"/v1/gateways/open/chat/completions",
			openProxy,
			chat("claude-haiku-4-5"),
			{
				[GATEWAY_COMBO_HEADER]: "SomeOtherCombo",
				[GATEWAY_REQUIRE_MODEL_HEADER]: "1",
			},
		);
		expect(openCaptured.req?.headers.get(GATEWAY_COMBO_HEADER)).toBeNull();
		expect(
			openCaptured.req?.headers.get(GATEWAY_REQUIRE_MODEL_HEADER),
		).toBeNull();
		// A gateway without a model set passes the client's model through.
		expect(openCaptured.body?.model).toBe("claude-haiku-4-5");
	});

	test("GET models lists exactly the set and never asks the pool", async () => {
		const [proxy, captured] = stubProxy();
		const resp = await dispatch("GET", "/v1/gateways/gpt/models", proxy);
		expect(resp.status).toBe(200);
		const body = (await resp.json()) as { data: Array<{ id: string }> };
		expect(body.data.map((m) => m.id)).toEqual(["gpt-5.5", "standard"]);
		expect(captured.calls).toBe(0);
	});
});

describe("gateway model set config", () => {
	test("model defaults to name, and an entry keeps its combo", () => {
		const result = validateOpenAIGatewayConfig({
			models: [
				{ name: "gpt-5.5" },
				{ name: "std", model: "gpt-5.6-terra", combo: "C" },
			],
		});
		expect(result).toEqual({
			ok: true,
			value: {
				models: [
					{ name: "gpt-5.5", model: "gpt-5.5" },
					{ name: "std", model: "gpt-5.6-terra", combo: "C" },
				],
			},
		});
	});

	test.each([
		[{ models: [] }, "at least one"],
		[{ models: "gpt-5.5" }, "must be an array"],
		[{ models: [{ name: "a" }, { name: "a" }] }, "listed twice"],
		[{ models: [{ name: "a", extra: 1 }] }, "unknown models entry field"],
		[{ models: [{ name: "a", combo: "" }] }, "combo must be a combo name"],
		[{ models: [{ name: "bad name" }] }, "model id"],
	])("%j is refused", (input, fragment) => {
		const result = validateOpenAIGatewayConfig(input);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain(fragment);
	});
});

describe("gateway short path", () => {
	test("/<name>/v1/<rest> resolves to the gateway and its rest", () => {
		expect(matchOpenAIGatewayAliasPath("/gpt/v1/chat/completions")).toEqual({
			name: "gpt",
			rest: "/chat/completions",
		});
		expect(matchOpenAIGatewayAliasPath("/gpt/v1/models")).toEqual({
			name: "gpt",
			rest: "/models",
		});
	});

	test.each([
		"/api/v1/anything",
		"/v1/v1/models",
		"/messages/v1/x",
		"/assets/v1/x",
		"/Gpt/v1/models",
		"/gpt/v2/models",
		"/gpt/v1x/models",
		"/v1/chat/completions",
		"/requests",
	])("%s is not an alias", (path) => {
		expect(matchOpenAIGatewayAliasPath(path)).toBeNull();
	});
});
