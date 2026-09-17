import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restrictDbBackups, restrictDbFiles } from "../file-modes";

/**
 * SB23-2235. `restrictDbFiles` restricted the database and its `-wal`/`-shm`
 * siblings and nothing else, so `<db>.backup.*` files stayed at whatever mode
 * they were created with.
 *
 * `#76` fixed the creation side: `migrations.ts` chmods the backup before the
 * rename, so every backup written since v3.15.0 is 0600. What it could not fix
 * is a backup already on disk. Measured on a real install 2026-09-17: the
 * database and both sidecars 0600, and two backups from 2026-05-17 still 0644,
 * holding four access tokens and four refresh tokens between them.
 *
 * Every fixture below is chmodded to 0644 EXPLICITLY. Under umask 077 a
 * freshly created file is already 0600, so a test that skips the chmod passes
 * against reverted source and proves nothing
 * (`mem:tests-that-pass-for-the-wrong-reason`).
 */

const dirs: string[] = [];

function freshDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-backupmode-"));
	dirs.push(dir);
	return dir;
}

/** Creates a file and forces it to 0644, whatever the umask would have given. */
function seedWorldReadable(path: string): void {
	writeFileSync(path, "x");
	chmodSync(path, 0o644);
	// The fixture has to actually start wrong, or the assertion is vacuous.
	expect(mode(path)).toBe(0o644);
}

function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

afterEach(() => {
	while (dirs.length > 0) {
		rmSync(dirs.pop() as string, { recursive: true, force: true });
	}
});

describe("restrictDbBackups", () => {
	it("restricts a 0644 backup to 0600", () => {
		const dir = freshDir();
		const db = join(dir, "better-ccflare.db");
		const backup = `${db}.backup.1778991199258`;
		seedWorldReadable(db);
		seedWorldReadable(backup);

		restrictDbBackups(db);

		expect(mode(backup)).toBe(0o600);
	});

	it("restricts the backup's own -wal, -shm and .partial", () => {
		// These carry database pages too. The .partial is what a SIGTERM during
		// VACUUM INTO leaves behind, and it holds real content.
		const dir = freshDir();
		const db = join(dir, "better-ccflare.db");
		const siblings = [
			`${db}.backup.1779028256026-wal`,
			`${db}.backup.1779028256026-shm`,
			`${db}.backup.1779028256026.partial`,
		];
		seedWorldReadable(db);
		for (const path of siblings) seedWorldReadable(path);

		restrictDbBackups(db);

		for (const path of siblings) expect(mode(path)).toBe(0o600);
	});

	it("restricts a hand-renamed backup the pruner would skip", () => {
		// Pruning deliberately ignores a suffix that is not an integer, to honour
		// an operator keeping a file by name. A wrong mode on that file is not
		// something anyone intends, so the sweep is broader than the pruner.
		const dir = freshDir();
		const db = join(dir, "better-ccflare.db");
		const kept = `${db}.backup.keep-before-the-migration`;
		seedWorldReadable(db);
		seedWorldReadable(kept);

		restrictDbBackups(db);

		expect(mode(kept)).toBe(0o600);
	});

	it("leaves a backup belonging to a different database alone", () => {
		// Two databases can share a directory. Sweeping by directory rather than
		// by prefix would reach across and chmod a file this call has no claim
		// to. The negative assertion is the point: asserting only that OUR
		// backup became 0600 passes in both worlds.
		const dir = freshDir();
		const db = join(dir, "better-ccflare.db");
		const ours = `${db}.backup.1`;
		const theirs = join(dir, "other.db.backup.1");
		seedWorldReadable(db);
		seedWorldReadable(ours);
		seedWorldReadable(theirs);

		restrictDbBackups(db);

		expect(mode(ours)).toBe(0o600);
		expect(mode(theirs)).toBe(0o644);
	});

	it("ignores a file that merely starts with the database name", () => {
		// `better-ccflare.db.notes` is not a backup. The prefix includes
		// `.backup.` for exactly this reason.
		const dir = freshDir();
		const db = join(dir, "better-ccflare.db");
		const notes = `${db}.notes`;
		seedWorldReadable(db);
		seedWorldReadable(notes);

		restrictDbBackups(db);

		expect(mode(notes)).toBe(0o644);
	});

	it("does not throw when the directory does not exist", () => {
		const missing = join(freshDir(), "gone", "better-ccflare.db");
		expect(() => restrictDbBackups(missing)).not.toThrow();
	});
});

describe("restrictDbFiles covers backups", () => {
	it("sweeps the database, both sidecars and the backups in one call", () => {
		// The wiring assertion. restrictDbBackups can be correct while nothing
		// calls it, which is the shape mem:covering-the-function-is-not-covering
		// -the-call exists for: the function was easy to test and the handoff
		// was invisible.
		const dir = freshDir();
		const db = join(dir, "better-ccflare.db");
		const paths = [db, `${db}-wal`, `${db}-shm`, `${db}.backup.1778991199258`];
		for (const path of paths) seedWorldReadable(path);

		restrictDbFiles(db);

		for (const path of paths) expect(mode(path)).toBe(0o600);
	});
});
