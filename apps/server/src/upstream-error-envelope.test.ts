import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import {
	dispatchOpenAIGatewayRequest,
	type HandleProxyFn,
	handleChatCompletionsRequest,
	handleResponsesRequest,
} from "@better-ccflare/openai-responses-adapter";
import { handleProxy, type ProxyContext } from "@better-ccflare/proxy";
import {
	type Account,
	parseOpenAIGateways,
	UPSTREAM_CONTENT_TYPE_HEADER,
} from "@better-ccflare/types";
// The module record proxy.ts and response-handler.ts import from; the package
// entry re-exports nothing that would let a spy reach it.
import * as usageCollectorModule from "../../../packages/proxy/src/usage-collector";

/**
 * SB23-3494 through the real relay: `handleProxy`, account selection, the
 * error classifiers, `forwardToClient` and its analytics tee, against an
 * `anthropic-compatible` account whose endpoint is a loopback `Bun.serve`.
 * The test network guard refuses anything that is not loopback.
 */

const CLOUDFLARE_400 = `<html>
<head><title>400 Bad Request</title></head>
<body>
<center><h1>400 Bad Request</h1></center>
<hr><center>cloudflare</center>
</body>
</html>
`;

const CLOUDFLARE_502 = `<!DOCTYPE html>
<html><head><title>example.com | 502: Bad gateway</title></head>
<body><h1>Bad gateway</h1><p>Error code 502</p></body></html>
`;

type Answer = () => Response;

/** One loopback upstream; each account is a path prefix on it. */
const answers = new Map<string, Answer>();
const hits = new Map<string, number>();
let server: ReturnType<typeof Bun.serve>;

function html(body: string, status: number): Response {
	return new Response(body, {
		status,
		headers: {
			"content-type": "text/html; charset=UTF-8",
			server: "cloudflare",
			"cf-ray": "8c0ffee-LHR",
		},
	});
}

const JSON_400 =
	'{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: Field required"}}';

const MESSAGE_200 = JSON.stringify({
	id: "msg_1",
	type: "message",
	role: "assistant",
	model: "stub-model",
	content: [{ type: "text", text: "hello" }],
	stop_reason: "end_turn",
	stop_sequence: null,
	usage: { input_tokens: 3, output_tokens: 1 },
});

const SSE_200 = [
	`event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"stub-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}\n\n`,
	`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
	`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n`,
	`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
	`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n`,
	`event: message_stop\ndata: {"type":"message_stop"}\n\n`,
].join("");

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			const prefix = new URL(req.url).pathname.split("/")[1] ?? "";
			hits.set(prefix, (hits.get(prefix) ?? 0) + 1);
			const answer = answers.get(prefix);
			return answer
				? answer()
				: new Response("no stub", { status: 500, headers: {} });
		},
	});
});

afterAll(() => {
	server.stop(true);
});

function makeAccount(
	prefix: string,
	overrides: Partial<Account> = {},
): Account {
	return {
		id: `acc-${prefix}`,
		name: `stub-${prefix}`,
		provider: "anthropic-compatible",
		api_key: "loopback-test-key",
		refresh_token: null,
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
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
		custom_endpoint: `http://127.0.0.1:${server.port}/${prefix}`,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	} as Account;
}

interface Harness {
	ctx: ProxyContext;
}

function makeHarness(accounts: Account[]): Harness {
	const markAccountRateLimited = mock(async () => ({
		consecutiveRateLimits: 1,
		applied: true,
	}));
	const ctx = {
		strategy: {
			select: (accs: Account[]) => {
				const now = Date.now();
				return accs.filter(
					(acc) =>
						!acc.paused &&
						(!acc.rate_limited_until || acc.rate_limited_until <= now),
				);
			},
		},
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => null),
			markAccountRateLimited,
			resolverManager: {
				current: () => ({
					resolve: () => ({ projectId: null, worktreePath: null }),
				}),
			},
		},
		// One attempt, so a 5xx is not retried in place at a 1000ms base.
		runtime: {
			port: 0,
			clientId: "test",
			sessionDurationMs: 5 * 60 * 60 * 1000,
			retry: { attempts: 1, delayMs: 1, backoff: 1 },
		},
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getStorePayloads: () => true,
		},
		provider: { name: "anthropic", canHandle: () => true },
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) },
	} as unknown as ProxyContext;
	return { ctx };
}

