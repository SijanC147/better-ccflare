/**
 * SB23-2781 (B). A request translated by the OpenAI gateway makes at most one
 * Anthropic OAuth upstream call when that call is refused with a windowless
 * 429.
 *
 * Measured 2026-09-23T22:42:40Z: one `/v1/chat/completions` request walked
 * combo `ComboOpus` across six OAuth accounts, then the SessionStrategy
 * fallback walked the same six again, for 12 upstream 429s, before a Codex
 * account answered it. Claude Code traffic on the same accounts got 200s in
 * the same seconds, so the refusal is about the request, not the accounts.
 *
 * Every upstream call lands on the `fetch` stub below, which records it and
 * throws for any host it does not know, so nothing here reaches a real
 * account. The real `AnthropicProvider` and `CodexProvider` run, because the
 * registry outranks `ctx.provider` for a registered provider name
 * (`proxy-operations.ts`, `getProvider(account.provider) || ctx.provider`).
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { AnthropicProvider, usageCache } from "@better-ccflare/providers";
import {
	type Account,
	type ComboWithSlots,
	INBOUND_FORMAT_HEADER,
} from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { clearFamilyExhaustionCache } from "../handlers/model-capacity";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";
import { fetchSlot } from "./fetch-slot";

const originalFetch = globalThis.fetch;
const MODEL = "claude-opus-5-5";
const CODEX_ENDPOINT = "http://127.0.0.1:9/backend-api/codex/responses";
const CONSOLE_KEY = "sk-ant-api-test";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-x",
		name: "acc-x",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		// Beyond the refresh safety window, so no token refresh is fetched.
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
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		requires_reauth: false,
		peak_hours_pause_enabled: false,
		request_transformer: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		last_manual_reauth_at: null,
		consecutive_rate_limits: 0,
		renewal_day: null,
		usage_pause_five_hour_threshold: null,
		usage_pause_weekly_threshold: null,
		usage_pause_five_hour_enabled: false,
		usage_pause_weekly_enabled: false,
		...overrides,
	};
}

/** The six OAuth accounts of the incident, in combo order. */
const OAUTH_NAMES = ["XBOX", "PRTN", "OTLK", "ICLD", "UOM", "SB23"];

function oauthAccounts(): Account[] {
	return OAUTH_NAMES.map((name, index) =>
		makeAccount({ id: `oauth-${name}`, name, priority: index }),
	);
}

function codexAccount(): Account {
	return makeAccount({
		id: "codex-CDX",
		name: "CDX",
		provider: "codex",
		custom_endpoint: CODEX_ENDPOINT,
		priority: 10,
	});
}

function consoleAccount(): Account {
	return makeAccount({
		id: "console-KEY",
		name: "KEY",
		provider: "claude-console-api",
		api_key: CONSOLE_KEY,
		refresh_token: null,
		access_token: null,
		expires_at: null,
		priority: 1,
	});
}

function makeCombo(accountIds: string[]): ComboWithSlots {
	return {
		id: "combo-opus",
		name: "ComboOpus",
		description: null,
		enabled: true,
		created_at: Date.now(),
		updated_at: Date.now(),
		slots: accountIds.map((accountId, index) => ({
			id: `slot-${index}`,
			combo_id: "combo-opus",
			account_id: accountId,
			model: MODEL,
			priority: index,
			enabled: true,
			max_utilization_percent: null,
			min_reset_remaining_ms: null,
		})),
	};
}

function makeContext(
	accounts: Account[],
	combo: ComboWithSlots | null,
): ProxyContext {
	return {
		strategy: { select: mock((accs: Account[]) => accs) } as never,
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => combo),
			markAccountRateLimited: mock(() =>
				Promise.resolve({ consecutiveRateLimits: 1, applied: true }),
			),
			saveRequest: mock(() => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getModelScopedCapacityRouting: () => "off",
			getStorePayloads: () => false,
		} as never,
		// A `claude-console-api` row is not a registered provider name, so it
		// resolves to `ctx.provider`, which the server sets to Anthropic.
		provider: new AnthropicProvider(),
		refreshInFlight: new Map(),
		asyncWriter: {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		} as never,
	};
}

/** The windowless 429 captured from Anthropic (issue #301). */
function windowless429(): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "Error" },
		}),
		{
			status: 429,
			headers: {
				"content-type": "application/json",
				"x-robots-tag": "none",
				"x-should-retry": "true",
			},
		},
	);
}

/** A genuine account window: benches the account, not request-scoped. */
function windowed429(): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "rate limited" },
		}),
		{
			status: 429,
			headers: {
				"content-type": "application/json",
				"x-should-retry": "true",
				"retry-after": "60",
				"anthropic-ratelimit-unified-status": "rejected",
			},
		},
	);
}

