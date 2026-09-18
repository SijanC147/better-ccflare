import { describe, expect, it } from "bun:test";
import { AnthropicProvider } from "../provider";

/**
 * `GET /v1/models/{id}` for a client that is not an Anthropic SDK.
 *
 * The listing endpoint is covered by `models-listing.test.ts`; this file
 * covers the single-model lookup that completes the discovery pair, and the
 * two ways the two endpoints must not interfere:
 *
 *  - the exact `/v1/models` match still reaches the listing transform, so a
 *    single-model branch added under the same prefix cannot swallow it;
 *  - a client that sent `anthropic-version` gets Anthropic's own body on both.
 *
 * Fixtures only. Nothing here reaches the network: the single-model path does
 * not stitch pages, so no `fetch` stub is needed.
 */

const ANTHROPIC_MODEL = JSON.stringify({
	type: "model",
	id: "claude-opus-4-5-20260101",
	display_name: "Claude Opus 4.5",
	created_at: "2026-01-01T00:00:00Z",
});

/** Anthropic's own error envelope for an id the account cannot reach. */
const ANTHROPIC_NOT_FOUND = JSON.stringify({
	type: "error",
	error: {
		type: "not_found_error",
		message: "model: claude-nonexistent",
	},
});

function singleModelResponse(body: string, init?: ResponseInit): Response {
	return new Response(body, {
		status: 200,
		...init,
		headers: {
			"content-type": "application/json",
			"x-better-ccflare-request-path": "/v1/models/claude-opus-4-5-20260101",
			...(init?.headers as Record<string, string> | undefined),
		},
	});
}

describe("AnthropicProvider — GET /v1/models/{id} response shape", () => {
	it("translates one model into the OpenAI single-model shape", async () => {
		const provider = new AnthropicProvider();
		const out = await provider.processResponse(
			singleModelResponse(ANTHROPIC_MODEL),
			null,
			new Headers({ authorization: "Bearer test" }),
		);

		expect(out.status).toBe(200);
		const body = await out.json();

		// The whole contract, field by field. `created` is the epoch SECONDS of
		// created_at, so an assertion on the millisecond value would pass a
		// factor-of-1000 defect.
		expect(body).toMatchObject({
			id: "claude-opus-4-5-20260101",
			object: "model",
			created: Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000),
			owned_by: "anthropic",
		});

		// Not a list. Copying the listing transform is the easiest way to get
		// this wrong, and a client reading `.id` off a `{object: "list"}` body
		// gets undefined rather than an error.
		expect(body.object).not.toBe("list");
		expect(body.data).toBeUndefined();
	});

	it("keeps display_name and created_at, which the catalog ingester reads", async () => {
		const provider = new AnthropicProvider();
		const out = await provider.processResponse(
			singleModelResponse(ANTHROPIC_MODEL),
			null,
			new Headers(),
		);

		const body = await out.json();
		expect(body.display_name).toBe("Claude Opus 4.5");
		expect(body.created_at).toBe("2026-01-01T00:00:00Z");
	});

	it("reports an unparseable created_at as 0 rather than NaN", async () => {
		const provider = new AnthropicProvider();
		const out = await provider.processResponse(
			singleModelResponse(
				JSON.stringify({ id: "claude-x", created_at: "not-a-date" }),
			),
			null,
			new Headers(),
		);

		const body = await out.json();
		// NaN serializes as null through JSON.stringify, so asserting the number
		// is what catches it; `toBeDefined` would pass on null.
		expect(body.created).toBe(0);
		expect(typeof body.created).toBe("number");
	});

	it("falls back to the id when Anthropic sends no display_name", async () => {
		const provider = new AnthropicProvider();
		const out = await provider.processResponse(
			singleModelResponse(JSON.stringify({ id: "claude-x" })),
			null,
			new Headers(),
		);

		expect((await out.json()).display_name).toBe("claude-x");
	});

	it("leaves the body untouched for a client that sent anthropic-version", async () => {
		const provider = new AnthropicProvider();
		const out = await provider.processResponse(
			singleModelResponse(ANTHROPIC_MODEL),
			null,
			new Headers({ "anthropic-version": "2023-06-01" }),
		);

		const body = await out.json();
		expect(body.type).toBe("model");
		expect(body.object).toBeUndefined();
		expect(body.owned_by).toBeUndefined();
	});
});

