import { describe, expect, it } from "bun:test";
import {
	chmodSync,
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
import { Config } from "./index";

/**
 * Credential and endpoint fields are not adopted from a config other local users
 * can write (SB23-2351).
 *
 * SB23-2338 decided to warn and load the whole config, because refusing is a
 * permanent outage where chmod is a no-op. This keeps the loading and removes the
 * part that is not a setting: an attacker who can write the file still changes
 * behaviour, but no longer supplies authentication material or an outbound
 * destination.
 *
 * The rule is a denylist of two families plus named fields, and a suffix rule for
 * anything ending in token, secret or password. The suffix rule is the half that
 * answers the acceptance criterion's reason: ConfigData carries an index signature,
 * so a credential field added later would otherwise be adopted by default.
 */

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
 * A config with one ordinary setting and three things that must not be adopted.
 *
 * Explicit chmod, never writeFileSync's mode option: under umask 022 a requested
 * 0o666 lands 0644, which has no group or other WRITE bit, so the condition under
 * test would not hold and every assertion would pass against reverted source.
 */
function writableConfig(label: string, mode: number): string {
	const dir = mkdtempSync(join(tmpdir(), `better-ccflare-${label}-`));
	const configPath = join(dir, "config.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			lb_strategy: "session",
			pg_password: "ATTACKER-DB-PASSWORD",
			local_control_secret: "ATTACKER-CHOSEN",
			// Named by nothing. Only the suffix rule catches it, which is what makes
			// it the index-signature case the acceptance criterion was worried about.
			foo_token: "ATTACKER-FUTURE-FIELD",
		}),
	);
	chmodSync(configPath, mode);
	return configPath;
}

describe("a config other local users can write", () => {
	it("loads settings but not credentials or endpoints", () => {
		const configPath = writableConfig("cred", 0o666);
		try {
			expect(statSync(configPath).mode & 0o022).not.toBe(0);

			const config = new Config(configPath);

			// The setting is kept. Refusing the whole file was rejected by SB23-2338.
			expect(config.get("lb_strategy")).toBe("session");
			// The three that are not settings are gone.
			expect(config.get("pg_password")).toBeUndefined();
			expect(config.get("local_control_secret")).toBeUndefined();
			expect(config.get("foo_token")).toBeUndefined();
		} finally {
			rmSync(join(configPath, ".."), { recursive: true, force: true });
		}
	});

	it("catches a field no list names, by its suffix alone", () => {
		// Kills the suffix rule independently of the named list. Without a separate
		// case, deleting the suffix rule survives, because pg_password and
		// local_control_secret are both named explicitly.
		const configPath = writableConfig("suffix", 0o666);
		try {
			const config = new Config(configPath);
			expect(config.get("foo_token")).toBeUndefined();
			// And the named list is still doing its own job: outbound_proxy matches no
			// suffix and no prefix.
			const dir = mkdtempSync(join(tmpdir(), "better-ccflare-named-"));
			const p2 = join(dir, "config.json");
			writeFileSync(
				p2,
				JSON.stringify({
					lb_strategy: "session",
					outbound_proxy: "http://evil",
				}),
			);
			chmodSync(p2, 0o666);
			const c2 = new Config(p2);
			expect(c2.get("lb_strategy")).toBe("session");
			expect(c2.get("outbound_proxy")).toBeUndefined();
			rmSync(dir, { recursive: true, force: true });
		} finally {
			rmSync(join(configPath, ".."), { recursive: true, force: true });
		}
	});

	it("names the fields it ignored, once", () => {
		// The process otherwise behaves as though the operator never set them, which
		// is indistinguishable from a config that does not contain them.
		const configPath = writableConfig("named", 0o666);
		try {
			const logs = captureLogs(() => {
				new Config(configPath);
			});
			const reports = logs.filter(
				(event) =>
					event.level === "ERROR" &&
					event.msg.includes("credential or endpoint field"),
			);
			expect(reports).toHaveLength(1);
			expect(reports[0].msg).toContain("foo_token");
			expect(reports[0].msg).toContain("local_control_secret");
			expect(reports[0].msg).toContain("pg_password");
			// And it says the settings survived, so the operator does not read this as
			// the config having been refused.
			expect(reports[0].msg).toContain("still applied");
		} finally {
			rmSync(join(configPath, ".."), { recursive: true, force: true });
		}
	});

	it("does NOT strip anything from a config only we can write", () => {
		// The negative case. Without it a mutation that filters unconditionally
		// passes, and every install would silently lose its database password and
		// its tokens. This is the shape that let a widened mask through on PR #176:
		// ten files and 216 assertions, all asserting that something fires and none
		// asserting that it does not.
		const configPath = writableConfig("trusted", 0o600);
		try {
			expect(statSync(configPath).mode & 0o022).toBe(0);

			const config = new Config(configPath);

			expect(config.get("lb_strategy")).toBe("session");
			expect(config.get("pg_password")).toBe("ATTACKER-DB-PASSWORD");
			expect(config.get("local_control_secret")).toBe("ATTACKER-CHOSEN");
			expect(config.get("foo_token")).toBe("ATTACKER-FUTURE-FIELD");
		} finally {
			rmSync(join(configPath, ".."), { recursive: true, force: true });
		}
	});

	it("strips at the second parse site too, which is the one that matters", () => {
		// getLocalControlSecret() re-reads the file itself, and it does so on the boot
		// where the secret is absent from this.data, so a filter applied only in
		// loadConfig() would be bypassed exactly when an attacker's secret would be
		// adopted. The mode is restored before the call because restrictConfigFile()
		// lands 0600 during construction, so without that the second read sees a
		// private file and proves nothing.
		const configPath = writableConfig("second", 0o666);
		try {
			const config = new Config(configPath);
			chmodSync(configPath, 0o666);
			const secret = config.getLocalControlSecret();
			expect(secret).toBeDefined();
			expect(secret).not.toBe("ATTACKER-CHOSEN");
		} finally {
			rmSync(join(configPath, ".."), { recursive: true, force: true });
		}
	});

	it("does not write the stripped fields back to disk", () => {
		// this.data is what set() persists, so a stripped field must not reappear in
		// the file. If it did, one boot from a writable config would launder the
		// attacker's values into a 0600 file that then looks authoritative.
		const configPath = writableConfig("writeback", 0o666);
		try {
			const config = new Config(configPath);
			config.set("port", 9999);
			const onDisk = readFileSync(configPath, "utf8");
			expect(onDisk).toContain("9999");
			expect(onDisk).not.toContain("ATTACKER-DB-PASSWORD");
			expect(onDisk).not.toContain("ATTACKER-FUTURE-FIELD");
		} finally {
			rmSync(join(configPath, ".."), { recursive: true, force: true });
		}
	});
});
