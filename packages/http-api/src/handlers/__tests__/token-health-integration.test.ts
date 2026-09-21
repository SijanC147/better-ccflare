import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import {
	checkAllAccountsHealth,
	getAccountsNeedingReauth,
} from "@better-ccflare/proxy";
import type { Account } from "@better-ccflare/types";
import { createAccountTokenHealthHandler } from "../token-health";

// Mock database operations for testing
const mockAccounts: Account[] = [
	{
		id: "1",
		name: "test-account-1",
		provider: "anthropic",
		refresh_token: "valid-refresh-token",
		created_at: Date.now() - 120 * 24 * 60 * 60 * 1000, // 120 days ago (account is old)
		refresh_token_issued_at: Date.now() - 30 * 24 * 60 * 60 * 1000, // token refreshed 30 days ago (healthy)
		expires_at: Date.now() + 14 * 24 * 60 * 60 * 1000, // 14 days from now (healthy)
		paused: false,
		api_key: null,
		access_token: "access-token",
		request_count: 0,
		total_requests: 0,
		last_used: null,
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		requires_reauth: false,
		peak_hours_pause_enabled: false,
		request_transformer: null,
		last_manual_reauth_at: null,
		consecutive_rate_limits: 0,
		renewal_day: null,
		usage_pause_five_hour_threshold: null,
		usage_pause_weekly_threshold: null,
		usage_pause_five_hour_enabled: false,
		usage_pause_weekly_enabled: false,
	},
	{
		id: "2",
		name: "test-account-2",
		provider: "anthropic",
		refresh_token: "expiring-soon-token",
		created_at: Date.now() - 95 * 24 * 60 * 60 * 1000, // 95 days ago
		refresh_token_issued_at: null, // No refresh_token_issued_at — falls back to created_at (past 90 day max, will be expired)
		expires_at: Date.now() - 2 * 24 * 60 * 60 * 1000, // 2 days ago (expired)
		paused: false,
		api_key: null,
		access_token: "access-token",
		request_count: 0,
		total_requests: 0,
		last_used: null,
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		requires_reauth: false,
		peak_hours_pause_enabled: false,
		request_transformer: null,
		last_manual_reauth_at: null,
		consecutive_rate_limits: 0,
		renewal_day: null,
		usage_pause_five_hour_threshold: null,
		usage_pause_weekly_threshold: null,
		usage_pause_five_hour_enabled: false,
		usage_pause_weekly_enabled: false,
	},
	{
		id: "3",
		name: "test-account-3",
		provider: "anthropic",
		refresh_token: null, // No refresh token (console mode)
		created_at: Date.now() - 30 * 24 * 60 * 60 * 1000,
		refresh_token_issued_at: null,
		expires_at: null,
		paused: false,
		api_key: "api-key", // API key account
		access_token: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		requires_reauth: false,
		peak_hours_pause_enabled: false,
		request_transformer: null,
		last_manual_reauth_at: null,
		consecutive_rate_limits: 0,
		renewal_day: null,
		usage_pause_five_hour_threshold: null,
		usage_pause_weekly_threshold: null,
		usage_pause_five_hour_enabled: false,
		usage_pause_weekly_enabled: false,
	},
];

