import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "./database-operations";

/**
 * SB23-1812. db-file-mode.test.ts calls restrictDbFiles() directly. That proves
 * the mechanism and the load-bearing ordering, but not that the constructor
 * calls it: deleting `restrictDbFiles(resolvedPath)` from database-operations.ts
 * leaves that whole suite green.
 *
 * This opens a real database through DatabaseOperations and asserts on what
 * lands on disk, so the wiring itself is what is pinned.
 */
function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

/**
 * Pin the umask at 022. Under umask 077 bun:sqlite yields 0600 with no help
 * from our code, so every assertion below would pass against a fully reverted
 * source. That exact mutation survived on PR #57 and is why this issue exists.
 */
let savedUmask: number;
let dir: string;
let savedDatabaseUrl: string | undefined;
let savedXdgConfigHome: string | undefined;

beforeEach(() => {
	savedUmask = process.umask(0o022);
	dir = mkdtempSync(join(tmpdir(), "better-ccflare-dbctor-"));

	// The constructor takes the PostgreSQL branch when DATABASE_URL is set, and
	// falls back to the persisted dashboard Postgres config when it is not. Both
	// have to point nowhere or the SQLite branch under test is never reached.
	savedDatabaseUrl = process.env.DATABASE_URL;
	delete process.env.DATABASE_URL;
	savedXdgConfigHome = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = join(dir, "xdg");
});

afterEach(() => {
	process.umask(savedUmask);
	if (savedDatabaseUrl === undefined) {
		delete process.env.DATABASE_URL;
	} else {
		process.env.DATABASE_URL = savedDatabaseUrl;
	}
	if (savedXdgConfigHome === undefined) {
		delete process.env.XDG_CONFIG_HOME;
	} else {
		process.env.XDG_CONFIG_HOME = savedXdgConfigHome;
	}
	rmSync(dir, { recursive: true, force: true });
});

describe("DatabaseOperations constructor file modes", () => {
	it("restricts the database and its WAL to 0600", async () => {
		const dbPath = join(dir, "data", "better-ccflare.db");
		const ops = new DatabaseOperations(dbPath);
		try {
			// Written by the constructor via bun:sqlite, which creates 0644 under
			// this umask. Only the restrictDbFiles() call brings it to 0600.
			expect(existsSync(dbPath)).toBe(true);
			expect(mode(dbPath)).toBe(0o600);

			// configureSqlite turns WAL on after restrictDbFiles, and SQLite's unix
			// VFS gives the new -wal the main file's mode, so it is born 0600.
			//
			// Measured, not assumed: moving restrictDbFiles below configureSqlite
			// leaves this GREEN. restrictDbFiles sweeps `${path}-wal` and
			// `${path}-shm` explicitly, so the reversed order chmods the WAL after
			// the fact instead of letting it inherit. The two guards are redundant
			// for the mode that ends up on disk, and only the window differs: under
			// the reversal the WAL exists at 0644 until the chmod lands. Nothing
			// here can observe that window, so this assertion pins the wiring and
			// the final mode, not the ordering. The ordering's comment in
			// file-modes.ts is the record of why it is that way round.
			expect(existsSync(`${dbPath}-wal`)).toBe(true);
			expect(mode(`${dbPath}-wal`)).toBe(0o600);
		} finally {
			await ops.close();
		}
	});

	it("creates the database directory 0700", async () => {
		// dirname(dbPath) does not exist beforehand, so this exercises the
		// mkdirSync mode argument in the same constructor. Nothing chmods this
		// directory afterwards: the Config class only corrects the default
		// location, deliberately, because dirname(BETTER_CCFLARE_DB_PATH) can be
		// a directory this application does not own.
		const dbDir = join(dir, "data");
		const ops = new DatabaseOperations(join(dbDir, "better-ccflare.db"));
		try {
			expect(mode(dbDir)).toBe(0o700);
		} finally {
			await ops.close();
		}
	});
});
