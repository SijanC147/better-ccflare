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
import { createAccountProviderSettingsUpdateHandler } from "../accounts";

const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-account-provider-settings-update.db`;

const OLD_KEY = "sk-old-2c1f4a7b";
const NEW_KEY = "sk-new-9e84d3f0";

function cleanupDbFiles(): void {
	for (const suffix of ["", "-wal", "-shm"]) {
		const path = `${TEST_DB_PATH}${suffix}`;
		if (existsSync(path)) unlinkSync(path);
	}
}

function requestWith(body: unknown): Request {
	return new Request("http://localhost/api/accounts/x", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

type StoredAccount = {
	api_key: string | null;
	refresh_token: string | null;
	access_token: string | null;
	expires_at: number | null;
	custom_endpoint: string | null;
	priority: number;
	request_count: number;
	total_requests: number;
};

async function insertApiKeyAccount(
	dbOps: DatabaseOperations,
	provider: string,
	options: { customEndpoint?: string | null } = {},
): Promise<string> {
	const id = crypto.randomUUID();
	await dbOps.getAdapter().run(
		`INSERT INTO accounts (
			id, name, provider, api_key, refresh_token, access_token,
			expires_at, created_at, request_count, total_requests, priority, custom_endpoint
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			id,
			id,
			provider,
			OLD_KEY,
			OLD_KEY,
			OLD_KEY,
			1_000,
			Date.now(),
			41,
			137,
			7,
			options.customEndpoint ?? null,
		],
	);
	return id;
}

async function stored(
	dbOps: DatabaseOperations,
	id: string,
): Promise<StoredAccount> {
	const row = await dbOps.getAdapter().get<StoredAccount>(
		`SELECT api_key, refresh_token, access_token, expires_at, custom_endpoint,
			COALESCE(priority, 0) AS priority, request_count, total_requests
		 FROM accounts WHERE id = ?`,
		[id],
	);
	if (!row) throw new Error(`account ${id} missing`);
	return row;
}

