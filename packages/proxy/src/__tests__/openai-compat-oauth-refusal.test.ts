import { describe, expect, it, mock, spyOn } from "bun:test";
import type { Provider } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import {
	accountCanServeOpenAICompatPath,
	isOpenAICompatCompletionPath,
	OPENAI_COMPAT_UNSUPPORTED_STATUS,
} from "../handlers";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

/**
 * SB23-2570. `POST /v1/chat/completions` is forwarded verbatim to
 * `api.anthropic.com`, where Anthropic's OpenAI compatibility layer serves it
 * — for a Claude **API key**. A Claude OAuth account gets 429 instead, and
 * because `isModelUnavailableError` treats any 429 as model-unavailable, each
 * one benches a healthy account under `model_fallback_429`.
 *
 * Measured on the live host 2026-09-21: four fan-outs over eighteen minutes,
 * seven OAuth accounts each, **28 of 28 answered 429 and none ever answered
 * 200**, while the same seven accounts served **950 `/v1/messages` requests
 * with zero 429s** in the same window. That excludes **account-level** rate
 * limiting, not rate limiting as such: a per-endpoint quota of zero on a
 * subscription credential would produce the same table. Either way the
 * credential is what the endpoint refuses. The mechanism is unproven — the
 * 429 body was never captured.
 *
 * These tests drive `handleProxy` rather than the response builder, because
 * `mem:covering-the-function-is-not-covering-the-call` has fired twice in this
 * repo: a fully tested builder says nothing about whether the guard that calls
 * it is reachable, or whether its condition is the right one.
 */

function stubUsageCollector() {
	const handleStart = mock((_event: unknown) => {});
	const handleEnd = mock((_event: unknown) => Promise.resolve());
	spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue({
		handleStart,
		handleChunk: mock(() => {}),
		handleEnd,
	} as unknown as usageCollectorModule.UsageCollector);
	return { handleStart, handleEnd };
}

/**
 * An OAuth account by default. The three fields that decide it are
 * `provider`, `refresh_token` and `access_token`, and they must DIFFER — an
 * API key is written into all of `api_key`, `refresh_token` and
 * `access_token` at creation, so equal tokens mean an API-key account.
 */
function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 3_600_000,
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
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		requires_reauth: false,
		peak_hours_pause_enabled: false,
		request_transformer: null,
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

/** An Anthropic account that authenticates with an API key, not OAuth. */
function makeApiKeyAccount(overrides: Partial<Account> = {}): Account {
	return makeAccount({
		id: "acc-key",
		name: "api-key-account",
		api_key: "sk-ant-key",
		// The dashboard's add-account flow copies the key into all three
		// fields. Equal tokens are the tell, and the guard must read it.
		refresh_token: "sk-ant-key",
		access_token: "sk-ant-key",
		...overrides,
	});
}

function makeContext(
	accounts: Account[],
	providerOverrides: Partial<Provider> = {},
): ProxyContext {
	return {
		strategy: {
			select: (accs: Account[]) =>
				accs.filter(
					(acc) =>
						!acc.paused &&
						(!acc.rate_limited_until || acc.rate_limited_until <= Date.now()),
				),
		} as never,
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => null),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
		} as never,
		provider: {
			name: "anthropic",
			canHandle: () => true,
			...providerOverrides,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
	};
}

const CHAT_URL = "https://proxy.local/v1/chat/completions";

function makeChatRequest(url = CHAT_URL): Request {
	return new Request(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "claude-opus-5",
			messages: [{ role: "user", content: "hello" }],
		}),
	});
}

/**
 * The one value only this refusal produces. Every assertion about whether the
 * guard fired reads this rather than the status, because 400 is reachable
 * several other ways on these paths.
 */
const REFUSAL_CODE = "oauth_account_unsupported_endpoint";

/** The refusal's error code, or null if this is not our refusal at all. */
async function refusalCode(response: Response): Promise<string | null> {
	try {
		const body = (await response.clone().json()) as {
			error?: { code?: unknown };
		};
		return typeof body.error?.code === "string" ? body.error.code : null;
	} catch {
		return null;
	}
}

/** Seven OAuth accounts — the live pool size in the incident. */
function sevenOAuthAccounts(): Account[] {
	return ["EEG", "XBOX", "PRTN", "OTLK", "ICLD", "UOM", "SB23"].map((name, i) =>
		makeAccount({ id: `acc-${i}`, name }),
	);
}

