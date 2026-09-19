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
import { Config, unenforceableModes } from "./index";

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
 * re-stats and compares, and records the path in unenforceableModes when the
 * mode did not move. These tests pin that the level follows that measurement.
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

describe("a writable config on a filesystem that cannot enforce modes", () => {
	it("warns rather than erroring, and says the mode is not evidence", () => {
		withFixture((dir) => {
			const configPath = join(dir, "config.json");
			writeFileSync(configPath, JSON.stringify({ lb_strategy: "session" }));
			// Explicit chmod, never writeFileSync's mode option: that option is
			// masked by the umask, and under umask 022 a requested 0o666 lands 0644,
			// which has no group or other WRITE bit, so the condition under test
			// would not hold and the test would pass against reverted source.
			chmodSync(configPath, 0o666);
			expect(statSync(configPath).mode & 0o022).not.toBe(0);

			// Stand in for the filesystem. tmpdir() here is APFS or tmpfs and does
			// enforce modes, and no unprivileged fixture can produce one that does
			// not AND presents a group- or world-writable mode: a FAT volume
			// attached through DiskArbitration gives 0700, and mounting one with a
			// writable mask needs root. Marking the path exercises the real branch in
			// readRegularFile() rather than a copy of its logic; the measurement
			// itself is covered by config-chmod-noop.test.ts on a real FAT volume.
			unenforceableModes.add(configPath);
			try {
				const logs = captureLogs(() => {
					const config = new Config(configPath);
					// Still loaded. PR #176's decision is unchanged by the level.
					expect(config.get("lb_strategy")).toBe("session");
				});

				const warned = logs.filter(
					(event) => event.level === "WARN" && event.msg.includes(WARN_MARK),
				);
				expect(warned).toHaveLength(1);
				expect(warned[0].msg).toContain(configPath);
				// The operator is pointed at the thing that can actually decide it.
				expect(warned[0].msg).toContain("mount");

				// The negative half. Without it a mutation that emits BOTH lines, or
				// that ignores the Set and keeps erroring, passes on the assertion
				// above alone.
				expect(
					logs.filter((event) => event.msg.includes(ERROR_MARK)),
				).toHaveLength(0);
				expect(logs.filter((event) => event.level === "ERROR")).toHaveLength(0);
			} finally {
				unenforceableModes.delete(configPath);
			}
		});
	});

	it("still errors when the chmod does take", () => {
		// The other half of the same branch, on the same fixture with the Set left
		// alone. Without this a mutation that always warns passes the test above,
		// and the one-time ERROR that PR #176 exists for would be gone.
		withFixture((dir) => {
			const configPath = join(dir, "config.json");
			writeFileSync(configPath, JSON.stringify({ lb_strategy: "session" }));
			chmodSync(configPath, 0o666);
			expect(statSync(configPath).mode & 0o022).not.toBe(0);
			expect(unenforceableModes.has(configPath)).toBe(false);

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
			// while keeping the unenforceableModes read leaves every other test
			// green: this test's final 0600 assertion is satisfied after the fact by
			// restrictConfigFile(), and the WARN test seeds the Set by hand so it
			// never runs the compare at all. The mutant reintroduces ERROR-forever
			// on a real bind mount, because a fresh process finds the Set empty at
			// the report site and populated one call too late. Found by this PR's
			// independent reviewer, which is why the assertion is on ORDER rather
			// than on the final mode.
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
			expect(unenforceableModes.has(configPath)).toBe(false);

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

				// Marked unenforceable on purpose. The level branch must never be
				// reached at all when the predicate does not hold, so neither line
				// may appear even on a filesystem that cannot enforce modes.
				unenforceableModes.add(configPath);
				try {
					const logs = captureLogs(() => {
						new Config(configPath);
					});
					expect(
						logs.filter((event) => event.msg.includes(ERROR_MARK)),
					).toHaveLength(0);
					expect(
						logs.filter((event) => event.msg.includes(WARN_MARK)),
					).toHaveLength(0);
				} finally {
					unenforceableModes.delete(configPath);
				}
			});
		}
	});
});
