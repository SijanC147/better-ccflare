import { describe, expect, it } from "bun:test";
import { AnthropicProvider } from "../provider";

/**
 * `GET /v1/models` for a client that is not an Anthropic SDK.
 *
 * Two halves of one request path, both proven here:
 *  - the request never reaches Anthropic without `anthropic-version`, which is
 *    what produced the HTTP 400 "anthropic-version: header is required";
 *  - the response comes back in the OpenAI listing shape for a client that did
 *    not send that header, and untouched for one that did.
 */

const ANTHROPIC_PAGE = JSON.stringify({
	data: [
		{
			type: "model",
			id: "claude-opus-4-5-20260101",
			display_name: "Claude Opus 4.5",
			created_at: "2026-01-01T00:00:00Z",
		},
		{
			type: "model",
			id: "claude-haiku-4-5-20251001",
			display_name: "Claude Haiku 4.5",
			created_at: "2025-10-01T00:00:00Z",
		},
	],
	has_more: false,
	first_id: "claude-opus-4-5-20260101",
	last_id: "claude-haiku-4-5-20251001",
});

/** The same listing, cut so that a second page exists. */
const FIRST_OF_TWO_PAGES = JSON.stringify({
	data: [
		{
			type: "model",
			id: "claude-opus-4-5-20260101",
			display_name: "Claude Opus 4.5",
			created_at: "2026-01-01T00:00:00Z",
		},
		{
			type: "model",
			id: "claude-haiku-4-5-20251001",
			display_name: "Claude Haiku 4.5",
			created_at: "2025-10-01T00:00:00Z",
		},
	],
	has_more: true,
	first_id: "claude-opus-4-5-20260101",
	last_id: "claude-haiku-4-5-20251001",
});

function model(id: string, displayName: string) {
	return {
		type: "model",
		id,
		display_name: displayName,
		created_at: "2026-02-01T00:00:00Z",
	};
}

