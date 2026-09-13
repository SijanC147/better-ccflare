import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

/**
 * The configuration directory holds better-ccflare.db, its WAL and every
 * .backup.*, and the accounts table in that database stores api_key,
 * refresh_token and access_token as plaintext TEXT. At 0755 any local user can
 * traverse in and read all of them, which is a larger exposure than the 0644
 * config file PR #57 fixed. The directory must be 0700.
 */
function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

/**
 * Every test fixes the umask.
 *
 * Without this the tests pass for the wrong reason under a strict umask: with
 * umask 077 a plain mkdirSync already yields 0700, so removing `mode: 0o700`
 * from the source would leave these green. Pinning 022 means a directory only
 * reaches 0700 because the code asked for it. This is the exact mutation that
 * survived on PR #57.
 */
let savedUmask: number;

beforeEach(() => {
	savedUmask = process.umask(0o022);
});

afterEach(() => {
	process.umask(savedUmask);
});

/**
 * Point getPlatformConfigDir() at a temp tree. It reads XDG_CONFIG_HOME at call
 * time on macOS and Linux (paths-common.ts:18), so the default-location branch
 * is reachable without touching the real ~/.config/better-ccflare.
 */
function withXdgHome<T>(fn: (platformDir: string) => T): T {
	const base = mkdtempSync(join(tmpdir(), "better-ccflare-xdg-"));
	const saved = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = base;
	try {
		return fn(join(base, "better-ccflare"));
	} finally {
		if (saved === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = saved;
		}
		rmSync(base, { recursive: true, force: true });
	}
}

describe("config directory permissions", () => {
	it("creates the directory 0700 under a 022 umask", () => {
		withXdgHome((platformDir) => {
			const configPath = join(platformDir, "better-ccflare.json");
			// The directory does not exist yet, so this exercises the mkdirSync
			// mode option rather than the chmod.
			new Config(configPath);
			expect(mode(platformDir)).toBe(0o700);
		});
	});

	it("tightens a pre-existing 0755 directory to 0700 on load", () => {
		withXdgHome((platformDir) => {
			// chmod rather than mkdirSync's mode option: that option is masked by
			// the umask, so the fixture itself would not reliably be 0755.
			mkdirSync(platformDir, { recursive: true });
			chmodSync(platformDir, 0o755);
			expect(mode(platformDir)).toBe(0o755);

			const configPath = join(platformDir, "better-ccflare.json");
			// A fresh install creating its config inside a directory that already
			// exists: mkdirSync leaves the mode alone, so only the chmod can fix it.
			new Config(configPath);
			expect(mode(platformDir)).toBe(0o700);
		});
	});

	it("tightens the directory when the config file already exists", () => {
		withXdgHome((platformDir) => {
			mkdirSync(platformDir, { recursive: true });
			const configPath = join(platformDir, "better-ccflare.json");
			new Config(configPath);
			chmodSync(platformDir, 0o755);

			// An upgrade from a version that created the directory 0755. The
			// existing-file branch of loadConfig() has to correct it too, because
			// that install may never create the directory again.
			new Config(configPath);
			expect(mode(platformDir)).toBe(0o700);
		});
	});

	it("leaves a directory that is not the default location alone", () => {
		// The guard that keeps this change from being worse than the exposure it
		// fixes. With BETTER_CCFLARE_CONFIG_PATH=/etc/better-ccflare.json the
		// dirname is /etc, and 0700 there locks every other user out of the
		// machine. Only the application's own directory is touched.
		withXdgHome(() => {
			const custom = mkdtempSync(join(tmpdir(), "better-ccflare-custom-"));
			try {
				chmodSync(custom, 0o755);
				new Config(join(custom, "config.json"));
				expect(mode(custom)).toBe(0o755);
			} finally {
				rmSync(custom, { recursive: true, force: true });
			}
		});
	});
});
