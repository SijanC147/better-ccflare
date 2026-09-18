/**
 * SB23-2055. `GET /api/accounts` does NOT go through `toAccountResponse`: the
 * list handler builds its own response object, so a field added only to the
 * shared serializer never reaches the dashboard. This file covers the list
 * handler's own object, which is the copy the dashboard actually reads.
 *
 * The mutation this exists to kill is deleting `renewalDay`, `nextRenewalAt`
 * and `daysUntilRenewal` from that object: the types test still passes, because
 * `computeNextRenewal` is fully covered on its own and nothing there asserts
 * that anybody calls it (`mem:covering-the-function-is-not-covering-the-call`).
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Side-effect import: load @better-ccflare/core before @better-ccflare/types
// (types/agent.ts runtime-imports core while core/strategy.ts imports types).
import "@better-ccflare/core";
import type { Config } from "@better-ccflare/config";
import {
	BunSqlAdapter,
	type DatabaseOperations,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import { computeNextRenewal } from "@better-ccflare/types";
import { createAccountsListHandler } from "../accounts";

type ListedAccount = {
	id: string;
	name: string;
	renewalDay: number | null;
	nextRenewalAt: string | null;
	daysUntilRenewal: number | null;
};

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	return db;
}

function makeConfig(): Config {
	return {
		getUsageThrottlingFiveHourEnabled: () => false,
		getUsageThrottlingWeeklyEnabled: () => false,
	} as unknown as Config;
}

describe("GET /api/accounts renewal fields", () => {
	let db: Database;
	let handler: () => Promise<Response>;

	beforeEach(() => {
		db = makeDb();
		const adapter = new BunSqlAdapter(db);
		const dbOps = {
			getAdapter: () => adapter,
			getStatsRepository: () => ({
				getSessionStats: async () => new Map(),
			}),
		} as unknown as DatabaseOperations;
		handler = createAccountsListHandler(dbOps, makeConfig());
	});

	afterEach(() => {
		db.close();
	});

	function insertAccount(id: string, renewalDay: number | null): void {
		db.run(
			"INSERT INTO accounts (id, name, provider, created_at, renewal_day) VALUES (?, ?, ?, ?, ?)",
			[id, id, "anthropic", Date.now(), renewalDay],
		);
	}

	async function list(): Promise<ListedAccount[]> {
		const res = await handler();
		expect(res.status).toBe(200);
		return (await res.json()) as ListedAccount[];
	}

	it("carries the stored renewal day through to the response", async () => {
		insertAccount("acc-with-day", 15);

		const [account] = await list();
		expect(account.renewalDay).toBe(15);
	});

	it("carries the derived next date and countdown", async () => {
		insertAccount("acc-with-day", 15);

		const [account] = await list();
		// Compared against the helper rather than a literal date, because the
		// answer depends on today. Pinning a literal would make this test start
		// failing on the 16th of the month rather than when the code breaks.
		const expected = computeNextRenewal({ renewalDay: 15 });
		expect(account.nextRenewalAt).toBe(expected?.nextRenewalAt ?? null);
		expect(account.daysUntilRenewal).toBe(expected?.daysUntilRenewal ?? null);
	});

	it("emits an ISO calendar date, not a timestamp", async () => {
		// A day of month names no instant. Emitting midnight UTC would render as
		// the previous day for every viewer west of UTC, so the wire format is a
		// plain YYYY-MM-DD the dashboard reads in the browser's own zone.
		insertAccount("acc-with-day", 8);

		const [account] = await list();
		expect(account.nextRenewalAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it("reports all three fields as null when no day is set", async () => {
		// An unset day is not day 1. The dashboard renders nothing rather than
		// inventing a billing boundary the operator never entered.
		insertAccount("acc-no-day", null);

		const [account] = await list();
		expect(account.renewalDay).toBeNull();
		expect(account.nextRenewalAt).toBeNull();
		expect(account.daysUntilRenewal).toBeNull();
	});

	it("keeps the three keys present rather than omitting them", async () => {
		// `undefined` disappears from JSON entirely, so a handler that dropped
		// the fields would produce a body an "is it null" assertion still passes
		// against. Check the keys exist.
		insertAccount("acc-no-day", null);

		const [account] = await list();
		expect(Object.hasOwn(account, "renewalDay")).toBe(true);
		expect(Object.hasOwn(account, "nextRenewalAt")).toBe(true);
		expect(Object.hasOwn(account, "daysUntilRenewal")).toBe(true);
	});

	it("serves each account its own day", async () => {
		insertAccount("acc-a", 3);
		insertAccount("acc-b", 27);
		insertAccount("acc-c", null);

		const byId = new Map((await list()).map((a) => [a.id, a]));
		expect(byId.get("acc-a")?.renewalDay).toBe(3);
		expect(byId.get("acc-b")?.renewalDay).toBe(27);
		expect(byId.get("acc-c")?.renewalDay).toBeNull();
	});

	it("clamps a day-31 account to a month that is shorter", async () => {
		// End to end: 31 is stored as 31, and the date the API reports is a real
		// day of a real month. February never produces a 31st, and the helper
		// never rolls into March the way new Date(y, 1, 31) does.
		insertAccount("acc-31", 31);

		const [account] = await list();
		expect(account.renewalDay).toBe(31);
		const day = Number((account.nextRenewalAt as string).slice(8, 10));
		const month = Number((account.nextRenewalAt as string).slice(5, 7));
		const lastDay = new Date(
			Date.UTC(Number((account.nextRenewalAt as string).slice(0, 4)), month, 0),
		).getUTCDate();
		expect(day).toBe(lastDay);
	});
});
