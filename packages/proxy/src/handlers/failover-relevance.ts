/**
 * Which upstream error a client gets when failover runs out (SB23-10878).
 *
 * Reported 2026-10-30: a `claude-haiku-5-5` request was refused with a
 * windowless 429 by six Anthropic accounts, then a META account, which maps
 * the request onto a Muse Spark model, answered 402 with a link to Meta's
 * billing page. The client got the 402. A 402 is not a failover status, so
 * META's answer was forwarded as the final word on a request that every
 * account serving the requested model had refused for another reason.
 *
 * An attempt is "native" when the model it sent upstream is the model the
 * client asked for, and "foreign" when a mapping rewrote it, whoever wrote the
 * mapping: the incident's mapping (`muse-spark-1.2-contributor`) is an
 * explicit account mapping, not Meta's family default. A foreign account's
 * error says something about the foreign model, never about the requested
 * one. So once a native attempt has failed, a foreign error is not forwarded:
 * the request fails over, and if nothing else serves it, the client gets the
 * native failure's status with an error naming both answers.
 *
 * Exits that hand an upstream error to the client consult this: the final
 * forward in `proxyWithAccount`, the model-not-found pass-through and the
 * terminal-529 forward. The `extra_usage_exhausted` 400 pass-through does
 * not: it is Claude-only, says the account's overage is off whatever the
 * model, and writes its own row. The model label is the model each fetch
 * sends: the outgoing body's on the primary attempt, which a provider that
 * carries the model in the URL (Vertex AI) leaves empty, and an empty label
 * counts as native; the fallback model on a model-fallback attempt.
 *
 * A foreign 200 still serves the request, and a foreign error with no native
 * failure before it is still forwarded, so a pool of foreign accounts behaves
 * exactly as before. Six native 429s with no foreign answer still end in the
 * all-accounts-failed 503.
 */
import type { Account, RequestMeta } from "@better-ccflare/types";

export interface UpstreamAnswer {
	accountId: string;
	provider: string;
	status: number;
	upstreamModel: string | null;
	native: boolean;
	/** `x-should-retry` and `retry-after`, so a replayed status keeps its retry advice. */
	retryHeaders: Array<[string, string]>;
}

interface RequestFailoverState {
	/** The newest answer per account, oldest first. */
	answers: Map<string, UpstreamAnswer>;
	/** A foreign error not forwarded because a native attempt had failed first. */
	suppressed: UpstreamAnswer | null;
}

const states = new WeakMap<RequestMeta, RequestFailoverState>();

function stateFor(meta: RequestMeta): RequestFailoverState {
	let state = states.get(meta);
	if (!state) {
		state = { answers: new Map(), suppressed: null };
		states.set(meta, state);
	}
	return state;
}

/** The model the client asked for, after any agent rewrite. */
function requestedModel(meta: RequestMeta): string | null {
	return meta.appliedModel ?? meta.originalModel ?? null;
}

/**
 * Records an upstream answer for `account`. Called for every upstream fetch,
 * retries included, so the newest answer per account is the one it failed
 * over on.
 */
export function noteUpstreamAnswer(
	meta: RequestMeta,
	account: Account,
	response: Response,
	upstreamModel: string | null,
): void {
	const requested = requestedModel(meta);
	const retryHeaders: Array<[string, string]> = [];
	for (const name of ["x-should-retry", "retry-after"]) {
		const value = response.headers.get(name);
		if (value !== null) retryHeaders.push([name, value]);
	}
	const { answers } = stateFor(meta);
	// Delete first: `Map.set` on an existing key keeps its first position, and
	// the order is what "newest" reads.
	answers.delete(account.id);
	answers.set(account.id, {
		accountId: account.id,
		provider: account.provider,
		status: response.status,
		upstreamModel,
		// With no model on either side there is nothing to rank by, so the
		// answer counts as native and nothing changes.
		native: !requested || !upstreamModel || upstreamModel === requested,
		retryHeaders,
	});
}

/**
 * The newest native error answer. One answer is kept per account, so the
 * caller's own foreign answer can never be it.
 */
function newestNativeFailure(
	state: RequestFailoverState,
): UpstreamAnswer | null {
	let found: UpstreamAnswer | null = null;
	for (const answer of state.answers.values()) {
		if (answer.native && answer.status >= 400) found = answer;
	}
	return found;
}

/**
 * Whether `account`'s error answer must fail over instead of reaching the
 * client: its newest answer, when that is a foreign error and a native attempt
 * on another account failed first, else null. Records the suppression.
 */
export function suppressForeignError(
	meta: RequestMeta,
	account: Account,
	status: number,
): UpstreamAnswer | null {
	if (status < 400) return null;
	const state = states.get(meta);
	const own = state?.answers.get(account.id);
	if (!state || !own || own.native) return null;
	if (!newestNativeFailure(state)) return null;
	state.suppressed = own;
	return own;
}

const ERROR_TYPES: Record<number, string> = {
	400: "invalid_request_error",
	401: "authentication_error",
	403: "permission_error",
	404: "not_found_error",
	413: "request_too_large",
	429: "rate_limit_error",
	529: "overloaded_error",
};

/**
 * The response for an exhausted pool after a foreign error was suppressed:
 * the newest native failure's status and retry headers, with an
 * Anthropic-shaped error naming the requested model and the suppressed
 * answer. Null when nothing was suppressed, so every other exhaustion keeps
 * its existing response.
 */
export function createRelevantExhaustionResponse(
	meta: RequestMeta,
): Response | null {
	const state = states.get(meta);
	if (!state?.suppressed) return null;
	const native = newestNativeFailure(state);
	if (!native) return null;
	const foreign = state.suppressed;
	const requested = requestedModel(meta) ?? "the requested model";
	const message =
		`Every account that serves ${requested} refused this request; the last answered ${native.status} (${native.provider}). ` +
		`A ${foreign.provider} account that maps the request to ${foreign.upstreamModel ?? "another model"} answered ${foreign.status}, ` +
		"which is not forwarded because it is not about the requested model.";
	const headers = new Headers(native.retryHeaders);
	headers.set("content-type", "application/json");
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type:
					ERROR_TYPES[native.status] ??
					(native.status >= 500 ? "api_error" : "invalid_request_error"),
				message,
			},
		}),
		{ status: native.status, headers },
	);
}
