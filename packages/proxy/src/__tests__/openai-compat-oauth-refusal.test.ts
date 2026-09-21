import { describe, expect, it, mock, spyOn } from "bun:test";
import type { Provider } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import {
	accountCanServeOpenAICompatPath,
	isOpenAICompatCompletionPath,
	OPENAI_COMPAT_MEASURED_ON,
	OPENAI_COMPAT_OVERRIDE_ENV,
	OPENAI_COMPAT_UNSUPPORTED_MESSAGE,
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
 * A Claude OAuth account by default: `provider: "anthropic"`, a refresh token,
 * and no `api_key`. What makes it OAuth is that `getValidAccessToken`
 * (token-manager.ts:1009-1021) will hand it a Bearer — either the stored
 * access token or one minted from the refresh token. `access_token` being
 * present is convenience here, not part of the test; see the lone-refresh-token
 * case below, which is equally OAuth.
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

/**
 * A Claude API-key account, in the shape the product actually creates.
 *
 * `provider: "claude-console-api"` with both token fields NULL — see
 * `cli-commands/src/commands/account.ts:123`, `oauth-flow/src/index.ts:406`,
 * and `migrations.ts:1833`, which moved every legacy
 * `provider='anthropic' AND api_key IS NOT NULL` row onto that provider.
 *
 * An earlier version of this fixture built `provider: "anthropic"` with the
 * key copied into `api_key`, `refresh_token` AND `access_token`. **No such row
 * exists.** That pattern belongs to zai/openai-compatible/minimax/deepseek.
 * The fictional shape was the only thing keeping a dead clause in the
 * predicate alive under mutation — a test written from a belief about account
 * shapes rather than from the code that creates them.
 */
function makeApiKeyAccount(overrides: Partial<Account> = {}): Account {
	return makeAccount({
		id: "acc-key",
		name: "api-key-account",
		provider: "claude-console-api",
		api_key: "sk-ant-key",
		refresh_token: null,
		access_token: null,
		expires_at: null,
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

function makeChatRequest(url = CHAT_URL, body?: unknown): Request {
	return new Request(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(
			body ?? {
				model: "claude-opus-5",
				messages: [{ role: "user", content: "hello" }],
			},
		),
	});
}

/**
 * The one value only this refusal produces. Every assertion about whether the
 * guard fired reads this rather than the status, because 400 is reachable
 * several other ways on these paths.
 */
const REFUSAL_CODE = "oauth_account_unsupported_endpoint";

/**
 * What `handleProxy` actually did, as ONE discriminating string.
 *
 * Never collapse two different outcomes to the same value here. An earlier
 * version returned `null` for "not our refusal", for "body is not JSON", and
 * for "something threw", and a negative assertion then passed for all three.
 * The reviewer proved that cost real discrimination: a `throw` planted at step
 * 2, before the guard can possibly run, left both negative controls **green**,
 * because "the guard is unreachable" and "the guard correctly declined" had
 * become the same value.
 *
 * Worse, the `/v1/messages` control was landing on the not-JSON branch at
 * baseline — the response there is an HTML 400 — so it was asserting
 * `REFUSAL_CODE !== null` and testing nothing at all.
 */
type Outcome =
	/** JSON body carrying `error.code` — the value is that code. */
	| string
	/** The body did not parse as JSON at all, tagged with its status. */
	| `non-json:${number}`
	/** The body parsed as JSON but carried no `error.code`, tagged with its status. */
	| `json-no-code:${number}`
	/** Threw at the end of the attempt loop: execution got all the way past the guard. */
	| "reached-loop"
	/** Threw somewhere else — including before the guard could run. */
	| `threw-early:${string}`;

/** The refusal's error code, or a tag naming why there isn't one. */
async function readOutcome(response: Response): Promise<Outcome> {
	let body: unknown;
	try {
		body = await response.clone().json();
	} catch {
		// Distinct from "parsed but carried no code" on purpose: a non-JSON body
		// must never quietly satisfy an assertion about a JSON error code.
		return `non-json:${response.status}`;
	}
	const code = (body as { error?: { code?: unknown } })?.error?.code;
	// `json-no-code:`, NOT `non-json:`. An earlier version returned the same tag
	// for both, three lines under a comment promising they were kept distinct,
	// and the type's own doc then described only half of that tag's producers.
	// Most JSON 400s this proxy emits carry no `error.code`, so the two cases
	// are not rare siblings — they are the common case and the odd one.
	return typeof code === "string" ? code : `json-no-code:${response.status}`;
}

/**
 * Run `handleProxy` past the guard **hermetically** and report only what the
 * guard did: the refusal code, or `null` for anything else.
 *
 * The `buildUrl` stub is what makes this hermetic, and it is load-bearing.
 * Without it, a request that gets past the guard enters the attempt loop,
 * where `getValidAccessToken` (token-manager.ts) finds a stale access token
 * and **makes a real HTTP call to Anthropic's OAuth token endpoint**. That is
 * a network call from a unit test: it is slow, it is non-deterministic, and
 * how it fails differs between a developer's machine and a CI runner. An
 * earlier version of these two tests did exactly that — they were green on
 * macOS and the `/v1/messages` one was **red on Linux CI**, reported at 678 ms,
 * which is a network round trip rather than a guard check.
 *
 * Throwing from `buildUrl` stops the request the moment it reaches the
 * provider, which is already past the guard, so the distinction this function
 * exists to draw is preserved exactly. **The assertion is not weakened**: the
 * guard returns a response and never throws, so any throw means it did not
 * fire, and if it wrongly fires we still see the code. What is removed is the
 * network, not the discrimination.
 */
async function guardOutcome(
	url: string,
	accounts: Account[],
	body?: unknown,
): Promise<Outcome> {
	const ctx = makeContext(accounts, {
		buildUrl: () => {
			throw new Error("hermetic stub: upstream is never contacted");
		},
	} as Partial<Provider>);

	try {
		return await readOutcome(
			await handleProxy(makeChatRequest(url, body), new URL(url), ctx),
		);
	} catch (err) {
		// WHICH throw matters. `All accounts failed` is raised only at the end of
		// the attempt loop (proxy.ts step 11), so it proves execution travelled
		// all the way past the guard — that is what the old
		// `.rejects.toThrow(/All accounts failed/)` was buying, and collapsing it
		// to a bare `null` threw the proof away.
		const msg = err instanceof Error ? err.message : String(err);
		return /All accounts failed/.test(msg)
			? "reached-loop"
			: `threw-early:${msg}`;
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

		const messagesUrl = "https://proxy.local/v1/messages";
		const outcome = await guardOutcome(
			messagesUrl,
			sevenOAuthAccounts(),
			// A VALID Anthropic body. This is load-bearing and is the second
			// platform bug in this one test: sending the OpenAI-shaped body here
			// made the outcome depend on `/v1/messages` validation, which rejected
			// it on macOS (an HTML 400) and did not on Linux (straight into the
			// attempt loop). CI read `reached-loop` against a macOS
			// `non-json:400`. The body was never the point of this test, so the
			// fix is to stop the test depending on how it is judged rather than to
			// accept both answers — accepting both is the collapse this file has
			// already been bitten by twice.
			{
				model: "claude-opus-5",
				max_tokens: 16,
				messages: [{ role: "user", content: "hello" }],
			},
		);

		// A CLOSED SET of two named values, not a negation and not one value.
		//
		// Both members mean the same thing — execution got past step 2 and the
		// guard declined — and they differ only by platform. `/v1/messages`
		// under this harness answers an HTML 400 on macOS and runs on into the
		// attempt loop on Linux. CI caught that after an earlier version of this
		// line pinned the macOS value; the Linux answer is `reached-loop`.
		// Supplying a valid Anthropic body does NOT remove the split, so the
		// cause is not body validation. It is filed as SB23-2576, and **when
		// that issue is fixed this set should shrink to one member** — if it
		// does not, the shapes have drifted again.
		//
		// This is an allowlist rather than `not.toBe(REFUSAL_CODE)` on purpose.
		// The negation was satisfied by any outcome at all, including "the guard
		// was unreachable", which is how it passed against a proxy that could
		// never have run the guard. Here a throw planted ahead of the guard
		// yields `threw-early:…`, which is not in the set and fails; a guard
		// that wrongly fires yields the refusal code, also not in the set.
		expect(["reached-loop", "non-json:400"]).toContain(outcome);
	});

	it("does not refuse when an API-key Anthropic account is in the pool", async () => {
		stubUsageCollector();

		// Anthropic documents this path for API keys, so an operator who has
		// one must still reach it; refusing here would be a regression, not a
		// fix.
		const outcome = await guardOutcome(CHAT_URL, [
			...sevenOAuthAccounts(),
			makeApiKeyAccount(),
		]);

		// `reached-loop` is raised only at proxy.ts step 11, the end of the
		// attempt loop, so it proves execution travelled all the way past the
		// guard. A bare `not.toBe(REFUSAL_CODE)` was satisfied by any throw
		// anywhere, including one planted before the guard could run.
		expect(outcome).toBe("reached-loop");
	});

	it("can be switched off, and the refusal says how", async () => {
		// The guard suppresses its own evidence: once the refusal is generated
		// locally, the upstream 429 that would falsify the measurement is exactly
		// the signal that stops being produced. So the cost that matters is
		// DETECTION, not reversal, and the escape hatch is what makes the
		// measurement falsifiable without a release.
		stubUsageCollector();
		const saved = process.env[OPENAI_COMPAT_OVERRIDE_ENV];
		process.env[OPENAI_COMPAT_OVERRIDE_ENV] = "1";
		try {
			// `reached-loop`, not merely "not the refusal": with the guard off the
			// request must travel all the way to the end of the attempt loop.
			expect(await guardOutcome(CHAT_URL, sevenOAuthAccounts())).toBe(
				"reached-loop",
			);
		} finally {
			if (saved === undefined) delete process.env[OPENAI_COMPAT_OVERRIDE_ENV];
			else process.env[OPENAI_COMPAT_OVERRIDE_ENV] = saved;
		}

		// And the operator has to be able to find the switch from the refusal
		// alone, together with the date the claim was measured.
		expect(OPENAI_COMPAT_UNSUPPORTED_MESSAGE).toContain(
			OPENAI_COMPAT_OVERRIDE_ENV,
		);
		expect(OPENAI_COMPAT_UNSUPPORTED_MESSAGE).toContain(
			OPENAI_COMPAT_MEASURED_ON,
		);
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
		expect(await readOutcome(response)).toBe(REFUSAL_CODE);
	});
});

describe("SB23-2570 — readOutcome itself, the instrument these tests read", () => {
	// Without these, the `json-no-code:` / `non-json:` split is untested: a
	// mutation collapsing them back onto one tag survives the whole file,
	// because no control above ever receives a JSON body without an
	// `error.code`. An instrument nothing checks is the thing that made the
	// earlier version of this file vacuous, so it gets its own cases.

	it("distinguishes a body that did not parse from one that parsed without a code", async () => {
		const html = new Response("<html>", {
			status: 400,
			headers: { "Content-Type": "text/html" },
		});
		expect(await readOutcome(html)).toBe("non-json:400");

		// The common case: nearly every JSON error this proxy emits carries
		// `error.type` and `error.message` but no `error.code`. It must NOT read
		// as "the body was not JSON".
		const jsonNoCode = new Response(
			JSON.stringify({
				type: "error",
				error: { type: "service_unavailable_error", message: "nope" },
			}),
			{ status: 503, headers: { "Content-Type": "application/json" } },
		);
		expect(await readOutcome(jsonNoCode)).toBe("json-no-code:503");
	});

	it("returns the code itself when one is present", async () => {
		const refusal = new Response(
			JSON.stringify({ error: { code: REFUSAL_CODE } }),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
		expect(await readOutcome(refusal)).toBe(REFUSAL_CODE);
	});

	it("does not treat a non-string code as a code", async () => {
		// `error.code: 400` would otherwise stringify into the same slot as a
		// real code and could collide with a refusal value.
		const numericCode = new Response(JSON.stringify({ error: { code: 400 } }), {
			status: 418,
			headers: { "Content-Type": "application/json" },
		});
		expect(await readOutcome(numericCode)).toBe("json-no-code:418");
	});
});

describe("SB23-2570 — the predicates the guard rests on", () => {
	it("matches the one live completion path and nothing else", () => {
		expect(isOpenAICompatCompletionPath("/v1/chat/completions")).toBe(true);

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

	it("separates a Claude OAuth account from a claude-console-api key account", () => {
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

	it("treats a LONE refresh token as OAuth, because token-manager refreshes it", () => {
		// This assertion was inverted in review, and the inversion is the
		// finding. An earlier version asserted `true` here with a comment
		// claiming "an account with only a refresh token is not a usable OAuth
		// account". `getValidAccessToken` (token-manager.ts:1009-1021) says
		// otherwise: no api_key so :1009 does not fire, no access_token so the
		// reuse branch does not fire, and it falls through to the refresh and
		// mints a Bearer. That is precisely the account that gets benched.
		//
		// The old assertion did not merely miss the case — it FORBADE the
		// correct predicate, so the suite would have gone red on the fix.
		expect(
			accountCanServeOpenAICompatPath(
				makeAccount({ access_token: null, refresh_token: "r" }),
			),
		).toBe(false);
	});

	it("treats an empty refresh token with a live access token as OAuth", () => {
		// `oauth-flow/src/index.ts:317` inserts `tokens.refreshToken || ""`, and
		// `OAuthTokens.refreshToken` is optional, so an empty string is a
		// reachable value on a genuine OAuth row. A predicate keyed on
		// `!!refresh_token` calls this account servable and lets it fan out.
		expect(
			accountCanServeOpenAICompatPath(
				makeAccount({ refresh_token: "", access_token: "sk-ant-oat01-live" }),
			),
		).toBe(false);
	});

	it("lets an Anthropic OAuth account with a custom endpoint through", () => {
		// The CLI prompts for a custom endpoint on exactly this account type
		// (cli-commands/src/commands/account.ts:1825-1827) and buildUrl sends
		// every path to it instead of api.anthropic.com. The 28/28 measurement
		// was taken against api.anthropic.com and says nothing about a gateway
		// that re-authenticates with its own key. Refusing it would break a
		// first-class configuration on no evidence.
		expect(
			accountCanServeOpenAICompatPath(
				makeAccount({ custom_endpoint: "https://gateway.internal.example" }),
			),
		).toBe(true);
	});

	it("lets an anthropic row carrying an api_key and no refresh token through", () => {
		// Mirrors `getValidAccessToken`'s second branch (token-manager.ts:1009):
		// an api_key with no refresh token returns "" and prepareHeaders sends
		// `x-api-key`, never a Bearer. So this row can serve the path.
		//
		// Disclosed rather than asserted as reachable: after
		// `migrations.ts:1833` moved every `provider='anthropic' AND api_key IS
		// NOT NULL` row onto `claude-console-api`, it is not clear this shape
		// still occurs in the wild — the mutation that deletes the clause
		// survives without THIS test, because the fixture it would otherwise
		// catch is already caught by the provider clause above.
		//
		// The clause stays anyway, and this test exists, because the predicate's
		// contract is "agree with getValidAccessToken". A clause that mirrors the
		// authoritative function is cheap; a predicate that silently diverges
		// from it is the defect this whole fix round was about.
		expect(
			accountCanServeOpenAICompatPath(
				makeAccount({ api_key: "sk-ant-key", refresh_token: null }),
			),
		).toBe(true);
	});

	it("does not speak for the bare /chat/completions path", () => {
		// Measured: 2 live requests, both 404 FROM UPSTREAM, zero 429s. The
		// path does not exist on api.anthropic.com, so nothing benches and no
		// credential makes it work. Refusing it with a message saying "add an
		// API-key account" would be wrong advice.
		expect(isOpenAICompatCompletionPath("/chat/completions")).toBe(false);
	});
});
