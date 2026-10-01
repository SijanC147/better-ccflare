/**
 * The live summary emitted via `onSummary` (packages/proxy/src/usage-collector.ts)
 * carries `rateLimited`, derived from the same status the collector hands to
 * `saveRequest`. The REST list derives the same flag from the persisted
 * `status_code` (http-api handlers/requests.ts), and before SB23-3995 the
 * stream summary had no such key, so the live Requests tab never showed the
 * Rate Limited badge until a refetch.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";

import {
	AsyncDbWriter,
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import type { RequestResponse } from "@better-ccflare/types";
import { UsageCollector } from "../usage-collector";
import type { StartMessage } from "../worker-messages";

// Per process: a fixed /tmp name is shared by every worktree's suite.
const TEST_DB_PATH = `/tmp/test-usage-collector-rate-limited-summary-${process.pid}.db`;

function removeSqliteFiles(dbPath: string): void {
	for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
		if (existsSync(file)) unlinkSync(file);
	}
}

describe("UsageCollector - rateLimited in the live summary", () => {
	let dbOps: DatabaseOperations;
	let collector: UsageCollector;
	let summaries: Map<string, RequestResponse>;

	beforeAll(() => {
		removeSqliteFiles(TEST_DB_PATH);
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		summaries = new Map();
		collector = new UsageCollector(
			dbOps,
			new AsyncDbWriter(),
			() => false,
			(summary) => {
				summaries.set(summary.id, summary);
			},
		);
	});

	afterAll(async () => {
		collector.dispose();
		await collector.drain();
		DatabaseFactory.reset();
		removeSqliteFiles(TEST_DB_PATH);
	});

	function makeStart(requestId: string, responseStatus: number): StartMessage {
		return {
			type: "start",
			messageId: `msg-${requestId}`,
			requestId,
			accountId: null,
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now(),
			requestHeaders: {},
			requestBody: null,
			project: null,
			projectId: null,
			worktreePath: null,
			originalModel: null,
			appliedModel: null,
			responseStatus,
			responseHeaders: {},
			isStream: true,
			providerName: "anthropic",
			accountBillingType: null,
			accountAutoPauseOnOverageEnabled: null,
			accountName: null,
			agentUsed: null,
			comboName: null,
			apiKeyId: null,
			apiKeyName: null,
			retryAttempt: 0,
			failoverAttempts: 0,
		};
	}

	/** Fails loudly if onSummary never fired, so a skipped request cannot pass. */
	async function summaryFor(
		requestId: string,
		responseStatus: number,
	): Promise<RequestResponse> {
		collector.handleStart(makeStart(requestId, responseStatus));
		await collector.handleEnd({
			type: "end",
			requestId,
			success: responseStatus < 400,
		});
		const summary = summaries.get(requestId);
		if (!summary)
			throw new Error(`onSummary was not invoked for requestId=${requestId}`);
		return summary;
	}

	test("a 429 response produces rateLimited: true", async () => {
		const summary = await summaryFor("rate-limited-429", 429);
		expect(summary.statusCode).toBe(429);
		expect(summary.rateLimited).toBe(true);
	});

	test("a 200 response produces rateLimited: false, present rather than absent", async () => {
		const summary = await summaryFor("rate-limited-200", 200);
		expect(summary.statusCode).toBe(200);
		expect(summary).toHaveProperty("rateLimited", false);
	});

	test("another error status is not reported as rate limited", async () => {
		// 529 is Anthropic's overload status. It is not a rate limit, and the
		// REST list's `status_code === 429` agrees.
		const summary = await summaryFor("rate-limited-529", 529);
		expect(summary.rateLimited).toBe(false);
	});
});
