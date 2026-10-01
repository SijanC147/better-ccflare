import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import {
	type HandleProxyFn,
	handleResponsesRequest,
} from "@better-ccflare/openai-responses-adapter";
import { handleProxy, type ProxyContext } from "@better-ccflare/proxy";
import type { Account } from "@better-ccflare/types";
// The module record proxy.ts and response-handler.ts import from; the package
// entry re-exports nothing that would let a spy reach it.
import * as usageCollectorModule from "../../../packages/proxy/src/usage-collector";

/**
 * SB23-2370 through the real relay: `handleResponsesRequest`, `handleProxy`,
 * account selection and the real `CodexProvider`, against two Codex accounts
 * whose endpoints are path prefixes on one loopback `Bun.serve`. The test
 * network guard refuses anything that is not loopback.
 *
 * The stub upstream behaves as `openai/codex` `client.rs` describes: it issues
 * `x-codex-turn-state` on a request that carries none, and it is account-
 * specific, so A issues `ts-a-<n>` and B issues `ts-b-<n>`, `<n>` unique.
 */

const TURN_STATE = "x-codex-turn-state";
const TURN_METADATA = "x-codex-turn-metadata";

interface Seen {
	account: string;
	turnState: string | null;
	turnMetadata: string | null;
}

const seen: Seen[] = [];
/**
 * Never reset: the provider's store is a registry singleton that outlives one
 * test, so a token value reused across tests would be a hit nothing earned.
 * Real tokens are opaque and unique.
 */
let issuedSeq = 0;
/** Per-account answer overrides, consumed first. */
const queued = new Map<string, Array<() => Response>>();
let server: ReturnType<typeof Bun.serve>;

const RESPONSES_SSE = [
	`event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","object":"response","model":"gpt-5.5","status":"in_progress","output":[]}}\n\n`,
	`event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"hi"}\n\n`,
	`event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","object":"response","model":"gpt-5.5","status":"completed","output":[{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}],"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n`,
].join("");

const RESPONSES_JSON = JSON.stringify({
	id: "resp_1",
	object: "response",
	model: "gpt-5.5",
	status: "completed",
	output: [
		{
			id: "msg_1",
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "hi" }],
		},
	],
	usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
});

let answerJson = false;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			const account = new URL(req.url).pathname.split("/")[1] ?? "";
			const turnState = req.headers.get(TURN_STATE);
			seen.push({
				account,
				turnState,
				turnMetadata: req.headers.get(TURN_METADATA),
			});
			const override = queued.get(account)?.shift();
			if (override) return override();
			const headers: Record<string, string> = {
				"content-type": answerJson ? "application/json" : "text/event-stream",
			};
			if (!turnState) {
				issuedSeq += 1;
				headers[TURN_STATE] = `ts-${account}-${issuedSeq}`;
			}
			return new Response(answerJson ? RESPONSES_JSON : RESPONSES_SSE, {
				status: 200,
				headers,
			});
		},
	});
});

afterAll(() => {
	server.stop(true);
});

function codexAccount(prefix: string): Account {
	return {
		id: `acc-${prefix}`,
		name: `CDX-${prefix}`,
		provider: "codex",
		api_key: null,
		refresh_token: "refresh",
		access_token: `codex-access-${prefix}`,
		// Beyond the refresh window, so no token refresh is fetched.
		expires_at: Date.now() + 3 * 60 * 60 * 1000,
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
		custom_endpoint: `http://127.0.0.1:${server.port}/${prefix}/backend-api/codex/responses`,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
	} as Account;
}

/** A third-party OpenAI-compatible account on the same stub. */
function openAiCompatibleAccount(): Account {
	return {
		...codexAccount("oc"),
		id: "acc-oc",
		name: "OC",
		provider: "openai-compatible",
		api_key: "oc-test-key",
		refresh_token: null,
		access_token: null,
		expires_at: null,
		custom_endpoint: `http://127.0.0.1:${server.port}/oc`,
	} as Account;
}

/** The order the strategy hands accounts to the proxy, set per request. */
let route: string[] = ["a", "b"];

