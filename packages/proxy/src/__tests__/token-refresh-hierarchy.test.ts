import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import {
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import { AutoRefreshScheduler } from "../auto-refresh-scheduler";
import type { ProxyContext } from "../proxy";
import type { PublicSurface } from "./public-surface";

// Test database path
const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-token-refresh-hierarchy.db`;

type SchedulerProbe = PublicSurface<AutoRefreshScheduler> & {
	shouldRefreshAccount(
		account: {
			id: string;
			name: string;
			provider: string;
			refresh_token: string;
			access_token: string | null;
			expires_at: number | null;
			rate_limit_reset: number | null;
			custom_endpoint: string | null;
			paused: number;
			pause_reason: string | null;
		},
		now: number,
	): boolean;
};

describe("Auto-Refresh Token Hierarchy", () => {
	let db: Database;
	let dbOps: DatabaseOperations;
	let scheduler: AutoRefreshScheduler;
	let mockProxyContext: ProxyContext;

	beforeAll(async () => {
		// Clean up any existing test database
		try {
			if (existsSync(TEST_DB_PATH)) {
				unlinkSync(TEST_DB_PATH);
			}
		} catch (error) {
			console.warn("Failed to clean up existing test database:", error);
		}

		// Initialize test database
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		db = dbOps.getDatabase();

		// Create mock proxy context
		mockProxyContext = {
			runtime: {
				port: 8080,
				clientId: "test-client-id",
			},
		} as ProxyContext;

		// Initialize scheduler
		// `AutoRefreshScheduler` takes a `BunSqlAdapter`; `getDatabase()` returns
		// the raw `bun:sqlite` handle. The paths exercised below never touch the
		// adapter, which is why this suite has always passed the handle. The
		// sibling auto-refresh suites state the same gap the same way.
		scheduler = new AutoRefreshScheduler(db as never, mockProxyContext);
	});

	afterAll(() => {
		// Clean up test database
		try {
			if (existsSync(TEST_DB_PATH)) {
				unlinkSync(TEST_DB_PATH);
			}
		} catch (error) {
			console.warn("Failed to clean up test database:", error);
		}
		DatabaseFactory.reset();
	});

	describe("Window Refresh Logic", () => {
		it("should correctly identify accounts that need window refresh", () => {
			const now = Date.now();
			const oneHourAgo = now - 60 * 60 * 1000; // 1 hour ago
			const oneHourFromNow = now + 60 * 60 * 1000; // 1 hour from now

			const accountStale = {
				id: "test-stale",
				name: "stale-account",
				provider: "anthropic",
				refresh_token: "refresh-token",
				access_token: "access-token",
				expires_at: oneHourFromNow,
				rate_limit_reset: oneHourAgo, // More than 24h old (stale)
				custom_endpoint: null,
				paused: 0,
				pause_reason: null,
			};

			const accountCurrent = {
				id: "test-current",
				name: "current-account",
				provider: "anthropic",
				refresh_token: "refresh-token",
				access_token: "access-token",
				expires_at: oneHourFromNow,
				rate_limit_reset: oneHourFromNow, // Future time
				custom_endpoint: null,
				paused: 0,
				pause_reason: null,
			};

			// Access private method for testing
			const shouldRefreshStale = (
				scheduler as unknown as SchedulerProbe
			).shouldRefreshAccount(accountStale, now);
			const shouldRefreshCurrent = (
				scheduler as unknown as SchedulerProbe
			).shouldRefreshAccount(accountCurrent, now);

			expect(shouldRefreshStale).toBe(true); // Should refresh (stale reset time)
			expect(shouldRefreshCurrent).toBe(true); // Should refresh (first-time check regardless of reset time)
		});

		it("should handle first-time refresh correctly", () => {
			const now = Date.now();
			const oneHourFromNow = now + 60 * 60 * 1000;

			const accountFirstTime = {
				id: "test-first-time",
				name: "first-time-account",
				provider: "anthropic",
				refresh_token: "refresh-token",
				access_token: "access-token",
				expires_at: oneHourFromNow,
				rate_limit_reset: oneHourFromNow,
				custom_endpoint: null,
				paused: 0,
				pause_reason: null,
			};

			// Access private method for testing
			const shouldRefreshFirstTime = (
				scheduler as unknown as SchedulerProbe
			).shouldRefreshAccount(accountFirstTime, now);

			expect(shouldRefreshFirstTime).toBe(true); // Should refresh (first time)
		});
	});
});
