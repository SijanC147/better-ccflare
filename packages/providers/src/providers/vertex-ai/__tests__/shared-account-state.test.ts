import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { makeAccount } from "../../../testing/account-fixture";
import type { ProviderRequestContext } from "../../../types";
import { VertexAIProvider } from "../provider";

/**
 * SB23-2457, then SB23-2508. `prepareRequest` derives two values from the body,
 * the Vertex model for the URL and the original model to restore into the
 * response, and `buildUrl` and `processResponse` read them back.
 *
 * They used to be written onto the `Account` object, so two concurrent requests
 * handed the SAME account object read each other's model: request B's
 * `prepareRequest` landed between request A's write and A's `processResponse`,
 * and A's response came back labelled with B's model. Nothing in the provider
 * prevented it. The proxy stayed correct only because `AccountRepository`
 * allocates a fresh object per row per call.
 *
 * Since SB23-2508 the values are keyed on the per-attempt carrier, a
 * `ProviderRequestContext` the proxy creates once per upstream attempt and
 * passes to all three hooks. So:
 *
 *  - `keeps each request's model on one shared account` drives exactly the
 *    interleaving that used to corrupt and asserts it no longer does. Against
 *    the pre-SB23-2508 provider it fails: A restores B's model.
 *  - `reads the other request's model when the carrier is shared` is the
 *    negative control, rewritten rather than deleted. The corruption is now
 *    reachable only by handing two requests one carrier, which the proxy never
 *    does. It is here so the safe cases are known to measure something: a
 *    provider that stored nothing at all would pass them too.
 *  - `keeps each request's model when each has its own account object` is the
 *    shape the proxy has always had, kept so a change to it shows up here.
 *  - `falls back without a carrier` pins what a caller outside a request gets.
 */

const VERTEX_CONFIG = JSON.stringify({
	projectId: "test-project",
	region: "us-east5",
});

function vertexAccount(): Account {
	return makeAccount({
		id: "vertex-1",
		name: "vertex-1",
		provider: "vertex-ai",
		custom_endpoint: VERTEX_CONFIG,
	});
}

function bodyFor(model: string): ArrayBuffer {
	const bytes = new TextEncoder().encode(JSON.stringify({ model }));
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

function jsonResponse(model: string): Response {
	return new Response(JSON.stringify({ model, id: "msg_1" }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

async function modelOf(response: Response): Promise<string> {
	return ((await response.json()) as { model?: string }).model ?? "";
}

const MODEL_A = "claude-sonnet-4-5-20250929";
const MODEL_B = "claude-haiku-4-5-20251001";
const VERTEX_A = "claude-sonnet-4-5@20250929";
const VERTEX_B = "claude-haiku-4-5@20251001";

function carrier(): ProviderRequestContext {
	return {};
}

describe("vertex-ai per-request state (SB23-2457, SB23-2508)", () => {
	it("keeps each request's model on one shared account", async () => {
		const provider = new VertexAIProvider();
		const shared = vertexAccount();
		const request = new Request("https://example.invalid/v1/messages");
		const contextA = carrier();
		const contextB = carrier();

		// Request A is prepared and dispatched upstream.
		provider.prepareRequest(request, bodyFor(MODEL_A), shared, contextA);
		const urlA = provider.buildUrl("/v1/messages", "", shared, contextA);

		// Request B arrives on the same account object while A is in flight.
		provider.prepareRequest(request, bodyFor(MODEL_B), shared, contextB);
		const urlB = provider.buildUrl("/v1/messages", "", shared, contextB);

		// A's upstream response comes back after B was prepared.
		const restoredA = await provider.processResponse(
			jsonResponse(VERTEX_A),
			shared,
			undefined,
			undefined,
			contextA,
		);
		const restoredB = await provider.processResponse(
			jsonResponse(VERTEX_B),
			shared,
			undefined,
			undefined,
			contextB,
		);

		expect(urlA).toContain(`/models/${VERTEX_A}:`);
		expect(urlB).toContain(`/models/${VERTEX_B}:`);
		expect(await modelOf(restoredA)).toBe(MODEL_A);
		expect(await modelOf(restoredB)).toBe(MODEL_B);
	});

	it("writes nothing onto the account", () => {
		const provider = new VertexAIProvider();
		const account = vertexAccount();
		const before = Object.keys(account).sort();

		provider.prepareRequest(
			new Request("https://example.invalid/v1/messages"),
			bodyFor(MODEL_A),
			account,
			carrier(),
		);

		expect(Object.keys(account).sort()).toEqual(before);
	});

	/**
	 * The negative control. Two requests sharing ONE carrier is the only way
	 * left to reproduce the corruption, and the proxy creates a new carrier per
	 * attempt, so this is the shape it must never take. If this stops
	 * corrupting, the provider has stopped reading the carrier and the test
	 * above is no longer measuring anything.
	 */
	it("reads the other request's model when the carrier is shared", async () => {
		const provider = new VertexAIProvider();
		const request = new Request("https://example.invalid/v1/messages");
		const sharedContext = carrier();

		provider.prepareRequest(
			request,
			bodyFor(MODEL_A),
			vertexAccount(),
			sharedContext,
		);
		provider.prepareRequest(
			request,
			bodyFor(MODEL_B),
			vertexAccount(),
			sharedContext,
		);

		const restoredA = await provider.processResponse(
			jsonResponse(VERTEX_A),
			vertexAccount(),
			undefined,
			undefined,
			sharedContext,
		);

		expect(await modelOf(restoredA)).toBe(MODEL_B);
	});

	it("keeps each request's model when each has its own account object", async () => {
		const provider = new VertexAIProvider();
		const accountA = vertexAccount();
		const accountB = vertexAccount();
		const contextA = carrier();
		const contextB = carrier();
		const request = new Request("https://example.invalid/v1/messages");

		expect(accountA).not.toBe(accountB);

		provider.prepareRequest(request, bodyFor(MODEL_A), accountA, contextA);
		const urlA = provider.buildUrl("/v1/messages", "", accountA, contextA);

		provider.prepareRequest(request, bodyFor(MODEL_B), accountB, contextB);
		const urlB = provider.buildUrl("/v1/messages", "", accountB, contextB);

		const restoredB = await provider.processResponse(
			jsonResponse(VERTEX_B),
			accountB,
			undefined,
			undefined,
			contextB,
		);
		const restoredA = await provider.processResponse(
			jsonResponse(VERTEX_A),
			accountA,
			undefined,
			undefined,
			contextA,
		);

		expect(urlA).toContain(`/models/${VERTEX_A}:`);
		expect(urlB).toContain(`/models/${VERTEX_B}:`);
		expect(await modelOf(restoredA)).toBe(MODEL_A);
		expect(await modelOf(restoredB)).toBe(MODEL_B);
	});

	/**
	 * The model catalog and the unauthenticated passthrough build a URL with no
	 * request behind it, so no carrier. A prepared account must not leak its
	 * model into that URL either: the state is on the carrier, not the account.
	 */
	it("falls back without a carrier", async () => {
		const provider = new VertexAIProvider();
		const account = vertexAccount();
		provider.prepareRequest(
			new Request("https://example.invalid/v1/messages"),
			bodyFor(MODEL_B),
			account,
			carrier(),
		);

		expect(provider.buildUrl("/v1/messages", "", account)).toContain(
			"/models/claude-sonnet-4-5@20250929:",
		);
		const passthrough = await provider.processResponse(
			jsonResponse(VERTEX_A),
			account,
		);
		expect(await modelOf(passthrough)).toBe(VERTEX_A);
	});
});