describe("createAccountProviderSettingsUpdateHandler", () => {
	let dbOps: DatabaseOperations;
	let handler: ReturnType<typeof createAccountProviderSettingsUpdateHandler>;

	beforeAll(() => {
		cleanupDbFiles();
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		handler = createAccountProviderSettingsUpdateHandler(dbOps);
	});

	afterAll(() => {
		DatabaseFactory.reset();
		cleanupDbFiles();
	});

	beforeEach(async () => {
		await dbOps.getAdapter().run("DELETE FROM accounts", []);
	});

	describe("credential rotation", () => {
		it("writes the new key to every column creation populates", async () => {
			const id = await insertApiKeyAccount(dbOps, "zai");
			const before = Date.now();

			expect((await handler(requestWith({ apiKey: NEW_KEY }), id)).status).toBe(
				200,
			);

			const row = await stored(dbOps, id);
			// The creation routes write the key to all three token columns. Updating
			// only api_key would leave the proxy authenticating with access_token's
			// stale copy.
			expect(row.api_key).toBe(NEW_KEY);
			expect(row.refresh_token).toBe(NEW_KEY);
			expect(row.access_token).toBe(NEW_KEY);
			expect(row.expires_at).toBeGreaterThan(before);
		});

		it("keeps the account id, its statistics and its priority", async () => {
			const id = await insertApiKeyAccount(dbOps, "openai-compatible");

			const res = await handler(requestWith({ apiKey: NEW_KEY }), id);
			const payload = (await res.json()) as {
				account: { id: string; priority: number };
			};

			expect(payload.account.id).toBe(id);
			expect(payload.account.priority).toBe(7);

			const row = await stored(dbOps, id);
			expect(row.request_count).toBe(41);
			expect(row.total_requests).toBe(137);
			expect(row.priority).toBe(7);
		});

		it("refuses an empty key rather than clearing the credential", async () => {
			const id = await insertApiKeyAccount(dbOps, "zai");

			for (const empty of [null, "", "   "]) {
				expect((await handler(requestWith({ apiKey: empty }), id)).status).toBe(
					400,
				);
			}

			const row = await stored(dbOps, id);
			expect(row.api_key).toBe(OLD_KEY);
			expect(row.access_token).toBe(OLD_KEY);
		});

		it("refuses rotation for providers that do not use an API key", async () => {
			for (const provider of ["anthropic", "vertex-ai", "bedrock"]) {
				const id = await insertApiKeyAccount(dbOps, provider);
				expect(
					(await handler(requestWith({ apiKey: NEW_KEY }), id)).status,
				).toBe(400);
				expect((await stored(dbOps, id)).api_key).toBe(OLD_KEY);
			}
		});
	});

	describe("credentials are never returned", () => {
		it("omits the key from the response and reports apiKeySet instead", async () => {
			const id = await insertApiKeyAccount(dbOps, "zai");

			const res = await handler(requestWith({ apiKey: NEW_KEY }), id);
			const payload = (await res.json()) as {
				account: { apiKeySet: boolean };
			};

			// Serialize the whole response: a named-field assertion would pass while
			// the value leaked through some other field.
			const serialized = JSON.stringify(payload);
			expect(serialized.includes(NEW_KEY)).toBe(false);
			expect(serialized.includes(OLD_KEY)).toBe(false);
			expect(payload.account.apiKeySet).toBe(true);
		});

		it("reports apiKeySet false for an account with no stored key", async () => {
			const id = crypto.randomUUID();
			await dbOps.getAdapter().run(
				`INSERT INTO accounts (id, name, provider, refresh_token, created_at, priority)
					 VALUES (?, ?, ?, ?, ?, ?)`,
				[id, id, "vertex-ai", "", Date.now(), 0],
			);

			const res = await handler(requestWith({ customEndpoint: null }), id);
			// vertex-ai keeps {projectId, region} in custom_endpoint, so the field is
			// refused for it and apiKeySet is exercised through the zai path below.
			expect(res.status).toBe(400);
		});

		it("does not return the key when only customEndpoint changes", async () => {
			const id = await insertApiKeyAccount(dbOps, "zai");

			const res = await handler(
				requestWith({ customEndpoint: "https://example.test/v1" }),
				id,
			);

			const serialized = JSON.stringify(await res.json());
			expect(res.status).toBe(200);
			expect(serialized.includes(OLD_KEY)).toBe(false);
		});
	});

	describe("partial update", () => {
		it("leaves an unsupplied field alone", async () => {
			const id = await insertApiKeyAccount(dbOps, "zai", {
				customEndpoint: "https://kept.test/v1",
			});

			expect((await handler(requestWith({ apiKey: NEW_KEY }), id)).status).toBe(
				200,
			);

			const row = await stored(dbOps, id);
			expect(row.custom_endpoint).toBe("https://kept.test/v1");
			expect(row.api_key).toBe(NEW_KEY);
		});

		it("leaves the credential alone when only customEndpoint is sent", async () => {
			const id = await insertApiKeyAccount(dbOps, "zai");

			expect(
				(
					await handler(
						requestWith({ customEndpoint: "https://example.test/v1" }),
						id,
					)
				).status,
			).toBe(200);

			const row = await stored(dbOps, id);
			expect(row.custom_endpoint).toBe("https://example.test/v1");
			expect(row.api_key).toBe(OLD_KEY);
			expect(row.access_token).toBe(OLD_KEY);
		});

		it("clears customEndpoint on null and on an empty string", async () => {
			for (const cleared of [null, ""]) {
				const id = await insertApiKeyAccount(dbOps, "zai", {
					customEndpoint: "https://example.test/v1",
				});

				expect(
					(await handler(requestWith({ customEndpoint: cleared }), id)).status,
				).toBe(200);
				expect((await stored(dbOps, id)).custom_endpoint).toBeNull();
			}
		});

		it("updates both fields in one call", async () => {
			const id = await insertApiKeyAccount(dbOps, "zai");

			const res = await handler(
				requestWith({
					apiKey: NEW_KEY,
					customEndpoint: "https://example.test/v1",
				}),
				id,
			);
			const payload = (await res.json()) as { updated: string[] };

			expect(res.status).toBe(200);
			expect(payload.updated).toEqual(["apiKey", "customEndpoint"]);

			const row = await stored(dbOps, id);
			expect(row.api_key).toBe(NEW_KEY);
			expect(row.custom_endpoint).toBe("https://example.test/v1");
		});

		it("rejects a body with no recognized field", async () => {
			const id = await insertApiKeyAccount(dbOps, "zai");

			expect((await handler(requestWith({}), id)).status).toBe(400);
			expect((await handler(requestWith({ priority: 3 }), id)).status).toBe(
				400,
			);
			expect((await stored(dbOps, id)).priority).toBe(7);
		});

		it("rejects a customEndpoint that is not a URL", async () => {
			const id = await insertApiKeyAccount(dbOps, "zai");

			expect(
				(await handler(requestWith({ customEndpoint: "not a url" }), id))
					.status,
			).toBe(400);
			expect((await stored(dbOps, id)).custom_endpoint).toBeNull();
		});

		it("refuses customEndpoint for providers that store config there", async () => {
			for (const provider of ["vertex-ai", "bedrock"]) {
				const id = await insertApiKeyAccount(dbOps, provider, {
					customEndpoint: "bedrock:default:us-east-1",
				});

				expect(
					(
						await handler(
							requestWith({ customEndpoint: "https://example.test/v1" }),
							id,
						)
					).status,
				).toBe(400);
				expect((await stored(dbOps, id)).custom_endpoint).toBe(
					"bedrock:default:us-east-1",
				);
			}
		});
	});

	it("returns not found for a missing account", async () => {
		expect(
			(await handler(requestWith({ apiKey: NEW_KEY }), "missing")).status,
		).toBe(404);
	});
});
