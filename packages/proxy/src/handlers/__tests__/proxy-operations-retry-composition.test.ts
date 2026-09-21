import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { RETRY_DEFAULTS } from "@better-ccflare/core";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { fetchSlot } from "../../__tests__/fetch-slot";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";
import { resetRateLimitProbeGatesForTests } from "../rate-limit-cooldown";

/**
 * How many upstream fetches ONE client request can cost when more than one
 * in-place retry loop runs on it.
 *
 * Every other retry suite in this package drives a single loop, so each loop's
 * budget is pinned and the composed total is pinned by nothing. Three loops
 * read the same `retry_attempts` and run in program order on one request:
 *
 *   checkZai1305        proxy-operations.ts:624   reissues through
 *                                                 makeProxyRequest directly,
 *                                                 so one fetch per retry
 *   529 overload        :2222                     reissues through
 *                                                 reissueRequestInPlace
 *   transient 5xx       :2324                     reissues through
 *                                                 reissueRequestInPlace
 *
 * `reissueRequestInPlace` (:2153) calls `forwardUpstream` (:2164), which wraps
 * every attempt in `forwardWithTransportRetry`. So a retry issued by either of
 * the last two loops is not one fetch, it is up to `retry_attempts` fetches,
 * and the budgets multiply rather than add. The nesting is real because a
 * throw propagates all the way out: `forwardObservedUpstream` rethrows
 * (observed-upstream.ts:35) and `makeProxyRequest` does not catch its `fetch`.
 *
 * Nothing excludes the chain. A 200 carrying a 1305 whose last 1305 retry
 * answers 529, whose last 529 retry answers 500, whose 5xx budget then
 * exhausts, walks all three. That is what the two cases below drive.
 *
 * The count is taken at the global `fetch` seam, which is the only place that
 * sees a transport retry: a counter inside `reissueRequestInPlace` would see
 * the re-issues and miss the fetches they each cost, which is exactly the
 * blindness this file exists to remove.
 */

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "composition-test",
		provider: "anthropic",
		api_key: "test-key",
		refresh_token: "",
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
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
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		last_manual_reauth_at: null,
		renewal_day: null,
		request_transformer: null,
		requires_reauth: false,
		usage_pause_five_hour_threshold: null,
		usage_pause_weekly_threshold: null,
		usage_pause_five_hour_enabled: false,
		usage_pause_weekly_enabled: false,
		...overrides,
	};
}

function makeRequestMeta(): RequestMeta {
	return {
		id: "req-composition",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		clientSessionId: "sess-composition",
	};
}

function makeRequestBody() {
	return new TextEncoder().encode(
		JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 10,
		}),
	).buffer;
}

/**
 * `retry` is set explicitly to a COPY of RETRY_DEFAULTS rather than left off.
 * `Config.getRuntime()` always emits a `retry`, so a context without one drives
 * the `settings ?? RETRY_DEFAULTS` fallback inside `getOverloadRetryConfig`,
 * which is a different mechanism from a default install and would make this a
 * test of the fallback. The values are the documented defaults: attempts 3,
 * meaning two retries per loop.
 */
function makeProxyContext(): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(() =>
				Promise.resolve({ consecutiveRateLimits: 1, applied: true }),
			),
			saveRequest: mock((..._args: unknown[]) => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			updateAccountRateLimitMeta: mock((..._args: unknown[]) =>
				Promise.resolve(),
			),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: {
			port: 8080,
			clientId: "test",
			retry: { ...RETRY_DEFAULTS },
		} as never,
		provider: {
			name: "anthropic",
			canHandle: () => true,
			buildUrl: () => "https://api.anthropic.com/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: "allowed",
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		} as never,
		config: { getStorePayloads: () => true } as never,
		internalProbeSecret: "test-secret",
	};
}

function makeRequest(body: ArrayBuffer) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * A connect-phase refusal. `isRetryableUpstreamError` is an allowlist keyed on
 * `err.code` (core/constants.ts), so an ordinary Error would not be retried and
 * the transport layer would contribute nothing. Using a code from the allowlist
 * is what makes the nesting observable.
 */
function connectionRefused(): Error {
	const err = new Error("connect ECONNREFUSED 127.0.0.1:443");
	(err as Error & { code: string }).code = "ConnectionRefused";
	return err;
}

const serverErrorBody =
	'{"type":"error","error":{"type":"api_error","message":"Internal server error"}}';
const overloadedBody =
	'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

