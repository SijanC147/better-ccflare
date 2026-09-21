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
 * 429s. A rate limit cannot be path-selective like that.
 *
 * The 429 matters beyond the failed request, which is why this guard exists
 * rather than a doc note: `isModelUnavailableError` returns true for any 429
 * (proxy-operations.ts), so each one reaches the model-fallback branch and
 * benches a healthy production account under `model_fallback_429`, writing
 * `rate_limited_until`. One client request cost seven benched accounts.
 *
 * Tracked as SB23-2570.
 */

/** Paths this proxy forwards verbatim to the OpenAI-compatible upstream layer. */
const OPENAI_COMPAT_COMPLETION_PATHS = new Set([
	"/v1/chat/completions",
	"/chat/completions",
]);

/**
 * True for a completion path served by Anthropic's OpenAI compatibility layer
 * rather than by the native Messages API.
 */
export function isOpenAICompatCompletionPath(pathname: string): boolean {
	return OPENAI_COMPAT_COMPLETION_PATHS.has(pathname);
}

/**
 * True for a genuine Claude OAuth account.
 *
 * Deliberately the same three-part test as `isEligibleForReauthDeadline`
 * (packages/types/src/account.ts): provider `anthropic`, both tokens present,
 * and the two NOT equal. That last clause is the whole point — the dashboard's
 * "add account" flow writes an API key into `api_key`, `refresh_token` AND
 * `access_token`, so `!!account.refresh_token` alone reports an API-key
 * account as OAuth and would refuse a request this endpoint can actually
 * serve. Do not simplify it to a refresh-token check.
 */
function isClaudeOAuthAccount(account: Account): boolean {
	return (
		(account.provider ?? "anthropic") === "anthropic" &&
		!!account.refresh_token &&
		!!account.access_token &&
		account.refresh_token !== account.access_token
	);
}

/**
 * True when this account can serve Anthropic's OpenAI-compatible completion
 * path. An API-key Anthropic account can; a Claude OAuth account cannot.
 * Non-Anthropic providers are unaffected — they reach their own upstreams and
 * this guard must never speak for them.
 */
export function accountCanServeOpenAICompatPath(account: Account): boolean {
	return !isClaudeOAuthAccount(account);
}

/** The status this proxy answers for an unsupported OpenAI-compatible path. */
export const OPENAI_COMPAT_UNSUPPORTED_STATUS = 400;

export const OPENAI_COMPAT_UNSUPPORTED_ERROR_TYPE = "invalid_request_error";

export const OPENAI_COMPAT_UNSUPPORTED_MESSAGE =
	"Anthropic's OpenAI compatibility layer requires a Claude API key, and every " +
	"account routed to this request authenticates with OAuth. Send this request to " +
	"/v1/messages instead, or add an Anthropic account that uses an API key.";

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
