import { describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	fchmodSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logBus } from "@better-ccflare/logger";
import { stickyFixture } from "@better-ccflare/security/testing";
import type { LogEvent } from "@better-ccflare/types";
import { __setFchmodForTest } from "./chmod-seam";
import { __setEntryLstatForTest, lstatEntryForTrust } from "./entry-lstat-seam";
import { Config } from "./index";

/**
 * SB23-3809. A server publishes its local_control_secret to
 * `<config>.local-control`, and the CLI's getLocalControlSecret() reads that
 * file first, so a CLI learns the server's secret even while the config's saves
 * are refused.
 *
 * Secrets are compared as booleans throughout, never with toBe(a, b) on two
 * secret values, because a failing toBe prints both operands and a real
 * generated secret has no business in test output. The fixture values written
 * by hand are labels, not secrets, and are still compared the same way.
 *
 * Cross-process proof, which no test in this file can give because the
 * in-process memo answers for a second Config: see
 * packages/http-api/src/services/__tests__/local-control-sidecar-two-process.test.ts.
 *
 * Every fixture lives under mkdtemp and every Config names its path.
 */

const TRAILING_COMMA = `{"lb_strategy":"session","pg_password":"operator-value",}`;
const CONFIG_VALUE = "CONFIG-FIXTURE-VALUE";
const SIDECAR_VALUE = "SIDECAR-FIXTURE-VALUE";
const PLANTED_VALUE = "PLANTED-FIXTURE-VALUE";
/** Where the server publishing in these tests says it listens (SB23-4035). */
const LISTENER = { host: "127.0.0.1", port: 8999, pid: process.pid };

function withFixture(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-sidecar-"));
	expect(dir.length).toBeGreaterThan(0);
	expect(dir.startsWith(tmpdir())).toBe(true);
	expect(dir.includes("better-ccflare-worktrees")).toBe(false);
	try {
		fn(dir);
	} finally {
		chmodSync(dir, 0o700);
		rmSync(dir, { recursive: true, force: true });
	}
}

function seed(path: string, bytes: string, mode = 0o600): string {
	writeFileSync(path, bytes, { mode });
	chmodSync(path, mode);
	return path;
}

function sidecarBytes(value: string): string {
	return `${JSON.stringify({ local_control_secret: value })}\n`;
}

