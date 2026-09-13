import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restrictDbFile, restrictDbFiles } from "./file-modes";
import { ensureSchema, runMigrations } from "./migrations";

/**
 * better-ccflare.db stores credentials as plaintext TEXT — api_key,
 * refresh_token and access_token (migrations.ts:116-118) — so the database, its
 * WAL and every VACUUM INTO backup must be 0600. Measured on a real install
 * they were all 0644.
 */
function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

/**
 * Pin the umask at 022. Under umask 077 SQLite and VACUUM INTO would produce
 * 0600 files on their own, so every assertion below would pass with the source
 * change reverted. PR #57 shipped exactly that: two tests that stayed green
 * when `mode: 0o600` was dropped.
 */
let savedUmask: number;
let dir: string;

beforeEach(() => {
	savedUmask = process.umask(0o022);
	dir = mkdtempSync(join(tmpdir(), "better-ccflare-dbmode-"));
});

afterEach(() => {
	process.umask(savedUmask);
	rmSync(dir, { recursive: true, force: true });
});

describe("restrictDbFile", () => {
	it("brings a 0644 file to 0600", () => {
		const p = join(dir, "x.db");
		writeFileSync(p, "");
		chmodSync(p, 0o644);
		expect(restrictDbFile(p)).toBe(true);
		expect(mode(p)).toBe(0o600);
	});

	it("reports false for a file that does not exist", () => {
		expect(restrictDbFile(join(dir, "absent.db"))).toBe(false);
	});

	it("refuses to touch a directory", () => {
		// A directory that loses its execute bits takes the whole config
		// directory with it, including the database. PR #57 measured that.
		const sub = join(dir, "sub");
		mkdirSync(sub);
		chmodSync(sub, 0o755);
		expect(restrictDbFile(sub)).toBe(false);
		expect(mode(sub)).toBe(0o755);
	});

	it("restricts the -wal and -shm sidecars", () => {
		const p = join(dir, "x.db");
		for (const suffix of ["", "-wal", "-shm"]) {
			writeFileSync(`${p}${suffix}`, "");
			chmodSync(`${p}${suffix}`, 0o644);
		}
		restrictDbFiles(p);
		expect(mode(p)).toBe(0o600);
		expect(mode(`${p}-wal`)).toBe(0o600);
		expect(mode(`${p}-shm`)).toBe(0o600);
	});
});

describe("SQLite files created by the application", () => {
	it("gives a new WAL 0600 because the database is restricted first", () => {
		const p = join(dir, "better-ccflare.db");
		const db = new Database(p, { create: true });
		try {
			// The ordering under test: restrict the main file, and only then turn
			// WAL on. SQLite's unix VFS creates the -wal with the main database
			// file's mode, so a WAL opened after this is born 0600.
			expect(mode(p)).toBe(0o644);
			restrictDbFiles(p);
			expect(mode(p)).toBe(0o600);

			db.exec("PRAGMA journal_mode = WAL");
			db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
			db.exec("INSERT INTO t (id) VALUES (1)");

			expect(existsSync(`${p}-wal`)).toBe(true);
			expect(mode(`${p}-wal`)).toBe(0o600);
		} finally {
			db.close();
		}
	});
});

describe("VACUUM INTO backups", () => {
	it("writes the .backup.<ts> as 0600", () => {
		// runMigrations only takes a backup before a destructive schema change.
		// A legacy account_tier column is one of its triggers (migrations.ts,
		// willMutate), which is the same fixture the existing backup tests use.
		const p = join(dir, "better-ccflare.db");
		const db = new Database(p, { create: true });
		ensureSchema(db);
		db.prepare(
			"INSERT INTO accounts (id, name, provider, refresh_token, created_at) VALUES (?, ?, ?, ?, ?)",
		).run("a", "a", "anthropic", "secret-token", Date.now());
		db.prepare("ALTER TABLE accounts ADD COLUMN account_tier TEXT").run();
		db.close();

		const db2 = new Database(p);
		runMigrations(db2, p);
		db2.close();

		const backups = readdirSync(dir).filter((f) =>
			f.startsWith("better-ccflare.db.backup."),
		);
		expect(backups.length).toBeGreaterThan(0);
		for (const b of backups) {
			// VACUUM INTO writes 0644 and renameSync preserves whatever mode it
			// finds, so without the chmod before the rename these land
			// world-readable with every credential the source holds.
			expect(mode(join(dir, b))).toBe(0o600);
		}
	});
});
