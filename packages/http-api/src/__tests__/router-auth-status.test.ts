/**
 * The status the /api router answers when it refuses a request (SB23-3746):
 * 401 when the credential is missing or invalid, 403 when a valid key is not
 * allowed. Before this, both were 401, which tells a client to
 * re-authenticate when re-authenticating cannot help.
 *
 * Every request here is refused or passes before dispatch, so no handler
 * runs: an authorized request to an unregistered path returns null.
 */
import { Database } from "bun:sqlite";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import "@better-ccflare/core";
import type { Config } from "@better-ccflare/config";
import {
	BunSqlAdapter,
	type DatabaseOperations,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import { NodeCryptoUtils } from "@better-ccflare/types";
import { APIRouter } from "../router";
import type { APIContext } from "../types";

const UNREGISTERED = "/api/sb23-3746-unregistered";

describe("APIRouter — refusal status", () => {
	let adminKey: string;
	let apiOnlyKey: string;
	let records: Array<Record<string, unknown>>;
	let activeKeys: number;
	let router: APIRouter;
	let db: Database;

	beforeAll(async () => {
		const crypto = new NodeCryptoUtils();
		adminKey = await crypto.generateApiKey();
		apiOnlyKey = await crypto.generateApiKey();
		const record = async (name: string, key: string, role: string) => ({
			id: `id-${name}`,
			name,
			hashedKey: await crypto.hashApiKey(key),
			prefixLast8: key.slice(-8),
			createdAt: 0,
			lastUsed: null,
			usageCount: 0,
			isActive: true,
			role,
		});
		records = [
			await record("admin", adminKey, "admin"),
			await record("api-only", apiOnlyKey, "api-only"),
		];
	});

	beforeEach(() => {
		activeKeys = records.length;
		// Only so the router's constructor can build its handlers; no handler
		// runs in this file.
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		const adapter = new BunSqlAdapter(db);
		const dbOps = {
			getAdapter: () => adapter,
			countActiveApiKeys: async () => activeKeys,
			getActiveApiKeys: async () => (activeKeys > 0 ? records : []),
			updateApiKeyUsage: () => {},
		} as unknown as DatabaseOperations;
		const config = {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getGithubReadToken: () => "",
			getObjectSetting: () => undefined,
		} as unknown as Config;
		router = new APIRouter({
			db: adapter,
			config,
			dbOps,
			alertService: {},
		} as unknown as APIContext);
	});

	afterEach(() => {
		db.close();
	});

	const send = (method: string, path: string, key?: string) => {
		const url = new URL(`http://localhost${path}`);
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (key) headers["x-api-key"] = key;
		return router.handleRequest(
			url,
			new Request(url, {
				method,
				headers,
				body: method === "GET" ? undefined : "{}",
			}),
		);
	};

	const refusal = async (res: Response | null) => {
		expect(res).not.toBeNull();
		return { status: res?.status, body: await res?.json() };
	};

	it("answers 401 when no key is sent", async () => {
		expect(await refusal(await send("GET", "/api/accounts"))).toEqual({
			status: 401,
			body: {
				error:
					"API key required. Include it in the 'x-api-key' header or Authorization: Bearer <key>",
			},
		});
	});

	it("answers 401 for a key that matches no active key", async () => {
		expect(
			await refusal(await send("GET", "/api/accounts", `${adminKey}x`)),
		).toEqual({ status: 401, body: { error: "Invalid API key" } });
	});

	it("answers 403 when a valid api-only key asks for a dashboard path", async () => {
		expect(
			await refusal(await send("GET", "/api/accounts", apiOnlyKey)),
		).toEqual({
			status: 403,
			body: {
				error: "Unauthorized: This API key does not have dashboard access",
			},
		});
	});

	it("answers 403 when a valid api-only key asks for a debug path", async () => {
		expect(
			await refusal(await send("GET", "/api/debug/heap", apiOnlyKey)),
		).toEqual({
			status: 403,
			body: { error: "Unauthorized: Debug endpoints require an admin API key" },
		});
	});

	it("lets an admin key through to dispatch", async () => {
		expect(await send("GET", UNREGISTERED, adminKey)).toBeNull();
	});

	it("refuses the api-only key before dispatch on the same path", async () => {
		const res = await send("GET", UNREGISTERED, apiOnlyKey);
		expect(res?.status).toBe(403);
	});

	it("answers 403 to a role change from a caller with no admin identity", async () => {
		// Reachable with authentication off: the request passes with no key,
		// so no role, and the role branch refuses it.
		activeKeys = 0;
		expect(
			await refusal(await send("PATCH", "/api/api-keys/admin/role")),
		).toEqual({
			status: 403,
			body: {
				error:
					"Only admin keys can update API key roles. Your key has api-only access.",
			},
		});
	});
});
