import { describe, expect, it } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logBus } from "@better-ccflare/logger";
import type { LogEvent } from "@better-ccflare/types";
import { __setChmodForTest, chmodForConfig } from "./chmod-seam";
import { Config } from "./index";

/**
 * SB23-2350. A config another local user can write is reported and loaded
 * anyway, which is PR #176's decision and is not revisited here. What is
 * revisited is the LEVEL.
 *
 * On a filesystem that enforces modes the report was already clearable:
 * restrictConfigFile() lands 0600 on the same load, so the next boot does not
 * meet the predicate and says nothing. On a filesystem that ignores modes the
 * chmod is a no-op, the file reads writable forever, and the line fired on
 * every boot with nothing the operator could do about it, shipping to
 * OpenObserve each time.
 *
 * The distinction is measured, not assumed: chmodAndVerify() already chmods,
 * re-stats and compares, and records the path in a module-private Set when the
 * mode did not move. These tests pin that the level follows that measurement.
 *
 * How the no-op filesystem is modelled changed in SB23-2365. It used to be a
 * pre-seeded export of that Set, which selected the branch without ever running
 * the compare the branch depends on, so a mutation deleting the chmodAndVerify()
 * call at the report site survived the whole suite. The fixture is now the chmod
 * itself, swapped through __setChmodForTest() on a real 0666 file, so the
 * compare runs and reads 0666 the way it would on a bind mount.
 */

const ERROR_MARK = "its contents may not be yours";
const WARN_MARK = "does not enforce Unix modes";

function captureLogs(fn: () => void): LogEvent[] {
	const captured: LogEvent[] = [];
	const handler = (event: LogEvent) => captured.push(event);
	logBus.on("log", handler);
	try {
		fn();
	} finally {
		logBus.off("log", handler);
	}
	return captured;
}

/**
 * A fixture directory that is asserted to be a temp directory and not a
 * checkout before anything runs in it, because a fixture path that resolved
 * wrong is how a sub-agent once wrote into a live config.
 */
