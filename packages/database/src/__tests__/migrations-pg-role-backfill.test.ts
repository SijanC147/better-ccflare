/**
 * Regression for Codex PR #28 P1: PostgreSQL migration parity.
 *
 * The SQLite migration (migrations.ts v4) adds api_keys.role with default
 * 'api-only' and then immediately backfills every existing key to 'admin'
 * for backwards compatibility. The PostgreSQL migration added the column
 * with the same default but did NOT backfill, so a PG upgrade demoted all
 * existing keys to 'api-only' — and since authorizeEndpoint() blocks
 * api-only keys from /api/*, existing users lost dashboard/API-key
 * management access with no way to promote an admin key.
 *
 * runMigrationsPg() must now mirror SQLite: backfill existing keys to
 * 'admin' exactly when the role column is freshly added (not on every
 * startup, which would re-promote intentionally api-only keys).
 */
import { describe, expect, it } from "bun:test";
import "@better-ccflare/core";
import type { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchemaPg, runMigrationsPg } from "../migrations-pg";

interface RecordingAdapter {
	executed: string[];
	roleColumnExists: boolean;
}

/**
 * Minimal fake of the BunSqlAdapter surface that runMigrationsPg uses
 * (get for columnExists, unsafe/run for DDL/DML). columnExists() reports
 * the api_keys.role column as present/absent based on roleColumnExists;
 * every other column is reported present so only the role path runs.
 */
function makeFakeAdapter(roleColumnExists: boolean): {
	adapter: BunSqlAdapter;
	state: RecordingAdapter;
} {
	const state: RecordingAdapter = { executed: [], roleColumnExists };

	const adapter = {
		// columnExists() => SELECT COUNT(*) ... information_schema.columns
		async get<R>(_sql: string, params: unknown[] = []): Promise<R | null> {
			const [table, column] = params as [string, string];
			if (table === "api_keys" && column === "role") {
				return { exists: state.roleColumnExists ? 1 : 0 } as R;
			}
			// Pretend every other column already exists so the test stays
			// focused on the role migration path.
			return { exists: 1 } as R;
		},
		async unsafe(sql: string): Promise<unknown> {
			state.executed.push(sql.replace(/\s+/g, " ").trim());
			return undefined;
		},
		async run(sql: string): Promise<void> {
			state.executed.push(sql.replace(/\s+/g, " ").trim());
		},
	} as unknown as BunSqlAdapter;

	return { adapter, state };
}

describe("runMigrationsPg — api_keys.role backfill parity (Codex P1)", () => {
	it("adds the role column and backfills existing keys to admin when role is missing", async () => {
		const { adapter, state } = makeFakeAdapter(false);

		await runMigrationsPg(adapter);

		const addedRole = state.executed.some((s) =>
			/ALTER TABLE api_keys ADD COLUMN role/i.test(s),
		);
		const backfilled = state.executed.some((s) =>
			/UPDATE api_keys SET role = 'admin' WHERE role = 'api-only'/i.test(s),
		);
		const indexed = state.executed.some((s) =>
			/CREATE INDEX IF NOT EXISTS idx_api_keys_role ON api_keys\(role\)/i.test(
				s,
			),
		);

		expect(addedRole).toBe(true);
		expect(backfilled).toBe(true);
		expect(indexed).toBe(true);

		// Backfill must run AFTER the column is added.
		const addIdx = state.executed.findIndex((s) =>
			/ALTER TABLE api_keys ADD COLUMN role/i.test(s),
		);
		const backfillIdx = state.executed.findIndex((s) =>
			/UPDATE api_keys SET role = 'admin'/i.test(s),
		);
		expect(addIdx).toBeGreaterThanOrEqual(0);
		expect(backfillIdx).toBeGreaterThan(addIdx);
	});

	it("does NOT backfill when the role column already exists (idempotent across restarts)", async () => {
		const { adapter, state } = makeFakeAdapter(true);

		await runMigrationsPg(adapter);

		const addedRole = state.executed.some((s) =>
			/ALTER TABLE api_keys ADD COLUMN role/i.test(s),
		);
		const backfilled = state.executed.some((s) =>
			/UPDATE api_keys SET role = 'admin' WHERE role = 'api-only'/i.test(s),
		);

		expect(addedRole).toBe(false);
		expect(backfilled).toBe(false);
	});
});

/**
 * SB23-3691: the reset condition's two columns (SB23-2575) on PostgreSQL. The
 * fake reports exactly the columns named in `missing` as absent, so the test
 * sees the ALTERs an upgrade from a database without them would emit, and no
 * others.
 */
function makeColumnAdapter(missing: ReadonlySet<string>): {
	adapter: BunSqlAdapter;
	executed: string[];
} {
	const executed: string[] = [];
	const adapter = {
		async get<R>(_sql: string, params: unknown[] = []): Promise<R | null> {
			const [table, column] = params as [string, string];
			return { exists: missing.has(`${table}.${column}`) ? 0 : 1 } as R;
		},
		async unsafe(sql: string): Promise<unknown> {
			executed.push(sql.replace(/\s+/g, " ").trim());
			return undefined;
		},
		async run(sql: string): Promise<void> {
			executed.push(sql.replace(/\s+/g, " ").trim());
		},
	} as unknown as BunSqlAdapter;
	return { adapter, executed };
}

const RESET_COLUMNS = [
	"usage_pause_five_hour_min_reset_remaining_ms",
	"usage_pause_weekly_min_reset_remaining_ms",
] as const;

describe("PostgreSQL usage pause reset columns (SB23-3691)", () => {
	it("adds both reset columns as BIGINT to a database that lacks them", async () => {
		const { adapter, executed } = makeColumnAdapter(
			new Set(RESET_COLUMNS.map((column) => `accounts.${column}`)),
		);

		await runMigrationsPg(adapter);

		for (const column of RESET_COLUMNS) {
			expect(
				executed.filter(
					(sql) => sql === `ALTER TABLE accounts ADD COLUMN ${column} BIGINT`,
				),
			).toHaveLength(1);
		}
		// Only the missing columns: every other column reads present.
		expect(
			executed.filter((sql) => sql.startsWith("ALTER TABLE accounts ADD")),
		).toHaveLength(2);
	});

	it("adds neither when both are already there", async () => {
		const { adapter, executed } = makeColumnAdapter(new Set());

		await runMigrationsPg(adapter);

		for (const column of RESET_COLUMNS) {
			expect(executed.some((sql) => sql.includes(`ADD COLUMN ${column}`))).toBe(
				false,
			);
		}
	});

	it("creates both reset columns as BIGINT in a fresh accounts table", async () => {
		const { adapter, executed } = makeColumnAdapter(new Set());

		await ensureSchemaPg(adapter);

		const accounts = executed.filter((sql) =>
			sql.startsWith("CREATE TABLE IF NOT EXISTS accounts ("),
		);
		expect(accounts).toHaveLength(1);
		for (const column of RESET_COLUMNS) {
			expect(accounts[0]).toContain(`${column} BIGINT,`);
		}
	});
});
