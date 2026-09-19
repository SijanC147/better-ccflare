import "@better-ccflare/core";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { AccountRepository } from "../account.repository";

describe("AccountRepository requires_reauth", () => {
	let db: Database;
	let repository: AccountRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		db.run(
			"INSERT INTO accounts (id, name, access_token, expires_at, created_at) VALUES ('account-1', 'Account 1', 'old-token', 1, 1)",
		);
		repository = new AccountRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("round-trips requires_reauth through setRequiresReauth and findById", async () => {
		await repository.setRequiresReauth("account-1", true);

		expect((await repository.findById("account-1"))?.requires_reauth).toBe(
			true,
		);

		await repository.setRequiresReauth("account-1", false);

		expect((await repository.findById("account-1"))?.requires_reauth).toBe(
			false,
		);
	});

	it("clears requires_reauth when tokens are updated without rotation", async () => {
		await repository.setRequiresReauth("account-1", true);

		await repository.updateTokens("account-1", "new-token", 2);

		expect((await repository.findById("account-1"))?.requires_reauth).toBe(
			false,
		);
	});

	it("clears requires_reauth when tokens are updated with refresh-token rotation", async () => {
		await repository.setRequiresReauth("account-1", true);

		await repository.updateTokens("account-1", "new-token", 2, "new-refresh");

		expect((await repository.findById("account-1"))?.requires_reauth).toBe(
			false,
		);
	});
});