function withFixture(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-unenforceable-"));
	expect(dir.length).toBeGreaterThan(0);
	expect(dir.startsWith(tmpdir())).toBe(true);
	expect(dir.includes("better-ccflare-worktrees")).toBe(false);
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Model a filesystem with no Unix modes to set: chmod succeeds and changes
 * nothing. Restored in a `finally` because `bun test` shares one process across
 * files, and a stub left installed would silently disarm every later chmod in
 * this package.
 */
function withChmodThatDoesNothing(fn: () => void): void {
	const calls: Array<{ path: string; mode: number }> = [];
	__setChmodForTest((path, mode) => {
		calls.push({ path, mode });
	});
	try {
		fn();
	} finally {
		__setChmodForTest(null);
	}
	// The stub must actually have been reached. Without this the test passes
	// identically against a source that never calls chmod at all, which is the
	// mutation this whole change exists to kill.
	expect(calls.length).toBeGreaterThan(0);
}

describe("a writable config on a filesystem that cannot enforce modes", () => {
	// Skipped on Windows, where chmodAndVerify() returns before the compare
	// because Node derives st_mode from FILE_ATTRIBUTE_READONLY there and a
	// re-stat would read 0666 for any writable file. The no-op stub therefore
	// cannot reach the WARN branch on win32 at all, so a case there would assert
	// against a branch the platform does not run.
	it.skipIf(process.platform === "win32")(
		"warns rather than erroring, and says the mode is not evidence",
		() => {
			withFixture((dir) => {
				const configPath = join(dir, "config.json");
				writeFileSync(configPath, JSON.stringify({ lb_strategy: "session" }));
				// Explicit chmod, never writeFileSync's mode option: that option is
				// masked by the umask, and under umask 022 a requested 0o666 lands 0644,
				// which has no group or other WRITE bit, so the condition under test
				// would not hold and the test would pass against reverted source.
				chmodSync(configPath, 0o666);
				expect(statSync(configPath).mode & 0o022).not.toBe(0);

				// Stand in for the filesystem, by swapping the chmod rather than by
				// pre-seeding the Set that records its result. tmpdir() here is APFS or
				// tmpfs and does enforce modes, and no unprivileged fixture can produce
				// one that does not AND presents a group- or world-writable mode: a FAT
				// volume attached through DiskArbitration gives 0700, and mounting one
				// with a writable mask needs root.
				//
				// This is the whole of SB23-2365. A chmod that succeeds and changes
				// nothing is exactly what a Docker bind mount from a macOS host does, so
				// with the file left at a real 0666 the chmod, the re-stat and the
				// compare in chmodAndVerify() all run for real and the compare reads
				// 0666. Pre-seeding selected this branch while running none of them.
				let logs: LogEvent[] = [];
				withChmodThatDoesNothing(() => {
					logs = captureLogs(() => {
						const config = new Config(configPath);
						// Still loaded. PR #176's decision is unchanged by the level.
						expect(config.get("lb_strategy")).toBe("session");
					});
				});

				// The measurement itself, which nothing pinned before this change: the
				// compare ran, found the mode had not moved, and said so naming both
				// modes. Whole message with toBe, not a pair of toContain and
				// not.toContain: a blocklist of two strings cannot catch a sentence
				// nobody thought to list, and a mutation that ADDED one has survived
				// that shape in this exact file family.
				const measured = logs.filter((event) =>
					event.msg.startsWith("chmod on the config file"),
				);
				expect(measured).toHaveLength(1);
				expect(measured[0].level).toBe("WARN");
				expect(measured[0].msg).toBe(
					`chmod on the config file ${configPath} reported success but the mode is still ` +
						"0666 rather than 0600, so it may be readable " +
						"by other local users. Filesystems without Unix modes behave this way, " +
						"including Docker bind mounts from a macOS or Windows host and FAT or " +
						"exFAT volumes. Move the config onto a filesystem that enforces modes, " +
						"or mount it so only this user can read it.",
				);

				const warned = logs.filter(
					(event) => event.level === "WARN" && event.msg.includes(WARN_MARK),
				);
				expect(warned).toHaveLength(1);
				expect(warned[0].msg).toBe(
					`The config file ${configPath} reads mode 0666, but chmod on it reported success and did not land 0600, reported just above, so this filesystem does not enforce Unix modes and that reading says nothing about who can write the file. Docker bind mounts from a macOS or Windows host and FAT or exFAT volumes behave this way. Whether another local user can write ${configPath} is decided at the mount or on the host, not by these bits, and this process cannot see it. This file is where local_control_secret, pg_password and upstream_maintainer_token are stored, so check the access rules where the volume is mounted, or move the config onto a filesystem that enforces modes.`,
				);

				// The negative half. Without it a mutation that emits BOTH lines, or
				// that ignores the measurement and keeps erroring, passes on the
				// assertions above alone.
				expect(
					logs.filter((event) => event.msg.includes(ERROR_MARK)),
				).toHaveLength(0);
				expect(logs.filter((event) => event.level === "ERROR")).toHaveLength(0);
				// The measurement must precede the level it decides. Deleting the
				// chmodAndVerify() call at the report site leaves the Set empty there,
				// so the level is chosen as "took" and this file's ERROR-free assertion
				// above fails. That mutation is the acceptance line for SB23-2365 and it
				// survived 187 pass before this test swapped its fixture.
				const order = logs.map((event) => event.msg);
				expect(
					order.findIndex((msg) => msg.startsWith("chmod on the config file")),
				).toBeLessThan(order.findIndex((msg) => msg.includes(WARN_MARK)));
			});
		},
	);

	it("still errors when the chmod does take", () => {
		// The other half of the same branch, on the same fixture with the Set left
		// alone. Without this a mutation that always warns passes the test above,
		// and the one-time ERROR that PR #176 exists for would be gone.
		withFixture((dir) => {
			const configPath = join(dir, "config.json");
			writeFileSync(configPath, JSON.stringify({ lb_strategy: "session" }));
			chmodSync(configPath, 0o666);
			expect(statSync(configPath).mode & 0o022).not.toBe(0);
			// No stub installed, so the real chmodSync runs and really lands 0600.
			// This is the half that proves withChmodThatDoesNothing() restores: if a
			// stub leaked out of the test above, this test reads 0666 and fails.

			const logs = captureLogs(() => {
				const config = new Config(configPath);
				expect(config.get("lb_strategy")).toBe("session");
			});

			const reported = logs.filter(
				(event) => event.level === "ERROR" && event.msg.includes(ERROR_MARK),
			);
			expect(reported).toHaveLength(1);

			// The chmod must happen AT THE REPORT SITE, before the level is chosen,
			// not later in loadConfig(). Deleting the chmodAndVerify() call here
			// leaves this test's final 0600 assertion satisfied after the fact by
			// restrictConfigFile(), so the order is what catches it. Found by PR
			// #186's independent reviewer, which is why the assertion is on ORDER
			// rather than on the final mode. Since SB23-2365 the WARN test above
			// kills the same mutant from the other side, by running the compare
			// instead of pre-seeding its result.
			const order = logs.map((event) => event.msg);
			const chmodAt = order.findIndex((msg) =>
				msg.includes("Restricted config file permissions to 0600"),
			);
			const errorAt = order.findIndex((msg) => msg.includes(ERROR_MARK));
			expect(chmodAt).toBeGreaterThanOrEqual(0);
			expect(errorAt).toBeGreaterThanOrEqual(0);
			expect(chmodAt).toBeLessThan(errorAt);
			// The field that makes this an authentication bypass rather than a
			// disclosure is still named.
			expect(reported[0].msg).toContain("local_control_secret");
			// And the window is closed on the way out, which is what makes this one
			// clearable: the next boot reads 0600 and says nothing.
			expect(statSync(configPath).mode & 0o777).toBe(0o600);

			// The negative half.
			expect(
				logs.filter((event) => event.msg.includes(WARN_MARK)),
			).toHaveLength(0);
		});
	});

	it("is clearable on a mode-enforcing filesystem: the second boot is silent", () => {
		// The claim the issue turns on, measured rather than argued. A fresh
		// process is modelled by a fresh path, because contentsNotOurs is
		// module-scoped and deliberately never cleared, so a second Config on the
		// SAME path would be silent whatever the mode is and would prove nothing.
		withFixture((dir) => {
			const configPath = join(dir, "config.json");
			writeFileSync(configPath, JSON.stringify({ lb_strategy: "session" }));
			chmodSync(configPath, 0o666);

			captureLogs(() => {
				new Config(configPath);
			});
			// What the next boot would find on disk.
			expect(statSync(configPath).mode & 0o777).toBe(0o600);

			// Now read that same on-disk state the way a new process would, on a
			// path the module Sets have never seen.
			const second = join(dir, "second.json");
			writeFileSync(second, JSON.stringify({ lb_strategy: "session" }));
			chmodSync(second, 0o600);
			const logs = captureLogs(() => {
				new Config(second);
			});
			expect(
				logs.filter((event) => event.msg.includes(ERROR_MARK)),
			).toHaveLength(0);
			expect(
				logs.filter((event) => event.msg.includes(WARN_MARK)),
			).toHaveLength(0);
		});
	});

	it.skipIf(process.platform !== "darwin")(
		"still loads the config, and still errors, when the chmod THROWS",
		() => {
			// The regression the inner try/catch exists for. The chmod now runs
			// inside readRegularFile()'s own try, so without its own catch a throw
			// lands in the outer one, returns null, and turns a warning about a
			// writable config into a silently empty config. That is the shape PR
			// #176's review found one line down from here, and nothing else in this
			// file reaches it.
			//
			// A macOS uchg flag is the fixture: it makes chmodSync throw EPERM while
			// the file stays readable, unprivileged. Measured 2026-09-19. Linux has
			// chattr +i but it needs root, so this skips there and says so rather
			// than mocking node:fs, which would prove a stub was called.
			//
			// The level stays ERROR. A throw means a real filesystem refused a real
			// chmod, which is a mode-enforcing filesystem, so the mode read above is
			// evidence.
			withFixture((dir) => {
				const configPath = join(dir, "config.json");
				writeFileSync(configPath, JSON.stringify({ lb_strategy: "session" }));
				chmodSync(configPath, 0o666);
				const flag = Bun.spawnSync(["chflags", "uchg", configPath]);
				expect(flag.exitCode).toBe(0);
				try {
					const logs = captureLogs(() => {
						const config = new Config(configPath);
						// The assertion that matters: loaded, not silently empty.
						expect(config.get("lb_strategy")).toBe("session");
					});

					expect(
						logs.filter(
							(event) =>
								event.level === "ERROR" && event.msg.includes(ERROR_MARK),
						),
					).toHaveLength(1);
					// The ERROR must be the THREW text, not the TOOK text. The took
					// branch ends on "It has been brought to 0600 ... This line does
					// not repeat on the next boot", and both halves are false here:
					// the mode is still 0666, asserted below, and a uchg flag survives
					// a reboot so the line repeats forever. A security message that
					// says the window is closed when it is open is worse than no
					// message. Kills a mutation collapsing threw into took.
					const errored = logs.filter(
						(event) =>
							event.level === "ERROR" && event.msg.includes(ERROR_MARK),
					);
					expect(errored).toHaveLength(1);
					expect(errored[0].msg).toContain("The chmod to 0600 FAILED");
					expect(errored[0].msg).toContain("repeats on every boot");
					expect(errored[0].msg).not.toContain("has been brought to 0600");
					expect(errored[0].msg).not.toContain("does not repeat");
					// The chmod failure is reported in its own right, at warn, rather
					// than swallowed. More than one: restrictConfigFile() re-attempts
					// the same chmod further down loadConfig() and throws again, which
					// is pre-existing behaviour for any config whose chmod fails and
					// is not introduced here. Asserted as a floor rather than a count
					// so it pins the thing that matters, which is that it is reported
					// at all.
					expect(
						logs.filter((event) =>
							event.msg.includes("Could not restrict config file permissions"),
						).length,
					).toBeGreaterThan(0);
					// And not mislabelled as a filesystem that ignores modes. It does
					// not ignore them; it refused.
					expect(
						logs.filter((event) => event.msg.includes(WARN_MARK)),
					).toHaveLength(0);
					// The mode really did not move, so the fixture proved its premise.
					expect(statSync(configPath).mode & 0o777).toBe(0o666);
				} finally {
					// Before withFixture's rmSync, which cannot remove a uchg file.
					Bun.spawnSync(["chflags", "nouchg", configPath]);
				}
			});
		},
	);

	it("says nothing at all for a config only we can write", () => {
		// The predicate's own negative, so a mask widened from 0o022 to 0o222 dies
		// here rather than firing on every install on every boot. 0644 is the
		// valuable case: it is what versions before PR #57 wrote, so it is what an
		// upgrading install has on disk.
		for (const mode of [0o600, 0o644]) {
			withFixture((dir) => {
				const configPath = join(dir, "config.json");
				writeFileSync(configPath, JSON.stringify({ lb_strategy: "session" }));
				chmodSync(configPath, mode);
				expect(statSync(configPath).mode & 0o022).toBe(0);

				// On a filesystem that cannot enforce modes, on purpose. The level
				// branch must never be reached at all when the predicate does not
				// hold, so neither line may appear even there. Uses the real chmod
				// rather than the stub, because withChmodThatDoesNothing() asserts
				// its stub was reached and restrictConfigFile() early-returns on a
				// mode that is already 0600, so on the 0600 case there is no chmod to
				// intercept and the helper would fail on its own precondition.
				const logs = captureLogs(() => {
					new Config(configPath);
				});
				expect(
					logs.filter((event) => event.msg.includes(ERROR_MARK)),
				).toHaveLength(0);
				expect(
					logs.filter((event) => event.msg.includes(WARN_MARK)),
				).toHaveLength(0);
			});
		}
	});
});

describe("the chmod seam's NODE_ENV gate", () => {
	const GATE_REFUSAL =
		"__setChmodForTest is available only while NODE_ENV=test. " +
		"Swapping the chmod this package calls outside a test run would " +
		"silently disarm the permission enforcement on the config file, which " +
		"holds local_control_secret, pg_password and upstream_maintainer_token.";

	it("reads NODE_ENV=test without setting it, and BUN_ENV and BUN_TEST unset", () => {
		// The marker is measured here rather than taken from a note. A case that
		// set NODE_ENV itself would pass against a guard keyed on anything at all
		// and would prove nothing, which is the point #159's own gate test makes
		// at config-path-refuses-default.test.ts:66.
		expect(process.env.NODE_ENV).toBe("test");
		// And the two that look like they would work and do not. A guard keyed on
		// either would never fire, so this fails the moment that stops being true
		// and someone reaches for one.
		expect(process.env.BUN_ENV).toBeUndefined();
		expect(process.env.BUN_TEST).toBeUndefined();
	});

	it("refuses to swap the chmod when NODE_ENV is not test", () => {
		const saved = process.env.NODE_ENV;
		try {
			for (const value of ["production", undefined]) {
				if (value === undefined) delete process.env.NODE_ENV;
				else process.env.NODE_ENV = value;
				// Whole message with toBe. A substring pair would accept a refusal
				// that had grown a sentence telling the operator to set NODE_ENV,
				// which is the opposite of what this guard is for.
				expect(() => __setChmodForTest(() => {})).toThrow(GATE_REFUSAL);
				// Restoring is ALLOWED whatever NODE_ENV says, and that asymmetry is
				// deliberate. It puts the real chmodSync back, so it cannot disarm
				// anything, and refusing it would strand a stub in the shared process
				// whenever a test changed NODE_ENV between the install and the
				// finally that restores.
				expect(() => __setChmodForTest(null)).not.toThrow();
			}
		} finally {
			if (saved === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = saved;
		}
		expect(process.env.NODE_ENV).toBe("test");
	});

	it.skipIf(process.platform === "win32")(
		"restores the real chmod when passed null",
		() => {
			// The negative for withChmodThatDoesNothing()'s finally. Without it a
			// restore that silently did nothing would leave every later chmod in
			// this package disarmed, across files, and every test that asserts a
			// mode would read whatever the umask left.
			withFixture((dir) => {
				const target = join(dir, "restore.txt");
				writeFileSync(target, "x");
				chmodSync(target, 0o666);

				let stubbed = 0;
				__setChmodForTest(() => {
					stubbed += 1;
				});
				try {
					chmodForConfig(target, 0o600);
				} finally {
					__setChmodForTest(null);
				}
				expect(stubbed).toBe(1);
				// The stub really was a no-op, so the fixture models a filesystem
				// with no modes to set rather than a chmod that quietly worked.
				expect(statSync(target).mode & 0o777).toBe(0o666);

				chmodForConfig(target, 0o600);
				expect(stubbed).toBe(1);
				expect(statSync(target).mode & 0o777).toBe(0o600);
			});
		},
	);
});