describe("SB23-2570 — /v1/chat/completions across an all-OAuth pool", () => {
	it("refuses with status 400 and names the discriminating error code, without forwarding", async () => {
		stubUsageCollector();
		const accounts = sevenOAuthAccounts();
		// A provider whose buildUrl throws: reaching upstream at all is the
		// failure this guard exists to prevent, so make it loud rather than
		// letting a silent forward pass as a refusal.
		const ctx = makeContext(accounts, {
			buildUrl: () => {
				throw new Error("upstream must not be reached for an OAuth account");
			},
		} as Partial<Provider>);

		const response = await handleProxy(
			makeChatRequest(),
			new URL(CHAT_URL),
			ctx,
		);

		// The status number, named. Not "the request failed".
		expect(response.status).toBe(400);
		expect(response.status).toBe(OPENAI_COMPAT_UNSUPPORTED_STATUS);

		const body = (await response.json()) as {
			error: { code: string; type: string; message: string };
		};

		// The body's discriminating field: this is the value that separates
		// this refusal from every other 400 the proxy can produce.
		expect(body.error.code).toBe(REFUSAL_CODE);
		expect(body.error.type).toBe("invalid_request_error");

		// The message must name the endpoint that does work, because the whole
		// point is that the operator should stop debugging this one.
		expect(body.error.message).toContain("/v1/messages");
	});

	it("stages exactly one request row for the refusal, with a null account", async () => {
		const { handleStart, handleEnd } = stubUsageCollector();
		const ctx = makeContext(sevenOAuthAccounts());

		await handleProxy(makeChatRequest(), new URL(CHAT_URL), ctx);

		expect(handleStart).toHaveBeenCalledTimes(1);
		const staged = handleStart.mock.calls[0][0] as unknown as {
			accountId: string | null;
			responseStatus: number;
			path: string;
		};
		expect(staged.accountId).toBeNull();
		expect(staged.responseStatus).toBe(400);
		expect(staged.path).toBe("/v1/chat/completions");

		expect(handleEnd).toHaveBeenCalledTimes(1);
		const ended = handleEnd.mock.calls[0][0] as unknown as {
			success: boolean;
			error: string;
		};
		expect(ended.success).toBe(false);
		expect(ended.error).toBe("openai_compat_oauth_unsupported");
	});

	it("does not refuse /v1/messages, the endpoint OAuth accounts do serve", async () => {
		stubUsageCollector();
		const ctx = makeContext(sevenOAuthAccounts());

		const messagesUrl = "https://proxy.local/v1/messages";
		const response = await handleProxy(
			makeChatRequest(messagesUrl),
			new URL(messagesUrl),
			ctx,
		);

		// The error CODE, not the status. This harness's `/v1/messages`
		// request happens to 400 for an unrelated reason (the body is
		// OpenAI-shaped and carries no `max_tokens`), so `status !== 400`
		// fails against correct code and would tempt the next reader to loosen
		// the guard rather than the test. The code is what only our refusal
		// can produce.
		expect(await refusalCode(response)).not.toBe(REFUSAL_CODE);
	});

	it("does not refuse when an API-key Anthropic account is in the pool", async () => {
		stubUsageCollector();
		const ctx = makeContext([...sevenOAuthAccounts(), makeApiKeyAccount()]);

		// Anthropic documents this path for API keys, so an operator who has
		// one must still reach it; refusing here would be a regression, not a
		// fix. The guard RETURNS a response and never throws, so reaching the
		// ordinary all-accounts-failed throw is itself proof it let the
		// request through to the loop.
		await expect(
			handleProxy(makeChatRequest(), new URL(CHAT_URL), ctx),
		).rejects.toThrow(/All accounts failed/);
	});

	it("refuses before the loop: the all-OAuth pool never reaches the failover throw", async () => {
		stubUsageCollector();
		const ctx = makeContext(sevenOAuthAccounts());

		// The negative half of the test above. Same pool minus the API-key
		// account, same path: this one must NOT throw. Without this pair, a
		// guard that never fired and a guard that always fired would each pass
		// one of the two tests alone.
		const response = await handleProxy(
			makeChatRequest(),
			new URL(CHAT_URL),
			ctx,
		);
		expect(await refusalCode(response)).toBe(REFUSAL_CODE);
	});
});

describe("SB23-2570 — the predicates the guard rests on", () => {
	it("matches both completion paths the live log recorded and nothing else", () => {
		expect(isOpenAICompatCompletionPath("/v1/chat/completions")).toBe(true);
		expect(isOpenAICompatCompletionPath("/chat/completions")).toBe(true);

		expect(isOpenAICompatCompletionPath("/v1/messages")).toBe(false);
		expect(isOpenAICompatCompletionPath("/v1/models")).toBe(false);
		// Exact match, not prefix or substring: a suffix match would catch
		// an unrelated future path and a prefix match would catch a query-ish
		// tail, and both would refuse a request that works today.
		expect(isOpenAICompatCompletionPath("/v1/chat/completions/extra")).toBe(
			false,
		);
		expect(isOpenAICompatCompletionPath("/api/v1/chat/completions")).toBe(
			false,
		);
	});

	it("separates an OAuth account from an API-key account whose tokens are equal", () => {
		expect(accountCanServeOpenAICompatPath(makeAccount())).toBe(false);
		expect(accountCanServeOpenAICompatPath(makeApiKeyAccount())).toBe(true);
	});

	it("treats a non-Anthropic provider as able to serve it", () => {
		// zai, codex, openai and friends reach their own upstreams. This guard
		// must never speak for them, whatever their token fields look like.
		expect(
			accountCanServeOpenAICompatPath(makeAccount({ provider: "zai" })),
		).toBe(true);
		expect(
			accountCanServeOpenAICompatPath(makeAccount({ provider: "codex" })),
		).toBe(true);
	});

	it("treats a null provider as anthropic, matching the column's default", () => {
		// `provider` is nullable and the rest of the tree reads a null as
		// "anthropic" (isEligibleForReauthDeadline does the same). If this
		// drifted to `true`, a legacy row with a null provider would fan out
		// and bench itself, which is the original defect.
		expect(
			accountCanServeOpenAICompatPath(
				makeAccount({ provider: null as unknown as string }),
			),
		).toBe(false);
	});

	it("does not treat a lone refresh token as OAuth", () => {
		// The naive predicate. An account with only a refresh token is not a
		// usable OAuth account, and refusing for it would block a path that
		// might work.
		expect(
			accountCanServeOpenAICompatPath(
				makeAccount({ access_token: null, refresh_token: "r" }),
			),
		).toBe(true);
	});
});
