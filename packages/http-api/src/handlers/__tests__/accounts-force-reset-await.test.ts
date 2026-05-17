/**
 * Regression for Codex PR #28 P2: createAccountForceResetRateLimitHandler
 * must await dbOps.forceResetAccountRateLimit() (a Promise<boolean> on the
 * async DB adapter path). Before the fix the result was a Promise, so the
 * `if (!resetSuccess)` failure branch was dead code and the handler reported
 * success even when the persisted rate-limit lock was not cleared.
 */
import { describe, expect, it } from "bun:test";
import "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import {
	createAccountAutoPauseOnOverageHandler,
	createAccountForceResetRateLimitHandler,
} from "../accounts";

const ACCOUNT = {
	id: "acct-1",
	name: "test-account",
	provider: "zai", // non-anthropic: skips the fetchUsageData fallback path
	access_token: null,
};

function makeDbOps(forceReset: () => Promise<boolean>): DatabaseOperations {
	return {
		getAdapter() {
			return {
				async get() {
					return ACCOUNT;
				},
			};
		},
		forceResetAccountRateLimit: forceReset,
	} as unknown as DatabaseOperations;
}

const req = new Request(
	"http://localhost/api/accounts/acct-1/force-reset-rate-limit",
	{
		method: "POST",
	},
);

describe("force-reset rate limit awaits the DB write (Codex P2)", () => {
	it("returns an error (not success) when the reset resolves false", async () => {
		const handler = createAccountForceResetRateLimitHandler(
			makeDbOps(async () => false),
		);

		const res = await handler(req, ACCOUNT.id);
		const data = await res.json();

		// Pre-fix: resetSuccess was a Promise (truthy) -> success:true.
		// Post-fix: awaited false -> error response.
		expect(res.status).not.toBe(200);
		expect(data.success).not.toBe(true);
		expect(data.error ?? data.message ?? "").toMatch(/reset|fail/i);
	});

	it("returns an error when the reset rejects", async () => {
		const handler = createAccountForceResetRateLimitHandler(
			makeDbOps(async () => {
				throw new Error("db write rejected");
			}),
		);

		const res = await handler(req, ACCOUNT.id);
		const data = await res.json();

		expect(res.status).not.toBe(200);
		expect(data.success).not.toBe(true);
	});

	it("reports success when the reset resolves true", async () => {
		const handler = createAccountForceResetRateLimitHandler(
			makeDbOps(async () => true),
		);

		const res = await handler(req, ACCOUNT.id);
		const data = await res.json();

		expect(res.status).toBe(200);
		expect(data.success).toBe(true);
	});
});

/**
 * Same await-bug class as force-reset: createAccountAutoPauseOnOverageHandler
 * must await dbOps.setAutoPauseOnOverageEnabled() (Promise<void> on the async
 * adapter path). Without the await, a rejected write was unhandled and the
 * handler returned 200 / success:true even though the toggle never committed
 * (Codex PR #28 P2).
 */
const ANTHROPIC_ACCOUNT = {
	id: "acct-anthropic-1",
	name: "test-anthropic",
	provider: "anthropic",
};

function makeAutoPauseDbOps(
	setAutoPause: (accountId: string, enabled: boolean) => Promise<void>,
): DatabaseOperations {
	return {
		getAdapter() {
			return {
				async get() {
					return ANTHROPIC_ACCOUNT;
				},
			};
		},
		setAutoPauseOnOverageEnabled: setAutoPause,
	} as unknown as DatabaseOperations;
}

const autoPauseReq = () =>
	new Request(
		"http://localhost/api/accounts/acct-anthropic-1/auto-pause-on-overage",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled: 1 }),
		},
	);

describe("auto-pause-on-overage awaits the DB write (Codex P2)", () => {
	it("returns an error when the toggle write rejects", async () => {
		const handler = createAccountAutoPauseOnOverageHandler(
			makeAutoPauseDbOps(async () => {
				throw new Error("simulated DB rejection");
			}),
		);

		const res = await handler(autoPauseReq(), ANTHROPIC_ACCOUNT.id);
		const data = await res.json();

		// Pre-fix: write was unawaited -> handler returned 200/success:true
		// regardless of the rejection. Post-fix: rejection is awaited and
		// caught -> error response.
		expect(res.status).not.toBe(200);
		expect(data.success).not.toBe(true);
	});

	it("reports success when the toggle write resolves", async () => {
		const handler = createAccountAutoPauseOnOverageHandler(
			makeAutoPauseDbOps(async () => undefined),
		);

		const res = await handler(autoPauseReq(), ANTHROPIC_ACCOUNT.id);
		const data = await res.json();

		expect(res.status).toBe(200);
		expect(data.success).toBe(true);
	});
});
