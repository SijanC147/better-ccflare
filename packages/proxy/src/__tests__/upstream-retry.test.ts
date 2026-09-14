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

/** A transport failure: fetch threw, so no Response object ever existed. */
function connectionRefused() {
	return new TypeError("fetch failed");
}

describe("forwardWithTransportRetry — the configured attempt count is the attempt count", () => {
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

			await expect(promise).rejects.toThrow("fetch failed");
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

describe("forwardWithTransportRetry — what is never retried", () => {
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

describe("getOverloadRetryConfig — the documented keys drive it", () => {
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

		await expect(promise).rejects.toThrow("fetch failed");
		expect(calls).toBe(1);
	});
});
