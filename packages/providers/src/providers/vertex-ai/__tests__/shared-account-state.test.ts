import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { makeAccount } from "../../../testing/account-fixture";
import { VertexAIProvider } from "../provider";

/**
 * SB23-2457. `prepareRequest` stashes `_vertexModel` and `_originalModel` on
 * the `Account` object it is handed, and `buildUrl` and `processResponse` read
 * them back. The issue asked whether two concurrent requests can read each
 * other's model.
 *
 * The answer is that it depends entirely on whether the two requests are handed
 * the SAME `Account` object, and in this proxy they are not. These tests settle
 * it from both sides rather than asserting the safe case alone:
 *
 *  - `carries the right URL even on one shared account` shows the URL can never
 *    be wrong, whatever the carrier does, because nothing can interleave
 *    between the write and the read.
 *  - `reads the other request's model when the account object is shared` is the
 *    negative control. It makes the hazard happen on purpose, so the safe cases
 *    below are known to be measuring something. Without it a green suite would
 *    equally describe a provider that never stored anything at all.
 *  - `keeps each request's model when each has its own account object` is the
 *    production shape.
 *
 * Every assertion here is about the provider in isolation. What makes the
 * production path safe is argued in the block comment above the reads in
 * `../provider.ts`, and pinned in
 * `packages/database/src/__tests__/account-object-identity.test.ts`.
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

describe("vertex-ai shared account state (SB23-2457)", () => {
	/**
	 * The issue proposed asserting on the URL each of two concurrent requests
	 * builds. That probe cannot fail, and this test is here to record why.
	 *
	 * `proxy-operations.ts` calls `prepareRequest` at :858 and `buildUrl` at
	 * :906 with no `await` between them, so on a single-threaded runtime the
	 * write and the read are one atomic step. A second request cannot run any
	 * of its own code inside that window, so `_vertexModel` is correct even
	 * when the two requests deliberately share one account object, as here.
	 */
	it("carries the right URL even on one shared account", () => {
		const provider = new VertexAIProvider();
		const shared = vertexAccount();
		const request = new Request("https://example.invalid/v1/messages");

		provider.prepareRequest(request, bodyFor(MODEL_A), shared);
		const urlA = provider.buildUrl("/v1/messages", "", shared);

		provider.prepareRequest(request, bodyFor(MODEL_B), shared);
		const urlB = provider.buildUrl("/v1/messages", "", shared);

		expect(urlA).toContain(`/models/${VERTEX_A}:`);
		expect(urlB).toContain(`/models/${VERTEX_B}:`);
		expect(urlA).not.toContain(VERTEX_B);
		expect(urlB).not.toContain(VERTEX_A);
	});

	/**
	 * The negative control, and the one test that would catch a regression to a
	 * genuinely shared carrier.
	 *
	 * `processResponse` runs at `proxy-operations.ts:1735`, after the upstream
	 * fetch, so unlike `buildUrl` it is separated from its write by many
	 * `await`s. Request B's `prepareRequest` therefore CAN land between request
	 * A's write and A's read. This drives exactly that order and asserts A is
	 * corrupted: the provider offers no protection of its own.
	 */
	it("reads the other request's model when the account object is shared", async () => {
		const provider = new VertexAIProvider();
		const shared = vertexAccount();
		const request = new Request("https://example.invalid/v1/messages");

		// Request A is prepared and dispatched upstream.
		provider.prepareRequest(request, bodyFor(MODEL_A), shared);
		provider.buildUrl("/v1/messages", "", shared);

		// Request B arrives while A is still in flight and overwrites the stash.
		provider.prepareRequest(request, bodyFor(MODEL_B), shared);
		provider.buildUrl("/v1/messages", "", shared);

		// A's upstream response comes back and is restored against B's model.
		const restored = await provider.processResponse(
			jsonResponse(VERTEX_A),
			shared,
		);

		expect(await modelOf(restored)).toBe(MODEL_B);
	});

	/**
	 * The production shape. Every selection path re-reads the accounts table and
	 * `AccountRepository.findAll` maps each row through `toAccount`, so two
	 * concurrent requests on one account row hold two distinct objects and
	 * neither write is visible to the other.
	 */
	it("keeps each request's model when each has its own account object", async () => {
		const provider = new VertexAIProvider();
		const accountA = vertexAccount();
		const accountB = vertexAccount();
		const request = new Request("https://example.invalid/v1/messages");

		expect(accountA).not.toBe(accountB);

		provider.prepareRequest(request, bodyFor(MODEL_A), accountA);
		const urlA = provider.buildUrl("/v1/messages", "", accountA);

		provider.prepareRequest(request, bodyFor(MODEL_B), accountB);
		const urlB = provider.buildUrl("/v1/messages", "", accountB);

		const restoredB = await provider.processResponse(
			jsonResponse(VERTEX_B),
			accountB,
		);
		const restoredA = await provider.processResponse(
			jsonResponse(VERTEX_A),
			accountA,
		);

		expect(urlA).toContain(`/models/${VERTEX_A}:`);
		expect(urlB).toContain(`/models/${VERTEX_B}:`);
		expect(await modelOf(restoredA)).toBe(MODEL_A);
		expect(await modelOf(restoredB)).toBe(MODEL_B);
	});
});
