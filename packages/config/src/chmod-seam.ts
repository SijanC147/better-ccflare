import { chmodSync } from "node:fs";

/**
 * The chmod this package calls, behind a reference a test can swap
 * (SB23-2365).
 *
 * The seam exists for one measurement. chmodAndVerify() in index.ts chmods,
 * re-stats and compares, and the branch that decides whether a writable config
 * is reported at ERROR or at WARN reads the result of that compare. No
 * unprivileged fixture on macOS or Linux can produce a filesystem that ignores
 * modes AND presents a group- or world-writable file: a FAT volume attached
 * through DiskArbitration gives 0700, which has no group or other write bit, and
 * mounting one with a writable mask needs root (`mount_msdos -m 777` fails with
 * "msdos filesystem is not available" unprivileged, measured 2026-09-19).
 *
 * What stood here before was a module-scoped Set exported from the package's
 * public entry, which a test pre-seeded to select the WARN branch. That worked
 * and cost more than it looked: pre-seeding selects the branch WITHOUT running
 * the compare the branch depends on, so a mutation deleting the chmod-and-verify
 * call at the report site survived the whole config suite, 187 pass and 0 fail
 * at head 5ba29b23. The test was measuring the branch rather than the
 * measurement. Swapping chmod instead makes the no-op filesystem the fixture
 * models, on a real 0666 file, so the compare runs for real and reads 0666.
 *
 * `mock.module("node:fs")` is the obvious alternative and is rejected. `bun test`
 * shares one process across files and this repository has recorded cross-file
 * leakage from module-level mocking: one lane's `GlobalRegistrator.register()`
 * replaced 35 globals and broke four tests two packages away while everything in
 * its own package stayed green. A named reference in one module cannot reach
 * another package, and restoring it is a single call in a `finally`.
 *
 * This module is deliberately NOT re-exported from index.ts, which is what
 * `exports["."]` resolves to, so the seam is not on the package's public entry
 * the way the Set was. Reaching it takes a deep import of an internal file
 * rather than a named export of the package.
 */
let chmodImpl: (path: string, mode: number) => void = chmodSync;

/** chmod a path, through the reference a test can swap. */
export function chmodForConfig(path: string, mode: number): void {
	chmodImpl(path, mode);
}

/**
 * Swap the chmod above, for tests, and refuse outside a test run.
 *
 * Gated on NODE_ENV rather than trusted to a brief, following #159's constructor
 * guard: the remedy for a seam that could be reached in production is a seam
 * that refuses, because the call that reaches it wrongly never intended to. In
 * a server or CLI run NODE_ENV is not "test", so this throws and the reference
 * cannot be moved at all.
 *
 * NODE_ENV is the marker because it is the one `bun test` actually sets. BUN_ENV
 * and BUN_TEST were both measured unset inside a test, so a guard keyed on
 * either would never fire; re-measured 2026-09-19 by the gate test beside this,
 * which reads NODE_ENV without setting it.
 *
 * Pass null to restore the real `chmodSync`. Callers restore in a `finally`,
 * because the process is shared across test files and a stub left installed
 * would silently disarm every later chmod in this package.
 */
export function __setChmodForTest(
	fn: ((path: string, mode: number) => void) | null,
): void {
	// Only the INSTALL is gated. Restoring moves the reference back to the real
	// chmodSync, which is the safe direction, and refusing it was a defect rather
	// than extra strictness: a test whose body changes NODE_ENV and whose finally
	// then calls this would have the restore throw, leaving the stub installed
	// for the rest of the shared process. Measured blast radius of a leaked stub
	// is 11 tests across four files in this package, so the failure is loud, but
	// it is loud in files that have nothing to do with whatever left it there.
	// Raised as Finding 2 by PR #200's independent security reviewer.
	if (fn !== null && process.env.NODE_ENV !== "test") {
		throw new Error(
			"__setChmodForTest is available only while NODE_ENV=test. " +
				"Swapping the chmod this package calls outside a test run would " +
				"silently disarm the permission enforcement on the config file, which " +
				"holds local_control_secret, pg_password and upstream_maintainer_token.",
		);
	}
	chmodImpl = fn ?? chmodSync;
}