function makeCtx(): ProxyContext {
	return {
		strategy: {
			select: (accs: Account[]) =>
				route
					.map((prefix) => accs.find((acc) => acc.id === `acc-${prefix}`))
					.filter((acc): acc is Account => acc !== undefined),
		},
		dbOps: {
			getAllAccounts: mock(async () => [
				codexAccount("a"),
				codexAccount("b"),
				openAiCompatibleAccount(),
			]),
			getActiveComboForFamily: mock(async () => null),
			markAccountRateLimited: mock(async () => ({
				consecutiveRateLimits: 1,
				applied: true,
			})),
			resolverManager: {
				current: () => ({
					resolve: () => ({ projectId: null, worktreePath: null }),
				}),
			},
		},
		// One attempt, so nothing is retried in place.
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
			getStorePayloads: () => false,
		},
		provider: { name: "anthropic", canHandle: () => true },
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) },
	} as unknown as ProxyContext;
}

let collector: ReturnType<typeof spyOn> | null = null;
beforeEach(() => {
	seen.length = 0;
	queued.clear();
	route = ["a", "b"];
	answerJson = false;
	collector = spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue({
		handleStart: mock(() => {}),
		handleChunk: mock(() => {}),
		handleEnd: mock(() => Promise.resolve()),
	} as unknown as usageCollectorModule.UsageCollector);
});

afterEach(() => {
	collector?.mockRestore();
	collector = null;
});

/** A fresh turn id per test: the provider's store outlives one test. */
let turnSeq = 0;
function newTurn(): string {
	turnSeq += 1;
	return `019a0000-0000-7000-8000-${String(turnSeq).padStart(12, "0")}`;
}

async function codexCli(opts: {
	turnId?: string;
	token?: string | null;
	stream?: boolean;
}): Promise<Response> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (opts.turnId)
		headers[TURN_METADATA] = JSON.stringify({ turn_id: opts.turnId });
	if (opts.token) headers[TURN_STATE] = opts.token;
	const req = new Request("http://localhost/v1/responses", {
		method: "POST",
		headers,
		body: JSON.stringify({
			model: "gpt-5.5",
			stream: opts.stream ?? true,
			input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
		}),
	});
	const res = await handleResponsesRequest(
		req,
		new URL(req.url),
		handleProxy as HandleProxyFn,
		makeCtx(),
	);
	await res.text();
	return res;
}

describe("x-codex-turn-state on the native /v1/responses path (SB23-2370)", () => {
	it("relays the issued token to the client and back to the account that issued it", async () => {
		const turnId = newTurn();
		route = ["a"];
		const first = await codexCli({ turnId });
		expect(first.status).toBe(200);
		const token = first.headers.get(TURN_STATE);
		expect(token).toMatch(/^ts-a-\d+$/);
		expect(seen[0]).toEqual({
			account: "a",
			turnState: null,
			turnMetadata: JSON.stringify({ turn_id: turnId }),
		});

		const second = await codexCli({ turnId, token: token ?? undefined });
		expect(second.status).toBe(200);
		expect(seen[1]?.account).toBe("a");
		expect(seen[1]?.turnState).toBe(token);
		// The upstream issued nothing new, so the client sees nothing new.
		expect(second.headers.get(TURN_STATE)).toBeNull();
	});

	it("relays it on the non-streaming JSON branch too", async () => {
		answerJson = true;
		route = ["a"];
		const turnId = newTurn();
		const first = await codexCli({ turnId, stream: false });
		expect(first.status).toBe(200);
		const token = first.headers.get(TURN_STATE);
		expect(token).toMatch(/^ts-a-\d+$/);
		await codexCli({ turnId, token: token ?? undefined, stream: false });
		expect(seen[1]?.turnState).toBe(token);
	});

	it("strips a token the proxy never saw issued", async () => {
		route = ["a"];
		const res = await codexCli({ turnId: newTurn(), token: "forged-or-stale" });
		expect(res.status).toBe(200);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.turnState).toBeNull();
	});

	for (const withMetadata of [true, false]) {
		it(`gives each account its own token when a turn moves A, B, B, A (${withMetadata ? "with" : "without"} turn metadata)`, async () => {
			const turnId = withMetadata ? newTurn() : undefined;
			route = ["a"];
			const first = await codexCli({ turnId });
			const tokenA = first.headers.get(TURN_STATE);
			expect(tokenA).toMatch(/^ts-a-\d+$/);

			// The client keeps its first token for the whole turn (OnceLock).
			const held = tokenA ?? undefined;
			route = ["b"];
			const toB = await codexCli({ turnId, token: held });
			const tokenB = toB.headers.get(TURN_STATE);
			expect(tokenB).toMatch(/^ts-b-\d+$/);
			await codexCli({ turnId, token: held });
			route = ["a"];
			await codexCli({ turnId, token: held });

			expect(seen.map((s) => [s.account, s.turnState])).toEqual([
				["a", null],
				["b", null],
				["b", tokenB],
				["a", tokenA],
			]);
		});
	}

	it("does not hand A's token to B when A fails over mid-request", async () => {
		const turnId = newTurn();
		route = ["a"];
		const first = await codexCli({ turnId });
		const tokenA = first.headers.get(TURN_STATE);
		expect(tokenA).toMatch(/^ts-a-\d+$/);

		route = ["a", "b"];
		queued.set("a", [
			() =>
				new Response(JSON.stringify({ error: { message: "rate limited" } }), {
					status: 429,
					headers: { "content-type": "application/json", "retry-after": "60" },
				}),
		]);
		const res = await codexCli({ turnId, token: tokenA ?? undefined });
		expect(res.status).toBe(200);
		expect(seen.map((s) => [s.account, s.turnState])).toEqual([
			["a", null],
			["a", tokenA],
			["b", null],
		]);
	});
});

