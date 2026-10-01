import { describe, expect, it } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logBus } from "@better-ccflare/logger";
import type { LogEvent } from "@better-ccflare/types";
import { __setFchmodForTest } from "./chmod-seam";
import { Config } from "./index";

/**
 * SB23-2274. The fchmod on the save path is read back, like every other chmod
 * on this file.
 *
 * saveByRename() opens its temp file with mode 0600, but that create mode is
 * masked by the umask, so under umask 0277 the temp is born 0400 and only the
 * fchmod brings it to 0600 before the rename publishes it as the config. These
 * tests set that umask so the fchmod is the one thing deciding the mode on disk.
 * Under the ordinary 022 the create mode already lands 0600, and a test there
 * passes with the fchmod deleted.
 *
 * The umask is process-global and `bun test` shares one process across files,
 * so it is set only around the save and restored in a finally. The fixture
 * directory and the seeded config are created before it changes: a directory
 * made under 0277 is 0500 and the save could not create its temp file in it.
 */

function withFixture(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-save-fchmod-"));
	expect(dir.length).toBeGreaterThan(0);
	expect(dir.startsWith(tmpdir())).toBe(true);
	expect(dir.includes("better-ccflare-worktrees")).toBe(false);
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

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

/** Run fn under umask 0277, restoring the previous umask whatever happens. */
function underUmask0277(fn: () => void): void {
	const previous = process.umask(0o277);
	try {
		fn();
	} finally {
		process.umask(previous);
	}
}

/** The exact line the save path emits for a mode that did not land, asserted whole. */
function fchmodWarning(target: string, mode: string): string {
	return `fchmod to 0600 on the config being saved to ${target} did not take: the new file reads ${mode}. It is not readable by other local users, but it is not the mode this process set. Filesystems without Unix modes behave this way, including Docker bind mounts from a macOS or Windows host and FAT or exFAT volumes. The save goes ahead, because the file it replaces sits on the same filesystem and refusing would lose the setting without changing its mode. Move the config onto a filesystem that enforces modes, or mount it so only this user can read it. This line does not repeat for this path in this process.`;
}

const skipOnWindows = process.platform === "win32";

describe.skipIf(skipOnWindows)(
	"SB23-2274 — the save path's fchmod is verified",
	() => {
		/**
		 * The instrument first. If process.umask did not take on this runtime, every
		 * test below would pass with the fchmod deleted, so prove a create under it
		 * really is masked before trusting anything that depends on it.
		 */
		it("measures that umask 0277 masks a 0600 create to 0400 on this runtime", () => {
			withFixture((dir) => {
				const probe = join(dir, "probe");
				underUmask0277(() => {
					writeFileSync(probe, "x", { mode: 0o600 });
				});
				expect(statSync(probe).mode & 0o777).toBe(0o400);
			});
		});

		/** Kills the mutation that deletes the fchmod: without it the config lands 0400. */
		it("saves the config at 0600 when the umask would have made it 0400", () => {
			withFixture((dir) => {
				const path = join(dir, "better-ccflare.json");
				writeFileSync(path, `{"lb_strategy":"session"}`, { mode: 0o600 });
				const config = new Config(path);

				const events = captureLogs(() => {
					underUmask0277(() => {
						config.set("lb_strategy", "round-robin");
					});
				});

				expect(JSON.parse(readFileSync(path, "utf8")).lb_strategy).toBe(
					"round-robin",
				);
				expect(statSync(path).mode & 0o777).toBe(0o600);
				expect(
					events.some((event) => event.msg.startsWith("fchmod to 0600")),
				).toBe(false);
			});
		});

		/**
		 * A no-op fchmod is what a filesystem without Unix modes does: it reports
		 * success and the descriptor keeps the mode it was created with. Kills the
		 * mutation that deletes the read-back, and the one that keys the once-only
		 * set on the random temp path rather than the config, which would warn on
		 * every save.
		 */
		it("warns once per path when the fchmod reports success and does not land", () => {
			withFixture((dir) => {
				const path = join(dir, "better-ccflare.json");
				writeFileSync(path, `{"lb_strategy":"session"}`, { mode: 0o600 });
				const config = new Config(path);

				__setFchmodForTest(() => {});
				let events: LogEvent[];
				try {
					events = captureLogs(() => {
						underUmask0277(() => {
							config.set("lb_strategy", "round-robin");
							config.set("lb_strategy", "session");
						});
					});
				} finally {
					__setFchmodForTest(null);
				}

				const warnings = events.filter((event) =>
					event.msg.startsWith("fchmod to 0600"),
				);
				expect(warnings.map((event) => event.level)).toEqual(["WARN"]);
				expect(warnings[0]?.msg).toBe(fchmodWarning(path, "0400"));
				// The save still went ahead, which is the documented choice.
				expect(JSON.parse(readFileSync(path, "utf8")).lb_strategy).toBe(
					"session",
				);
				expect(statSync(path).mode & 0o777).toBe(0o400);
			});
		});

		/** The seam refuses outside a test run, the same as __setChmodForTest. */
		it("refuses to swap the fchmod when NODE_ENV is not test", () => {
			const previous = process.env.NODE_ENV;
			process.env.NODE_ENV = "production";
			try {
				expect(() => __setFchmodForTest(() => {})).toThrow(
					"__setFchmodForTest is available only while NODE_ENV=test",
				);
			} finally {
				process.env.NODE_ENV = previous;
				__setFchmodForTest(null);
			}
		});
	},
);
