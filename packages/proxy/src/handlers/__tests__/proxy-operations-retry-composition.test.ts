import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { RETRY_DEFAULTS, type RetrySettings } from "@better-ccflare/core";
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
 *
 * One consequence to read correctly when mutation-testing this file. Because
 * each script is sized exactly to the bounded path, a mutant that overruns is
 * caught by the exhaustion throw on its FIRST extra call, so the failure
 * reports one more than expected (9 against 10, 5 against 6) whatever the
 * mutant's true unbounded cost would have been. The kill is real and the
 * property asserted is the right one, "no more fetches than the bound allows",
 * but the received number is a floor on the mutant rather than its count.
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
		// test. These two override the DELAY only; the attempt count is left to
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

	it("529 then 5xx on one Anthropic request costs 9 fetches, not 15", async () => {
		// Before the shared budget this cost 15 fetches and 5 upstream
		// responses: the 529 loop spent two re-issues, then the 5xx loop
		// entered with a full fresh budget and spent two more, and each
		// re-issue was itself up to three fetches through the transport retry.
		const script: ScriptStep[] = [
			// The original attempt.
			...withTransportRetries(() => jsonResponse(529, overloadedBody)),
			// 529 loop, re-issue 1 of the request's 2: still 529.
			...withTransportRetries(() => jsonResponse(529, overloadedBody)),
			// 529 loop, re-issue 2 of the request's 2: a 500 breaks the 529
			// loop on `status !== 529` and hands a transient 5xx to the next
			// block, which now finds the budget spent and re-issues nothing.
			...withTransportRetries(() => jsonResponse(500, serverErrorBody)),
		];
		const counters = installScriptedFetch(script);

		const ctx = makeProxyContext();
		const account = makeAccount();
		const { result, forwarded } = await runProxy(account, ctx);

		// Asserted before the outcome: a mutation that changes the composed
		// budget changes these two first, and an outcome assertion placed
		// first would fail before the count the mutation was aimed at.
		expect(counters.fetches()).toBe(9);
		expect(counters.responses()).toBe(3);

		// The 2026-09-13 incident the 5xx block was written for is preserved.
		// The bench sits OUTSIDE that block's retry loop, so a spent budget
		// skips the in-place 500 re-issue and nothing else: the account is
		// still benched and the request still fails over rather than handing
		// the client a 500 with failover_attempts=0.
		expect(account.rate_limited_reason).toBe("upstream_5xx_server_error");
		expect(account.rate_limited_until).not.toBeNull();
		expect(forwarded).toBe(false);
		expect(result).toBeNull();
	});

	it("1305 then 529 on one zai request costs 5 fetches, not 17", async () => {
		// Before the shared budget the full chain cost 17 fetches and 7
		// upstream responses, walking all three loops. Now the 1305 loop
		// spends the request's whole budget, so the 529 that its last retry
		// returns is benched and failed over rather than re-issued twice more.
		const script: ScriptStep[] = [
			// The original attempt: a 200 whose SSE body carries 1305.
			...withTransportRetries(zai1305Response),
			// 1305 loop, re-issue 1 of the request's 2. It reissues through
			// makeProxyRequest directly, so there is no transport retry here
			// and one fetch is the whole re-issue. Still 1305.
			zai1305Response,
			// 1305 loop, re-issue 2 of the request's 2: a 529 carries no 1305,
			// so checkZai1305 returns it unchanged. The budget is now spent, so
			// the 529 block downstream re-issues nothing.
			() => jsonResponse(529, overloadedBody),
		];
		const counters = installScriptedFetch(script);

		const ctx = makeProxyContext();
		const account = makeAccount({ provider: "zai", name: "zai-test" });
		await runProxy(account, ctx);

		expect(counters.fetches()).toBe(5);
		expect(counters.responses()).toBe(3);
	});

	it("a single loop still spends exactly the operator's retry_attempts", async () => {
		// The shared budget must not be readable as a cut to what one loop
		// costs. With one loop and no transport failure, three attempts means
		// three fetches, which is what it meant before.
		const script: ScriptStep[] = [
			() => jsonResponse(500, serverErrorBody),
			() => jsonResponse(500, serverErrorBody),
			() => jsonResponse(500, serverErrorBody),
		];
		const counters = installScriptedFetch(script);

		const { result } = await runProxy(makeAccount(), makeProxyContext());

		expect(counters.fetches()).toBe(3);
		expect(counters.responses()).toBe(3);
		expect(result).toBeNull();
	});

	it("gives each account its own budget across a failover", async () => {
		// The budget is created inside proxyWithAccount, so it is per account
		// rather than per client request. A request that exhausts it on one
		// account starts fresh on the next: the budget exists to stop ONE
		// account being hammered, and the next account has taken no
		// punishment. The consequence, which this test states rather than
		// hides, is that the pool-wide total for one client request is bounded
		// by the failover limit and not by this budget.
		const perAccount: ScriptStep[] = [
			() => jsonResponse(500, serverErrorBody),
			() => jsonResponse(500, serverErrorBody),
			() => jsonResponse(500, serverErrorBody),
		];
		const counters = installScriptedFetch([...perAccount, ...perAccount]);

		const ctx = makeProxyContext();
		const first = await runProxy(makeAccount({ id: "acc-1" }), ctx);
		expect(counters.fetches()).toBe(3);

		const second = await runProxy(makeAccount({ id: "acc-2" }), ctx);
		// Six, not three: the second account spent its own full budget. Three
		// would mean the budget had leaked across the failover.
		expect(counters.fetches()).toBe(6);
		expect(first.result).toBeNull();
		expect(second.result).toBeNull();
	});

	it.each([
		0, 1,
	])("retry_attempts %i still means no in-place retry at all", async (attempts) => {
		// SB23-1980 is the record of a validation fallback that turned 0
		// into 3, the largest value in play. The budget must not
		// reintroduce that: 0 clamps to 1 in getOverloadRetryConfig and
		// `enabled` requires maxAttempts > 1, so both values give a budget
		// of 0 and the original attempt is the only fetch.
		const counters = installScriptedFetch([
			() => jsonResponse(500, serverErrorBody),
		]);

		const ctx = makeProxyContext();
		(ctx.runtime as unknown as { retry: RetrySettings }).retry = {
			attempts,
			delayMs: 0,
			backoff: 2,
		};
		const { result } = await runProxy(makeAccount(), ctx);

		expect(counters.fetches()).toBe(1);
		expect(result).toBeNull();
	});
});