/** What the analytics path recorded, captured by the collector spy. */
interface Recorded {
	starts: Array<Record<string, unknown>>;
	ends: Array<Record<string, unknown>>;
}

let collectorSpy: ReturnType<typeof spyOn> | null = null;

function spyCollector(): Recorded {
	const recorded: Recorded = { starts: [], ends: [] };
	collectorSpy = spyOn(
		usageCollectorModule,
		"getUsageCollector",
	).mockReturnValue({
		handleStart: (msg: Record<string, unknown>) => {
			recorded.starts.push(msg);
		},
		handleChunk: () => {},
		handleEnd: async (msg: Record<string, unknown>) => {
			recorded.ends.push(msg);
		},
	} as unknown as usageCollectorModule.UsageCollector);
	return recorded;
}

afterEach(() => {
	collectorSpy?.mockRestore();
	collectorSpy = null;
	answers.clear();
	hits.clear();
});

function messagesRequest(stream = false): Request {
	return new Request("http://proxy.local/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "stub-model",
			max_tokens: 16,
			stream,
			messages: [{ role: "user", content: "hi" }],
		}),
	});
}

function send(ctx: ProxyContext, req: Request): Promise<Response> {
	return handleProxy(req, new URL(req.url), ctx);
}

/** Lets the analytics tee's background onClose run. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await Bun.sleep(5);
}

describe("an HTML upstream error reaches a /v1 client as JSON", () => {
	it("Cloudflare HTML 400: status kept, JSON envelope, header set, analytics raw", async () => {
		answers.set("a", () => html(CLOUDFLARE_400, 400));
		const recorded = spyCollector();
		const { ctx } = makeHarness([makeAccount("a")]);

		const response = await send(ctx, messagesRequest());

		expect(response.status).toBe(400);
		expect(response.headers.get("content-type")).toBe("application/json");
		expect(response.headers.get(UPSTREAM_CONTENT_TYPE_HEADER)).toBe(
			"text/html; charset=UTF-8",
		);
		expect(response.headers.get("server")).toBe("cloudflare");
		expect(await response.json()).toEqual({
			type: "error",
			error: {
				type: "upstream_error",
				message:
					"Upstream returned HTTP 400 with a non-JSON body (text/html): 400 Bad Request 400 Bad Request cloudflare",
			},
		});

		// The analytics path recorded what the upstream actually sent: the raw
		// status, the HTML content type and the HTML body.
		await settle();
		expect(recorded.starts).toHaveLength(1);
		expect(recorded.starts[0]?.responseStatus).toBe(400);
		expect(
			(recorded.starts[0]?.responseHeaders as Record<string, string>)[
				"content-type"
			],
		).toBe("text/html; charset=UTF-8");
		const end = recorded.ends.find((e) => e.responseBody !== undefined);
		expect(
			Buffer.from(String(end?.responseBody), "base64").toString("utf-8"),
		).toBe(CLOUDFLARE_400);
	});

	it("HTML 502 on the last candidate: forwarded with its status, as JSON", async () => {
		answers.set("a", () => html(CLOUDFLARE_502, 502));
		spyCollector();
		const { ctx } = makeHarness([makeAccount("a")]);

		const response = await send(ctx, messagesRequest());

		expect(response.status).toBe(502);
		expect(response.headers.get("content-type")).toBe("application/json");
		expect(response.headers.get(UPSTREAM_CONTENT_TYPE_HEADER)).toBe(
			"text/html; charset=UTF-8",
		);
		const body = await response.json();
		expect(body.type).toBe("error");
		expect(body.error.type).toBe("upstream_error");
		expect(body.error.message).toBe(
			"Upstream returned HTTP 502 with a non-JSON body (text/html): example.com | 502: Bad gateway Bad gateway Error code 502",
		);
	});
});

describe("what the envelope must not touch", () => {
	it("a JSON 400 passes byte-identical, with no upstream-type header", async () => {
		answers.set(
			"a",
			() =>
				new Response(JSON_400, {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		);
		spyCollector();
		const { ctx } = makeHarness([makeAccount("a")]);

		const response = await send(ctx, messagesRequest());

		expect(response.status).toBe(400);
		expect(response.headers.get("content-type")).toBe("application/json");
		expect(response.headers.get(UPSTREAM_CONTENT_TYPE_HEADER)).toBeNull();
		expect(await response.text()).toBe(JSON_400);
	});

	it("a streaming 200 passes byte-identical", async () => {
		answers.set(
			"a",
			() =>
				new Response(SSE_200, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);
		spyCollector();
		const { ctx } = makeHarness([makeAccount("a")]);

		const response = await send(ctx, messagesRequest(true));

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		expect(response.headers.get(UPSTREAM_CONTENT_TYPE_HEADER)).toBeNull();
		expect(await response.text()).toBe(SSE_200);
	});

	it("failover still classifies the raw HTML 429: the account is benched and the next one answers", async () => {
		answers.set("a", () => html("<h1>429 Too Many Requests</h1>", 429));
		answers.set(
			"b",
			() =>
				new Response(MESSAGE_200, {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		spyCollector();
		const first = makeAccount("a", { priority: 0 });
		const second = makeAccount("b", { priority: 1 });
		const { ctx } = makeHarness([first, second]);

		const response = await send(ctx, messagesRequest());

		expect(hits.get("a")).toBe(1);
		expect(hits.get("b")).toBe(1);
		expect(response.status).toBe(200);
		expect(response.headers.get(UPSTREAM_CONTENT_TYPE_HEADER)).toBeNull();
		expect(await response.text()).toBe(MESSAGE_200);
		expect(first.rate_limited_until).toBeGreaterThan(Date.now());
		expect(second.rate_limited_until).toBeNull();
	});
});

describe("the OpenAI Chat Completions paths", () => {
	function chatRequest(path: string): Request {
		return new Request(`http://proxy.local${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "stub-model",
				max_tokens: 16,
				messages: [{ role: "user", content: "hi" }],
			}),
		});
	}

	it("/v1/chat/completions answers an HTML 502 in the OpenAI error shape", async () => {
		answers.set("a", () => html(CLOUDFLARE_502, 502));
		spyCollector();
		const { ctx } = makeHarness([makeAccount("a")]);
		const req = chatRequest("/v1/chat/completions");

		const response = await handleChatCompletionsRequest(
			req,
			new URL(req.url),
			handleProxy as HandleProxyFn,
			ctx,
		);

		expect(response.status).toBe(502);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(response.headers.get(UPSTREAM_CONTENT_TYPE_HEADER)).toBe(
			"text/html; charset=UTF-8",
		);
		const body = await response.json();
		expect(body.error.type).toBe("upstream_error");
		expect(body.error.message).toBe(
			"Upstream returned HTTP 502 with a non-JSON body (text/html): example.com | 502: Bad gateway Bad gateway Error code 502",
		);
		expect(body.error.message).not.toContain("<");
	});

	it("a named gateway answers an HTML 400 in the OpenAI error shape", async () => {
		answers.set("a", () => html(CLOUDFLARE_400, 400));
		spyCollector();
		const { ctx } = makeHarness([makeAccount("a")]);
		const { gateways, errors } = parseOpenAIGateways({ gw: {} });
		expect(errors).toEqual([]);
		const req = chatRequest("/v1/gateways/gw/chat/completions");

		const response = await dispatchOpenAIGatewayRequest(
			req,
			new URL(req.url),
			{ name: "gw", rest: "/chat/completions" },
			gateways,
			handleProxy as HandleProxyFn,
			ctx,
		);

		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.error.type).toBe("upstream_error");
		expect(body.error.message).toBe(
			"Upstream returned HTTP 400 with a non-JSON body (text/html): 400 Bad Request 400 Bad Request cloudflare",
		);
	});

	it("/v1/responses answers an HTML 400 with the upstream text, not a generic line", async () => {
		answers.set("a", () => html(CLOUDFLARE_400, 400));
		spyCollector();
		const { ctx } = makeHarness([makeAccount("a")]);
		const req = new Request("http://proxy.local/v1/responses", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "stub-model", input: "hi" }),
		});

		const response = await handleResponsesRequest(
			req,
			new URL(req.url),
			handleProxy as HandleProxyFn,
			ctx,
		);

		expect(response.status).toBe(400);
		expect(response.headers.get("content-type")).toBe("application/json");
		expect(await response.json()).toEqual({
			error: {
				message:
					"Upstream returned HTTP 400 with a non-JSON body (text/html): 400 Bad Request 400 Bad Request cloudflare",
				type: "upstream_error",
				code: "upstream_error",
			},
		});
	});
});