function readSidecar(path: string): unknown {
	return (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
		.local_control_secret;
}

function captureLogs<T>(fn: () => T): { result: T; logs: LogEvent[] } {
	const logs: LogEvent[] = [];
	const handler = (event: LogEvent) => logs.push(event);
	logBus.on("log", handler);
	try {
		return { result: fn(), logs };
	} finally {
		logBus.off("log", handler);
	}
}

/** The exact warning a refused sidecar produces. Asserted whole. */
function ignoredMessage(path: string, reason: string): string {
	return `Ignoring the local control secret file ${path}: ${reason}. Falling back to the secret in the config file, so a notification to the server fails to authenticate while API keys are active and that file's saves are refused. The server replaces this file with one it can trust the next time it starts, wherever its directory is not writable by other local users.`;
}

const NOT_WRITTEN_CONSEQUENCE =
	"Where the config file can be saved, the CLI reads the secret from there instead; where it cannot, CLI notifications such as --reauthenticate and --force-reset-rate-limit fail to authenticate against this server while API keys are active.";

function notWrittenMessage(path: string): string {
	return `Did not write the local control secret file ${path}: its directory could not be examined, belongs to another user, or is writable by other local users, so another local user could read or replace it. ${NOT_WRITTEN_CONSEQUENCE} Move the config to a directory only this user can write.`;
}

function notWrittenStickyMessage(path: string): string {
	return `Did not write the local control secret file ${path}: it would sit in a sticky directory, where it is trusted only once a single-named file of yours already exists at that name, and this server never creates one there. ${NOT_WRITTEN_CONSEQUENCE} Create it yourself at mode 0600, or move the config to a directory only this user can write.`;
}

function couldNotWriteMessage(path: string): string {
	return `Could not write the local control secret file ${path}, reported just above. The CLI falls back to the config file for the secret.`;
}

/** Leftover temp files from a sidecar save, which hold the secret. */
function sidecarTemps(dir: string): string[] {
	return readdirSync(dir).filter((name) =>
		name.includes(".local-control.tmp-"),
	);
}

function sidecarWarnings(logs: LogEvent[]): string[] {
	return logs
		.map((event) => event.msg)
		.filter(
			(msg) =>
				msg.startsWith("Ignoring the local control secret file") ||
				msg.startsWith("Did not write the local control secret file"),
		);
}

describe("SB23-3809: the server publishes its local_control_secret", () => {
	it("writes a 0600 sidecar holding the secret it returns, on a config whose saves are refused", () => {
		withFixture((dir) => {
			const path = seed(join(dir, "better-ccflare.json"), TRAILING_COMMA);
			const config = new Config(path);

			const held = config.publishLocalControlSecret(LISTENER);
			const sidecar = config.getLocalControlSidecarPath();

			expect(sidecar).toBe(`${path}.local-control`);
			expect(statSync(sidecar).mode & 0o777).toBe(0o600);
			expect(statSync(sidecar).nlink).toBe(1);
			expect(readSidecar(sidecar) === held).toBe(true);
			// The refusal still holds for the config itself.
			expect(readFileSync(path, "utf8")).toBe(TRAILING_COMMA);
		});
	});

	it("publishes the config's secret, never the sidecar's, so editing the config rotates it", () => {
		withFixture((dir) => {
			const path = seed(
				join(dir, "better-ccflare.json"),
				JSON.stringify({ local_control_secret: CONFIG_VALUE }),
			);
			const sidecar = seed(
				`${path}.local-control`,
				sidecarBytes(SIDECAR_VALUE),
			);

			const held = new Config(path).publishLocalControlSecret(LISTENER);

			expect(held === CONFIG_VALUE).toBe(true);
			expect(readSidecar(sidecar) === CONFIG_VALUE).toBe(true);
		});
	});

	it("does not rewrite a sidecar that already holds the value", () => {
		withFixture((dir) => {
			const path = seed(
				join(dir, "better-ccflare.json"),
				JSON.stringify({ local_control_secret: CONFIG_VALUE }),
			);
			const config = new Config(path);
			config.publishLocalControlSecret(LISTENER);
			const before = statSync(config.getLocalControlSidecarPath()).ino;

			new Config(path).publishLocalControlSecret(LISTENER);

			expect(statSync(config.getLocalControlSidecarPath()).ino).toBe(before);
		});
	});

	/**
	 * The secret published for a config whose values were not believed is the one
	 * this process minted, never the file's. Two of the three refusals, each
	 * carrying a planted local_control_secret: a config other users could write
	 * (stripped), and a hardlinked config, which is an untrusted PATH in a
	 * directory only we can write and so still gets a sidecar by design.
	 *
	 * A config owned by another uid takes the same branch as the hardlink,
	 * trustedRegularPath() refusing it before any read. It needs root to
	 * manufacture and is not exercised here.
	 */
	it("publishes a minted secret, not the planted one, for a stripped config", () => {
		withFixture((dir) => {
			const path = seed(
				join(dir, "better-ccflare.json"),
				JSON.stringify({
					lb_strategy: "session",
					local_control_secret: PLANTED_VALUE,
				}),
				0o666,
			);

			const held = new Config(path).publishLocalControlSecret(LISTENER);
			const published = readSidecar(`${path}.local-control`);

			expect(held === PLANTED_VALUE).toBe(false);
			expect(published === PLANTED_VALUE).toBe(false);
			expect(published === held).toBe(true);
		});
	});

	it("publishes a minted secret, not the planted one, for a hardlinked config in a trusted directory", () => {
		withFixture((dir) => {
			const original = seed(
				join(dir, "elsewhere.json"),
				JSON.stringify({ local_control_secret: PLANTED_VALUE }),
			);
			const path = join(dir, "better-ccflare.json");
			linkSync(original, path);
			expect(statSync(path).nlink).toBe(2);

			const held = new Config(path).publishLocalControlSecret(LISTENER);
			const published = readSidecar(`${path}.local-control`);

			expect(held === PLANTED_VALUE).toBe(false);
			expect(published === PLANTED_VALUE).toBe(false);
			expect(published === held).toBe(true);
		});
	});

	it("replaces a planted symlink at the sidecar name without writing through it", () => {
		withFixture((dir) => {
			const path = seed(
				join(dir, "better-ccflare.json"),
				JSON.stringify({ local_control_secret: CONFIG_VALUE }),
			);
			const victim = seed(join(dir, "victim.txt"), "untouched");
			symlinkSync(victim, `${path}.local-control`);

			new Config(path).publishLocalControlSecret(LISTENER);

			expect(readFileSync(victim, "utf8")).toBe("untouched");
			const info = statSync(`${path}.local-control`);
			expect(info.isFile()).toBe(true);
			expect(info.mode & 0o777).toBe(0o600);
			expect(readSidecar(`${path}.local-control`) === CONFIG_VALUE).toBe(true);
		});
	});
});

describe("SB23-3809: an untrusted config directory writes no sidecar", () => {
	it("writes none in a directory other local users can write", () => {
		withFixture((root) => {
			const dir = join(root, "shared");
			mkdirSync(dir);
			chmodSync(dir, 0o770);
			const path = seed(join(dir, "better-ccflare.json"), TRAILING_COMMA);
			const config = new Config(path);

			const { logs } = captureLogs(() =>
				config.publishLocalControlSecret(LISTENER),
			);

			expect(existsSync(`${path}.local-control`)).toBe(false);
			expect(sidecarWarnings(logs)).toEqual([
				notWrittenMessage(`${path}.local-control`),
			]);
		});
	});

	it("writes none in a sticky directory where no sidecar of ours exists yet", () => {
		const fx = stickyFixture("sidecar-sticky");
		try {
			const path = fx.entry("better-ccflare.json");
			seed(path, TRAILING_COMMA);
			const config = new Config(path);

			const { logs } = captureLogs(() =>
				config.publishLocalControlSecret(LISTENER),
			);

			expect(existsSync(`${path}.local-control`)).toBe(false);
			expect(sidecarWarnings(logs)).toEqual([
				notWrittenStickyMessage(`${path}.local-control`),
			]);
		} finally {
			fx.cleanup();
		}
	});

	/**
	 * A sidecar written while the directory was trusted must not survive a start
	 * that refuses the directory, or it outranks a correct config, silently, as
	 * soon as the directory is trusted again. Found by PR #309's review (L1).
	 */
	it("removes a stale sidecar when the directory is refused, so it cannot outrank the config later", () => {
		withFixture((root) => {
			const dir = join(root, "conf");
			mkdirSync(dir, { mode: 0o700 });
			const path = seed(
				join(dir, "better-ccflare.json"),
				JSON.stringify({ local_control_secret: CONFIG_VALUE }),
			);
			const sidecar = seed(
				`${path}.local-control`,
				sidecarBytes(SIDECAR_VALUE),
			);
			chmodSync(dir, 0o770);

			const { logs } = captureLogs(() =>
				new Config(path).publishLocalControlSecret(LISTENER),
			);

			expect(existsSync(sidecar)).toBe(false);
			expect(sidecarWarnings(logs)).toEqual([notWrittenMessage(sidecar)]);
			chmodSync(dir, 0o700);
			expect(new Config(path).getLocalControlSecret() === CONFIG_VALUE).toBe(
				true,
			);
		});
	});
});

describe("SB23-3809: a sidecar write that cannot be made safe publishes nothing", () => {
	/**
	 * A filesystem without Unix modes, simulated through the fchmod seam: the
	 * new file keeps a mode other users can read. Publishing it would expose a
	 * secret no reader would believe, so it is refused, no temp file survives,
	 * and the stale sidecar is removed. Found by PR #309's review (L2).
	 */
	it("refuses to publish when 0600 did not take, and removes the stale one", () => {
		withFixture((dir) => {
			const path = seed(join(dir, "better-ccflare.json"), TRAILING_COMMA);
			const sidecar = seed(
				`${path}.local-control`,
				sidecarBytes(SIDECAR_VALUE),
			);
			__setFchmodForTest((fd) => fchmodSync(fd, 0o644));
			try {
				const { logs } = captureLogs(() =>
					new Config(path).publishLocalControlSecret(LISTENER),
				);

				expect(existsSync(sidecar)).toBe(false);
				expect(sidecarTemps(dir)).toEqual([]);
				expect(
					logs.some((event) =>
						event.msg.startsWith("Published the local control"),
					),
				).toBe(false);
				expect(
					logs.some(
						(event) =>
							event.msg ===
							`Could not replace the local control secret file atomically: Error: the new file reads 0644 after fchmod to 0600, so it was not published`,
					),
				).toBe(true);
				expect(sidecarWarnings(logs)).toEqual([]);
				expect(logs.map((event) => event.msg)).toContain(
					couldNotWriteMessage(sidecar),
				);
			} finally {
				__setFchmodForTest(null);
			}
		});
	});

	it("removes a stale sidecar when the write itself fails", () => {
		withFixture((dir) => {
			const path = seed(join(dir, "better-ccflare.json"), TRAILING_COMMA);
			const sidecar = seed(
				`${path}.local-control`,
				sidecarBytes(SIDECAR_VALUE),
			);
			__setFchmodForTest(() => {
				throw new Error("simulated fchmod failure");
			});
			try {
				const { logs } = captureLogs(() =>
					new Config(path).publishLocalControlSecret(LISTENER),
				);

				expect(existsSync(sidecar)).toBe(false);
				expect(sidecarTemps(dir)).toEqual([]);
				expect(logs.map((event) => event.msg)).toContain(
					couldNotWriteMessage(sidecar),
				);
			} finally {
				__setFchmodForTest(null);
			}
		});
	});
});

describe("SB23-3809: the CLI reads the sidecar first", () => {
	it("prefers the sidecar over the config's own secret", () => {
		withFixture((dir) => {
			const path = seed(
				join(dir, "better-ccflare.json"),
				JSON.stringify({ local_control_secret: CONFIG_VALUE }),
			);
			seed(`${path}.local-control`, sidecarBytes(SIDECAR_VALUE));

			const secret = new Config(path).getLocalControlSecret();

			expect(secret === SIDECAR_VALUE).toBe(true);
		});
	});

	/**
	 * The ordering that matters most. The server strips a writable config's
	 * secret and brings the file to 0600, so a CLI starting afterwards reads a
	 * clean-looking file holding the planted value. Read last, the sidecar would
	 * lose to it.
	 */
	it("prefers the sidecar over a planted secret the server stripped", () => {
		withFixture((dir) => {
			const path = seed(
				join(dir, "better-ccflare.json"),
				JSON.stringify({ local_control_secret: PLANTED_VALUE }),
				0o666,
			);
			const held = new Config(path).publishLocalControlSecret(LISTENER);
			// What a CLI process finds on disk afterwards: the plant, at 0600.
			chmodSync(path, 0o600);
			const cliPath = join(dir, "cli-view.json");
			seed(cliPath, readFileSync(path, "utf8"));
			seed(
				`${cliPath}.local-control`,
				readFileSync(`${path}.local-control`, "utf8"),
			);

			const secret = new Config(cliPath).getLocalControlSecret();

			expect(secret === PLANTED_VALUE).toBe(false);
			expect(secret === held).toBe(true);
		});
	});

	it("is silent when no sidecar exists", () => {
		withFixture((dir) => {
			const path = seed(
				join(dir, "better-ccflare.json"),
				JSON.stringify({ local_control_secret: CONFIG_VALUE }),
			);

			const { result, logs } = captureLogs(() =>
				new Config(path).getLocalControlSecret(),
			);

			expect(result === CONFIG_VALUE).toBe(true);
			expect(sidecarWarnings(logs)).toEqual([]);
		});
	});
});

/**
 * A sidecar that fails any check is not believed. Each case plants one beside a
 * valid config holding CONFIG_VALUE, so falling back is observable: the CLI must
 * return the config's value, never the sidecar's, and say why exactly once
 * across two Configs.
 */
describe("SB23-3809: a sidecar that fails a check is refused", () => {
	function expectRefused(
		plant: (sidecar: string, dir: string) => void,
		reason: string,
	): void {
		withFixture((dir) => {
			const path = seed(
				join(dir, "better-ccflare.json"),
				JSON.stringify({ local_control_secret: CONFIG_VALUE }),
			);
			const sidecar = `${path}.local-control`;
			plant(sidecar, dir);

			const { result, logs } = captureLogs(() => [
				new Config(path).getLocalControlSecret(),
				new Config(path).getLocalControlSecret(),
			]);

			expect(result.every((secret) => secret === CONFIG_VALUE)).toBe(true);
			expect(sidecarWarnings(logs)).toEqual([ignoredMessage(sidecar, reason)]);
		});
	}

	it("refuses a symlink", () => {
		expectRefused((sidecar, dir) => {
			const real = seed(join(dir, "real-sidecar"), sidecarBytes(SIDECAR_VALUE));
			symlinkSync(real, sidecar);
		}, "it is a symlink, and a link is never followed to a secret");
	});

	it("refuses a hardlink", () => {
		expectRefused((sidecar, dir) => {
			const real = seed(join(dir, "real-sidecar"), sidecarBytes(SIDECAR_VALUE));
			linkSync(real, sidecar);
		}, "it has 2 hard links, so owning its name does not prove this user wrote it");
	});

	it("refuses one owned by another uid", () => {
		const uid = process.getuid?.() ?? 0;
		try {
			expectRefused(
				(sidecar) => {
					seed(sidecar, sidecarBytes(SIDECAR_VALUE));
					__setEntryLstatForTest((p) =>
						p === sidecar ? { uid: uid + 1, nlink: 1 } : lstatEntryForTrust(p),
					);
				},
				`it is owned by uid ${uid + 1}, not by this process's uid ${uid}`,
			);
		} finally {
			__setEntryLstatForTest(null);
		}
	});

	it("refuses one other local users can read", () => {
		expectRefused(
			(sidecar) => seed(sidecar, sidecarBytes(SIDECAR_VALUE), 0o644),
			"it is mode 0644, so other local users can read or write it; this file must be 0600. A filesystem that does not enforce Unix modes, such as a Docker bind mount from a macOS or Windows host or a FAT or exFAT volume, reads this way on every start",
		);
	});

	it("refuses a FIFO without blocking", () => {
		expectRefused((sidecar) => {
			const made = Bun.spawnSync(["mkfifo", "-m", "600", sidecar]);
			expect(made.exitCode).toBe(0);
		}, "it is not a regular file");
	});

	it("refuses bytes that are not JSON, naming no token", () => {
		expectRefused(
			(sidecar) => seed(sidecar, `{"local_control_secret": ${SIDECAR_VALUE}}`),
			"it is not valid JSON (SyntaxError)",
		);
	});

	it("refuses JSON with no secret in it", () => {
		expectRefused(
			(sidecar) => seed(sidecar, `{"something_else":"x"}`),
			"it holds no local_control_secret string",
		);
	});

	it("refuses one larger than any this code writes", () => {
		const bytes = sidecarBytes("x".repeat(5000));
		expectRefused(
			(sidecar) => seed(sidecar, bytes),
			`it is ${Buffer.byteLength(bytes)} bytes, larger than any this code writes`,
		);
	});

	it("refuses one in a directory other local users can write", () => {
		expectRefused((sidecar, dir) => {
			seed(sidecar, sidecarBytes(SIDECAR_VALUE));
			chmodSync(dir, 0o770);
		}, "its directory could not be examined, belongs to another user, or is writable by other local users without the sticky bit, so anyone could have written it");
	});
});