describe("Token Health HTTP API Integration", () => {
	describe("Token Health Monitoring", () => {
		it("should check all accounts health", () => {
			const healthReport = checkAllAccountsHealth(mockAccounts);

			expect(healthReport).toBeDefined();
			expect(healthReport.accounts).toHaveLength(3);
			expect(healthReport.summary).toBeDefined();
			expect(healthReport.summary.total).toBe(3);
		});

		it("should identify accounts needing re-authentication", () => {
			const needingReauth = getAccountsNeedingReauth(mockAccounts);

			// Should find accounts that need re-authentication
			expect(needingReauth.length).toBeGreaterThanOrEqual(1);
			// The specific account may vary based on implementation details
			expect(
				needingReauth.some((acc) => acc.name.includes("test-account")),
			).toBe(true);
		});

		it("should handle empty accounts list", () => {
			const emptyHealthReport = checkAllAccountsHealth([]);
			const emptyNeedingReauth = getAccountsNeedingReauth([]);

			expect(emptyHealthReport.accounts).toHaveLength(0);
			expect(emptyHealthReport.summary.total).toBe(0);
			expect(emptyNeedingReauth).toHaveLength(0);
		});
	});

	describe("Account Health Status Types", () => {
		it("should return correct status for different account types", () => {
			const healthReport = checkAllAccountsHealth(mockAccounts);

			const account1 = healthReport.accounts.find(
				(acc) => acc.accountName === "test-account-1",
			);
			const account2 = healthReport.accounts.find(
				(acc) => acc.accountName === "test-account-2",
			);
			const account3 = healthReport.accounts.find(
				(acc) => acc.accountName === "test-account-3",
			);

			// Account with valid refresh token should have appropriate status
			expect(account1?.status).toBeDefined();

			// Account expiring soon should have appropriate status
			expect(account2?.status).toBeDefined();

			// Account without refresh token should be "no-refresh-token"
			expect(account3?.status).toBe("no-refresh-token");
		});

		it("should include days until expiration for OAuth accounts", () => {
			const healthReport = checkAllAccountsHealth(mockAccounts);

			const account1 = healthReport.accounts.find(
				(acc) => acc.accountName === "test-account-1",
			);
			const account2 = healthReport.accounts.find(
				(acc) => acc.accountName === "test-account-2",
			);

			// Assert the lookups found something. Guarding each assertion behind
			// `!== undefined` is what let this test run empty for as long as the
			// lookups used `acc.name`, which TokenHealthStatus does not have.
			expect(account1).toBeDefined();
			expect(account2).toBeDefined();

			// test-account-1 is seeded healthy, refreshed 30 days ago and
			// expiring in 14, so its estimate is still in the future.
			expect(account1?.daysUntilExpiration).toBeGreaterThan(0);

			// test-account-2 is seeded expired on purpose: no
			// refresh_token_issued_at, so the estimate falls back to created_at
			// and lands past the 90 day maximum. The monitor treats
			// `daysUntilExpiration <= 0` as the expired branch
			// (packages/proxy/src/handlers/token-health-monitor.ts:99), so a
			// value at or below zero is the behaviour under test, not a defect.
			expect(account2?.daysUntilExpiration).toBeLessThanOrEqual(0);
			expect(account2?.status).toBe("expired");
		});
	});

	describe("Response Data Structure", () => {
		it("should provide consistent health report structure", () => {
			const healthReport = checkAllAccountsHealth(mockAccounts);

			// Check top-level structure
			expect(healthReport).toHaveProperty("accounts");
			expect(healthReport).toHaveProperty("summary");
			expect(healthReport).toHaveProperty("timestamp");

			// Check summary structure
			expect(healthReport.summary).toHaveProperty("total");
			expect(healthReport.summary).toHaveProperty("healthy");
			expect(healthReport.summary).toHaveProperty("warning");
			expect(healthReport.summary).toHaveProperty("critical");
			expect(healthReport.summary).toHaveProperty("expired");
			expect(healthReport.summary).toHaveProperty("noRefreshToken");
			expect(healthReport.summary).toHaveProperty("requiresReauth");

			// Check account structure
			healthReport.accounts.forEach((account) => {
				expect(account).toHaveProperty("accountName");
				expect(account).toHaveProperty("provider");
				expect(account).toHaveProperty("status");
				expect(account).toHaveProperty("message");
			});
		});
	});
});

describe("CLI Integration Tests", () => {
	it("should handle account-specific health checks", () => {
		const healthReport = checkAllAccountsHealth(mockAccounts);
		const accountHealth = healthReport.accounts.find(
			(acc) => acc.accountName === "test-account-1",
		);

		expect(accountHealth).toBeDefined();
		expect(accountHealth?.accountName).toBe("test-account-1");
		expect(accountHealth?.provider).toBe("anthropic");
	});
});