function message(model: string): Response {
	return new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			model,
			content: [{ type: "text", text: "hi" }],
			stop_reason: "end_turn",
			stop_sequence: null,
			usage: { input_tokens: 5, output_tokens: 2 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

type Call = "oauth" | "api-key" | "codex";

/**
 * Installs the fetch stub and returns the list of calls it records. An
 * Anthropic call is classified by the credential it carries, so an OAuth
 * call and an API-key call to the same host are counted apart.
 */
function installFetch(
	oauthAnswer: (index: number) => Response = () => windowless429(),
	codexAnswer: () => Response = () => message("gpt-5.6-sol"),
): Call[] {
	const calls: Call[] = [];
	const unknown: string[] = [];
	let oauthIndex = 0;
	fetchSlot.fetch = async (input, init) => {
		const request =
			input instanceof Request ? input : new Request(String(input), init);
		const url = new URL(request.url);
		if (url.hostname === "api.anthropic.com") {
			// A `claude-console-api` key reaches this host as a bearer too
			// (getValidAccessToken returns the key as the access token), so the
			// credential's value tells the two kinds apart, not the header.
			const bearer = request.headers.get("authorization") ?? "";
			if (
				request.headers.get("x-api-key") ||
				bearer === `Bearer ${CONSOLE_KEY}`
			) {
				calls.push("api-key");
				return message(MODEL);
			}
			if (bearer === "Bearer access-token") {
				calls.push("oauth");
				return oauthAnswer(oauthIndex++);
			}
		}
		if (url.href.startsWith(CODEX_ENDPOINT)) {
			calls.push("codex");
			return codexAnswer();
		}
		unknown.push(url.href);
		throw new Error(`unexpected fetch in gateway-oauth-skip test: ${url.href}`);
	};
	// Surface a stray call even if the code under test swallows the throw.
	(calls as Call[] & { unknown?: string[] }).unknown = unknown;
	return calls;
}

function unknownCalls(calls: Call[]): string[] {
	return (calls as Call[] & { unknown?: string[] }).unknown ?? [];
}

function makeRequest(gateway: boolean): Request {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"anthropic-version": "2023-06-01",
	};
	if (gateway) headers[INBOUND_FORMAT_HEADER] = "openai-chat";
	return new Request("http://localhost/v1/messages", {
		method: "POST",
		headers,
		body: JSON.stringify({
			model: MODEL,
			max_tokens: 16,
			messages: [{ role: "user", content: "hello" }],
		}),
	});
}

function send(ctx: ProxyContext, gateway: boolean): Promise<Response> {
	return handleProxy(
		makeRequest(gateway),
		new URL("http://localhost/v1/messages"),
		ctx,
	);
}

describe("gateway request: one OAuth call after a windowless 429 (SB23-2781)", () => {
	// Installed for the whole test, not around handleProxy alone: a forwarded
	// body reports to the collector when it is read, after handleProxy returns.
	let collector: ReturnType<typeof spyOn> | null = null;
	beforeEach(() => {
		collector = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue({
			handleStart: mock(() => {}),
			handleChunk: mock(() => {}),
			handleEnd: mock(() => Promise.resolve()),
		} as unknown as usageCollectorModule.UsageCollector);
	});

	afterEach(() => {
		collector?.mockRestore();
		fetchSlot.fetch = originalFetch;
		usageCache.clear();
		clearFamilyExhaustionCache();
		resetRateLimitProbeGatesForTests();
	});

	it("combo of six OAuth slots plus Codex: exactly one OAuth call, answered by Codex", async () => {
		const oauth = oauthAccounts();
		const ctx = makeContext(
			[...oauth, codexAccount()],
			makeCombo(oauth.map((a) => a.id)),
		);
		const calls = installFetch();

		const response = await send(ctx, true);

		expect(response.status).toBe(200);
		expect(calls).toEqual(["oauth", "codex"]);
		expect(unknownCalls(calls)).toEqual([]);
		// Request-scoped: no OAuth account was benched.
		expect(oauth.every((a) => a.rate_limited_until === null)).toBe(true);
	});

	it("the same pool without the gateway marker still walks all six slots and the fallback", async () => {
		const oauth = oauthAccounts();
		const ctx = makeContext(
			[...oauth, codexAccount()],
			makeCombo(oauth.map((a) => a.id)),
		);
		const calls = installFetch();

		const response = await send(ctx, false);

		expect(response.status).toBe(200);
		// The incident's twelve: six combo slots, then six SessionStrategy
		// fallback candidates, then Codex.
		expect(calls).toEqual([...Array(12).fill("oauth"), "codex"]);
		expect(unknownCalls(calls)).toEqual([]);
	});

	it("without a combo, SessionStrategy routing also stops after one OAuth call", async () => {
		const oauth = oauthAccounts();
		const ctx = makeContext([...oauth, codexAccount()], null);
		const calls = installFetch();

		const response = await send(ctx, true);

		expect(response.status).toBe(200);
		expect(calls).toEqual(["oauth", "codex"]);
		expect(unknownCalls(calls)).toEqual([]);
	});

	it("a windowed 429 benches that account and does not skip the remaining OAuth accounts", async () => {
		const oauth = oauthAccounts();
		const ctx = makeContext([...oauth, codexAccount()], null);
		// First OAuth account reports a real window; the second refuses the
		// request with a windowless 429; the other four must then be skipped.
		const calls = installFetch((index) =>
			index === 0 ? windowed429() : windowless429(),
		);

		const response = await send(ctx, true);

		expect(response.status).toBe(200);
		expect(calls).toEqual(["oauth", "oauth", "codex"]);
		expect(oauth[0].rate_limited_until).not.toBeNull();
	});

	it("an API-key Anthropic account stays eligible after the OAuth refusal", async () => {
		const [first, ...rest] = oauthAccounts();
		const ctx = makeContext(
			[first, consoleAccount(), ...rest, codexAccount()],
			null,
		);
		const calls = installFetch();

		const response = await send(ctx, true);

		expect(response.status).toBe(200);
		expect(calls).toEqual(["oauth", "api-key"]);
		expect(unknownCalls(calls)).toEqual([]);
	});

	it("a refusal inside the SessionStrategy fallback skips the fallback's remaining OAuth accounts", async () => {
		const oauth = oauthAccounts();
		// The combo holds one OAuth slot that reports a real window, so the
		// flag is first set inside the fallback loop, not the combo loop.
		const ctx = makeContext(
			[...oauth, codexAccount()],
			makeCombo([oauth[0].id]),
		);
		const calls = installFetch((index) =>
			index === 0 ? windowed429() : windowless429(),
		);

		const response = await send(ctx, true);

		expect(response.status).toBe(200);
		expect(calls).toEqual(["oauth", "oauth", "codex"]);
		expect(unknownCalls(calls)).toEqual([]);
	});

	it("an all-OAuth pool ends after one OAuth call, with no ungated retry of a skipped account", async () => {
		const oauth = oauthAccounts();
		const ctx = makeContext(oauth, makeCombo(oauth.map((a) => a.id)));
		const calls = installFetch();

		// The terminal for an exhausted pool is a throw that the server maps to
		// 503 (proxy.ts step 11); no request row, no response object.
		await expect(send(ctx, true)).rejects.toThrow();
		expect(calls).toEqual(["oauth"]);
		expect(unknownCalls(calls)).toEqual([]);
	});

	it("a candidate followed only by skipped OAuth accounts is the terminal attempt, so its 5xx is forwarded", async () => {
		const [first, ...rest] = oauthAccounts();
		const ctx = makeContext([first, codexAccount(), ...rest], null);
		// No in-place re-issue, so one Codex call answers the request.
		ctx.runtime = {
			...ctx.runtime,
			retry: { attempts: 1, delayMs: 0, backoff: 1 },
		};
		const calls = installFetch(
			() => windowless429(),
			() =>
				new Response(
					JSON.stringify({
						type: "error",
						error: { type: "api_error", message: "codex upstream 502" },
					}),
					{ status: 502, headers: { "content-type": "application/json" } },
				),
		);

		// Forwarded rather than swallowed into the step-11 throw: Codex is the
		// last account this request can reach, because the four OAuth accounts
		// after it are skipped.
		const response = await send(ctx, true);

		expect(response.status).toBe(502);
		expect(await response.text()).toContain("codex upstream 502");
		expect(calls).toEqual(["oauth", "codex"]);
	});

	it("an OAuth account behind a custom endpoint is not skipped", async () => {
		const [first, second] = oauthAccounts();
		const gateway = makeAccount({
			id: "oauth-GW",
			name: "GW",
			custom_endpoint: "http://127.0.0.1:9/anthropic-gateway",
			priority: 1,
		});
		const ctx = makeContext([first, gateway, second, codexAccount()], null);
		const seen: string[] = [];
		fetchSlot.fetch = async (input, init) => {
			const request =
				input instanceof Request ? input : new Request(String(input), init);
			const url = new URL(request.url);
			if (url.hostname === "api.anthropic.com") {
				seen.push("oauth");
				return windowless429();
			}
			if (url.href.startsWith("http://127.0.0.1:9/anthropic-gateway")) {
				seen.push("custom-endpoint");
				return message(MODEL);
			}
			seen.push(`unexpected:${url.href}`);
			throw new Error(`unexpected fetch: ${url.href}`);
		};

		const response = await send(ctx, true);

		expect(response.status).toBe(200);
		expect(seen).toEqual(["oauth", "custom-endpoint"]);
	});
});
