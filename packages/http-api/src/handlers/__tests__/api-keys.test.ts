import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import { createApiKeysGenerateHandler } from "../api-keys";

/**
 * Regression for Codex PR #28 P2: when no API keys exist, a name-only
 * POST /api/api-keys defaulted role to "api-only", which generateApiKey()
 * rejects (api-only first key would lock the user out of the dashboard).
 * Raw-API clients that create the first key with just a name were broken,
 * while the CLI/dashboard worked because they send role: "admin".
 *
 * Fix: when the caller does not explicitly request a role and no active
 * keys exist, the bootstrap key defaults to "admin".
 */
const TEST_DB_PATH = "/tmp/test-api-keys-bootstrap.db";

describe("API key generate handler — first-key bootstrap (Codex P2)", () => {
	let dbOps: DatabaseOperations;
	let handler: (req: Request) => Promise<Response>;

	beforeAll(() => {
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch (error) {
			console.warn("Failed to clean up existing test database:", error);
		}
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		handler = createApiKeysGenerateHandler(dbOps);
	});

	afterAll(() => {
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch (error) {
			console.warn("Failed to clean up test database:", error);
		}
		DatabaseFactory.reset();
	});

	beforeEach(async () => {
		await dbOps.clearApiKeys();
	});

	function post(body: unknown): Request {
		return new Request("http://localhost/api/api-keys", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("name-only first key defaults to admin (was rejected before fix)", async () => {
		expect(await dbOps.countActiveApiKeys()).toBe(0);

		const res = await handler(post({ name: "bootstrap-key" }));
		const data = await res.json();

		expect(res.status).toBe(201);
		expect(data.success).toBe(true);
		expect(data.data.role).toBe("admin");
	});

	it("name-only key defaults to api-only once an admin key exists", async () => {
		await handler(post({ name: "first-admin", role: "admin" }));
		expect(await dbOps.countActiveApiKeys()).toBe(1);

		const res = await handler(post({ name: "second-key" }));
		const data = await res.json();

		expect(res.status).toBe(201);
		expect(data.data.role).toBe("api-only");
	});

	it("explicit role: 'admin' first key still works", async () => {
		const res = await handler(post({ name: "explicit-admin", role: "admin" }));
		const data = await res.json();

		expect(res.status).toBe(201);
		expect(data.data.role).toBe("admin");
	});

	it("explicit role: 'api-only' first key is still rejected (guard preserved)", async () => {
		expect(await dbOps.countActiveApiKeys()).toBe(0);

		const res = await handler(post({ name: "bad-first", role: "api-only" }));
		const data = await res.json();

		expect(res.status).not.toBe(201);
		expect(data.success).not.toBe(true);
		expect(data.error).toBeDefined();
	});

	it("invalid role value is rejected with 400", async () => {
		const res = await handler(post({ name: "x", role: "superuser" }));
		const data = await res.json();

		expect(res.status).toBe(400);
		expect(data.error).toBeDefined();
	});
});
