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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResolverManager } from "@better-ccflare/core";
import {
	AsyncDbWriter,
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import {
	type HandleProxyFn,
	handleCompletionsRequest,
} from "@better-ccflare/openai-responses-adapter";
import { handleProxy, type ProxyContext } from "@better-ccflare/proxy";
import type { Account } from "@better-ccflare/types";
import { makeProxyContext } from "../../../packages/proxy/src/__tests__/proxy-context-fixture";
// The module record proxy.ts and response-handler.ts import from; the package
// entry re-exports nothing that would let a spy reach it.
import * as usageCollectorModule from "../../../packages/proxy/src/usage-collector";

/**
 * SB23-1970: token accounting survives the legacy Completions translation.
 *
 * The issue's trap: `UsageCollector` parses the Anthropic answer, so a
 * translation upstream of the collector would break usage recording silently.
 * This drives the real chain, `handleCompletionsRequest` into the real
 * `handleProxy`, account selection, `forwardToClient` and its analytics tee,
 * against an `anthropic-compatible` account whose endpoint is a loopback
 * `Bun.serve`, and the real `UsageCollector` writing a `requests` row to a
 * temporary database. The assertions read that row. The test network guard
 * refuses anything that is not loopback.
 */

const INPUT_TOKENS = 11;
const OUTPUT_TOKENS = 7;

const MESSAGE_200 = JSON.stringify({
	id: "msg_1",
	type: "message",
	role: "assistant",
	model: "stub-model",
	content: [{ type: "text", text: "hello" }],
	stop_reason: "end_turn",
	stop_sequence: null,
	usage: { input_tokens: INPUT_TOKENS, output_tokens: OUTPUT_TOKENS },
});

const SSE_200 = [
	`event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"stub-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":${INPUT_TOKENS},"output_tokens":1}}}\n\n`,
	`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
	`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n`,
	`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
	`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":${OUTPUT_TOKENS}}}\n\n`,
	`event: message_stop\ndata: {"type":"message_stop"}\n\n`,
].join("");

let server: ReturnType<typeof Bun.serve>;
let answer: () => Response = () => new Response("no stub", { status: 500 });
const upstreamBodies: Array<Record<string, unknown>> = [];

const dir = mkdtempSync(join(tmpdir(), "legacy-completions-accounting-"));
let dbOps: DatabaseOperations;
let collector: usageCollectorModule.UsageCollector;
let collectorSpy: ReturnType<typeof spyOn> | null = null;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			upstreamBodies.push(
				(await req.json().catch(() => ({}))) as Record<string, unknown>,
			);
			return answer();
		},
	});
	DatabaseFactory.initialize(join(dir, `accounting-${process.pid}.db`));
	dbOps = DatabaseFactory.getInstance();
	collector = new usageCollectorModule.UsageCollector(
		dbOps,
		new AsyncDbWriter(),
		() => false,
		() => {},
	);
	collectorSpy = spyOn(
		usageCollectorModule,
		"getUsageCollector",
	).mockReturnValue(collector);
});

// `trash` hands the directory to Finder and measured 6.06 s on this machine
// under load, past Bun's 5000 ms default hook limit.
afterAll(async () => {
	collectorSpy?.mockRestore();
	collector.dispose();
	await collector.drain();
	DatabaseFactory.reset();
	server.stop(true);
	await Bun.$`trash ${dir}`.quiet().nothrow();
}, 30_000);

afterEach(() => {
	upstreamBodies.length = 0;
});

function makeAccount(): Account {
	return {
		id: "acc-loop",
		name: "stub-loop",
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
		custom_endpoint: `http://127.0.0.1:${server.port}`,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
	} as Account;
}

function makeContext(): ProxyContext {
	const accounts = [makeAccount()];
	return makeProxyContext({
		strategy: { select: (accs: Account[]) => accs },
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => null),
			markAccountRateLimited: mock(async () => ({
				consecutiveRateLimits: 1,
				applied: true,
			})),
			resolverManager: new ResolverManager(),
		},
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
			getForceAccountModel: () => false,
			getModelScopedCapacityRouting: () => "off",
			getCombosEnabled: () => true,
			getStorePayloads: () => false,
		},
		provider: {
			name: "anthropic",
			canHandle: () => true,
			observeRequest: undefined,
		},
		asyncWriter: { enqueue: mock(() => {}) },
	});
}

interface Row {
	path: string;
	status_code: number;
	input_tokens: number;
	output_tokens: number;
	inbound_format: string | null;
}

/** The collector's save runs on the async writer, so poll for the row. */
async function onlyRow(): Promise<Row> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const rows = await dbOps
			.getAdapter()
			.query<Row & { output_tokens: number }>(
				"SELECT path, status_code, input_tokens, output_tokens, inbound_format FROM requests",
			);
		if (rows.length > 0 && (rows[0]?.output_tokens ?? 0) > 0) {
			expect(rows).toHaveLength(1);
			return rows[0] as Row;
		}
		await Bun.sleep(20);
	}
	throw new Error("no requests row with tokens was written");
}

async function send(body: Record<string, unknown>): Promise<Response> {
	const req = new Request("http://proxy.local/v1/completions", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return handleCompletionsRequest(
		req,
		new URL(req.url),
		handleProxy as HandleProxyFn,
		makeContext(),
	);
}

describe("legacy Completions: the requests row carries the upstream's tokens", () => {
	afterEach(async () => {
		await dbOps.getAdapter().run("DELETE FROM requests");
	});

	it("non-streaming", async () => {
		answer = () =>
			new Response(MESSAGE_200, {
				headers: { "content-type": "application/json" },
			});
		const resp = await send({ model: "stub-model", prompt: "Say hello" });
		expect(resp.status).toBe(200);
		const body = (await resp.json()) as {
			object: string;
			choices: Array<{ text: string }>;
			usage: { prompt_tokens: number; completion_tokens: number };
		};
		expect(body.object).toBe("text_completion");
		expect(body.choices[0]?.text).toBe("hello");
		expect(body.usage.prompt_tokens).toBe(INPUT_TOKENS);
		expect(body.usage.completion_tokens).toBe(OUTPUT_TOKENS);
		expect(upstreamBodies).toEqual([
			{
				model: "stub-model",
				max_tokens: 16,
				messages: [{ role: "user", content: "Say hello" }],
			},
		]);

		expect(await onlyRow()).toEqual({
			path: "/v1/messages",
			status_code: 200,
			input_tokens: INPUT_TOKENS,
			output_tokens: OUTPUT_TOKENS,
			inbound_format: "openai-completions",
		});
	});

	it("streaming: the collector parses the Anthropic stream the client never sees", async () => {
		answer = () =>
			new Response(SSE_200, {
				headers: { "content-type": "text/event-stream" },
			});
		const resp = await send({
			model: "stub-model",
			prompt: "Say hello",
			stream: true,
		});
		expect(resp.status).toBe(200);
		const text = await resp.text();
		expect(text).toContain('"object":"text_completion"');
		expect(text).not.toContain("message_start");
		expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);

		expect(await onlyRow()).toEqual({
			path: "/v1/messages",
			status_code: 200,
			input_tokens: INPUT_TOKENS,
			output_tokens: OUTPUT_TOKENS,
			inbound_format: "openai-completions",
		});
	});
});
