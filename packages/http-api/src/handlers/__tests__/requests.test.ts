/**
 * Tests for createRequestsSummaryHandler's attribution-source mapping (P2).
 *
 * Covers that project_attribution_source / agent_attribution_source columns
 * persisted via DatabaseOperations.saveRequest are read back and mapped onto
 * the RequestResponse fields the dashboard reads: projectAttributionSource
 * and agentAttributionSource (via the `as ProjectAttributionSource` /
 * `as AgentAttributionSource` casts in packages/http-api/src/handlers/requests.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import type { RequestResponse } from "@better-ccflare/types";
import { createRequestsSummaryHandler } from "../requests";

// Per process: a fixed name under TMPDIR is shared by every worktree's
// suite, and a concurrent run deletes the file under SQLite (SB23-2480).
const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-requests-summary-handler-${process.pid}.db`;

describe("createRequestsSummaryHandler — attribution source mapping", () => {
	let dbOps: DatabaseOperations;
	let handler: (limit?: number) => Promise<Response>;

	beforeAll(async () => {
		try {
			for (const f of [
				TEST_DB_PATH,
				`${TEST_DB_PATH}-wal`,
				`${TEST_DB_PATH}-shm`,
			]) {
				if (existsSync(f)) unlinkSync(f);
			}
		} catch (error) {
			console.warn("Failed to clean up existing test database:", error);
		}

		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();

		handler = createRequestsSummaryHandler(dbOps.getAdapter());

		await dbOps.saveRequest(
			"req-attribution-1",
			"POST",
			"/v1/messages",
			null, // accountUsed
			200, // statusCode
			true, // success
			null, // errorMessage
			100, // responseTime
			0, // failoverAttempts
			undefined, // usage
			"bot", // agentUsed
			undefined, // apiKeyId
			undefined, // apiKeyName
			"acme", // project
			undefined, // billingType
			undefined, // comboName
			undefined, // originalModel
			undefined, // appliedModel
			"path_project", // projectAttributionSource
			"prompt_agent", // agentAttributionSource
		);

		// Regression coverage for the persisted-badges bug: gateway_hint_* columns
		// were readable from the DB but not mapped onto RequestResponse here, so
		// they appeared in live collector updates and vanished after a dashboard
		// reload (which re-fetches this summary endpoint).
		await dbOps.saveRequest(
			"req-gateway-hint-1",
			"POST",
			"/v1/messages",
			null, // accountUsed
			200, // statusCode
			true, // success
			null, // errorMessage
			100, // responseTime
			0, // failoverAttempts
			undefined, // usage
			"bot", // agentUsed
			undefined, // apiKeyId
			undefined, // apiKeyName
			"acme", // project
			undefined, // billingType
			undefined, // comboName
			undefined, // originalModel
			undefined, // appliedModel
			undefined, // projectAttributionSource
			undefined, // agentAttributionSource
			undefined, // streamTerminalState
			undefined, // clientSessionId
			"agent", // gatewayHintRequestClass
			"explore", // gatewayHintAgentType
			"[1200,340]", // gatewayHintPrevToolDurations
			"none", // gatewayHintCompaction
			"false", // gatewayHintContextCompacted
		);
	});

	afterAll(() => {
		// Close before unlinking: the close-time checkpoint on an unlinked
		// file fails with SQLITE_IOERR_VNODE on macOS (SB23-2480).
		DatabaseFactory.reset();
		try {
			for (const f of [
				TEST_DB_PATH,
				`${TEST_DB_PATH}-wal`,
				`${TEST_DB_PATH}-shm`,
			]) {
				if (existsSync(f)) unlinkSync(f);
			}
		} catch (error) {
			console.warn("Failed to clean up test database:", error);
		}
	});

	it("maps project_attribution_source and agent_attribution_source onto the response", async () => {
		const response = await handler(50);
		expect(response.status).toBe(200);

		const body = (await response.json()) as RequestResponse[];
		const row = body.find((r) => r.id === "req-attribution-1");

		expect(row).toBeDefined();
		expect(row?.project).toBe("acme");
		expect(row?.projectAttributionSource).toBe("path_project");
		expect(row?.agentUsed).toBe("bot");
		expect(row?.agentAttributionSource).toBe("prompt_agent");
	});

	it("maps the gateway_hint_* columns onto the response", async () => {
		const response = await handler(50);
		expect(response.status).toBe(200);

		const body = (await response.json()) as RequestResponse[];
		const row = body.find((r) => r.id === "req-gateway-hint-1");

		expect(row).toBeDefined();
		expect(row?.gatewayHintRequestClass).toBe("agent");
		expect(row?.gatewayHintAgentType).toBe("explore");
		expect(row?.gatewayHintPrevToolDurations).toBe("[1200,340]");
		expect(row?.gatewayHintCompaction).toBe("none");
		expect(row?.gatewayHintContextCompacted).toBe("false");
	});
});
