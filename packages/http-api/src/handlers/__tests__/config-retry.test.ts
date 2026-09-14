/**
 * Tests for the upstream retry configuration endpoint.
 *
 * This handler is the only range check the three documented retry keys get.
 * packages/config accepts `retry_attempts`, `retry_delay_ms` and
 * `retry_backoff` on a bare `typeof value === "number"`, unlike the adjacent
 * `db_retry_*`, so a value that gets past this handler is clamped silently
 * further down or, for attempts, actually attempted (SB23-1980).
 */

import { describe, expect, it } from "bun:test";
import type { Config } from "@better-ccflare/config";
import { createRetryConfigHandlers } from "../config-retry";

const OVERLOAD_KEYS = [
	"CCFLARE_OVERLOAD_RETRY_ENABLED",
	"CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS",
	"CCFLARE_OVERLOAD_RETRY_BASE_MS",
];

function configStub(
	retry = { attempts: 3, delayMs: 1000, backoff: 2 },
	environmentKeys: string[] = [],
	overloadEnvironmentKeys: string[] = [],
) {
	const written: Array<{ attempts: number; delayMs: number; backoff: number }> =
		[];
	const config = {
		getRuntime: () => ({ retry }),
		getRetryEnvironmentKeys: () => environmentKeys,
		getOverloadRetryEnvironmentKeys: () => overloadEnvironmentKeys,
		setRetrySettings: (settings: {
			attempts: number;
			delayMs: number;
			backoff: number;
		}) => {
			written.push(settings);
		},
	} as unknown as Config;
	return { config, written };
}

function post(body: unknown): Request {
	return new Request("http://localhost/api/config/retry", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

describe("GET /api/config/retry", () => {
	it("reports the resolved values and the bounds the write enforces", async () => {
		const { config } = configStub();
		const body = (await createRetryConfigHandlers(config)
			.getRetryConfig()
			.json()) as Record<string, unknown>;

		expect(body.attempts).toBe(3);
		expect(body.delayMs).toBe(1000);
		expect(body.backoff).toBe(2);
		// The card carries no copy of these, so they have to travel with the read.
		expect(body.bounds).toEqual({
			attempts: { min: 0, max: 5 },
			delayMs: { min: 0, max: 30_000 },
			backoff: { min: 1, max: 5 },
		});
	});

	it("says a restart is needed, because RuntimeConfig is built once at startup", async () => {
		const { config } = configStub();
		const body = (await createRetryConfigHandlers(config)
			.getRetryConfig()
			.json()) as { restartRequired: boolean };
		expect(body.restartRequired).toBe(true);
	});

	it("keeps the two environment groups apart", async () => {
		// RETRY_* loses to a saved value, CCFLARE_OVERLOAD_RETRY_* beats it. One
		// merged list would state both facts as one and mislead either way.
		const { config } = configStub(undefined, ["RETRY_ATTEMPTS"], OVERLOAD_KEYS);
		const body = (await createRetryConfigHandlers(config)
			.getRetryConfig()
			.json()) as {
			environmentKeys: string[];
			overloadEnvironmentKeys: string[];
		};
		expect(body.environmentKeys).toEqual(["RETRY_ATTEMPTS"]);
		expect(body.overloadEnvironmentKeys).toEqual(OVERLOAD_KEYS);
	});
});

describe("POST /api/config/retry", () => {
	it("writes all three keys", async () => {
		const { config, written } = configStub();
		const response = await createRetryConfigHandlers(config).setRetryConfig(
			post({ attempts: 4, delayMs: 500, backoff: 1.5 }),
		);
		expect(response.status).toBe(204);
		expect(written).toEqual([{ attempts: 4, delayMs: 500, backoff: 1.5 }]);
	});

	it("leaves an omitted key at its current value", async () => {
		// An older client posting two fields must not reset the third.
		const { config, written } = configStub();
		await createRetryConfigHandlers(config).setRetryConfig(
			post({ attempts: 1 }),
		);
		expect(written).toEqual([{ attempts: 1, delayMs: 1000, backoff: 2 }]);
	});

	it("accepts 0 attempts rather than treating it as unset", async () => {
		// The one value an operator asking for no retries would type. Falling back
		// to the default here would hand them 3, the largest value in play.
		const { config, written } = configStub();
		await createRetryConfigHandlers(config).setRetryConfig(
			post({ attempts: 0 }),
		);
		expect(written[0].attempts).toBe(0);
	});

	it("rejects 500 attempts and writes nothing", async () => {
		const { config, written } = configStub();
		const response = await createRetryConfigHandlers(config).setRetryConfig(
			post({ attempts: 500 }),
		);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("between 0 and 5");
		expect(written).toEqual([]);
	});

	it("rejects a fractional attempts count", async () => {
		const { config, written } = configStub();
		const response = await createRetryConfigHandlers(config).setRetryConfig(
			post({ attempts: 2.5 }),
		);
		expect(response.status).toBe(400);
		expect(written).toEqual([]);
	});

	it("rejects a delay above the ceiling and a negative delay", async () => {
		const { config, written } = configStub();
		const handlers = createRetryConfigHandlers(config);
		expect(
			(await handlers.setRetryConfig(post({ delayMs: 60_000 }))).status,
		).toBe(400);
		expect((await handlers.setRetryConfig(post({ delayMs: -1 }))).status).toBe(
			400,
		);
		expect(written).toEqual([]);
	});

	it("rejects a backoff below 1, which would shrink the delay each retry", async () => {
		const { config, written } = configStub();
		const response = await createRetryConfigHandlers(config).setRetryConfig(
			post({ backoff: 0.5 }),
		);
		expect(response.status).toBe(400);
		expect(written).toEqual([]);
	});

	it("rejects a non-numeric value rather than coercing it", async () => {
		const { config, written } = configStub();
		const handlers = createRetryConfigHandlers(config);
		expect(
			(await handlers.setRetryConfig(post({ attempts: "3" }))).status,
		).toBe(400);
		expect(
			(await handlers.setRetryConfig(post({ delayMs: Number.NaN }))).status,
		).toBe(400);
		expect(written).toEqual([]);
	});

	it("rejects a body that is not JSON", async () => {
		const { config } = configStub();
		const request = new Request("http://localhost/api/config/retry", {
			method: "POST",
			body: "not json",
		});
		const response =
			await createRetryConfigHandlers(config).setRetryConfig(request);
		expect(response.status).toBe(400);
	});
});
