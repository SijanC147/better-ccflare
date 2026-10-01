import { lstatSync } from "node:fs";

/**
 * The two fields entryIsTrusted() reads from an entry in a sticky directory,
 * and nothing else.
 *
 * Narrow on purpose. A seam returning a whole Stats would let a stub change
 * the entry's type, size or mode as seen by the trust decision, which no test
 * needs; this one can only say who owns the entry and how many names it has.
 */
export interface EntryOwnership {
	uid: number;
	nlink: number;
}

/**
 * The lstat entryIsTrusted() calls on the entry at the end of a hop, behind a
 * reference a test can swap (SB23-2316).
 *
 * The seam exists for one measurement: the comparison of that entry's uid with
 * ours. On macOS no unprivileged fixture can reach it any other way. A sticky
 * directory a test creates is owned by the test process, so every entry the
 * test puts in it reads as ours; stubbing process.getuid() to a stranger instead
 * is refused one line earlier, by the directory-ownership test, and never
 * reaches the comparison. (On Linux stickyFixture() returns the root-owned /tmp,
 * which the directory check admits, so a getuid stub would reach it there; the
 * seam is used anyway because it works on both platforms.) The one root-owned sticky directory, /private/tmp on macOS, can
 * be made an allowed base by pointing TMPDIR at it, but the path validator
 * memoises its allowed base paths on first use and exports no reset for that
 * cache, so a test built that way passed alone and failed inside the full suite
 * (measured when SB23-2267 shipped). So a mutation deleting the comparison
 * survived the whole config suite, disclosed in that PR and in the test file's
 * header.
 *
 * Swapping this read makes a link of ours, in a sticky directory of ours, read
 * as another user's, with its real link count, so the directory checks run for
 * real and the uid comparison is the only thing that can refuse.
 *
 * Same shape as ./chmod-seam, for the same reasons: not `mock.module("node:fs")`,
 * which leaks across files in a shared `bun test` process, and not re-exported
 * from index.ts, so reaching it takes a deep import of an internal file.
 */
// One spelling of the production default, used at install and at restore, so
// the two cannot drift: with two closures, a test running after the first
// restore measured the restore's spelling while production ran the other one,
// and a mutation to one of them hid a kill (PR #293 review, F2).
const realLstat = (path: string): EntryOwnership => lstatSync(path);

let lstatImpl: (path: string) => EntryOwnership = realLstat;

/** lstat an entry for the sticky-directory trust decision. */
export function lstatEntryForTrust(path: string): EntryOwnership {
	return lstatImpl(path);
}

/**
 * Swap the lstat above, for tests, and refuse outside a test run.
 *
 * A stub reaching this in production would choose who the trust decision
 * thinks owns the config entry, which is the decision that lets the config,
 * and so local_control_secret, be read through a link in a shared directory.
 * Gated on NODE_ENV like __setChmodForTest, because that is the marker
 * `bun test` sets; the measurement is in ./chmod-seam.
 *
 * Pass null to restore the real lstat. Only the install is gated, so a restore
 * in a `finally` always lands, even after a test changed NODE_ENV.
 */
export function __setEntryLstatForTest(
	fn: ((path: string) => EntryOwnership) | null,
): void {
	if (fn !== null && process.env.NODE_ENV !== "test") {
		throw new Error(
			"__setEntryLstatForTest is available only while NODE_ENV=test. " +
				"Swapping the lstat this package's config trust check calls outside a " +
				"test run would let a caller choose who owns the config entry, which " +
				"decides whether local_control_secret is read through a link in a " +
				"shared directory.",
		);
	}
	lstatImpl = fn ?? realLstat;
}
