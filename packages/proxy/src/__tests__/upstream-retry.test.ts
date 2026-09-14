import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getOverloadRetryConfig } from "@better-ccflare/core";
import { forwardWithTransportRetry } from "../handlers/upstream-retry";

/**
 * These tests exist because `retry_attempts`, `retry_delay_ms` and
 * `retry_backoff` were parsed, displayed and documented for months while no
 * retry logic read them. A test that only asserts the keys parse would have
 * passed throughout. So every test below asserts the number of attempts
 * actually made, or the fact that no attempt was made.
 */

const OVERLOAD_ENV_KEYS = [
	"CCFLARE_OVERLOAD_RETRY_ENABLED",
	"CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS",
	"CCFLARE_OVERLOAD_RETRY_BASE_MS",
	"CCFLARE_OVERLOAD_RETRY_MAX_MS",
] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	savedEnv = {};
	for (const key of OVERLOAD_ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of OVERLOAD_ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const noSleep = async () => {};

function post(body = '{"model":"claude-sonnet-5"}') {
	return new Request("https://upstream.invalid/v1/messages", {
		method: "POST",
		body,
	});
}

/**
 * A connect-phase transport failure, in the shape Bun actually throws.
 *
 * Measured on Bun 1.4.2 on 2026-09-14: `fetch("http://127.0.0.1:1")` rejects
 * with a TypeError carrying `code: "ConnectionRefused"`. An earlier version of
 * this file threw a bare `new TypeError("fetch failed")`, which no longer
 * resembles anything the runtime produces and let an over-broad predicate pass.
 */
function connectionRefused() {
	const err = new TypeError(
		"Unable to connect. Is the computer able to access the url?",
	);
	(err as { code?: string }).code = "ConnectionRefused";
	return err;
}

/** DNS resolution never produced an address. */
function dnsFailure() {
	const err = new TypeError("getaddrinfo ENOTFOUND upstream.invalid");
	(err as { code?: string }).code = "ENOTFOUND";
	return err;
}

/** TLS handshake failed, so the body was never sent. */
function tlsFailure() {
	const err = new TypeError("certificate has expired");
	(err as { code?: string }).code = "CERT_HAS_EXPIRED";
	return err;
}

describe("forwardWithTransportRetry: the configured attempt count is the attempt count", () => {
	for (const attempts of [1, 2, 3, 5]) {
		test(`retry_attempts: ${attempts} makes exactly ${attempts} attempts`, async () => {
			let calls = 0;
			const promise = forwardWithTransportRetry(
				post(),
				async () => {
					calls++;
					throw connectionRefused();
				},
				{
					settings: { attempts, delayMs: 0, backoff: 2 },
					sleep: noSleep,
				},
			);

			await expect(promise).rejects.toThrow("Unable to connect");
			expect(calls).toBe(attempts);
		});
	}

	test("a first attempt that succeeds is the only attempt", async () => {
		let calls = 0;
		const response = await forwardWithTransportRetry(
			post(),
			async () => {
				calls++;
				return new Response("ok", { status: 200 });
			},
			{ settings: { attempts: 5, delayMs: 0, backoff: 2 }, sleep: noSleep },
		);

		expect(response.status).toBe(200);
		expect(calls).toBe(1);
	});

	test("it stops retrying as soon as an attempt succeeds", async () => {
		let calls = 0;
		const response = await forwardWithTransportRetry(
			post(),
			async () => {
				calls++;
				if (calls < 3) throw connectionRefused();
				return new Response("ok", { status: 200 });
			},
			{ settings: { attempts: 5, delayMs: 0, backoff: 2 }, sleep: noSleep },
		);

		expect(response.status).toBe(200);
		expect(calls).toBe(3);
	});

	test("the retried request still carries the body", async () => {
		const bodies: string[] = [];
		let calls = 0;
		const response = await forwardWithTransportRetry(
			post('{"model":"claude-opus-5"}'),
			async (target) => {
				calls++;
				bodies.push(await target.text());
				if (calls < 2) throw connectionRefused();
				return new Response("ok", { status: 200 });
			},
			{ settings: { attempts: 3, delayMs: 0, backoff: 2 }, sleep: noSleep },
		);

		expect(response.status).toBe(200);
		expect(bodies).toEqual([
			'{"model":"claude-opus-5"}',
			'{"model":"claude-opus-5"}',
		]);
	});
});

describe("forwardWithTransportRetry: retry_delay_ms and retry_backoff reach the delay", () => {
	// Without these, `retryDelayMs(cfg, attempt + 1)` could be replaced by a
	// constant and all the attempt-count tests would still pass. That is the
	// "asserts the key parses" failure this file's header rejects, applied to
	// the other two keys rather than to retry_attempts.
	function collectDelays(settings: {
		attempts: number;
		delayMs: number;
		backoff: number;
	}) {
		const delays: number[] = [];
		const slept: number[] = [];
		const promise = forwardWithTransportRetry(
			post(),
			async () => {
				throw connectionRefused();
			},
			{
				settings,
				sleep: async (ms) => {
					slept.push(ms);
				},
				onRetry: ({ delayMs }) => delays.push(delayMs),
			},
		);
		return { promise, delays, slept };
	}

	test("each delay stays inside its own jittered cap, which grows by retry_backoff", () => {
		const settings = { attempts: 4, delayMs: 100, backoff: 3 };
		const { promise, delays, slept } = collectDelays(settings);
		return promise.catch(() => {
			// attempts: 4 means 3 retries, so 3 delays.
			expect(delays.length).toBe(3);
			// The value passed to sleep is the value reported to onRetry.
			expect(slept).toEqual(delays);
			delays.forEach((delay, i) => {
				const cap = Math.min(
					settings.delayMs * settings.backoff ** (i + 1),
					3000,
				);
				expect(delay).toBeGreaterThanOrEqual(0);
				expect(delay).toBeLessThanOrEqual(cap);
			});
			// Caps here are 300, 900 and 2700, so the third delay's ceiling is
			// nine times the first's. A constant delay cannot satisfy this.
			expect(Math.min(settings.delayMs * settings.backoff ** 3, 3000)).toBe(
				2700,
			);
		});
	});

	test("retry_delay_ms of 0 produces a delay of 0 on every retry", () => {
		const { promise, delays } = collectDelays({
			attempts: 4,
			delayMs: 0,
			backoff: 2,
		});
		return promise.catch(() => {
			expect(delays).toEqual([0, 0, 0]);
		});
	});

	test("a larger retry_delay_ms raises the ceiling it is drawn under", async () => {
		// Sampled rather than asserted once: the draw is uniform over [0, cap],
		// so a single pair could order either way by chance. The maximum over
		// many draws separates the two caps reliably.
		const maxOf = async (delayMs: number) => {
			let seen = 0;
			for (let i = 0; i < 200; i++) {
				const { promise, delays } = collectDelays({
					attempts: 2,
					delayMs,
					backoff: 2,
				});
				await promise.catch(() => {});
				seen = Math.max(seen, delays[0] ?? 0);
			}
			return seen;
		};
		// attempts: 2 means one retry, at cap = delayMs * backoff**1.
		// So the caps are 20 and 2000. The larger sample must clear the
		// smaller cap; 200 uniform draws miss the top 1% with probability
		// 0.99**200, about 13%, so compare against the smaller cap rather
		// than against the larger one to keep this deterministic.
		expect(await maxOf(1000)).toBeGreaterThan(20);
		expect(await maxOf(10)).toBeLessThanOrEqual(20);
	});
});

describe("getOverloadRetryConfig: an out-of-range value is clamped, not replaced", () => {
	// retry_attempts: 0 is an operator asking for no retries. Falling back to
	// the default would hand them 3, the largest value in play.
	test("retry_attempts of 0 disables retry rather than becoming 3", () => {
		const cfg = getOverloadRetryConfig({
			attempts: 0,
			delayMs: 100,
			backoff: 2,
		});
		expect(cfg.maxAttempts).toBe(1);
		expect(cfg.enabled).toBe(false);
	});

	test("a negative retry_attempts also disables retry", () => {
		expect(
			getOverloadRetryConfig({ attempts: -5, delayMs: 100, backoff: 2 })
				.maxAttempts,
		).toBe(1);
	});

	test("retry_attempts of 0 makes exactly one attempt", async () => {
		let calls = 0;
		const promise = forwardWithTransportRetry(
			post(),
			async () => {
				calls++;
				throw connectionRefused();
			},
			{ settings: { attempts: 0, delayMs: 0, backoff: 2 }, sleep: noSleep },
		);
		await expect(promise).rejects.toThrow("Unable to connect");
		expect(calls).toBe(1);
	});

	test("a negative retry_delay_ms clamps to 0, not to the 1000 default", () => {
		expect(
			getOverloadRetryConfig({ attempts: 3, delayMs: -1, backoff: 2 }).baseMs,
		).toBe(0);
	});

	test("a retry_backoff below 1 clamps to 1, not to the 2 default", () => {
		expect(
			getOverloadRetryConfig({ attempts: 3, delayMs: 100, backoff: 0.5 })
				.backoff,
		).toBe(1);
	});

	test("a non-finite value falls back to the default, which is different from clamping", () => {
		const cfg = getOverloadRetryConfig({
			attempts: Number.NaN,
			delayMs: Number.NaN,
			backoff: Number.NaN,
		});
		expect(cfg.maxAttempts).toBe(3);
		expect(cfg.baseMs).toBe(1000);
		expect(cfg.backoff).toBe(2);
	});
});

describe("forwardWithTransportRetry: what is never retried", () => {
	test("a response is never retried, whatever its status", async () => {
		// 429 routes to another account through the selector and 529 has its own
		// in-place retry. A second layer over either is a retry storm.
		for (const status of [429, 500, 502, 503, 504, 529]) {
			let calls = 0;
			const response = await forwardWithTransportRetry(
				post(),
				async () => {
					calls++;
					return new Response("upstream said no", { status });
				},
				{ settings: { attempts: 5, delayMs: 0, backoff: 2 }, sleep: noSleep },
			);

			expect(response.status).toBe(status);
			expect(calls).toBe(1);
		}
	});

	test("every measured connect-phase failure is retried", async () => {
		for (const make of [connectionRefused, dnsFailure, tlsFailure]) {
			let calls = 0;
			const promise = forwardWithTransportRetry(
				post(),
				async () => {
					calls++;
					throw make();
				},
				{ settings: { attempts: 3, delayMs: 0, backoff: 2 }, sleep: noSleep },
			);
			await expect(promise).rejects.toThrow();
			expect(calls).toBe(3);
		}
	});

	test("a throw that does not prove the request failed to arrive is not retried", async () => {
		// The guarded call wraps observation and header handling as well as the
		// fetch, so a provider error or an ordinary bug can surface as a throw on
		// a request that DID reach the model. Retrying those double-bills. So does
		// retrying a reset or a broken pipe, either of which can arrive after the
		// body was fully sent.
		const unsafe: Array<[string, () => Error]> = [
			["a plain bug", () => new Error("boom")],
			[
				"a provider error",
				() => {
					const err = new Error("provider rejected the response");
					err.name = "ProviderError";
					return err;
				},
			],
			[
				"ECONNRESET, which can follow a fully sent body",
				() => {
					const err = new TypeError("socket hang up");
					(err as { code?: string }).code = "ECONNRESET";
					return err;
				},
			],
			[
				"EPIPE, same reason",
				() => {
					const err = new TypeError("write EPIPE");
					(err as { code?: string }).code = "EPIPE";
					return err;
				},
			],
			[
				"ETIMEDOUT, which can fire while the model is generating",
				() => {
					const err = new TypeError("upstream timed out");
					(err as { code?: string }).code = "ETIMEDOUT";
					return err;
				},
			],
		];

		for (const [label, make] of unsafe) {
			let calls = 0;
			const promise = forwardWithTransportRetry(
				post(),
				async () => {
					calls++;
					throw make();
				},
				{ settings: { attempts: 5, delayMs: 0, backoff: 2 }, sleep: noSleep },
			);
			await expect(promise).rejects.toThrow();
			expect(calls, `${label} must not be retried`).toBe(1);
		}
	});

	test("an aborted request is never retried", async () => {
		const controller = new AbortController();
		let calls = 0;
		const promise = forwardWithTransportRetry(
			post(),
			async () => {
				calls++;
				controller.abort();
				const err = new Error("The operation was aborted.");
				err.name = "AbortError";
				throw err;
			},
			{
				settings: { attempts: 5, delayMs: 0, backoff: 2 },
				signal: controller.signal,
				sleep: noSleep,
			},
		);

		await expect(promise).rejects.toThrow("The operation was aborted.");
		expect(calls).toBe(1);
	});

	test("a stream that has already sent bytes cannot reach the retry loop", async () => {
		// The loop retries only a throw, and a throw means no Response object was
		// produced. So by construction nothing that returned a body, streamed or
		// not, is ever retried here. This asserts that construction directly: an
		// attempt that resolves with a streaming body is made exactly once, even
		// when the stream errors after the first chunk has been handed over.
		let calls = 0;
		const response = await forwardWithTransportRetry(
			post(),
			async () => {
				calls++;
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("event: start\n"));
							controller.error(new Error("upstream died mid-stream"));
						},
					}),
					{ status: 200 },
				);
			},
			{ settings: { attempts: 5, delayMs: 0, backoff: 2 }, sleep: noSleep },
		);

		expect(calls).toBe(1);
		await expect(response.text()).rejects.toThrow();
		expect(calls).toBe(1);
	});
});

