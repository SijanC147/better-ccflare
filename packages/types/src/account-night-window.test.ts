/**
 * Tests for the `night_window_enabled` account column's type-level mapping.
 *
 * The column is an INTEGER in SQLite (0/1) and a BOOLEAN in PostgreSQL, so the
 * row type accepts either and `toAccount` must coerce both to a boolean.
 *
 * The fork deleted the uncalled `toAccountResponse` builder (SB23-2280); the
 * camelCase `nightWindowEnabled` is built by the accounts list handler.
 */
import { describe, expect, it } from "bun:test";
import { type AccountRow, toAccount } from "./account";

function makeRow(overrides: Partial<AccountRow> = {}): AccountRow {
	return {
		id: "a1",
		name: "acct",
		provider: "sailresearch",
		api_key: null,
		refresh_token: "rt",
		access_token: null,
		expires_at: null,
		created_at: 1,
		last_used: null,
		request_count: 0,
		total_requests: 0,
		...overrides,
	};
}

describe("night_window_enabled mapping", () => {
	it("toAccount coerces SQLite integers to a boolean", () => {
		expect(
			toAccount(makeRow({ night_window_enabled: 1 })).night_window_enabled,
		).toBe(true);
		expect(
			toAccount(makeRow({ night_window_enabled: 0 })).night_window_enabled,
		).toBe(false);
	});

	it("toAccount coerces PostgreSQL booleans to a boolean", () => {
		expect(
			toAccount(makeRow({ night_window_enabled: true })).night_window_enabled,
		).toBe(true);
		expect(
			toAccount(makeRow({ night_window_enabled: false })).night_window_enabled,
		).toBe(false);
	});

	it("toAccount defaults to false when the column is absent", () => {
		expect(toAccount(makeRow()).night_window_enabled).toBe(false);
	});
});
