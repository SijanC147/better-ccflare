import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	configureSqlite,
	isValidSqlitePageSize,
	MAX_SQLITE_PAGE_SIZE,
	MIN_SQLITE_PAGE_SIZE,
} from "../database-operations";

/**
 * SB23-2041. `PRAGMA page_size` discards an unacceptable value without error
 * and without changing anything, so a typo in `db_page_size` is
 * indistinguishable from a working setting.
 *
 * The boundaries below are SQLite's, measured against bun:sqlite rather than
 * taken from documentation: 5000, 100 and 99999 were each issued against a
 * fresh database and each left the page size at 4096 with no throw.
 */
describe("isValidSqlitePageSize", () => {
	it("accepts every power of two SQLite allows", () => {
		// The complete set, not a sample. There are only eight.
		for (const size of [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536]) {
			expect(isValidSqlitePageSize(size)).toBe(true);
		}
	});

	it("rejects a value that is not a power of two", () => {
		// 5000 is the realistic typo: in range, plausible, silently discarded.
		for (const size of [5000, 3000, 4095, 4097, 12288]) {
			expect(isValidSqlitePageSize(size)).toBe(false);
		}
	});

	it("rejects powers of two outside SQLite's range", () => {
		// Powers of two specifically, so the range check is what rejects these
		// rather than the power-of-two check doing the work.
		expect(isValidSqlitePageSize(256)).toBe(false);
		expect(isValidSqlitePageSize(131072)).toBe(false);
	});

	it("rejects the boundaries' neighbours but accepts the boundaries", () => {
		expect(isValidSqlitePageSize(MIN_SQLITE_PAGE_SIZE)).toBe(true);
		expect(isValidSqlitePageSize(MAX_SQLITE_PAGE_SIZE)).toBe(true);
		expect(isValidSqlitePageSize(MIN_SQLITE_PAGE_SIZE - 1)).toBe(false);
		expect(isValidSqlitePageSize(MAX_SQLITE_PAGE_SIZE + 1)).toBe(false);
	});

	it("rejects 0, which passes the power-of-two bit test on its own", () => {
		// `(0 & -1) === 0` is true, so without the range check 0 would be
		// accepted. This is the case a naive implementation gets wrong.
		expect(isValidSqlitePageSize(0)).toBe(false);
	});

	it("rejects negatives, fractions and non-finite values", () => {
		for (const size of [-4096, 4096.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(isValidSqlitePageSize(size)).toBe(false);
		}
	});
});

/**
 * The warning in `configureSqlite` rests on two SQLite behaviours that are not
 * obvious and are not promised by our own code. Pinned here so that if either
 * ever changes, the warning becomes wrong loudly rather than quietly.
 *
 * Both were measured before the warning was written, not assumed.
 */
describe("SQLite page_size behaviour the warning depends on", () => {
	const dirs: string[] = [];

	function freshDb(): Database {
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-pagesize-"));
		dirs.push(dir);
		return new Database(join(dir, "test.db"));
	}

	function pageSize(db: Database): number {
		return (db.query("PRAGMA page_size").get() as { page_size: number })
			.page_size;
	}

	afterEach(() => {
		while (dirs.length > 0) {
			rmSync(dirs.pop() as string, { recursive: true, force: true });
		}
	});

	it("applies a legal page size to an empty database", () => {
		const db = freshDb();
		const target = pageSize(db) === 8192 ? 16384 : 8192;

		db.run(`PRAGMA page_size = ${target}`);

		expect(pageSize(db)).toBe(target);
		db.close();
	});

	it("silently ignores an illegal value, with no throw", () => {
		const db = freshDb();
		const before = pageSize(db);

		// 5000 is in range and plausible, and is not a power of two. The absence
		// of a throw is the assertion: that is why validation has to happen
		// before the PRAGMA rather than around it.
		expect(() => db.run("PRAGMA page_size = 5000")).not.toThrow();

		expect(pageSize(db)).toBe(before);
		db.close();
	});

	it("does NOT apply a legal page size once the database holds data", () => {
		// The half SB23-2041 was filed without. This is why db_page_size is inert
		// on every existing install regardless of the value set.
		const db = freshDb();
		db.run("CREATE TABLE t(a)");
		db.run("INSERT INTO t VALUES (1)");
		const before = pageSize(db);
		const target = before === 8192 ? 16384 : 8192;

		db.run(`PRAGMA page_size = ${target}`);

		expect(pageSize(db)).toBe(before);
		db.close();
	});

	it("materialises the staged page size on a full VACUUM", () => {
		// The value is pending rather than discarded, which is what makes the
		// warning's advice actionable: an operator running VACUUM by hand gets
		// the setting they asked for.
		const db = freshDb();
		db.run("CREATE TABLE t(a)");
		db.run("INSERT INTO t VALUES (1)");
		const target = pageSize(db) === 8192 ? 16384 : 8192;

		db.run(`PRAGMA page_size = ${target}`);
		db.run("VACUUM");

		expect(pageSize(db)).toBe(target);
		db.close();
	});
});

/**
 * The warnings themselves.
 *
 * Added after a mutation survived: disabling the staged-value branch entirely
 * left every test above green, because they pin SQLite's behaviour and the
 * validator, and neither observes whether `configureSqlite` actually says
 * anything. A warning nobody asserts is a warning that can be deleted without
 * a single test noticing, which is the failure this file exists to prevent.
 */
describe("configureSqlite page size warnings", () => {
	const dirs: string[] = [];
	const originalWarn = console.warn;

	function freshDb(populated: boolean): Database {
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-pagewarn-"));
		dirs.push(dir);
		const db = new Database(join(dir, "test.db"));
		if (populated) {
			db.run("CREATE TABLE t(a)");
			db.run("INSERT INTO t VALUES (1)");
		}
		return db;
	}

	/** Runs configureSqlite and returns everything it warned. */
	function warningsFrom(db: Database, pageSize: number): string[] {
		const captured: string[] = [];
		console.warn = (...args: unknown[]) => {
			captured.push(args.map(String).join(" "));
		};
		try {
			configureSqlite(db, { pageSize });
		} finally {
			console.warn = originalWarn;
		}
		return captured;
	}

	afterEach(() => {
		console.warn = originalWarn;
		while (dirs.length > 0) {
			rmSync(dirs.pop() as string, { recursive: true, force: true });
		}
	});

	it("warns that an illegal value was discarded", () => {
		const db = freshDb(false);

		const warnings = warningsFrom(db, 5000).filter((w) =>
			w.includes("db_page_size"),
		);

		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("5000");
		expect(warnings[0]).toContain("power of two");
		db.close();
	});

	it("warns that a legal value is staged but not applied on a populated database", () => {
		// The mutation that survived before this test existed. It is also the
		// case that affects every existing install.
		const db = freshDb(true);
		const target = 16384;

		const warnings = warningsFrom(db, target).filter((w) =>
			w.includes("db_page_size"),
		);

		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("staged but not applied");
		// Must tell the operator to act, because nothing here will.
		expect(warnings[0]).toContain("VACUUM");
		db.close();
	});

	it("warns even on a brand-new database, because WAL has already allocated pages", () => {
		// This test was written expecting silence and it failed, which is how the
		// third finding on SB23-2041 surfaced.
		//
		// configureSqlite issues `PRAGMA journal_mode = WAL` before it reaches the
		// page-size block, and WAL allocates pages. So by the time the PRAGMA is
		// issued, even a database created microseconds earlier is no longer empty
		// and the page size can never be applied.
		//
		// db_page_size is therefore inert on EVERY database, fresh or populated,
		// and that is our PRAGMA ordering rather than a SQLite limitation. The
		// same hazard is documented for auto_vacuum at the top of configureSqlite,
		// which is ordered first precisely to avoid it; nobody applied the
		// reasoning to page_size sitting below WAL. Moving it is a behaviour
		// change on database initialisation and is filed separately.
		const db = freshDb(false);

		const warnings = warningsFrom(db, 16384).filter((w) =>
			w.includes("db_page_size"),
		);

		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("staged but not applied");
		db.close();
	});

	it("says nothing when the configured size already matches", () => {
		const db = freshDb(true);
		const current = (
			db.query("PRAGMA page_size").get() as { page_size: number }
		).page_size;

		const warnings = warningsFrom(db, current).filter((w) =>
			w.includes("db_page_size"),
		);

		expect(warnings).toEqual([]);
		db.close();
	});
});
