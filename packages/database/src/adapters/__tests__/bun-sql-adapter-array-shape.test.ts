/**
 * Tests that BunSqlAdapter.query() hands back the same shape on both dialects.
 *
 * Bun's SQL driver returns an array carrying four extra enumerable own
 * properties (count, command, lastInsertRowid, affectedRows). A plain array
 * enumerates only its indices, so `Object.keys()` read 7 for 3 rows on
 * PostgreSQL and 3 on SQLite, and any spread or `Object.entries()` over a
 * result leaked them. That divergence has no type error, because an array with
 * extra properties still satisfies the declared `R[]`, and it produced no test
 * failure until a live PostgreSQL run: it bit `pg-live-queries.test.ts` exactly
 * that way.
 *
 * Live PostgreSQL was the only instrument that could see it. It is not the only
 * instrument that can: the adapter's PG constructor arm takes any object with
 * an `unsafe()` method, so a fake client returning the driver's shape pins this
 * in CI on any host, with no cluster. The live harness remains the proof that
 * the fake is faithful.
 */
import { describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../bun-sql-adapter";

/**
 * Reproduce what Bun's SQL driver returns: a real Array with four extra
 * enumerable own properties hung off it.
 */
function makeDriverResult<T>(rows: T[], command = "SELECT"): T[] {
	return Object.assign([...rows], {
		count: rows.length,
		command,
		lastInsertRowid: 0,
		affectedRows: rows.length,
	});
}

/** Minimal fake standing in for Bun's SQL client. */
function makeFakeSql(unsafeImpl: () => Promise<unknown>) {
	return { unsafe: unsafeImpl, on: () => {} };
}

function makePgAdapter(unsafeImpl: () => Promise<unknown>): BunSqlAdapter {
	return new BunSqlAdapter(
		// biome-ignore lint/suspicious/noExplicitAny: constructing the adapter with a fake SQL client for testing
		makeFakeSql(unsafeImpl) as any,
		false,
	);
}

describe("BunSqlAdapter.query() result shape", () => {
	const rows = [
		{ id: 1, name: "a" },
		{ id: 2, name: "b" },
		{ id: 3, name: "c" },
	];

	it("the fake client reproduces the driver's extra properties", () => {
		// Guards the fixture itself. If this stops holding, the assertions below
		// pass against a shape PostgreSQL never produces and prove nothing.
		const raw = makeDriverResult(rows);
		expect(Array.isArray(raw)).toBe(true);
		expect(Object.keys(raw)).toHaveLength(7);
		expect((raw as unknown as { count: number }).count).toBe(3);
	});

	it("enumerates only its indices, as SQLite does", async () => {
		const adapter = makePgAdapter(async () => makeDriverResult(rows));

		const result = await adapter.query<{ id: number; name: string }>(
			"SELECT id, name FROM t",
		);

		// The assertion that fails without the normalisation: 7 keys, not 3.
		expect(Object.keys(result)).toHaveLength(3);
		expect(Object.keys(result)).toEqual(["0", "1", "2"]);
	});

	it("carries none of the four driver properties", async () => {
		const adapter = makePgAdapter(async () => makeDriverResult(rows));

		const result = await adapter.query("SELECT id, name FROM t");

		for (const leaked of [
			"count",
			"command",
			"lastInsertRowid",
			"affectedRows",
		]) {
			expect(Object.hasOwn(result, leaked)).toBe(false);
		}
	});

	it("is a plain Array, not a driver subclass", async () => {
		// Deleting the four by name would satisfy the assertions above while
		// leaving a subclass instance here, which is not parity with SQLite.
		class DriverArray<T> extends Array<T> {}
		const subclassed = DriverArray.from(rows) as unknown as typeof rows;
		const adapter = makePgAdapter(async () =>
			Object.assign(subclassed, { count: 3, command: "SELECT" }),
		);

		const result = await adapter.query("SELECT id, name FROM t");

		expect(Object.getPrototypeOf(result)).toBe(Array.prototype);
	});

	it("preserves the rows themselves, in order", async () => {
		const adapter = makePgAdapter(async () => makeDriverResult(rows));

		const result = await adapter.query<{ id: number; name: string }>(
			"SELECT id, name FROM t",
		);

		expect(result).toEqual(rows);
		expect(result).toHaveLength(3);
	});

	it("returns an empty array for an empty result", async () => {
		const adapter = makePgAdapter(async () => makeDriverResult([]));

		const result = await adapter.query("SELECT id FROM t WHERE false");

		expect(result).toEqual([]);
		expect(Object.keys(result)).toHaveLength(0);
	});
});

describe("BunSqlAdapter.runWithChanges() keeps reading the driver's count", () => {
	// query() drops `count`, so this method must keep calling sql.unsafe()
	// directly. Nothing pinned that before: routing it through query() would
	// make `count` undefined and the `?? 0` would report every DML statement as
	// affecting zero rows.
	//
	// Four retention cleanup loops then stop after one batch on every
	// PostgreSQL install, silently, because each terminates on
	// `while (deleted === BATCH_SIZE)` with `deleted` coming from
	// runWithChanges: request.repository.ts:692, :713 and :737, and
	// usage-history.repository.ts:231.
	it("returns the affected-row count for a DML statement", async () => {
		const adapter = makePgAdapter(async () =>
			Object.assign([], {
				count: 7,
				command: "DELETE",
				lastInsertRowid: 0,
				affectedRows: 7,
			}),
		);

		expect(
			await adapter.runWithChanges(
				"DELETE FROM requests WHERE timestamp < ?",
				[0],
			),
		).toBe(7);
	});

	it("reports zero when the driver supplies no count", async () => {
		const adapter = makePgAdapter(async () => []);

		expect(await adapter.runWithChanges("DELETE FROM requests")).toBe(0);
	});
});

describe("BunSqlAdapter.get() is unaffected", () => {
	it("returns the first row, and a row's own count column survives", async () => {
		// `SELECT COUNT(*) as count` is how every .count reader in this repo gets
		// its value: off a row object, not off the array. The normalisation in
		// query() must not disturb that.
		const adapter = makePgAdapter(async () =>
			makeDriverResult([{ count: 42 }]),
		);

		const row = await adapter.get<{ count: number }>(
			"SELECT COUNT(*) as count FROM accounts",
		);

		expect(row).toEqual({ count: 42 });
	});

	it("returns null for an empty result", async () => {
		const adapter = makePgAdapter(async () => makeDriverResult([]));

		expect(await adapter.get("SELECT id FROM t WHERE false")).toBeNull();
	});
});
