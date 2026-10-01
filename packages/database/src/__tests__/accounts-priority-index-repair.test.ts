import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../migrations";

/**
 * SB23-3947. Both accounts rebuilds in `runMigrations` used to recreate
 * `idx_accounts_priority` as a one-column `ON accounts(priority)` after their
 * DROP TABLE. `addPerformanceIndexes` defines the same name as the composite
 * `ON accounts(priority ASC, request_count DESC, last_used)` with
 * IF NOT EXISTS, so on any install that took either rebuild the composite
 * index was never built. PR #299 stopped new rebuilds doing it; this is the
 * repair for an install that already has it.
 */

const dirs: string[] = [];

function freshDb(): Database {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-priority-index-"));
	dirs.push(dir);
	const db = new Database(join(dir, "test.db"));
	runMigrations(db);
	return db;
}

afterEach(() => {
	while (dirs.length > 0) {
		rmSync(dirs.pop() as string, { recursive: true, force: true });
	}
});

function priorityKey(db: Database): string[] {
	return (
		db.query("PRAGMA index_xinfo(idx_accounts_priority)").all() as Array<{
			name: string | null;
			desc: number;
			key: number;
		}>
	)
		.filter((c) => c.key === 1)
		.map((c) => `${c.name} ${c.desc ? "DESC" : "ASC"}`);
}

function schemaVersion(db: Database): number {
	return (db.query("PRAGMA schema_version").get() as { schema_version: number })
		.schema_version;
}

const COMPOSITE = ["priority ASC", "request_count DESC", "last_used ASC"];

describe("idx_accounts_priority repair (SB23-3947)", () => {
	it("replaces the one-column form a rebuild left behind", () => {
		const db = freshDb();
		db.run("DROP INDEX idx_accounts_priority");
		db.run(
			"CREATE INDEX IF NOT EXISTS idx_accounts_priority ON accounts(priority)",
		);
		// The fixture holds the defect before the migration runs.
		expect(priorityKey(db)).toEqual(["priority ASC"]);

		runMigrations(db);

		expect(priorityKey(db)).toEqual(COMPOSITE);
		db.close();
	});

	it("leaves the composite form alone", () => {
		// No DDL at all on a second run of a fresh database: dropping and
		// recreating the right index every boot would move schema_version.
		const db = freshDb();
		expect(priorityKey(db)).toEqual(COMPOSITE);
		const before = schemaVersion(db);

		runMigrations(db);

		expect(schemaVersion(db)).toBe(before);
		expect(priorityKey(db)).toEqual(COMPOSITE);
		db.close();
	});

	it("builds the composite form when the index is missing", () => {
		const db = freshDb();
		db.run("DROP INDEX idx_accounts_priority");
		runMigrations(db);
		expect(priorityKey(db)).toEqual(COMPOSITE);
		db.close();
	});
});
