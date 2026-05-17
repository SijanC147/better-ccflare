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
import { createAccountForceResetRateLimitHandler } from "../accounts";

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