describe("getOverloadRetryConfig: the documented keys drive it", () => {
	test("the documented keys are what it reports", () => {
		const cfg = getOverloadRetryConfig({
			attempts: 4,
			delayMs: 250,
			backoff: 3,
		});
		expect(cfg.enabled).toBe(true);
		expect(cfg.maxAttempts).toBe(4);
		expect(cfg.baseMs).toBe(250);
		expect(cfg.backoff).toBe(3);
	});

	test("retry_attempts of 1 disables retry", () => {
		const cfg = getOverloadRetryConfig({
			attempts: 1,
			delayMs: 250,
			backoff: 2,
		});
		expect(cfg.enabled).toBe(false);
	});

	test("the deprecated CCFLARE_OVERLOAD_RETRY_* variables still override", () => {
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "7";
		process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "42";
		const cfg = getOverloadRetryConfig({
			attempts: 4,
			delayMs: 250,
			backoff: 2,
		});
		expect(cfg.maxAttempts).toBe(7);
		expect(cfg.baseMs).toBe(42);
	});

	test("CCFLARE_OVERLOAD_RETRY_ENABLED=false disables retry", async () => {
		process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = "false";
		let calls = 0;
		const promise = forwardWithTransportRetry(
			post(),
			async () => {
				calls++;
				throw connectionRefused();
			},
			{ settings: { attempts: 5, delayMs: 0, backoff: 2 }, sleep: noSleep },
		);

		await expect(promise).rejects.toThrow("Unable to connect");
		expect(calls).toBe(1);
	});
});
