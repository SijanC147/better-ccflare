import { chmodSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Logger } from "@better-ccflare/logger";

const log = new Logger("DatabaseFileModes");

/**
 * 0600. The accounts table stores credentials as plaintext TEXT — api_key,
 * refresh_token and access_token (migrations.ts:116-118) — so every file that
 * can hold database pages must be readable by the owner only.
 */
export const DB_FILE_MODE = 0o600;

/**
 * Bring one database file to 0600 if it exists and is a regular file.
 *
 * Regular files only, for the reason PR #57 measured on the config path: a
 * directory that loses its execute bits locks the operator out of everything
 * under it, and the database lives in that same directory.
 *
 * Warns rather than throws. chmod fails legitimately on a bind-mounted volume,
 * on a file owned by another user, and on filesystems without Unix modes, and
 * none of those means the database is unusable. It can also report success and
 * change nothing (Docker bind mounts, FAT/exFAT); detecting that is SB23-1686
 * and is deliberately not attempted here.
 *
 * Returns true only when the file now reads 0600 as far as this call can tell,
 * so callers can log what happened. Nothing branches on it.
 */
export function restrictDbFile(path: string): boolean {
	try {
		const info = statSync(path);
		if (!info.isFile()) return false;
		if ((info.mode & 0o777) === DB_FILE_MODE) return true;
		chmodSync(path, DB_FILE_MODE);
		log.info(`Restricted ${path} permissions to 0600`);
		return true;
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		// The -wal and -shm siblings are absent most of the time; that is the
		// normal case and not worth a line in the log.
		if (err.code === "ENOENT") return false;
		log.warn(`Could not restrict ${path} permissions: ${error}`);
		return false;
	}
}

/**
 * Restrict a SQLite database and its sidecars.
 *
 * Call this with the main database file BEFORE turning WAL on. SQLite's unix
 * VFS creates a new -wal and -shm with the main database file's mode, so
 * fixing the database first means the WAL is born 0600 instead of being
 * chmodded after it has already existed at 0644. The sidecars are still swept
 * here because an unclean shutdown leaves them behind from an earlier run that
 * did create them 0644.
 */
export function restrictDbFiles(dbPath: string): void {
	restrictDbFile(dbPath);
	restrictDbFile(`${dbPath}-wal`);
	restrictDbFile(`${dbPath}-shm`);
	restrictDbBackups(dbPath);
}

/**
 * Bring every `<db>.backup.*` file beside the database to 0600.
 *
 * A backup holds the same plaintext credentials as the database it copies, so
 * it needs the same mode. It does not get one by inheritance: the backup is
 * written by `VACUUM INTO` (migrations.ts), which creates a fresh file whose
 * mode comes from the process umask, not from the source. Under the default
 * umask 022 that is 0644, whatever the live database is set to. Measured on a
 * real install 2026-09-17, where the database and both sidecars were 0600 and
 * two backups holding four access tokens and four refresh tokens were 0644
 * (SB23-2235).
 *
 * Swept here, alongside the stale sidecars, rather than only fixed at creation:
 * a backup written by an older binary is on disk now and nothing else will ever
 * revisit it.
 *
 * Matches the pruner's prefix rule (`<basename>.backup.`) so the two agree on
 * what belongs to this database, and deliberately does NOT require an integer
 * suffix the way pruning does. Pruning skips a hand-renamed
 * `db.backup.keep-this` to honour the operator's intent; a wrong MODE on that
 * same file is not something anyone intends, and leaving it 0644 to respect a
 * naming convention would protect the convention instead of the credentials.
 * That also covers `.backup.<ts>.partial`, `-wal` and `-shm`, which carry
 * database pages too.
 */
export function restrictDbBackups(dbPath: string): void {
	const dir = dirname(dbPath);
	const prefix = `${basename(dbPath)}.backup.`;

	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return;
		log.warn(`Could not list ${dir} to restrict database backups: ${error}`);
		return;
	}

	for (const name of entries) {
		if (name.startsWith(prefix)) restrictDbFile(join(dir, name));
	}
}
