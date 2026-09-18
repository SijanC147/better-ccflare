/**
 * SB23-2055. `AccountRepository.findAll` and `findById` read explicit column
 * lists, so a column absent from them is never read and `toAccount` maps the
 * missing property to null. There is no error and no log line: the account
 * simply looks like one whose operator never set a renewal day.
 *
 * This file exists because a mutation that deleted `renewal_day` from those two
 * SELECTs survived every other suite. The accounts list handler runs its own
 * query, so covering the HTTP layer says nothing about the repository.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Side-effect import: load @better-ccflare/core before @better-ccflare/types.
// types/agent.ts runtime-imports core while core/strategy.ts imports types, a
// pre-existing cycle that crashes when types is the first module evaluated.
import "@better-ccflare/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { AccountRepository } from "../account.repository";

/** Not 1, so a dropped column cannot be mistaken for a plausible value. */
const RENEWAL_DAY = 23;

describe("AccountRepository renewal_day", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		repo = new AccountRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	function insert(id: string, renewalDay: number | null): void {
		db.run(
			"INSERT INTO accounts (id, name, provider, created_at, renewal_day) VALUES (?, ?, ?, ?, ?)",
			[id, id, "anthropic", Date.now(), renewalDay],
		);
	}

	it("reads the renewal day in findById", async () => {
		insert("acc-1", RENEWAL_DAY);

		const account = await repo.findById("acc-1");
		expect(account?.renewal_day).toBe(RENEWAL_DAY);
	});

	it("reads the renewal day in findAll", async () => {
		insert("acc-1", RENEWAL_DAY);

		const [account] = await repo.findAll();
		expect(account.renewal_day).toBe(RENEWAL_DAY);
	});

	it("reports null for an account that has no renewal day", async () => {
		insert("acc-2", null);

		expect((await repo.findById("acc-2"))?.renewal_day).toBeNull();
	});

	it("does not report a set day as unset", async () => {
		// The negative form. null is what a dropped column produces AND what an
		// unconfigured account legitimately holds, so asserting the number alone
		// does not distinguish the two failures.
		insert("acc-1", RENEWAL_DAY);

		expect((await repo.findById("acc-1"))?.renewal_day).not.toBeNull();
	});
});