describe("AnthropicProvider — GET /v1/models/{id} errors", () => {
	it("turns a 404 into OpenAI's error shape and keeps the status", async () => {
		const provider = new AnthropicProvider();
		const out = await provider.processResponse(
			singleModelResponse(ANTHROPIC_NOT_FOUND, { status: 404 }),
			null,
			new Headers(),
		);

		// The status is the half most likely to be lost: an empty 200 is what
		// the OpenAI shape must never be, and a client checks the status first.
		expect(out.status).toBe(404);

		const body = await out.json();
		expect(body.error.type).toBe("invalid_request_error");
		expect(body.error.code).toBe("model_not_found");
		expect(body.error.message).toBe("model: claude-nonexistent");
		// Anthropic's own discriminator must not survive into an OpenAI body.
		expect(body.type).toBeUndefined();
	});

	it("reports a non-404 upstream error as its own type", async () => {
		const provider = new AnthropicProvider();
		const out = await provider.processResponse(
			singleModelResponse(
				JSON.stringify({
					type: "error",
					error: { type: "rate_limit_error", message: "slow down" },
				}),
				{ status: 429 },
			),
			null,
			new Headers(),
		);

		expect(out.status).toBe(429);
		const body = await out.json();
		// Collapsing every upstream failure to model_not_found would tell a
		// caller its model id is wrong when the account is merely throttled.
		expect(body.error.type).toBe("rate_limit_error");
		expect(body.error.code).toBeNull();
	});

	it("still produces an error object when the upstream body carries none", async () => {
		const provider = new AnthropicProvider();
		const out = await provider.processResponse(
			singleModelResponse(JSON.stringify({}), { status: 500 }),
			null,
			new Headers(),
		);

		expect(out.status).toBe(500);
		const body = await out.json();
		expect(body.error.type).toBe("api_error");
		expect(typeof body.error.message).toBe("string");
		expect(body.error.message.length).toBeGreaterThan(0);
	});

	it("passes a non-JSON body through untouched", async () => {
		const provider = new AnthropicProvider();
		const out = await provider.processResponse(
			new Response("upstream is down", {
				status: 502,
				headers: {
					"content-type": "text/plain",
					"x-better-ccflare-request-path": "/v1/models/claude-x",
				},
			}),
			null,
			new Headers(),
		);

		expect(out.status).toBe(502);
		expect(await out.text()).toBe("upstream is down");
	});

	it("pairs invalid_request_error with model_not_found on a 404 that is not Anthropic's envelope", async () => {
		const provider = new AnthropicProvider();
		const out = await provider.processResponse(
			// A CDN or edge 404, with no Anthropic `error` object at all.
			singleModelResponse(JSON.stringify({ message: "Not Found" }), {
				status: 404,
			}),
			null,
			new Headers(),
		);

		expect(out.status).toBe(404);
		const body = await out.json();
		// `type` and `code` must agree. `api_error` beside `model_not_found`
		// tells a client both "retry, this is our fault" and "your id is
		// wrong", and OpenAI's real 404 pairs invalid_request_error with
		// model_not_found. Asserting only one of the two is what let these
		// drift apart.
		expect(body.error.type).toBe("invalid_request_error");
		expect(body.error.code).toBe("model_not_found");
	});

	it("maps an Anthropic not_found_error carrying a non-404 status to both fields", async () => {
		const provider = new AnthropicProvider();
		const out = await provider.processResponse(
			singleModelResponse(
				JSON.stringify({
					type: "error",
					error: { type: "not_found_error", message: "no such model" },
				}),
				{ status: 400 },
			),
			null,
			new Headers(),
		);

		// The other half of the same pairing: the envelope says not-found
		// while the status does not, and `code` must follow the envelope
		// rather than staying null.
		const body = await out.json();
		expect(body.error.type).toBe("invalid_request_error");
		expect(body.error.code).toBe("model_not_found");
	});

	it("passes a literal null JSON body through instead of throwing", async () => {
		const provider = new AnthropicProvider();

		// `JSON.parse("null")` succeeds and yields null, so the try/catch
		// around the parse does not catch this. A throw escaping
		// processResponse is read by the proxy as an account failure, so one
		// intermediary answering `null` would fail the request over every
		// account in the pool and report that all of them failed.
		for (const status of [200, 502]) {
			const out = await provider.processResponse(
				singleModelResponse("null", { status }),
				null,
				new Headers(),
			);
			expect(out.status).toBe(status);
			expect(await out.text()).toBe("null");
		}
	});

	it("passes a JSON array body through instead of translating it", async () => {
		const provider = new AnthropicProvider();
		const out = await provider.processResponse(
			singleModelResponse("[]"),
			null,
			new Headers(),
		);

		expect(await out.text()).toBe("[]");
	});

	it("passes a 200 carrying no id through rather than inventing a model", async () => {
		const provider = new AnthropicProvider();
		const out = await provider.processResponse(
			singleModelResponse(JSON.stringify({ display_name: "nameless" })),
			null,
			new Headers(),
		);

		const body = await out.json();
		// Wrapping this in an OpenAI object would assert a model exists that
		// the upstream never named.
		expect(body.object).toBeUndefined();
		expect(body.display_name).toBe("nameless");
	});
});

