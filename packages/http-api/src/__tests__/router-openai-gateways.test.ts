/**
 * Router-level dispatch for /api/openai-gateways/:name (SB23-2720). The handler
 * is covered in handlers/__tests__/openai-gateways.test.ts; these pin the
 * branch in router.ts: exactly one name segment, and PUT and DELETE only.
 * Auth is off (no API keys in the stub dbOps). An unmatched route returns null.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "@better-ccflare/core";
import type { Config } from "@better-ccflare/config";
import {
	BunSqlAdapter,
	type DatabaseOperations,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import { OPENAI_GATEWAYS_CONFIG_KEY } from "@better-ccflare/types";
import { APIRouter } from "../router";
import type { APIContext } from "../types";

describe("APIRouter — /api/openai-gateways/:name dispatch", () => {
	let db: Database;
	let router: APIRouter;
	let stored: Record<string, unknown>;
	let writes: number;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		const adapter = new BunSqlAdapter(db);
		const dbOps = {
			getAdapter: () => adapter,
			countActiveApiKeys: async () => 0,
			getActiveApiKeys: async () => [],
		} as unknown as DatabaseOperations;
		stored = { x: { description: "existing" } };
		writes = 0;
		const config = {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getGithubReadToken: () => "",
			getObjectSetting: (key: string) =>
				key === OPENAI_GATEWAYS_CONFIG_KEY ? stored : undefined,
			setObjectSetting: (_key: string, value: Record<string, unknown>) => {
				writes++;
				stored = value;
			},
		} as unknown as Config;
		const context = {
			db: adapter,
			config,
			dbOps,
			alertService: {},
		} as unknown as APIContext;
		router = new APIRouter(context);
	});

	afterEach(() => {
		db.close();
	});

	const send = (method: string, path: string, body?: unknown) => {
		const url = new URL(`http://localhost${path}`);
		const req = new Request(url, {
			method,
			headers: { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return router.handleRequest(url, req);
	};

	it("dispatches PUT /api/openai-gateways/:name to the handler", async () => {
		const res = await send("PUT", "/api/openai-gateways/y", {});
		expect(res?.status).toBe(200);
		expect(writes).toBe(1);
		expect(Object.keys(stored).sort()).toEqual(["x", "y"]);
	});

	it("does not dispatch PUT with an extra path segment", async () => {
		const res = await send("PUT", "/api/openai-gateways/x/y", {});
		expect(res).toBeNull();
		expect(writes).toBe(0);
	});

	it("dispatches DELETE /api/openai-gateways/:name", async () => {
		const res = await send("DELETE", "/api/openai-gateways/x");
		expect(res?.status).toBe(204);
		expect(writes).toBe(1);
		expect(stored).toEqual({});
	});

	it("does not dispatch an unsupported method", async () => {
		const res = await send("PATCH", "/api/openai-gateways/x", {});
		expect(res).toBeNull();
		expect(writes).toBe(0);
	});
});