function jsonResponse(status: number, body: string): Response {
	return new Response(body, {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** A 200 whose SSE body carries Zai's 1305 overload event. */
function zai1305Response(): Response {
	return new Response(
		'data: {"error":{"code":1305,"message":"service overloaded"}}\n\n',
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

type ScriptStep = "throw" | (() => Response);

/**
 * Installs a fetch double that walks `script` in order, and returns the
 * counters. `fetches` counts every call including the ones that throw;
 * `responses` counts only the calls that produced a Response, which is the
 * number of upstream answers the retry loops actually saw.
 *
 * Running off the end of the script is an explicit failure rather than a
 * fallback response: a silent fallback would let a miscounted script pass by
 * absorbing the extra calls, which is the one way this instrument could report
 * the number it was written to expect.
 */
function installScriptedFetch(script: ScriptStep[]): {
	fetches: () => number;
	responses: () => number;
} {
	let fetches = 0;
	let responses = 0;
	fetchSlot.fetch = mock(async () => {
		const step = script[fetches];
		fetches++;
		if (step === undefined) {
			throw new Error(
				`scripted fetch exhausted: call ${fetches} has no step (script length ${script.length})`,
			);
		}
		if (step === "throw") throw connectionRefused();
		responses++;
		return step();
	});
	return { fetches: () => fetches, responses: () => responses };
}

/** One original attempt or one re-issue, preceded by its two transport retries. */
function withTransportRetries(final: () => Response): ScriptStep[] {
	return ["throw", "throw", final];
}

async function runProxy(
	account: Account,
	ctx: ProxyContext,
): Promise<{ result: Response | null; forwarded: boolean }> {
	const bodyBuffer = makeRequestBody();
	let forwarded = false;
	let result: Response | null = null;
	try {
		result = await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (!msg.includes("UsageCollector not initialized")) throw e;
		forwarded = true;
	}
	return { result, forwarded };
}

describe("proxyWithAccount — composed in-place retry budgets", () => {
	let originalFetch: typeof fetchSlot.fetch;

	beforeEach(() => {
		originalFetch = fetchSlot.fetch;
		// Zero the backoff so this is an attempt-count test and not a timing
		// test. These two override the delay only; the ATTEMPT count is left to
		// ctx.runtime.retry so the number measured is a default install's.
		process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = "0";
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS;
		delete process.env.CCFLARE_SERVER_ERROR_RETRY_ENABLED;
		delete process.env.CCFLARE_SERVER_ERROR_COOLDOWN_MS;
		resetRateLimitProbeGatesForTests();
	});

	afterEach(() => {
		fetchSlot.fetch = originalFetch;
		delete process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS;
		delete process.env.CCFLARE_SERVER_ERROR_RETRY_ENABLED;
		delete process.env.CCFLARE_SERVER_ERROR_COOLDOWN_MS;
		resetRateLimitProbeGatesForTests();
	});

	it("529 then 5xx on one Anthropic request: two loops compose", async () => {
		const script: ScriptStep[] = [
			// The original attempt.
			...withTransportRetries(() => jsonResponse(529, overloadedBody)),
			// 529 loop, retry 1 of 2: still 529, so the loop continues.
			...withTransportRetries(() => jsonResponse(529, overloadedBody)),
			// 529 loop, retry 2 of 2: a 500 breaks the 529 loop on
			// `status !== 529` and hands a transient 5xx to the next block,
			// which enters with a full fresh budget.
			...withTransportRetries(() => jsonResponse(500, serverErrorBody)),
			// 5xx loop, retry 1 of 2.
			...withTransportRetries(() => jsonResponse(500, serverErrorBody)),
			// 5xx loop, retry 2 of 2: budget exhausted, bench and fail over.
			...withTransportRetries(() => jsonResponse(500, serverErrorBody)),
		];
		const counters = installScriptedFetch(script);

		const ctx = makeProxyContext();
		const account = makeAccount();
		const { result, forwarded } = await runProxy(account, ctx);

		// Five upstream answers, fifteen upstream fetches, for one client
		// request, on one account, at the documented defaults. Asserted FIRST:
		// a mutation that changes the composed budget changes these two before
		// it changes anything about the outcome, and an outcome assertion that
		// fails first would mask which number moved.
		expect(counters.fetches()).toBe(15);
		expect(counters.responses()).toBe(5);

		// The outcome that proves both loops ran to exhaustion rather than the
		// request ending some other way at the same count.
		expect(forwarded).toBe(false);
		expect(result).toBeNull();
		expect(account.rate_limited_reason).toBe("upstream_5xx_server_error");
	});

	it("1305 then 529 then 5xx on one zai request: all three loops compose", async () => {
		const script: ScriptStep[] = [
			// The original attempt: a 200 whose SSE body carries 1305.
			...withTransportRetries(zai1305Response),
			// 1305 loop, retry 1 of 2. It reissues through makeProxyRequest
			// directly, so there is no transport retry here and a single fetch
			// is the whole retry. Still 1305, so the loop continues.
			zai1305Response,
			// 1305 loop, retry 2 of 2: a 529 carries no 1305, so checkZai1305
			// returns it unchanged and the 529 block downstream receives it.
			() => jsonResponse(529, overloadedBody),
			// 529 loop, retry 1 of 2.
			...withTransportRetries(() => jsonResponse(529, overloadedBody)),
			// 529 loop, retry 2 of 2: a 500 breaks it and starts the 5xx loop.
			...withTransportRetries(() => jsonResponse(500, serverErrorBody)),
			// 5xx loop, retry 1 of 2.
			...withTransportRetries(() => jsonResponse(500, serverErrorBody)),
			// 5xx loop, retry 2 of 2: exhausted.
			...withTransportRetries(() => jsonResponse(500, serverErrorBody)),
		];
		const counters = installScriptedFetch(script);

		const ctx = makeProxyContext();
		const account = makeAccount({ provider: "zai", name: "zai-test" });
		await runProxy(account, ctx);

		// Seven upstream answers, seventeen upstream fetches, for one client
		// request, on one account, at the documented defaults. Asserted first,
		// for the reason given in the Anthropic case above.
		expect(counters.fetches()).toBe(17);
		expect(counters.responses()).toBe(7);

		expect(account.rate_limited_reason).toBe("upstream_5xx_server_error");
	});

	it("a single loop still spends exactly the operator's retry_attempts", async () => {
		// The composition above must not be read as a licence to change what
		// one loop costs. With one loop and no transport failure, three
		// attempts means three fetches and no more.
		const script: ScriptStep[] = [
			() => jsonResponse(500, serverErrorBody),
			() => jsonResponse(500, serverErrorBody),
			() => jsonResponse(500, serverErrorBody),
		];
		const counters = installScriptedFetch(script);

		const ctx = makeProxyContext();
		const account = makeAccount();
		const { result } = await runProxy(account, ctx);

		expect(result).toBeNull();
		expect(counters.fetches()).toBe(3);
		expect(counters.responses()).toBe(3);
	});
});
