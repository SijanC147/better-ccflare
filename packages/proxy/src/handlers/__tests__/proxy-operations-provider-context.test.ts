import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	getProvider,
	type Provider,
	type ProviderRequestContext,
} from "@better-ccflare/providers";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { fetchSlot } from "../../__tests__/fetch-slot";
import { makeProxyContext } from "../../__tests__/proxy-context-fixture";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

/**
 * SB23-2508. `proxyWithAccount` creates one `ProviderRequestContext` per
 * upstream attempt and must hand that same object to `prepareRequest`,
 * `buildUrl` and every `processResponse` call the attempt makes. A provider
 * keys per-request state on it, so a fresh literal at any one of those sites
 * silently drops that state: vertex-ai would then build its URL with the
 * fallback model, or return the Vertex model name to the client.
 *
 * The provider-level tests in
 * `packages/providers/src/providers/vertex-ai/__tests__/shared-account-state.test.ts`
 * cannot see a call site, so this file pins the threading itself, then drives
 * two concurrent requests through the real vertex-ai provider on one shared
 * account object, the case that used to cross-contaminate.
 */

const BASE_ACCOUNT: Account = {
	id: "acc-1",
	name: "provider-context-test",
	// Unregistered name: proxyWithAccount resolves getProvider(account.provider)
	// first and only falls back to ctx.provider when the registry misses.
	provider: "stub-provider-context",
	api_key: "test-key",
	refresh_token: "",
	access_token: null,
	expires_at: null,
	request_count: 0,
	total_requests: 0,
	last_used: null,
	created_at: 0,
	rate_limited_until: null,
	rate_limited_reason: null,
	rate_limited_at: null,
	session_start: null,
	session_request_count: 0,
	paused: false,
	rate_limit_reset: null,
	rate_limit_status: null,
	rate_limit_remaining: null,
	priority: 0,
	auto_fallback_enabled: false,
	auto_refresh_enabled: false,
	auto_pause_on_overage_enabled: false,
	peak_hours_pause_enabled: false,
	custom_endpoint: "https://upstream.local/v1",
	model_mappings: null,
	cross_region_mode: null,
	model_fallbacks: null,
	billing_type: null,
	pause_reason: null,
	refresh_token_issued_at: null,
	consecutive_rate_limits: 0,
	requires_reauth: false,
	request_transformer: null,
	last_manual_reauth_at: null,
	renewal_day: null,
	usage_pause_five_hour_threshold: null,
	usage_pause_weekly_threshold: null,
	usage_pause_five_hour_enabled: false,
	usage_pause_weekly_enabled: false,
	usage_pause_five_hour_min_reset_remaining_ms: null,
	usage_pause_weekly_min_reset_remaining_ms: null,
};

function makeRequestMeta(id: string): RequestMeta {
	return {
		id,
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function bodyFor(model: string): ArrayBuffer {
	const bytes = new TextEncoder().encode(
		JSON.stringify({
			model,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 10,
		}),
	);
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

function messageResponse(model: string, status = 200): Response {
	return new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			model,
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 1 },
		}),
		{ status, headers: { "content-type": "application/json" } },
	);
}

function overloaded(): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "overloaded_error", message: "Overloaded" },
		}),
		{ status: 529, headers: { "content-type": "application/json" } },
	);
}

type Hook = "prepareRequest" | "buildUrl" | "processResponse";

interface Seen {
	hook: Hook;
	context: ProviderRequestContext | undefined;
	requestModel?: string | null;
}

function makeContext(provider: Partial<Provider>): ProxyContext {
	return makeProxyContext({
		dbOps: {
			markAccountRateLimited: mock(() =>
				Promise.resolve({ consecutiveRateLimits: 1, applied: true }),
			),
			saveRequest: mock((..._args: unknown[]) => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			resolverManager: undefined,
		},
		runtime: { clientId: "test" },
		provider: {
			name: "anthropic-compatible",
			canHandle: () => true,
			buildUrl: () => "https://upstream.local/v1/messages",
			prepareHeaders: () => new Headers(),
			prepareRequest: undefined,
			observeUpstream: undefined,
			extractUsageInfo: undefined,
			transformRequestBody: undefined,
			processResponse: async (response: Response) => response,
			parseRateLimit: (response: Response) => ({
				isRateLimited: response.status === 529,
				resetTime: undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
			...provider,
		},
		asyncWriter: { enqueue: mock(() => {}) },
		config: { getStorePayloads: () => true },
		internalProbeSecret: "test-secret",
	});
}

// forwardToClient needs UsageCollector wiring absent in unit tests; every
// provider hook this file observes runs before that point.
async function dispatch(
	account: Account,
	requestId: string,
	body: ArrayBuffer,
	ctx: ProxyContext,
): Promise<void> {
	const req = new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "content-type": "application/json" },
	});
	try {
		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(requestId),
			body,
			() => undefined,
			0,
			ctx,
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (!msg.includes("UsageCollector not initialized")) throw e;
	}
}

