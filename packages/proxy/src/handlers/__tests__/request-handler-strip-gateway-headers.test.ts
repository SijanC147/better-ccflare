import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { sanitizeRequestHeaders } from "@better-ccflare/http-common";
import {
	GATEWAY_INTERNAL_HEADERS,
	INBOUND_FORMAT_HEADER,
	INBOUND_GATEWAY_HEADER,
} from "@better-ccflare/types";
import { makeProxyRequest } from "../request-handler";

/**
 * SB23-2727. The gateway routing headers and the inbound marker are internal:
 * they reach the history row and never the provider. Both forwarding paths of
 * `makeProxyRequest` are covered, as for the probe secret.
 */
describe("makeProxyRequest strips the internal gateway headers", () => {
	let realFetch: typeof globalThis.fetch;
	let sentHeaders: Headers | undefined;

	beforeEach(() => {
		realFetch = globalThis.fetch;
		sentHeaders = undefined;
		globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
			sentHeaders =
				input instanceof Request
					? new Headers(input.headers)
					: new Headers(init?.headers);
			return new Response("ok", { status: 200 });
		}) as unknown as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	const internal = {
		"x-better-ccflare-gateway-combo": "GptStandard",
		"x-better-ccflare-gateway-require-model": "1",
		[INBOUND_FORMAT_HEADER]: "openai-chat",
		[INBOUND_GATEWAY_HEADER]: "work",
	};

	it("sanitizeRequestHeaders keeps the inbound marker for the history row", () => {
		const kept = sanitizeRequestHeaders(new Headers(internal));
		expect(kept.get(INBOUND_FORMAT_HEADER)).toBe("openai-chat");
		expect(kept.get(INBOUND_GATEWAY_HEADER)).toBe("work");
	});

	it("names all four headers in the shared list", () => {
		expect([...GATEWAY_INTERNAL_HEADERS].sort()).toEqual(
			Object.keys(internal).sort(),
		);
	});

	it("on the headers-param path", async () => {
		await makeProxyRequest(
			"https://upstream.invalid/v1/messages",
			"POST",
			new Headers({ ...internal, "content-type": "application/json" }),
			undefined,
			false,
		);
		for (const name of Object.keys(internal)) {
			expect(sentHeaders?.get(name)).toBeNull();
		}
		expect(sentHeaders?.get("content-type")).toBe("application/json");
	});

	it("on the Request-target path", async () => {
		await makeProxyRequest(
			new Request("https://upstream.invalid/v1/messages", {
				method: "POST",
				headers: { ...internal, authorization: "Bearer token" },
			}),
		);
		for (const name of Object.keys(internal)) {
			expect(sentHeaders?.get(name)).toBeNull();
		}
		expect(sentHeaders?.get("authorization")).toBe("Bearer token");
	});
});