describe("x-codex-turn-state never reaches a non-Codex upstream (SB23-2370)", () => {
	it("is stripped when a Codex turn moves to an OpenAI-compatible account", async () => {
		const turnId = newTurn();
		route = ["a"];
		const first = await codexCli({ turnId });
		const tokenA = first.headers.get(TURN_STATE);
		expect(tokenA).toMatch(/^ts-a-\d+$/);
		route = ["oc"];
		await codexCli({ turnId, token: tokenA ?? undefined });
		expect(seen.map((s) => [s.account, s.turnState])).toEqual([
			["a", null],
			["oc", null],
		]);
	});
});

describe("x-codex-turn-state from a refused request (SB23-2370)", () => {
	it("is not filed from a 429: the failover never reaches processResponse", async () => {
		const turnId = newTurn();
		route = ["a", "b"];
		queued.set("a", [
			() =>
				new Response(JSON.stringify({ error: { message: "rate limited" } }), {
					status: 429,
					headers: {
						"content-type": "application/json",
						"retry-after": "60",
						[TURN_STATE]: "ts-a-refused",
					},
				}),
		]);
		const first = await codexCli({ turnId });
		expect(first.status).toBe(200);
		route = ["a"];
		await codexCli({ turnId });
		expect(seen.map((s) => [s.account, s.turnState])).toEqual([
			["a", null],
			["b", null],
			["a", null],
		]);
	});

	it("is not filed from a 400 that reaches processResponse: only a 2xx token is, as the Codex client reads it only from a stream", async () => {
		const turnId = newTurn();
		route = ["a"];
		queued.set("a", [
			() =>
				new Response(
					JSON.stringify({
						error: { message: "bad input", type: "invalid_request_error" },
					}),
					{
						status: 400,
						headers: {
							"content-type": "application/json",
							[TURN_STATE]: "ts-a-refused",
						},
					},
				),
		]);
		const first = await codexCli({ turnId });
		expect(first.status).toBe(400);
		await codexCli({ turnId });
		expect(seen.map((s) => [s.account, s.turnState])).toEqual([
			["a", null],
			["a", null],
		]);
	});
});

describe("x-codex-turn-state on /v1/messages (SB23-2370)", () => {
	it("carries the upstream's token back to the client and sends none the client did not earn", async () => {
		route = ["a"];
		const req = new Request("http://localhost/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
				[TURN_STATE]: "client-invented",
			},
			body: JSON.stringify({
				model: "gpt-5.5",
				max_tokens: 16,
				stream: true,
				messages: [{ role: "user", content: "hi" }],
			}),
		});
		const res = await handleProxy(req, new URL(req.url), makeCtx());
		await res.text();
		expect(res.status).toBe(200);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.turnState).toBeNull();
		expect(res.headers.get(TURN_STATE)).toMatch(/^ts-a-\d+$/);
	});
});

