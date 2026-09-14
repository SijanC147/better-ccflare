import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { restrictDbFiles } from "./file-modes";
import { getLegacyDbPath, resolveDbPath } from "./paths";

type LegacyPathKind = "absent" | "regular" | "other";

/**
 * Classify a legacy path without opening it.
 *
 * existsSync() returns true for a FIFO and copyFileSync() on one blocks
 * forever waiting for a writer that never arrives, with no timeout, no log
 * line and no error. This function runs on database creation at startup, and
 * the legacy path is environment-influenced through XDG_CONFIG_HOME, so an
 * unguarded copy is a silent startup hang. statSync() only stats, so it is
 * safe on a FIFO. readRegularFile() in packages/config/src/index.ts is the
 * same guard for the config file, added by PR #78.
 *
 * statSync() follows symlinks, so a symlink pointing at a real database still
 * migrates; a dangling one reports "absent". Any other stat failure (EACCES,
 * ELOOP) reports "other": it is not something this function can copy from.
 */
function classifyLegacyPath(target: string): LegacyPathKind {
	try {
		const info = statSync(target, { throwIfNoEntry: false });
		if (!info) {
			return "absent";
		}
		return info.isFile() ? "regular" : "other";
	} catch {
		return "other";
	}
}

/**
 * Migrate from legacy ccflare database to better-ccflare
 * This function:
 * 1. Checks if better-ccflare.db exists (if yes, no migration needed)
 * 2. Checks if legacy ccflare.db exists
 * 3. Copies ccflare.db and related files to better-ccflare.db location
 *
 * @returns true if migration was performed, false otherwise
 */
export function migrateFromCcflare(): boolean {
	const newDbPath = resolveDbPath();
	const legacyDbPath = getLegacyDbPath();

	// If new DB already exists, no migration needed
	if (existsSync(newDbPath)) {
		return false;
	}

	// If legacy DB doesn't exist, no migration possible.
	//
	// A legacy path that exists but is not a regular file is logged rather than
	// skipped silently. Silence matches the surrounding code, but this branch is
	// reachable only when an operator has pointed XDG_CONFIG_HOME at a tree that
	// holds something odd at ccflare/ccflare.db, and then a migration they
	// expected does not happen for a reason nothing on stdout explains. The
	// startup hang this replaces was expensive precisely because it was silent.
	const legacyKind = classifyLegacyPath(legacyDbPath);
	if (legacyKind === "other") {
		console.error(
			`⚠️  The legacy database path ${legacyDbPath} is not a regular file, so it was not migrated.`,
		);
		return false;
	}
	if (legacyKind === "absent") {
		return false;
	}

	try {
		// Ensure target directory exists
		const newDbDir = dirname(newDbPath);
		if (!existsSync(newDbDir)) {
			mkdirSync(newDbDir, { recursive: true, mode: 0o700 });
		}

		// Copy main database file
		copyFileSync(legacyDbPath, newDbPath);
		console.log(`✅ Migrated database from ${legacyDbPath} to ${newDbPath}`);

		// Copy WAL and SHM files if they exist
		const walPath = `${legacyDbPath}-wal`;
		const shmPath = `${legacyDbPath}-shm`;

		// Same guard for the sidecars. A FIFO at either of these blocks the same
		// way, and it blocks after the main database has already been copied, so
		// the process would hang with a half-finished migration behind it.
		const walKind = classifyLegacyPath(walPath);
		if (walKind === "regular") {
			copyFileSync(walPath, `${newDbPath}-wal`);
			console.log(`✅ Migrated WAL file`);
		} else if (walKind === "other") {
			console.error(
				`⚠️  The legacy WAL path ${walPath} is not a regular file, so it was not migrated.`,
			);
		}

		const shmKind = classifyLegacyPath(shmPath);
		if (shmKind === "regular") {
			copyFileSync(shmPath, `${newDbPath}-shm`);
			console.log(`✅ Migrated SHM file`);
		} else if (shmKind === "other") {
			console.error(
				`⚠️  The legacy SHM path ${shmPath} is not a regular file, so it was not migrated.`,
			);
		}

		// copyFileSync reproduces the source mode, and the legacy ccflare.db is
		// 0644. Opening the database restricts it anyway, but that can be a
		// separate process minutes later, so do not leave a copy of every
		// plaintext credential world-readable in the meantime.
		restrictDbFiles(newDbPath);

		console.log(`
⚠️  Migration complete! Your ccflare data has been copied to better-ccflare.
   The original ccflare files have been left intact for safety.
   You can delete them manually if desired: ${dirname(legacyDbPath)}/
`);

		return true;
	} catch (error) {
		console.error(`❌ Failed to migrate database: ${error}`);
		return false;
	}
}
