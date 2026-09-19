import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";
import { resolveConfigPath } from "./paths";
import { getPlatformConfigDir } from "./paths-common";

/**
 * Mutation-testing this file is not safe from inside it, and the reason is
 * worth writing down. Proving the guard is load bearing means removing it and
 * watching these cases fail, but an unguarded run of the throw cases
 * constructs a real Config, whose constructor creates the config directory and
 * writes to it. The guard only fires when XDG_CONFIG_HOME is unset, so the
 * resolved path is necessarily derived from os.homedir().
 *
 * Setting process.env.HOME here does not move it. Measured 2026-09-18 on Bun
 * 1.4.2: `HOME=/tmp/probe bun -e '...homedir()'` prints /tmp/probe, so the
 * spawned process honours it, but assigning process.env.HOME after start
 * leaves homedir() on the operator's real home. An earlier draft of this file
 * pinned HOME in beforeEach and would have written to
 * ~/.config/better-ccflare under mutation, which is the incident this guard
 * exists to prevent.
 *
 * So run the mutation with HOME set on the command line:
 *   HOME=$(mktemp -d) bun test packages/config/src/config-path-refuses-default.test.ts
 */
const REDIRECT_ENV_VARS = [
	"BETTER_CCFLARE_CONFIG_PATH",
	"ccflare_CONFIG_PATH",
	"XDG_CONFIG_HOME",
] as const;

const SAVED_ENV_VARS = ["NODE_ENV", ...REDIRECT_ENV_VARS] as const;

describe("resolveConfigPath refuses the home-directory fall-through under test", () => {
	let saved: Record<string, string | undefined>;
	let home: string;

	beforeEach(() => {
		saved = {};
		for (const name of SAVED_ENV_VARS) saved[name] = process.env[name];
		home = mkdtempSync(join(tmpdir(), "better-ccflare-config-path-"));
		for (const name of REDIRECT_ENV_VARS) delete process.env[name];
	});

	afterEach(() => {
		for (const name of SAVED_ENV_VARS) {
			const value = saved[name];
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(home, { recursive: true, force: true });
	});

	test("throws when NODE_ENV is test and nothing redirects the path", () => {
		process.env.NODE_ENV = "test";
		expect(() => resolveConfigPath()).toThrow(
			/Refusing to resolve the config path/,
		);
	});

	/**
	 * The mutation that matters. The guard's whole value is that it fires during
	 * an ordinary `bun test` run without anyone opting in, so this case reads
	 * NODE_ENV rather than setting it. Remove the guard from paths.ts and this
	 * fails; a case that set NODE_ENV itself would still pass, and would prove
	 * only that the guard works when armed by hand.
	 */
	test("fires under the suite's own environment, unarmed", () => {
		expect(process.env.NODE_ENV).toBe("test");
		expect(() => resolveConfigPath()).toThrow(
			/Refusing to resolve the config path/,
		);
	});

	/**
	 * The constructor is the seam the incident went through, so pin it as well
	 * as the resolver. A no-argument Config under test must not reach the
	 * filesystem at all.
	 */
	test("a no-argument Config constructor throws rather than touching the real file", () => {
		process.env.NODE_ENV = "test";
		expect(() => new Config()).toThrow(/Refusing to resolve the config path/);
	});

	test("the error names the path it refused and every way to redirect", () => {
		process.env.NODE_ENV = "test";
		let message = "";
		try {
			resolveConfigPath();
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain(getPlatformConfigDir());
		for (const name of REDIRECT_ENV_VARS) expect(message).toContain(name);
	});

	// Negative: production runs resolve exactly as they did before.
	test("resolves the platform path unchanged when NODE_ENV is not test", () => {
		delete process.env.NODE_ENV;
		expect(resolveConfigPath()).toBe(
			join(getPlatformConfigDir(), "better-ccflare.json"),
		);
	});

	test("resolves the platform path unchanged when NODE_ENV is production", () => {
		process.env.NODE_ENV = "production";
		expect(resolveConfigPath()).toBe(
			join(getPlatformConfigDir(), "better-ccflare.json"),
		);
	});

	// Negative: each redirect on its own is enough, under test.
	for (const name of REDIRECT_ENV_VARS) {
		test(`${name} alone allows a no-argument Config under test`, () => {
			process.env.NODE_ENV = "test";
			const dir = mkdtempSync(join(tmpdir(), "better-ccflare-redirect-"));
			process.env[name] =
				name === "XDG_CONFIG_HOME" ? dir : join(dir, "better-ccflare.json");
			try {
				expect(() => new Config()).not.toThrow();
			} finally {
				delete process.env[name];
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	/**
	 * BETTER_CCFLARE_CONFIG_PATH is read before the guard, so an explicit path
	 * still wins whatever NODE_ENV says. Pinned because moving the guard above
	 * that branch would break every test that redirects by path.
	 */
	test("an explicit config path env var still wins under test", () => {
		process.env.NODE_ENV = "test";
		const path = join(home, "explicit.json");
		process.env.BETTER_CCFLARE_CONFIG_PATH = path;
		expect(resolveConfigPath()).toBe(path);
	});
});
