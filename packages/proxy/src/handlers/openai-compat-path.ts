import type { Account } from "@better-ccflare/types";

/**
 * The OpenAI SDK compatibility layer on `api.anthropic.com`.
 *
 * Anthropic documents `https://api.anthropic.com/v1/` as an OpenAI-compatible
 * base URL, so `POST /v1/chat/completions` IS a real upstream endpoint — but
 * the documentation pairs it with a Claude **API key** only
 * (platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk). It
 * says nothing about OAuth access tokens, and measurement says they do not
 * work: on 2026-09-21 seven distinct Claude OAuth accounts answered 429 to
 * this path on all 28 attempts across four fan-outs, while the same seven
 * accounts served 950 `/v1/messages` requests in the same window with zero
 * 429s.
 *
 * What that excludes is **account-level** rate limiting: a 429 selective by
 * path, identical across seven independent accounts, and persistent across
 * four fan-outs eighteen minutes apart is not an account running out of
 * quota. It does NOT exclude rate limiting as such — a per-endpoint quota is
 * ordinary, and a subscription credential carrying zero quota on an
 * API-key-oriented compatibility endpoint would produce the same table. Either
 * way the credential or its plan is what the endpoint refuses, and either way
 * this guard is the right response. The mechanism itself stays **unproven**
 * because the 429 body was never captured (payload storage is off).
 *
 * The 429 matters beyond the failed request, which is why this guard exists
 * rather than a doc note: `isModelUnavailableError` returns true for any 429
 * (proxy-operations.ts), so each one reaches the model-fallback branch and
 * benches a healthy production account under `model_fallback_429`, writing
 * `rate_limited_until`. One client request cost seven benched accounts.
 *
 * Tracked as SB23-2570.
 */

/**
 * The one path this guard speaks for.
 *
 * `/chat/completions` without the `/v1` prefix is deliberately NOT here. It
 * reaches `https://api.anthropic.com/chat/completions`, which is not an
 * endpoint: the live log records 2 requests on it and both answered **404
 * from upstream**, not 429. So there is no benching to prevent there (404
 * does not reach `isModelUnavailableError`), the premise this guard rests on
 * is false for it, and a message telling the operator to add an API-key
 * account would be wrong advice — no credential makes that path exist.
 */
const OPENAI_COMPAT_COMPLETION_PATHS = new Set(["/v1/chat/completions"]);

/**
 * True for a completion path served by Anthropic's OpenAI compatibility layer
 * rather than by the native Messages API.
 */
export function isOpenAICompatCompletionPath(pathname: string): boolean {
	return OPENAI_COMPAT_COMPLETION_PATHS.has(pathname);
}

/**
 * True when a request on this account will carry an **OAuth bearer token** to
 * `api.anthropic.com`.
 *
 * Clauses 1 and 3 are derived from `getValidAccessToken`
 * (handlers/token-manager.ts), which is the only function whose branch decides
 * which credential leaves the process. Read that function, not this comment,
 * if you need to change either of them.
 *
 * **Clause 2 is deliberately NOT in that function and must not be deleted for
 * being absent from it.** `getValidAccessToken` never reads `custom_endpoint`.
 * That clause answers a different question — *where* the credential is going,
 * not *which* credential it is — and a bearer sent to somebody else's gateway
 * is outside everything this guard measured. The contract "agree with
 * `getValidAccessToken`" is asserted over clauses 1 and 3 only.
 *
 * It is deliberately NOT the `isEligibleForReauthDeadline` test, which an
 * earlier version of this file copied. That function answers a different
 * question (when a manual reauth falls due), and the justification copied with
 * it — "the add-account flow writes an API key into all three token fields" —
 * is false for `anthropic`. That pattern belongs to `zai`, `openai-compatible`,
 * `minimax` and `deepseek` (http-api/src/handlers/accounts.ts), all of which
 * the provider clause below has already excluded. A Claude API-key account is
 * inserted as **`claude-console-api`** (cli-commands/src/commands/account.ts:123,
 * oauth-flow/src/index.ts:406), and migrations.ts:1833 moved every legacy
 * `provider='anthropic' AND api_key IS NOT NULL` row to it, so no
 * anthropic-provider row reaches this function carrying an API key by that
 * route.
 *
 * The clauses, in `getValidAccessToken`'s own order:
 */