describe("Error Handling", () => {
	it("should handle missing account gracefully", () => {
		const healthReport = checkAllAccountsHealth(mockAccounts);
		const missingAccount = healthReport.accounts.find(
			(acc) => acc.accountName === "nonexistent-account",
		);

		expect(missingAccount).toBeUndefined();
	});

	it("should handle malformed account data", () => {
		const malformedAccounts = [
			{
				id: "1",
				name: "",
				provider: "anthropic",
				refresh_token: "token",
				created_at: Date.now(),
				refresh_token_issued_at: null,
				expires_at: Date.now(),
				paused: false,
				api_key: null,
				access_token: "access-token",
				request_count: 0,
				total_requests: 0,
				last_used: null,
				rate_limited_until: null,
				session_start: null,
				session_request_count: 0,
				rate_limit_reset: null,
				rate_limit_status: null,
				rate_limit_remaining: null,
				priority: 0,
				auto_fallback_enabled: false,
				auto_refresh_enabled: false,
				auto_pause_on_overage_enabled: false,
				custom_endpoint: null,
				model_mappings: null,
				cross_region_mode: null,
				model_fallbacks: null,
				billing_type: null,
				pause_reason: null,
				rate_limited_reason: null,
				rate_limited_at: null,
				requires_reauth: false,
				peak_hours_pause_enabled: false,
				request_transformer: null,
				last_manual_reauth_at: null,
				consecutive_rate_limits: 0,
				renewal_day: null,
				usage_pause_five_hour_threshold: null,
				usage_pause_weekly_threshold: null,
				usage_pause_five_hour_enabled: false,
				usage_pause_weekly_enabled: false,
			},
		];

		expect(() => {
			const healthReport = checkAllAccountsHealth(malformedAccounts);
			expect(healthReport.accounts).toHaveLength(1);
		}).not.toThrow();
	});
});

// Conventional test pattern (mirrors account-remove-handler.test.ts). Requires
// the generated `inline-*-worker.ts` build artifacts to be present.
const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-account-token-health-handler.db`;

describe("createAccountTokenHealthHandler — HTTP response codes", () => {
	let dbOps: DatabaseOperations;

	function cleanupDbFiles() {
		for (const suffix of ["", "-wal", "-shm"]) {
			try {
				const p = `${TEST_DB_PATH}${suffix}`;
				if (existsSync(p)) unlinkSync(p);
			} catch {
				// best-effort cleanup
			}
		}
	}

	beforeEach(() => {
		cleanupDbFiles();
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
	});

	afterEach(() => {
		// Close BEFORE unlinking: deleting the file under an open connection
		// makes close()'s `PRAGMA wal_checkpoint(TRUNCATE)` fail with
		// SQLITE_IOERR_VNODE, surfacing as an unhandled error between tests.
		DatabaseFactory.reset();
		cleanupDbFiles();
	});

	it("returns 400 when the account name is empty", async () => {
		const handler = createAccountTokenHealthHandler(dbOps, "");
		const response = await handler();
		expect(response.status).toBe(400);
	});

	it("returns 404 when the account does not exist", async () => {
		const handler = createAccountTokenHealthHandler(dbOps, "missing-account");
		const response = await handler();
		expect(response.status).toBe(404);
	});

	it("returns 200 with token health data when the account exists", async () => {
		await dbOps
			.getAdapter()
			.run(
				"INSERT INTO accounts (id, name, provider, refresh_token, created_at) VALUES (?, ?, ?, ?, ?)",
				["uuid-1", "healthy-account", "anthropic", "rt", Date.now()],
			);

		const handler = createAccountTokenHealthHandler(dbOps, "healthy-account");
		const response = await handler();
		expect(response.status).toBe(200);

		const body = (await response.json()) as { success: boolean; data: unknown };
		expect(body.success).toBe(true);
		expect(body.data).toBeDefined();
	});
});
