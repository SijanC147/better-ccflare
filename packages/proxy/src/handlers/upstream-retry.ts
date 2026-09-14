import {
	getOverloadRetryConfig,
	isRetryableUpstreamError,
	type RetrySettings,
	retryDelayMs,
} from "@better-ccflare/core";

/**
 * Runs one upstream attempt. Given a Request, it either resolves with the
 * upstream response or throws.
 */
export type UpstreamAttempt = (target: Request) => Promise<Response>;

export interface UpstreamRetryOptions {
	/** Resolved retry settings, normally `ctx.runtime.retry`. */
	settings: RetrySettings;
	/** Aborted when the client disconnects. An abort is never retried. */
	signal?: AbortSignal;
	/** Called once per retry, before the delay is awaited. */
	onRetry?: (info: {
		attempt: number;
		maxAttempts: number;
		delayMs: number;
		error: unknown;
	}) => void;
	/** Sleep hook, replaced in tests so an attempt-count assertion is not a timing test. */
	sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Retries an upstream request when, and only when, the attempt threw.
 *
 * Every request through this proxy is a non-idempotent POST and /v1/messages
 * carries no idempotency key, so a retry that reaches a model twice can bill
 * twice and, on a stream, deliver two answers. A throw is the one signal that
 * rules that out: no response object was produced, so nothing was forwarded to
 * the client and the upstream returned nothing. Connection refused, DNS failure
 * and TLS failure land here. A response, of any status, does not: 429 already
 * routes to another account through the account selector and 529 has its own
 * in-place retry, so retrying either here would stack two layers and turn a
 * spike into a storm.
 *
 * `settings.attempts` counts the first attempt, so `attempts: 3` runs at most
 * two retries and `attempts: 1` runs none.
 */
export async function forwardWithTransportRetry(
	target: Request,
	attemptOnce: UpstreamAttempt,
	options: UpstreamRetryOptions,
): Promise<Response> {
	const cfg = getOverloadRetryConfig(options.settings);
	const maxAttempts = cfg.enabled ? cfg.maxAttempts : 1;
	const sleep = options.sleep ?? defaultSleep;

	let current = target;
	for (let attempt = 0; ; attempt++) {
		const isLast = attempt >= maxAttempts - 1;
		// Tee the body before consuming it: a Request whose body has been sent
		// cannot be sent again, and cloning after the failed fetch is too late.
		// The spare is cancelled on every path that does not use it, because an
		// abandoned clone retains its backing buffer (issue #382).
		const spare = !isLast && current.body ? current.clone() : null;
		try {
			const response = await attemptOnce(current);
			spare?.body?.cancel();
			return response;
		} catch (err) {
			if (isLast || !isRetryableUpstreamError(err, options.signal)) {
				spare?.body?.cancel();
				throw err;
			}
			const delayMs = retryDelayMs(cfg, attempt + 1);
			options.onRetry?.({
				attempt: attempt + 1,
				maxAttempts,
				delayMs,
				error: err,
			});
			await sleep(delayMs);
			current = spare ?? current;
		}
	}
}