function sendsOAuthBearer(account: Account): boolean {
	// Not an Anthropic-provider row: `claude-console-api` and the other API-key
	// providers return their key at token-manager.ts:1002 and never mint a
	// bearer. They also reach their own upstreams, so this guard must never
	// speak for them.
	if ((account.provider ?? "anthropic") !== "anthropic") return false;

	// A custom endpoint means we are not talking to api.anthropic.com at all
	// (AnthropicProvider.buildUrl:425-440 sends every path to that host, and
	// validateEndpointUrl accepts any http/https host). The 28/28 measurement
	// was taken against api.anthropic.com and says nothing about a gateway that
	// re-authenticates with its own key and may serve this path perfectly well.
	// The CLI prompts for one on exactly this account type
	// (cli-commands/src/commands/account.ts:1825-1827), so refusing it would
	// break a first-class configuration on no evidence.
	if (account.custom_endpoint) return false;

	// token-manager.ts:1009 — an api_key with no refresh token returns "" and
	// prepareHeaders sends `x-api-key`, never a bearer.
	if (!account.refresh_token && account.api_key) return false;

	// Everything else is a bearer. Note this includes an account with a refresh
	// token and a NULL access_token: token-manager.ts falls through to the
	// refresh and mints one. A lone refresh token IS OAuth, which is why there
	// is no `access_token` clause here — an earlier version had one, and it let
	// exactly that account through to be benched.
	//
	// It also includes the row shape written by
	// cli-commands/src/commands/account.ts:2691-2698, which puts an API key into
	// BOTH `api_key` and `refresh_token` on an existing anthropic row. Refusing
	// that is deliberate: that row hands an API key to the OAuth token endpoint
	// as if it were a refresh token, which cannot succeed, so a 400 naming the
	// working endpoint beats a seven-account fan-out. It is arguably broken
	// independently of this guard.
	return true;
}

/**
 * True when this account can serve Anthropic's OpenAI-compatible completion
 * path. An API-key account can; an account that will present an OAuth bearer
 * to `api.anthropic.com` cannot.
 */
export function accountCanServeOpenAICompatPath(account: Account): boolean {
	return !sendsOAuthBearer(account);
}

/**
 * The escape hatch, and the reason it exists is not convenience.
 *
 * This guard rests on a measurement of how `api.anthropic.com` behaved on one
 * day. If Anthropic later serves OAuth on that path, **nothing will notice** —
 * and the reason is sharper than "the check goes stale". Once the refusal is
 * generated locally, the upstream 429 that would falsify it is exactly the
 * signal the guard stops producing. The guard suppresses its own evidence.
 *
 * So the cost that matters is detection, not reversal. Setting this to `1`
 * restores the pre-guard behaviour and lets an operator falsify the
 * measurement in thirty seconds without waiting for a release. The refusal
 * message names it, and names the date the measurement was taken, so whoever
 * reads the message has both halves.
 *
 * Asked for by the independent reviewer of PR #238.
 */
export const OPENAI_COMPAT_OVERRIDE_ENV =
	"BETTER_CCFLARE_ALLOW_OAUTH_OPENAI_COMPAT";

/**
 * True when an operator has explicitly turned the guard off.
 *
 * Read at call time rather than captured at module load, so a test can set it
 * and so a value is never frozen into a long-lived process by import order.
 */
export function isOpenAICompatGuardDisabled(): boolean {
	return process.env[OPENAI_COMPAT_OVERRIDE_ENV] === "1";
}

/** The status this proxy answers for an unsupported OpenAI-compatible path. */
export const OPENAI_COMPAT_UNSUPPORTED_STATUS = 400;

export const OPENAI_COMPAT_UNSUPPORTED_ERROR_TYPE = "invalid_request_error";

/** The date the 28-of-28 measurement behind this guard was taken. */
export const OPENAI_COMPAT_MEASURED_ON = "2026-09-21";

export const OPENAI_COMPAT_UNSUPPORTED_MESSAGE =
	"Anthropic's OpenAI compatibility layer requires a Claude API key, and every " +
	"account routed to this request authenticates with OAuth. Send this request to " +
	"/v1/messages instead, or add an Anthropic account that uses an API key. " +
	`This refusal is based on upstream behaviour measured ${OPENAI_COMPAT_MEASURED_ON}; ` +
	`set ${OPENAI_COMPAT_OVERRIDE_ENV}=1 to bypass it and re-test that behaviour.`;

/**
 * Refuse the request locally, in the OpenAI error shape the caller expects.
 *
 * 400 rather than 404: a 404 is what the upstream returns for a path that does
 * not exist, and this path does exist — it is the credential that cannot use
 * it. 400 also keeps the refusal outside the range an OpenAI client retries.
 */
export function createOpenAICompatUnsupportedResponse(): Response {
	return new Response(
		JSON.stringify({
			error: {
				message: OPENAI_COMPAT_UNSUPPORTED_MESSAGE,
				type: OPENAI_COMPAT_UNSUPPORTED_ERROR_TYPE,
				param: null,
				code: "oauth_account_unsupported_endpoint",
			},
		}),
		{
			status: OPENAI_COMPAT_UNSUPPORTED_STATUS,
			headers: { "Content-Type": "application/json" },
		},
	);
}
