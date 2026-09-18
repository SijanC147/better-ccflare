/**
 * SB23-2055. PostgreSQL parity for `accounts.renewal_day`.
 *
 * Production runs Postgres, so a column added only to the SQLite migration is
 * absent where it matters most, and nothing about the SQLite suite would say
 * so. The two halves are separate files with separate column lists and they
 * have drifted before: `#28` P1 was exactly this, an api_keys column that
 * existed on both sides while only SQLite ran the backfill.
 *
 * `runMigrationsPg` is driven through the same fake adapter the role-backfill
 * regression uses, recording the SQL it would execute.
 */
import { describe, expect, it } from "bun:test";
import "@better-ccflare/core";
import type { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchemaPg, runMigrationsPg } from "../migrations-pg";

interface RecordingAdapter {
	executed: string[];
	renewalDayExists: boolean;
}

/**
 * Reports `accounts.renewal_day` as present or absent on demand and every
 * other column as present, so only the path under test runs.
 */
function makeFakeAdapter(renewalDayExists: boolean): {
	adapter: BunSqlAdapter;
	state: RecordingAdapter;
} {
	const state: RecordingAdapter = { executed: [], renewalDayExists };

	const adapter = {
		async get<R>(_sql: string, params: unknown[] = []): Promise<R | null> {
			const [table, column] = params as [string, string];
			if (table === "accounts" && column === "renewal_day") {
				return { exists: state.renewalDayExists ? 1 : 0 } as R;
			}
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

const ADD_RENEWAL_DAY = /ALTER TABLE accounts ADD COLUMN renewal_day/i;

describe("runMigrationsPg — accounts.renewal_day", () => {
	it("adds the column when it is missing", async () => {
		const { adapter, state } = makeFakeAdapter(false);

		await runMigrationsPg(adapter);

		expect(state.executed.some((s) => ADD_RENEWAL_DAY.test(s))).toBe(true);
	});

	it("declares it INTEGER, matching the SQLite side", async () => {
		// Not BIGINT. The epoch columns need 64 bits; a day of month is 1 to 31,
		// and a type mismatch between the two backends is how a value that round
		// trips on one silently does not on the other.
		const { adapter, state } = makeFakeAdapter(false);

		await runMigrationsPg(adapter);

		const statement = state.executed.find((s) => ADD_RENEWAL_DAY.test(s));
		expect(statement).toBeDefined();
		expect(statement).toMatch(/renewal_day INTEGER\b/i);
		expect(statement).not.toMatch(/BIGINT/i);
	});

	it("does not add the column again when it already exists", async () => {
		// An ALTER on every boot would throw on the second start.
		const { adapter, state } = makeFakeAdapter(true);

		await runMigrationsPg(adapter);

		expect(state.executed.some((s) => ADD_RENEWAL_DAY.test(s))).toBe(false);
	});

	it("adds no default and no backfill", async () => {
		// An unset renewal day is null and must stay null. A DEFAULT would give
		// every existing account a billing date its operator never entered, which
		// is the failure shape SB23-1980 records: a value nobody chose, arriving
		// as though they had.
		const { adapter, state } = makeFakeAdapter(false);

		await runMigrationsPg(adapter);

		const statement = state.executed.find((s) => ADD_RENEWAL_DAY.test(s));
		expect(statement).not.toMatch(/DEFAULT/i);
		expect(
			state.executed.some((s) => /UPDATE accounts SET renewal_day/i.test(s)),
		).toBe(false);
	});
});

describe("ensureSchemaPg — accounts.renewal_day", () => {
	it("creates the column on a fresh install", async () => {
		// The upgrade path and the fresh-install path are different code. A column
		// present only in columnsToAdd reaches an upgraded database and never a
		// new one, and only a fresh install would notice.
		const executed: string[] = [];
		const adapter = {
			async get<R>(): Promise<R | null> {
				return { exists: 1 } as R;
			},
			async unsafe(sql: string): Promise<unknown> {
				executed.push(sql.replace(/\s+/g, " ").trim());
				return undefined;
			},
			async run(sql: string): Promise<void> {
				executed.push(sql.replace(/\s+/g, " ").trim());
			},
		} as unknown as BunSqlAdapter;

		await ensureSchemaPg(adapter);

		const createAccounts = executed.find((s) =>
			/CREATE TABLE IF NOT EXISTS accounts \(/i.test(s),
		);
		expect(createAccounts).toBeDefined();
		expect(createAccounts).toMatch(/renewal_day INTEGER/i);
	});
});