describe("proxyWithAccount — per-request provider carrier (SB23-2508)", () => {
	let originalFetch: typeof globalThis.fetch;
	const savedEnv: Record<string, string | undefined> = {};
	const ENV_KEYS = [
		"CCFLARE_OVERLOAD_RETRY_ENABLED",
		"CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS",
		"CCFLARE_OVERLOAD_RETRY_BASE_MS",
		"CCFLARE_OVERLOAD_RETRY_MAX_MS",
	];

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
		process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = "true";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "2";
		process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = "0";
	});

	afterEach(() => {
		fetchSlot.fetch = originalFetch;
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	it("hands one carrier to every hook of an attempt, the in-place retry included", async () => {
		let fetchCount = 0;
		fetchSlot.fetch = mock(async () => {
			fetchCount++;
			return fetchCount === 1 ? overloaded() : messageResponse("m-upstream");
		});

		const seen: Seen[] = [];
		const ctx = makeContext({
			prepareRequest: (_req, _body, _account, context) => {
				seen.push({ hook: "prepareRequest", context });
			},
			buildUrl: (_path, _query, _account, context) => {
				seen.push({ hook: "buildUrl", context });
				return "https://upstream.local/v1/messages";
			},
			processResponse: async (
				response,
				_account,
				_headers,
				_drain,
				context,
			) => {
				seen.push({
					hook: "processResponse",
					context,
					requestModel: context?.requestModel,
				});
				return response;
			},
		});

		await dispatch(BASE_ACCOUNT, "req-1", bodyFor("m-client"), ctx);

		expect(fetchCount).toBe(2);
		expect(seen.map((s) => s.hook)).toEqual([
			"prepareRequest",
			"buildUrl",
			"processResponse",
			"processResponse",
		]);
		const carrier = seen[0].context;
		expect(carrier).toBeDefined();
		for (const entry of seen) expect(entry.context).toBe(carrier);
		// What openai reads: the model actually sent upstream, at each call.
		expect(seen[2].requestModel).toBe("m-client");
		expect(seen[3].requestModel).toBe("m-client");
	});

	it("gives each attempt its own carrier", async () => {
		fetchSlot.fetch = mock(async () => messageResponse("m-upstream"));

		const carriers: (ProviderRequestContext | undefined)[] = [];
		const ctx = makeContext({
			prepareRequest: (_req, _body, _account, context) => {
				carriers.push(context);
			},
		});

		await dispatch(BASE_ACCOUNT, "req-1", bodyFor("m-client"), ctx);
		await dispatch(BASE_ACCOUNT, "req-2", bodyFor("m-client"), ctx);

		expect(carriers).toHaveLength(2);
		expect(carriers[0]).toBeDefined();
		expect(carriers[0]).not.toBe(carriers[1]);
	});

	/**
	 * Two concurrent requests through the real vertex-ai provider, handed the
	 * SAME account object, both prepared before either response comes back.
	 * Before SB23-2508 the provider stashed each request's model on that object,
	 * so whichever request was prepared second overwrote the first, and the
	 * first request's URL was right while its response was restored with the
	 * other request's model.
	 */
	it("keeps two concurrent vertex-ai requests on one shared account apart", async () => {
		const vertex = getProvider("vertex-ai");
		if (!vertex) throw new Error("vertex-ai is not registered");

		const MODEL_A = "claude-sonnet-4-5-20250929";
		const MODEL_B = "claude-haiku-4-5-20251001";
		const VERTEX_A = "claude-sonnet-4-5@20250929";
		const VERTEX_B = "claude-haiku-4-5@20251001";

		const shared: Account = {
			...BASE_ACCOUNT,
			id: "vertex-1",
			name: "vertex-1",
			provider: "vertex-ai",
			api_key: null,
			// A live token keeps getValidAccessToken off GoogleAuth.
			access_token: "test-access-token",
			expires_at: Date.now() + 60 * 60 * 1000,
			custom_endpoint: JSON.stringify({
				projectId: "test-project",
				region: "us-east5",
			}),
		};

		// Hold every upstream answer until both requests have dispatched, so
		// both prepareRequest calls land before either processResponse.
		const urls: string[] = [];
		let releaseAll: () => void = () => {};
		const bothDispatched = new Promise<void>((resolve) => {
			releaseAll = resolve;
		});
		fetchSlot.fetch = mock(async (input: RequestInfo | URL) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url;
			urls.push(url);
			if (urls.length === 2) releaseAll();
			await bothDispatched;
			return messageResponse(url.includes(VERTEX_A) ? VERTEX_A : VERTEX_B);
		});

		const restored = new Map<string, string>();
		const originalProcessResponse = vertex.processResponse;
		vertex.processResponse = async (response, account, ...rest) => {
			const out = await originalProcessResponse.call(
				vertex,
				response,
				account,
				...rest,
			);
			const requestId = response.headers.get("x-better-ccflare-request-id");
			const body = (await out.clone().json()) as { model?: string };
			if (requestId) restored.set(requestId, body.model ?? "");
			return out;
		};

		// If a request never reaches fetch, the other waits on the gate forever;
		// fail with the cause instead of Bun's test timeout.
		let stallTimer: ReturnType<typeof setTimeout> | undefined;
		const stalled = new Promise<never>((_, reject) => {
			stallTimer = setTimeout(
				() =>
					reject(new Error(`only ${urls.length} of 2 requests reached fetch`)),
				3000,
			);
		});
		try {
			const ctx = makeContext({});
			await Promise.race([
				Promise.all([
					dispatch(shared, "req-a", bodyFor(MODEL_A), ctx),
					dispatch(shared, "req-b", bodyFor(MODEL_B), ctx),
				]),
				stalled,
			]);
		} finally {
			clearTimeout(stallTimer);
			releaseAll();
			vertex.processResponse = originalProcessResponse;
		}

		expect(urls).toHaveLength(2);
		expect(urls.some((u) => u.includes(`/models/${VERTEX_A}:`))).toBe(true);
		expect(urls.some((u) => u.includes(`/models/${VERTEX_B}:`))).toBe(true);
		expect(restored.get("req-a")).toBe(MODEL_A);
		expect(restored.get("req-b")).toBe(MODEL_B);
		expect(Object.keys(shared)).not.toContain("_originalModel");
		expect(Object.keys(shared)).not.toContain("_vertexModel");
	});

	/**
	 * SB23-3971. vertex-ai names the model in the URL path, not the body, so a
	 * model fallback has to re-derive it and rebuild the URL. The loop used to
	 * re-send to the URL built for the first model, with `model` re-added to a
	 * body vertex had removed it from, and the response was restored with the
	 * first model's name. The fallback is in the primary's family on purpose:
	 * re-applying the account mapping to it would map it back to the primary.
	 */
	it("sends a vertex-ai model fallback to the fallback model's URL and reports that model", async () => {
		const vertex = getProvider("vertex-ai");
		if (!vertex) throw new Error("vertex-ai is not registered");

		const PRIMARY = "claude-sonnet-4-5-20250929";
		const FALLBACK = "claude-sonnet-4-20250514";
		const account: Account = {
			...BASE_ACCOUNT,
			id: "vertex-fallback",
			name: "vertex-fallback",
			provider: "vertex-ai",
			api_key: null,
			access_token: "test-access-token",
			expires_at: Date.now() + 60 * 60 * 1000,
			custom_endpoint: JSON.stringify({
				projectId: "test-project",
				region: "us-east5",
			}),
			model_mappings: JSON.stringify({ sonnet: [PRIMARY, FALLBACK] }),
		};

		const sent: { url: string; body: Record<string, unknown> }[] = [];
		fetchSlot.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input as Request;
			sent.push({
				url: request.url,
				body: (await request.clone().json()) as Record<string, unknown>,
			});
			return sent.length === 1
				? new Response(
						JSON.stringify({
							type: "error",
							error: { type: "rate_limit_error", message: "Rate limited" },
						}),
						{ status: 429, headers: { "content-type": "application/json" } },
					)
				: messageResponse("claude-sonnet-4@20250514");
		});

		let restored: string | undefined;
		let carrierAtResponse: ProviderRequestContext | undefined;
		const originalProcessResponse = vertex.processResponse;
		vertex.processResponse = async (response, acct, ...rest) => {
			carrierAtResponse = rest[2];
			const out = await originalProcessResponse.call(
				vertex,
				response,
				acct,
				...rest,
			);
			if (out.ok)
				restored = ((await out.clone().json()) as { model?: string }).model;
			return out;
		};
		try {
			await dispatch(
				account,
				"req-fallback",
				bodyFor(PRIMARY),
				makeContext({}),
			);
		} finally {
			vertex.processResponse = originalProcessResponse;
		}

		expect(sent).toHaveLength(2);
		expect(sent[0].url).toContain("/models/claude-sonnet-4-5@20250929:");
		expect(sent[1].url).toContain("/models/claude-sonnet-4@20250514:");
		expect(sent[0].body).not.toHaveProperty("model");
		expect(sent[1].body).not.toHaveProperty("model");
		expect(restored).toBe(FALLBACK);
		// The fallback name is cleared once the loop is done with it.
		expect(carrierAtResponse).toBeDefined();
		expect(carrierAtResponse).not.toHaveProperty("fallbackModel");
	});
});
