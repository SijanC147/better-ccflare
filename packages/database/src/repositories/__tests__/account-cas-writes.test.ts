import "@better-ccflare/core";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { AccountRepository } from "../account.repository";

interface RawAccountRow {
	access_token: string | null;
	expires_at: number | null;
	refresh_token: string | null;
	refresh_token_issued_at: number | null;
	requires_reauth: number;
}

describe("AccountRepository — compare-and-set token/requires_reauth writes (rotation-race hardening)", () => {
	let db: Database;
	let repository: AccountRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		db.run(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			["account-1", "Account 1", "anthropic", "rt-original", "at-old", 1, 1],
		);
		repository = new AccountRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	function getRaw(id: string): RawAccountRow {
		return db
			.query<RawAccountRow, [string]>(
				"SELECT access_token, expires_at, refresh_token, refresh_token_issued_at, requires_reauth FROM accounts WHERE id = ?",
			)
			.get(id) as RawAccountRow;
	}

	describe("updateTokensIfRefreshTokenMatches", () => {
		it("applies the write and returns true when expectedRefreshToken matches, resetting requires_reauth and rotating the refresh token when one is passed", async () => {
			await repository.setRequiresReauth("account-1", true);

			const result = await repository.updateTokensIfRefreshTokenMatches(
				"account-1",
				"rt-original",
				"at-new",
				999,
				"rt-rotated",
			);

			expect(result).toBe(true);
			const row = getRaw("account-1");
			expect(row.access_token).toBe("at-new");
			expect(row.expires_at).toBe(999);
			expect(row.refresh_token).toBe("rt-rotated");
			expect(row.refresh_token_issued_at).not.toBeNull();
			expect(row.requires_reauth).toBe(0);
		});

		it("updates access_token/expires_at and resets requires_reauth without touching refresh_token when no new refresh token is passed", async () => {
			await repository.setRequiresReauth("account-1", true);

			const result = await repository.updateTokensIfRefreshTokenMatches(
				"account-1",
				"rt-original",
				"at-new",
				999,
			);

			expect(result).toBe(true);
			const row = getRaw("account-1");
			expect(row.access_token).toBe("at-new");
			expect(row.expires_at).toBe(999);
			expect(row.refresh_token).toBe("rt-original");
			expect(row.requires_reauth).toBe(0);
		});

		it("returns false and leaves the row unchanged when expectedRefreshToken no longer matches (rotated concurrently)", async () => {
			const result = await repository.updateTokensIfRefreshTokenMatches(
				"account-1",
				"rt-stale",
				"at-new",
				999,
				"rt-rotated",
			);

			expect(result).toBe(false);
			const row = getRaw("account-1");
			expect(row.access_token).toBe("at-old");
			expect(row.expires_at).toBe(1);
			expect(row.refresh_token).toBe("rt-original");
			expect(row.requires_reauth).toBe(0);
		});
	});

	describe("updateTokensIfRefreshTokenAbsent", () => {
		it("applies the write and returns true when refresh_token is NULL", async () => {
			db.run(
				`INSERT INTO accounts (id, name, provider, refresh_token, access_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					"account-null-rt",
					"Account Null RT",
					"anthropic",
					null,
					"at-old",
					1,
					1,
				],
			);

			const result = await repository.updateTokensIfRefreshTokenAbsent(
				"account-null-rt",
				"at-new",
				999,
				"rt-issued",
			);

			expect(result).toBe(true);
			const row = getRaw("account-null-rt");
			expect(row.access_token).toBe("at-new");
			expect(row.expires_at).toBe(999);
			expect(row.refresh_token).toBe("rt-issued");
			expect(row.refresh_token_issued_at).not.toBeNull();
			expect(row.requires_reauth).toBe(0);
		});

		it("applies the write and returns true when refresh_token is an empty string", async () => {
			db.run(
				`INSERT INTO accounts (id, name, provider, refresh_token, access_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					"account-empty-rt",
					"Account Empty RT",
					"anthropic",
					"",
					"at-old",
					1,
					1,
				],
			);

			const result = await repository.updateTokensIfRefreshTokenAbsent(
				"account-empty-rt",
				"at-new",
				999,
				"rt-issued",
			);

			expect(result).toBe(true);
			const row = getRaw("account-empty-rt");
			expect(row.access_token).toBe("at-new");
			expect(row.expires_at).toBe(999);
			expect(row.refresh_token).toBe("rt-issued");
			expect(row.requires_reauth).toBe(0);
		});

		it("updates access_token/expires_at and resets requires_reauth without touching refresh_token when no new refresh token is passed", async () => {
			db.run(
				`INSERT INTO accounts (id, name, provider, refresh_token, access_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					"account-null-rt-2",
					"Account Null RT 2",
					"anthropic",
					null,
					"at-old",
					1,
					1,
				],
			);

			const result = await repository.updateTokensIfRefreshTokenAbsent(
				"account-null-rt-2",
				"at-new",
				999,
			);

			expect(result).toBe(true);
			const row = getRaw("account-null-rt-2");
			expect(row.access_token).toBe("at-new");
			expect(row.expires_at).toBe(999);
			expect(row.refresh_token).toBeNull();
			expect(row.requires_reauth).toBe(0);
		});

		it("returns false and leaves the row unchanged when the account already has a real refresh token", async () => {
			const result = await repository.updateTokensIfRefreshTokenAbsent(
				"account-1",
				"at-new",
				999,
				"rt-issued",
			);

			expect(result).toBe(false);
			const row = getRaw("account-1");
			expect(row.access_token).toBe("at-old");
			expect(row.expires_at).toBe(1);
			expect(row.refresh_token).toBe("rt-original");
			expect(row.requires_reauth).toBe(0);
		});

		it("returns false when the account id does not exist", async () => {
			const result = await repository.updateTokensIfRefreshTokenAbsent(
				"missing-account",
				"at-new",
				999,
				"rt-issued",
			);

			expect(result).toBe(false);
		});
	});

	describe("flagRequiresReauthIfTokenMatches", () => {
		it("sets requires_reauth = 1 and returns true when expectedRefreshToken matches", async () => {
			const result = await repository.flagRequiresReauthIfTokenMatches(
				"account-1",
				"rt-original",
			);

			expect(result).toBe(true);
			expect(getRaw("account-1").requires_reauth).toBe(1);
		});

		it("returns false and leaves requires_reauth at 0 when the refresh token was rotated concurrently", async () => {
			const result = await repository.flagRequiresReauthIfTokenMatches(
				"account-1",
				"rt-rotated-elsewhere",
			);

			expect(result).toBe(false);
			expect(getRaw("account-1").requires_reauth).toBe(0);
		});

		it("returns false when the account id does not exist", async () => {
			const result = await repository.flagRequiresReauthIfTokenMatches(
				"missing-account",
				"rt-original",
			);

			expect(result).toBe(false);
		});
	});
});
