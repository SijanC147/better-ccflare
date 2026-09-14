import { describe, expect, it } from "bun:test";
import type { Account, CircuitHealth } from "@better-ccflare/types";
import { createHealthHandler } from "../health";

/**
 * SB23-1903. `/api/health` reports circuit-breaker state and nothing gates on
 * it. Two things have to stay true and both are asserted here: an open circuit
 * reaches the response body, and an open circuit does NOT change `status`,
 * the HTTP status code, or any `pool` counter.
 *
 * The failure mode is a reporter that always looks healthy, so every case
 * below feeds a NON-default circuit payload and asserts the response carries
 * it through.
 */

const dbWith = (accounts: Partial<Account>[]) =>
	({
		getAllAccounts: async () => accounts,
	}) as unknown as import("@better-ccflare/database").DatabaseOperations;

const config = {
	getStrategy: () => "session",
} as unknown as import("@better-ccflare/config").Config;

const routableAccounts = [
	{ id: "a1", name: "a1", provider: "anthropic", paused: false },
	{ id: "a2", name: "a2", provider: "anthropic", paused: false },
];

function openCircuit(): CircuitHealth {
	return {
		enabled: true,
		accounts: [
			{
				key: "anthropic:a1",
				provider: "anthropic",
				accountId: "a1",
				state: "open",
				failureCount: 5,
				openedAt: 1_700_000_000_000,
				cooldownEndsAt: 1_700_000_060_000,
				halfOpenProbeInFlight: false,
				probeDeadlineAt: null,
			},
			{
				key: "anthropic:a2",
				provider: "anthropic",
				accountId: "a2",
				state: "open",
				failureCount: 5,
				openedAt: 1_700_000_000_000,
				cooldownEndsAt: 1_700_000_060_000,
				halfOpenProbeInFlight: false,
				probeDeadlineAt: null,
			},
		],
		providers: [
			{
				provider: "anthropic",
				tracked: 2,
				open: 2,
				halfOpen: 0,
				closed: 0,
				wideOpen: true,
			},
		],
	};
}

async function bodyOf(circuit: CircuitHealth, accounts = routableAccounts) {
	const handler = createHealthHandler(
		dbWith(accounts),
		config,
		undefined,
		undefined,
		undefined,
		() => null,
		undefined,
		() => circuit,
	);
	const response = await handler(new URL("http://localhost/health"));
	return {
		response,
		body: (await response.json()) as {
			status: string;
			circuit?: CircuitHealth;
			pool: { routable: number; usage_exhausted: number };
		},
	};
}

describe("/api/health — circuit block", () => {
	it("carries an open circuit and a wide-open provider into the response", async () => {
		const { body } = await bodyOf(openCircuit());

		expect(body.circuit?.enabled).toBe(true);
		expect(body.circuit?.accounts.map((a) => a.state)).toEqual([
			"open",
			"open",
		]);
		expect(body.circuit?.providers).toEqual([
			{
				provider: "anthropic",
				tracked: 2,
				open: 2,
				halfOpen: 0,
				closed: 0,
				wideOpen: true,
			},
		]);
	});

	it("does not let an open circuit change status, HTTP code, or pool counters", async () => {
		const { response, body } = await bodyOf(openCircuit());

		// Both accounts have every circuit open, yet the pool is untouched:
		// nothing in the request path consults the breaker.
		expect(body.status).toBe("ok");
		expect(response.status).toBe(200);
		expect(body.pool.routable).toBe(2);
		expect(body.pool.usage_exhausted).toBe(0);
	});

	it("reports a disabled breaker as disabled rather than omitting the block", async () => {
		const { body } = await bodyOf({
			enabled: false,
			accounts: [],
			providers: [],
		});

		expect(body.circuit).toEqual({
			enabled: false,
			accounts: [],
			providers: [],
		});
	});

	it("reports the breaker even when the pool itself is unhealthy", async () => {
		// A paused pool makes the endpoint 503. The circuit block must survive
		// that path, because "are we down because of us or because of them?" is
		// exactly the question asked when the endpoint is not 200.
		const { response, body } = await bodyOf(openCircuit(), [
			{ id: "a1", name: "a1", provider: "anthropic", paused: true },
		]);

		expect(response.status).toBe(503);
		expect(body.status).toBe("unhealthy");
		expect(body.circuit?.providers[0]?.wideOpen).toBe(true);
	});
});