/**
 * SB23-3629: Claude Code reaches Codex accounts through /v1/messages and never
 * replays the token, so the proxy derives the turn from the body. The bodies
 * below have Claude Code's shape: `metadata.user_id` is JSON carrying a
 * `session_id`, the newest message is a block array carrying `cache_control`,
 * and the same message is a plain string once it is older.
 */
describe("x-codex-turn-state replayed on turns derived from /v1/messages bodies (SB23-3629)", () => {
	let sessionSeq = 0;
	function newSession(): string {
		sessionSeq += 1;
		return `5e550000-0000-4000-8000-${String(sessionSeq).padStart(12, "0")}`;
	}

	type Msg = { role: string; content: unknown };
	const fresh = (text: string): Msg => ({
		role: "user",
		content: [{ type: "text", text, cache_control: { type: "ephemeral" } }],
	});
	const older = (text: string): Msg => ({ role: "user", content: text });
	const toolUse = (id: string): Msg => ({
		role: "assistant",
		content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }],
	});
	const toolResult = (id: string, extra: unknown[] = []): Msg => ({
		role: "user",
		content: [
			{ type: "tool_result", tool_use_id: id, content: "ok" },
			...extra,
		],
	});
	const said = (text: string): Msg => ({
		role: "assistant",
		content: [{ type: "text", text }],
	});

	const PROBE_SECRET = "sb23-3629-probe-secret";

	async function claudeCode(
		session: string | null,
		messages: Msg[],
		extraHeaders: Record<string, string> = {},
	): Promise<Response> {
		const req = new Request("http://localhost/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
				...extraHeaders,
			},
			body: JSON.stringify({
				model: "gpt-5.5",
				max_tokens: 16,
				stream: true,
				...(session
					? {
							metadata: {
								user_id: JSON.stringify({
									device_id: "d",
									session_id: session,
								}),
							},
						}
					: {}),
				messages,
			}),
		});
		const ctx = { ...makeCtx(), internalProbeSecret: PROBE_SECRET };
		const res = await handleProxy(req, new URL(req.url), ctx as ProxyContext);
		await res.text();
		expect(res.status).toBe(200);
		return res;
	}

	function sent(): Array<[string, string | null]> {
		return seen.map((s) => [s.account, s.turnState]);
	}

	it("replays the account's token through a tool loop, across the string and block forms of one message", async () => {
		route = ["a"];
		const s = newSession();
		const first = await claudeCode(s, [fresh("list files")]);
		const token = first.headers.get(TURN_STATE);
		expect(token).toMatch(/^ts-a-\d+$/);
		await claudeCode(s, [older("list files"), toolUse("t1"), toolResult("t1")]);
		await claudeCode(s, [
			older("list files"),
			toolUse("t1"),
			toolResult("t1"),
			toolUse("t2"),
			toolResult("t2"),
		]);
		expect(sent()).toEqual([
			["a", null],
			["a", token],
			["a", token],
		]);
	});

	it("sends none for a new prompt in the same session", async () => {
		route = ["a"];
		const s = newSession();
		await claudeCode(s, [fresh("list files")]);
		await claudeCode(s, [
			older("list files"),
			said("done"),
			fresh("now count them"),
		]);
		expect(sent()).toEqual([
			["a", null],
			["a", null],
		]);
	});

	it("sends none when a tool result arrives beside typed text: an interrupt plus a new prompt is a new turn", async () => {
		route = ["a"];
		const s = newSession();
		await claudeCode(s, [fresh("list files")]);
		await claudeCode(s, [
			older("list files"),
			toolUse("t1"),
			toolResult("t1", [
				{ type: "text", text: "[Request interrupted by user for tool use]" },
				{ type: "text", text: "do something else" },
			]),
		]);
		expect(sent()).toEqual([
			["a", null],
			["a", null],
		]);
	});

	it("sends none after a refusal whose feedback sits inside the tool_result: the user's words may open a new turn", async () => {
		route = ["a"];
		const s = newSession();
		await claudeCode(s, [fresh("edit the file")]);
		await claudeCode(s, [
			older("edit the file"),
			toolUse("t1"),
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						is_error: true,
						content:
							"The user doesn't want to proceed with this tool use. the user said: use tabs",
					},
				],
			},
		]);
		expect(sent()).toEqual([
			["a", null],
			["a", null],
		]);
	});

	it("never replays after a rewind resends the same prompt inside the TTL, nor on the rewound branch's follow-ups", async () => {
		route = ["a"];
		const s = newSession();
		const first = await claudeCode(s, [fresh("list files")]);
		const token = first.headers.get(TURN_STATE);
		await claudeCode(s, [older("list files"), toolUse("t1"), toolResult("t1")]);
		// The rewind: the same prompt again, as the opening of a new turn.
		await claudeCode(s, [fresh("list files")]);
		await claudeCode(s, [older("list files"), toolUse("t9"), toolResult("t9")]);
		expect(sent()).toEqual([
			["a", null],
			["a", token],
			["a", null],
			["a", null],
		]);
	});

	it("never replays to a fork that grows past the answered request without extending it", async () => {
		route = ["a"];
		const s = newSession();
		const first = await claudeCode(s, [fresh("list files")]);
		const token = first.headers.get(TURN_STATE);
		await claudeCode(s, [older("list files"), toolUse("t1"), toolResult("t1")]);
		// Same prompt, longer, but a different history: not this turn's next step.
		await claudeCode(s, [
			older("list files"),
			toolUse("t8"),
			toolResult("t8"),
			toolUse("t9"),
			toolResult("t9"),
		]);
		expect(sent()).toEqual([
			["a", null],
			["a", token],
			["a", null],
		]);
	});

	it("never hands one account's token to another, and gives each its own", async () => {
		const s = newSession();
		route = ["a"];
		const first = await claudeCode(s, [fresh("list files")]);
		const tokenA = first.headers.get(TURN_STATE);
		expect(tokenA).toMatch(/^ts-a-\d+$/);
		const loop = [older("list files"), toolUse("t1"), toolResult("t1")];
		route = ["b"];
		const toB = await claudeCode(s, loop);
		const tokenB = toB.headers.get(TURN_STATE);
		expect(tokenB).toMatch(/^ts-b-\d+$/);
		const loop2 = [...loop, toolUse("t2"), toolResult("t2")];
		await claudeCode(s, loop2);
		route = ["a"];
		await claudeCode(s, [...loop2, toolUse("t3"), toolResult("t3")]);
		expect(sent()).toEqual([
			["a", null],
			["b", null],
			["b", tokenB],
			["a", tokenA],
		]);
	});

	it("does not let the proxy's own keepalive replay of a body poison the turn", async () => {
		route = ["a"];
		const s = newSession();
		const first = await claudeCode(s, [fresh("list files")]);
		const token = first.headers.get(TURN_STATE);
		// The cache keepalive replays the last body byte for byte.
		await claudeCode(s, [fresh("list files")], {
			"x-better-ccflare-keepalive": "true",
			"x-better-ccflare-account-id": "acc-a",
			"x-better-ccflare-bypass-session": "true",
			"x-better-ccflare-internal-probe-secret": PROBE_SECRET,
		});
		await claudeCode(s, [older("list files"), toolUse("t1"), toolResult("t1")]);
		expect(sent()).toEqual([
			["a", null],
			["a", null],
			["a", token],
		]);
	});

	it("treats a byte-identical re-send from the client as a different turn", async () => {
		route = ["a"];
		const s = newSession();
		await claudeCode(s, [fresh("list files")]);
		await claudeCode(s, [fresh("list files")]);
		await claudeCode(s, [older("list files"), toolUse("t1"), toolResult("t1")]);
		expect(sent()).toEqual([
			["a", null],
			["a", null],
			["a", null],
		]);
	});

	it("derives nothing without a session id: the same prompt from two clients is two turns", async () => {
		route = ["a"];
		await claudeCode(null, [fresh("list files")]);
		await claudeCode(null, [
			older("list files"),
			toolUse("t1"),
			toolResult("t1"),
		]);
		expect(sent()).toEqual([
			["a", null],
			["a", null],
		]);
	});

	it("keeps sessions apart: the same tool loop in another session gets nothing", async () => {
		route = ["a"];
		await claudeCode(newSession(), [fresh("list files")]);
		await claudeCode(newSession(), [
			older("list files"),
			toolUse("t1"),
			toolResult("t1"),
		]);
		expect(sent()).toEqual([
			["a", null],
			["a", null],
		]);
	});
});
