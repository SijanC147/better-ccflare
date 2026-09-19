import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * A world-writable, sticky directory for tests that need one, with entry names
 * scoped to the calling run and a cleanup that only removes what it made.
 *
 * Test-only. Nothing at runtime imports this file, so it never reaches a bundle.
 * It deliberately imports no test framework: a failed precondition throws an
 * Error carrying the measured value, which fails the calling test just the same
 * and keeps `bun:test` out of a production package.
 *
 * ## Why two routes (SB23-2319)
 *
 * The first version of this fixture did `mkdtemp` then `chmodSync(dir, 0o1777)`
 * and asserted the sticky bit. That passed on macOS and failed on Linux CI at
 * the assertion. Probed on both:
 *
 *     macOS   chmodSync(dir, 0o1777) -> 1777
 *     Linux   chmodSync(dir, 0o1777) -> 0777, S_ISVTX silently dropped
 *
 * It is Bun, not the kernel, the filesystem or privilege. In the same container
 * coreutils `chmod 1777` yields `drwxrwxrwt` while `chmodSync` yields 0777, for
 * an octal literal, the same value in decimal, and the string "1777" alike, and
 * as root. Reading the bit back is unaffected: `statSync("/tmp")` reports 1777
 * on Linux, which is why the product feature works there and only a fixture
 * manufacturing the property did not.
 *
 * So: try to make one, and if the sticky bit did not take, use the base
 * directory itself, which Linux supplies already sticky and root-owned as /tmp.
 * macOS cannot take that route, because there `os.tmpdir()` is a private
 * /var/folders directory at 0700. Both properties are asserted at the end
 * whichever route ran, so there is no platform on which a caller proceeds
 * without a sticky directory.
 *
 * ## Why this returns an object rather than a path
 *
 * On the Linux route the directory IS `os.tmpdir()`, so a caller doing
 * `rmSync(dir, { recursive: true })` in its finally would delete the whole of
 * /tmp. Entries are therefore handed out by `entry()`, removed individually,
 * and the recursive removal is applied only to a directory this helper created.
 * That is the contract, and it is the reason this is a helper rather than a
 * comment.
 */
export interface StickyFixture {
	/** The sticky directory. May be `os.tmpdir()` itself. Never remove it. */
	dir: string;
	/** Reserve a run-scoped path inside `dir`. Removed individually by cleanup. */
	entry: (name: string) => string;
	/** Remove every reserved entry, and the directory only if we created it. */
	cleanup: () => void;
}

export function stickyFixture(label: string): StickyFixture {
	if (process.platform === "win32") {
		// Windows reports 0666 for any writable file, so the mode checks below are
		// vacuous there and a caller would get a directory with none of the
		// properties it asked for.
		throw new Error(
			"stickyFixture: sticky directories are a POSIX property; this fixture has no meaning on win32",
		);
	}

	const token = `better-ccflare-${label}-${process.pid}-${randomUUID().slice(0, 8)}`;
	const made = mkdtempSync(join(tmpdir(), `${token}-dir-`));
	chmodSync(made, 0o1777);
	const createdByUs = (statSync(made).mode & 0o1000) !== 0;
	if (!createdByUs) rmSync(made, { recursive: true, force: true });
	const dir = createdByUs ? made : tmpdir();

	// Before anything runs in it: the path must be real, and it must not overlap
	// the working tree in either direction.
	//
	// Both directions, because the two hazards are different and only one of them
	// is the obvious one. If `dir` CONTAINS the working tree, a caller that
	// ignores the cleanup contract and removes `dir` recursively takes the
	// repository with it. If `dir` is INSIDE the working tree, which is what
	// `TMPDIR` pointed at a path in the repository produces on the fallback
	// route, then every entry this fixture writes lands in the live tree and the
	// recursive removal on the created route deletes a directory of the
	// repository's. Every incident behind this guard in this project was the
	// second shape, a fixture path that silently resolved into live files, so a
	// check for the first shape alone would not have fired on any of them.
	//
	// Resolved first, so a relative TMPDIR cannot dodge both comparisons by never
	// sharing a prefix with an absolute cwd.
	//
	// Every refusal below removes `made` first when we still hold it. A throw
	// that leaks the directory it just created is worst precisely in the case
	// the overlap check is written for: measured here, the refusal left
	// `<worktree>/tmp-probe/better-ccflare-...-dir-ul8Ll0` behind at mode 1777,
	// inside the repository, which is the outcome the guard exists to prevent.
	const refuse = (message: string): never => {
		if (createdByUs) rmSync(made, { recursive: true, force: true });
		throw new Error(message);
	};

	if (dir.length === 0) {
		refuse("stickyFixture: resolved an empty directory path");
	}
	const resolvedDir = resolve(dir);
	const cwd = resolve(process.cwd());
	if (
		resolvedDir === cwd ||
		cwd.startsWith(`${resolvedDir}/`) ||
		resolvedDir.startsWith(`${cwd}/`)
	) {
		refuse(
			`stickyFixture: refusing a directory that overlaps the working tree (dir=${resolvedDir}, cwd=${cwd})`,
		);
	}

	const info = statSync(dir);
	if ((info.mode & 0o1000) === 0) {
		refuse(
			`stickyFixture: ${dir} is not sticky (mode ${(info.mode & 0o7777).toString(8)}); see SB23-2319`,
		);
	}
	if ((info.mode & 0o022) === 0) {
		refuse(
			`stickyFixture: ${dir} is not group- or world-writable (mode ${(info.mode & 0o7777).toString(8)})`,
		);
	}

	const entries: string[] = [];
	return {
		dir,
		entry(name: string): string {
			const path = join(dir, `${token}-${name}`);
			entries.push(path);
			return path;
		},
		cleanup(): void {
			// Individually, and non-recursively, so a symlink is unlinked rather than
			// followed. Never recursive on a directory we did not create.
			for (const path of entries) rmSync(path, { force: true });
			if (createdByUs) rmSync(made, { recursive: true, force: true });
		},
	};
}
