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
import { Config } from "./index";

/**
 * A chmod that reports success and changes nothing.
 *
 * `chmodSync` returns cleanly on filesystems that have no Unix modes to set:
 * Docker Desktop bind mounts from a macOS or Windows host, and FAT or exFAT
 * volumes. Catching a chmod that throws never saw those, so the guard came out
 * true on every load while the file stayed at whatever mode the filesystem
 * gives it, and nothing said so. The file holds pg_password,
 * local_control_secret and a GitHub PAT (SB23-1686).
 *
 * The condition is exercised for real rather than mocked. macOS can create and
 * attach an MS-DOS disk image without root, so these tests build one and put
 * the config on it. Measured by hand first, 2026-09-18: a file on such a volume
 * read 0700, `chmod 600` exited 0, and the file still read 0700.
 *
 * Linux CI cannot mount anything without root, so these skip there and say so.
 * That is disclosed rather than hidden: on Linux the detection is covered by
 * nothing, and the alternative was mocking node:fs, which would prove that a
 * stub was called rather than that a real no-op is caught.
 */
const canMountFat = process.platform === "darwin";

/**
 * Building and attaching a disk image takes seconds, not milliseconds, and
 * bun's default per-test timeout is 5000ms. An abort partway through leaves the
 * volume attached after the test process exits, because the teardown in the
 * finally below never runs, so the bound is generous rather than tight.
 */
const FAT_TEST_TIMEOUT_MS = 60_000;

function run(command: string, args: string[]): void {
	// `timeout` rather than Bun.spawnSync's own option: a synchronous spawn runs
	// no event loop, so that option cannot fire (#102).
	const result = Bun.spawnSync(
		["timeout", "-k", "10", "120", command, ...args],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	if (result.exitCode !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} exited ${result.exitCode}: ${result.stderr.toString()}`,
		);
	}
}

/**
 * Build a FAT volume and hand its mountpoint to `fn`.
 *
 * The fixture directory comes from mkdtempSync and is asserted to be neither
 * empty nor inside a checkout before anything runs in it, because a fixture
 * path that resolved wrong is how a sub-agent once truncated a live README.
 */
function withFatVolume(fn: (mountpoint: string) => void): void {
	const fixture = mkdtempSync(join(tmpdir(), "better-ccflare-fat-"));
	expect(fixture.length).toBeGreaterThan(0);
	expect(fixture.startsWith(tmpdir())).toBe(true);
	expect(fixture.includes("better-ccflare-worktrees")).toBe(false);

	const image = join(fixture, "fat.dmg");
	const mountpoint = join(fixture, "mnt");
	let attached = false;
	try {
		run("hdiutil", [
			"create",
			"-size",
			"8m",
			"-fs",
			"MS-DOS",
			"-volname",
			"CCFTEST",
			"-quiet",
			image,
		]);
		run("hdiutil", [
			"attach",
			image,
			"-mountpoint",
			mountpoint,
			"-nobrowse",
			"-quiet",
		]);
		attached = true;
		fn(mountpoint);
	} finally {
		if (attached) {
			// force, because a failed assertion can leave the volume busy, and a
			// leaked attachment outlives the test run.
			try {
				run("hdiutil", ["detach", mountpoint, "-force", "-quiet"]);
			} catch {
				// Nothing further to do; the image is removed below either way.
			}
		}
		rmSync(fixture, { recursive: true, force: true });
	}
}

function captureWarnings(fn: () => void): string[] {
	const captured: string[] = [];
	const handler = (event: LogEvent) => {
		if (event.level === "WARN") captured.push(event.msg);
	};
	logBus.on("log", handler);
	try {
		fn();
	} finally {
		logBus.off("log", handler);
	}
	return captured;
}

describe("a config chmod that succeeds and does nothing", () => {
	it.skipIf(!canMountFat)(
		"reports the mode it read back rather than claiming success",
		() => {
			withFatVolume((mountpoint) => {
				const configPath = join(mountpoint, "config.json");
				writeFileSync(configPath, JSON.stringify({ lb_strategy: "session" }));

				// The fixture must start at the wrong mode or the assertion below
				// passes against reverted source. A FAT volume gives its own mode and
				// ignores chmod, so this asserts what the volume chose rather than
				// setting it.
				const before = statSync(configPath).mode & 0o777;
				expect(before).not.toBe(0o600);

				const warnings = captureWarnings(() => {
					new Config(configPath);
				});

				// The chmod is still attempted and still does not throw.
				expect(statSync(configPath).mode & 0o777).toBe(before);
				const unenforceable = warnings.filter((msg) =>
					msg.includes("reported success but the mode is still"),
				);
				expect(unenforceable).toHaveLength(1);
				expect(unenforceable[0]).toContain(configPath);
				expect(unenforceable[0]).toContain("0600");
			});
		},
		FAT_TEST_TIMEOUT_MS,
	);

	it.skipIf(!canMountFat)(
		"warns once per process, not once per load",
		() => {
			withFatVolume((mountpoint) => {
				const configPath = join(mountpoint, "config.json");
				writeFileSync(configPath, JSON.stringify({ lb_strategy: "session" }));

				const warnings = captureWarnings(() => {
					new Config(configPath);
					new Config(configPath);
					new Config(configPath);
				});

				// restrictConfigFile() runs once per Config construction and the
				// condition is a property of the filesystem, so a per-load warning
				// would repeat forever on a machine that can never satisfy it.
				expect(
					warnings.filter((msg) =>
						msg.includes("reported success but the mode is still"),
					),
				).toHaveLength(1);
			});
		},
		FAT_TEST_TIMEOUT_MS,
	);

	// Deliberately not skipped on Linux: it needs no disk image, and it is the
	// one case here that CI does run, so a helper that warned unconditionally
	// still fails somewhere.
	it("says nothing when the chmod does take", () => {
		// The same code path on a filesystem that enforces modes. Without this,
		// a helper that warned unconditionally would pass every test above.
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-apfs-"));
		try {
			const configPath = join(dir, "config.json");
			writeFileSync(configPath, JSON.stringify({ lb_strategy: "session" }));
			// Explicit chmod, not writeFileSync's mode option: that option is
			// masked by the umask, and under umask 077 the file would be born
			// 0600 and the assertion below would pass against reverted source.
			chmodSync(configPath, 0o644);
			expect(statSync(configPath).mode & 0o777).toBe(0o644);

			const warnings = captureWarnings(() => {
				new Config(configPath);
			});

			expect(statSync(configPath).mode & 0o777).toBe(0o600);
			expect(
				warnings.filter((msg) =>
					msg.includes("reported success but the mode is still"),
				),
			).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
