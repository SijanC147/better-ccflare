/**
 * SB23-2457. `packages/providers/src/providers/vertex-ai/provider.ts` stores
 * per-request state on the `Account` object it is handed and reads it back
 * after the upstream fetch. That is only safe because two concurrent requests
 * on one account row are handed two DIFFERENT objects, and nothing in the type
 * system, the interfaces or any other test says so.
 *
 * The property is `rows.map(toAccount)` in `AccountRepository.findAll`: one
 * fresh object per row per call. A cache added anywhere between the SELECT and
 * the caller — memoizing `findAll`, or holding the returned array across
 * requests — would hand the same object to both, and the vertex-ai provider's
 * `_originalModel` would then be read by the wrong request. That failure is
 * demonstrated deliberately in
 * `packages/providers/src/providers/vertex-ai/__tests__/shared-account-state.test.ts`.
 *
 * So this file pins the property rather than the provider. It is not about
 * renewal days or column lists; it is about object identity, which is why the
 * assertions are all `toBe` / `not.toBe` on references and none of them look at
 * a field value.
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

describe("AccountRepository account object identity (SB23-2457)", () => {
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

	function insert(id: string): void {
		db.run(
			"INSERT INTO accounts (id, name, provider, created_at) VALUES (?, ?, ?, ?)",
			[id, id, "vertex-ai", Date.now()],
		);
	}

	it("returns a fresh object from each findAll call", async () => {
		insert("acc-1");

		const [first] = await repo.findAll();
		const [second] = await repo.findAll();

		expect(first.id).toBe(second.id);
		expect(first).not.toBe(second);
	});

	it("returns a fresh object from each findById call", async () => {
		insert("acc-1");

		const first = await repo.findById("acc-1");
		const second = await repo.findById("acc-1");

		expect(first?.id).toBe(second?.id);
		expect(first).not.toBe(second);
	});

	it("does not share one object between findAll and findById", async () => {
		insert("acc-1");

		const [fromAll] = await repo.findAll();
		const fromId = await repo.findById("acc-1");

		expect(fromId?.id).toBe(fromAll.id);
		expect(fromId).not.toBe(fromAll);
	});

	/**
	 * The positive control for the three tests above.
	 *
	 * `not.toBe` passes for any two distinct objects, including two that a
	 * caching layer built from one shared source and then copied. This asserts
	 * that a write to one really is invisible to the other, which is the
	 * property the vertex-ai provider depends on and the one a shallow copy
	 * would still satisfy while a shared reference would not.
	 */
	it("does not let a write to one object reach another", async () => {
		insert("acc-1");

		const [first] = await repo.findAll();
		(first as { _probe?: string })._probe = "written-by-request-a";

		const [second] = await repo.findAll();

		expect((second as { _probe?: string })._probe).toBeUndefined();
	});
});