describe("AnthropicProvider — the two model routes do not shadow each other", () => {
	it("keeps the exact /v1/models listing on the listing transform", async () => {
		const provider = new AnthropicProvider();
		const out = await provider.processResponse(
			new Response(
				JSON.stringify({
					data: [
						{
							type: "model",
							id: "claude-opus-4-5-20260101",
							display_name: "Claude Opus 4.5",
							created_at: "2026-01-01T00:00:00Z",
						},
					],
					has_more: false,
					first_id: "claude-opus-4-5-20260101",
					last_id: "claude-opus-4-5-20260101",
				}),
				{
					status: 200,
					headers: {
						"content-type": "application/json",
						"x-better-ccflare-request-path": "/v1/models",
					},
				},
			),
			null,
			new Headers(),
		);

		const body = await out.json();
		expect(body.object).toBe("list");
		expect(body.data).toHaveLength(1);
	});

	it("does not treat a trailing slash with no id as a single model", async () => {
		const provider = new AnthropicProvider();
		const out = await provider.processResponse(
			new Response(JSON.stringify({ id: "claude-x" }), {
				status: 200,
				headers: {
					"content-type": "application/json",
					"x-better-ccflare-request-path": "/v1/models/",
				},
			}),
			null,
			new Headers(),
		);

		// `/v1/models/` names no model. Translating it would answer a request
		// the upstream would have rejected.
		const body = await out.json();
		expect(body.object).toBeUndefined();
	});

	it("passes a literal null listing body through instead of throwing", async () => {
		const provider = new AnthropicProvider();
		const out = await provider.processResponse(
			new Response("null", {
				status: 200,
				headers: {
					"content-type": "application/json",
					"x-better-ccflare-request-path": "/v1/models",
				},
			}),
			null,
			new Headers(),
		);

		// Same trap as the single-model path, on the older of the two. Kept
		// here beside its sibling so the pair cannot be fixed on one side only.
		expect(await out.text()).toBe("null");
	});

	it("drops a listing entry with no id rather than emitting an id-less model", async () => {
		const provider = new AnthropicProvider();
		const out = await provider.processResponse(
			new Response(
				JSON.stringify({
					data: [
						{ type: "model", display_name: "no id at all" },
						{
							type: "model",
							id: "claude-real",
							display_name: "Claude Real",
							created_at: "2026-01-01T00:00:00Z",
						},
					],
					has_more: false,
					first_id: null,
					last_id: "claude-real",
				}),
				{
					status: 200,
					headers: {
						"content-type": "application/json",
						"x-better-ccflare-request-path": "/v1/models",
					},
				},
			),
			null,
			new Headers(),
		);

		const body = await out.json();
		// The pre-map filter is the only thing standing between an entry with
		// no id and `toOpenAIModelEntry`'s `model.id as string` cast, which
		// would put `{"id": undefined}` in the listing. Nothing pinned that
		// filter before, so deleting it passed the whole suite.
		expect(body.data).toHaveLength(1);
		expect(body.data[0].id).toBe("claude-real");
		expect(body.data.some((m: { id?: string }) => m.id === undefined)).toBe(
			false,
		);
	});

	it("leaves an unrelated /v1 path alone", async () => {
		const provider = new AnthropicProvider();
		const out = await provider.processResponse(
			new Response(JSON.stringify({ id: "msg_1", type: "message" }), {
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
		expect(body.type).toBe("message");
		expect(body.object).toBeUndefined();
	});
});