function jsonPage(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

/**
 * Every page after the first is a real `fetch`, so the stitching loop is
 * exercised against a fixture rather than the network. The global is restored
 * whatever the body does.
 */
async function withStubbedFetch(
	handler: (url: string) => Response,
	run: () => Promise<Response>,
): Promise<Response> {
	const realFetch = globalThis.fetch;
	globalThis.fetch = ((input: RequestInfo | URL) =>
		Promise.resolve(handler(String(input)))) as typeof fetch;
	try {
		return await run();
	} finally {
		globalThis.fetch = realFetch;
	}
}

function modelsResponse(body: string, init?: ResponseInit): Response {
	return new Response(body, {
		status: 200,
		headers: {
			"content-type": "application/json",
			"x-better-ccflare-request-path": "/v1/models",
		},
		...init,
	});
}

describe("AnthropicProvider — anthropic-version on outgoing requests", () => {
	it("supplies anthropic-version when the client did not send one", () => {
		const provider = new AnthropicProvider();
		const prepared = provider.prepareHeaders(new Headers(), "token");
		expect(prepared.get("anthropic-version")).toBe("2023-06-01");
	});

	it("keeps a version the client chose", () => {
		const provider = new AnthropicProvider();
		const prepared = provider.prepareHeaders(
			new Headers({ "anthropic-version": "2026-01-01" }),
			"token",
		);
		expect(prepared.get("anthropic-version")).toBe("2026-01-01");
	});
});

describe("AnthropicProvider — /v1/models response shape", () => {
	it("translates the listing for a client that sent no anthropic-version", async () => {
		const provider = new AnthropicProvider();
		const out = await provider.processResponse(
			modelsResponse(ANTHROPIC_PAGE),
			null,
			new Headers({ authorization: "Bearer test" }),
		);

		const body = await out.json();
		expect(body.object).toBe("list");
		expect(body.data).toHaveLength(2);
		expect(body.data[0]).toMatchObject({
			id: "claude-opus-4-5-20260101",
			object: "model",
			created: Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000),
			owned_by: "anthropic",
		});
		// Kept so the model-catalog ingester still recognises the teed body.
		expect(body.data[0].display_name).toBe("Claude Opus 4.5");
		expect(body.data[0].created_at).toBe("2026-01-01T00:00:00Z");
		expect(body.has_more).toBe(false);
		// A stale length would truncate the re-serialized body.
		expect(out.headers.get("content-length")).toBeNull();
	});

	it("leaves the Anthropic shape alone for a native SDK client", async () => {
		const provider = new AnthropicProvider();
		const out = await provider.processResponse(
			modelsResponse(ANTHROPIC_PAGE),
			null,
			new Headers({ "anthropic-version": "2023-06-01" }),
		);

		const body = await out.json();
		expect(body.object).toBeUndefined();
		expect(body.data[0].type).toBe("model");
		expect(body.data[0].object).toBeUndefined();
	});

	it("passes a non-200 through untouched so the error still reaches the client", async () => {
		const provider = new AnthropicProvider();
		const errorBody = JSON.stringify({
			type: "error",
			error: { type: "invalid_request_error", message: "nope" },
		});
		const out = await provider.processResponse(
			modelsResponse(errorBody, { status: 400 }),
			null,
			new Headers(),
		);

		expect(out.status).toBe(400);
		const body = await out.json();
		expect(body.type).toBe("error");
	});

	it("passes a body that is not JSON through untouched", async () => {
		const provider = new AnthropicProvider();
		const out = await provider.processResponse(
			new Response("not json", {
				status: 200,
				headers: {
					"content-type": "text/plain",
					"x-better-ccflare-request-path": "/v1/models",
				},
			}),
			null,
			new Headers(),
		);

		expect(await out.text()).toBe("not json");
	});

	it("stitches the second page into one body for a client that cannot page", async () => {
		const provider = new AnthropicProvider();
		const calls: string[] = [];
		const out = await withStubbedFetch(
			(url) => {
				calls.push(url);
				return jsonPage({
					data: [model("claude-sonnet-5-20260201", "Claude Sonnet 5")],
					has_more: false,
					first_id: "claude-sonnet-5-20260201",
					last_id: "claude-sonnet-5-20260201",
				});
			},
			() =>
				provider.processResponse(
					modelsResponse(FIRST_OF_TWO_PAGES),
					null,
					new Headers({ authorization: "Bearer test" }),
				),
		);

		const body = await out.json();
		expect(calls).toHaveLength(1);
		expect(calls[0]).toBe(
			"https://api.anthropic.com/v1/models?after_id=claude-haiku-4-5-20251001",
		);
		expect(body.data.map((m: { id: string }) => m.id)).toEqual([
			"claude-opus-4-5-20260101",
			"claude-haiku-4-5-20251001",
			"claude-sonnet-5-20260201",
		]);
		// The stitched body is complete, and says so: the page cap was not hit
		// and no page failed.
		expect(body.has_more).toBe(false);
		expect(body.first_id).toBe("claude-opus-4-5-20260101");
		expect(body.last_id).toBe("claude-sonnet-5-20260201");
	});

	it("stops at the page cap and admits the listing is short", async () => {
		const provider = new AnthropicProvider();
		let served = 0;
		const out = await withStubbedFetch(
			() => {
				served++;
				return jsonPage({
					data: [model(`claude-endless-${served}`, `Endless ${served}`)],
					// An upstream that never stops. The loop has to.
					has_more: true,
					first_id: `claude-endless-${served}`,
					last_id: `claude-endless-${served}`,
				});
			},
			() =>
				provider.processResponse(
					modelsResponse(FIRST_OF_TWO_PAGES),
					null,
					new Headers(),
				),
		);

		const body = await out.json();
		expect(served).toBe(10);
		expect(body.data).toHaveLength(12);
		expect(body.has_more).toBe(true);
	});

	it("keeps the pages it already has when a page part-way fails", async () => {
		const provider = new AnthropicProvider();
		let served = 0;
		const out = await withStubbedFetch(
			() => {
				served++;
				if (served === 2) throw new Error("connection reset");
				return jsonPage({
					data: [model("claude-sonnet-5-20260201", "Claude Sonnet 5")],
					has_more: true,
					first_id: "claude-sonnet-5-20260201",
					last_id: "claude-sonnet-5-20260201",
				});
			},
			() =>
				provider.processResponse(
					modelsResponse(FIRST_OF_TWO_PAGES),
					null,
					new Headers(),
				),
		);

		// The request is not failed: a partial listing that says it is partial
		// is more useful than an error, and the first page's models survive.
		expect(out.status).toBe(200);
		const body = await out.json();
		expect(served).toBe(2);
		expect(body.data.map((m: { id: string }) => m.id)).toEqual([
			"claude-opus-4-5-20260101",
			"claude-haiku-4-5-20251001",
			"claude-sonnet-5-20260201",
		]);
		expect(body.has_more).toBe(true);
	});

	it("fetches nothing more when the first page is already complete", async () => {
		const provider = new AnthropicProvider();
		let called = 0;
		const out = await withStubbedFetch(
			() => {
				called++;
				return jsonPage({ data: [], has_more: false });
			},
			() =>
				provider.processResponse(
					modelsResponse(ANTHROPIC_PAGE),
					null,
					new Headers(),
				),
		);

		expect(called).toBe(0);
		const body = await out.json();
		expect(body.data).toHaveLength(2);
		expect(body.has_more).toBe(false);
	});

	it("does not page for a native SDK client, which pages itself", async () => {
		const provider = new AnthropicProvider();
		let called = 0;
		const out = await withStubbedFetch(
			() => {
				called++;
				return jsonPage({ data: [], has_more: false });
			},
			() =>
				provider.processResponse(
					modelsResponse(FIRST_OF_TWO_PAGES),
					null,
					new Headers({ "anthropic-version": "2023-06-01" }),
				),
		);

		expect(called).toBe(0);
		const body = await out.json();
		// Anthropic's own paginated answer, untouched.
		expect(body.object).toBeUndefined();
		expect(body.data).toHaveLength(2);
		expect(body.has_more).toBe(true);
	});

	it("does not touch a response for any other path", async () => {
		const provider = new AnthropicProvider();
		const out = await provider.processResponse(
			new Response(ANTHROPIC_PAGE, {
				status: 200,
				headers: {
					"content-type": "application/json",
					"x-better-ccflare-request-path": "/v1/messages",
				},
			}),
			null,
			new Headers(),
		);

		const body = await out.json();
		expect(body.object).toBeUndefined();
	});
});
