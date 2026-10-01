/**
 * SB23-2457, revisited in SB23-2508. `AccountRepository.findAll` hands out one
 * fresh object per row per call (`rows.map(toAccount)`). This file pins that
 * property by reference: every assertion is `toBe` / `not.toBe`, none looks at
 * a field value.
 *
 * It was written because vertex-ai stored per-request state on the `Account`
 * and was correct only while no two requests shared an object. That reason is
 * gone: since SB23-2508 vertex-ai keys that state on the per-attempt
 * `ProviderRequestContext`, and
 * `packages/providers/src/providers/vertex-ai/__tests__/shared-account-state.test.ts`
 * shows two requests on one shared account object staying apart.
 *
 * The file stays for a different reason. The proxy still writes persisted
 * fields onto the account object it was handed, mid-request: token refreshes in
 * `packages/proxy/src/handlers/token-manager.ts`, the cooldown in
 * `rate-limit-cooldown.ts`, the rate-limit reset in `response-processor.ts`.
 * Today each write stays on that request's object until the next read from the
 * table. A cache between the SELECT and the caller would make those writes
 * visible to every concurrent request holding the same object, mid-flight.
 * Whether that would be harmful is not established; the point is that it would
 * change behaviour silently, and this file makes such a change a deliberate one.
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
