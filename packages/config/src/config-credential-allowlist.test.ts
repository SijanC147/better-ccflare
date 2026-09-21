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
 * can write (SB23-2351), and the process refuses to SAVE while that is true
 * (SB23-2366).
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
 *
 * The save half is the part with an absolute acceptance criterion: no operator's
 * config file may lose a field it had before the process started. saveConfig()
 * serialises this.data wholesale, so a filtered load plus one set() deletes the
 * stripped fields from disk, and getLocalControlSecret() performs that set() on
 * the same boot. Every assertion about it is written against the FILE, not against
 * a thrown error, because a throw is not the behaviour and would prove nothing
 * about what is on disk.
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
 * Built under os.tmpdir() as given, NOT under its realpath. On macOS tmpdir() is
 * /var/folders/... which resolves to /private/var/folders/..., and the security
 * package's allowlist holds the unresolved form, so a realpathed fixture is
 * refused outright with "Path outside allowed directories".
 *
 * Measured, not assumed: Config reports this unresolved path verbatim in its
 * refusal, so the whole-message assertions below compare against configPath as
 * given. An earlier draft compared against realpathSync(configPath) and failed on
 * exactly that difference, which is the reason the assertion is a whole-string
 * toBe rather than a substring match.
 */
function fixtureDir(label: string): string {
	return mkdtempSync(join(tmpdir(), `better-ccflare-${label}-`));
}

/**
 * A config with one ordinary setting and three things that must not be adopted.
 *
 * Explicit chmod, never writeFileSync's mode option: under umask 022 a requested
 * 0o666 lands 0644, which has no group or other WRITE bit, so the condition under
 * test would not hold and every assertion would pass against reverted source.
 */
function writableConfig(label: string, mode: number): string {
	const dir = fixtureDir(label);
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

/** The exact line saveConfig() emits when it refuses. Asserted whole, see below. */
function refusalMessage(configPath: string, strippedCount: number): string {
	return `Config not saved: ${configPath} was loaded from a file other local users can write, with ${strippedCount} credential or endpoint field(s) ignored, and writing it back would delete them from disk. The setting is held in memory for this process only. local_control_secret is regenerated on every boot while this lasts and is never written, so local control clients holding an earlier secret fail to authenticate. Make the file writable only by its owner, or move it to a directory no other local user can write, then restart.`;
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
			const dir = fixtureDir("named");
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

	it("strips the pg_ family, not merely the one field a suffix catches", () => {
		// Mutation M1: deleting "pg_" from UNTRUSTED_FIELD_PREFIXES. It survived the
		// original suite because pg_password ends in "password" and the suffix rule
		// caught it, leaving pg_enabled, pg_host, pg_port, pg_user and pg_ssl_mode
		// covered by nothing. pg_enabled is the gate that makes the rest take effect,
		// so that family is the whole point: apps/server bridges these into
		// DATABASE_URL, and the accounts table stores tokens in plaintext.
		//
		// No field here matches the suffix rule or the named list, deliberately.
		const dir = fixtureDir("pgfamily");
		const configPath = join(dir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				lb_strategy: "session",
				pg_enabled: true,
				pg_host: "attacker.example.com",
				pg_port: 5432,
				pg_user: "attacker",
			}),
		);
		chmodSync(configPath, 0o666);
		try {
			const config = new Config(configPath);
			expect(config.get("lb_strategy")).toBe("session");
			expect(config.get("pg_enabled")).toBeUndefined();
			expect(config.get("pg_host")).toBeUndefined();
			expect(config.get("pg_port")).toBeUndefined();
			expect(config.get("pg_user")).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("strips the openobserve_ family, not merely its token", () => {
		// Mutation M2: deleting "openobserve_" from UNTRUSTED_FIELD_PREFIXES. Same
		// shape as M1: openobserve_token ends in "token", so the suffix rule hid the
		// prefix rule's absence. openobserve_url is the outbound destination, and it
		// is the field that decides where request and response bodies are shipped.
		const dir = fixtureDir("o2family");
		const configPath = join(dir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				lb_strategy: "session",
				openobserve_url: "https://attacker.example.com",
				openobserve_org: "attacker",
				openobserve_ship_payloads: true,
			}),
		);
		chmodSync(configPath, 0o666);
		try {
			const config = new Config(configPath);
			expect(config.get("lb_strategy")).toBe("session");
			expect(config.get("openobserve_url")).toBeUndefined();
			expect(config.get("openobserve_org")).toBeUndefined();
			expect(config.get("openobserve_ship_payloads")).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("strips from a group-writable config, not only a world-writable one", () => {
		// Mutation M3: narrowing the strip mask from 0o022 to 0o002. On macOS the
		// default gid is staff, which every local account belongs to, so
		// group-writable is the common real exposure and the narrowed mask would miss
		// it entirely while every world-writable test stayed green.
		//
		// 0o620 has the group WRITE bit and no other-write bit, so it separates the
		// two masks: 0o620 & 0o022 is 0o020, and 0o620 & 0o002 is 0.
		const configPath = writableConfig("groupwrite", 0o620);
		try {
			expect(statSync(configPath).mode & 0o022).not.toBe(0);
			expect(statSync(configPath).mode & 0o002).toBe(0);

			const config = new Config(configPath);

			expect(config.get("lb_strategy")).toBe("session");
			expect(config.get("pg_password")).toBeUndefined();
			expect(config.get("local_control_secret")).toBeUndefined();
		} finally {
			rmSync(join(configPath, ".."), { recursive: true, force: true });
		}
	});

	it("names the fields it ignored, once per process", () => {
		// The process otherwise behaves as though the operator never set them, which
		// is indistinguishable from a config that does not contain them.
		//
		// Mutation M4: removing the strippedFieldsReported dedupe. It used to survive
		// because the second read re-derived writability from a file that was 0600 by
		// then and stripped nothing, so there was no second report to suppress. Now
		// that writability is captured on the first read, the second read strips too,
		// and without the dedupe this reads 2. getLocalControlSecret() is called here
		// precisely to drive that second read.
		const configPath = writableConfig("named", 0o666);
		try {
			const logs = captureLogs(() => {
				const config = new Config(configPath);
				config.getLocalControlSecret();
			});
			const reports = logs.filter(
				(event) =>
					event.level === "ERROR" &&
					event.msg.includes("credential or endpoint field(s) from"),
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

	it("still saves normally when nothing was stripped", () => {
		// The other half of the negative case, and the reason the refusal is gated on
		// "fields were actually dropped" rather than on "the file is writable".
		// Gating on writability would refuse every save on a Docker bind mount from a
		// macOS host, where chmod is a no-op and the config is perfectly ordinary:
		// that is the permanent outage route 1 was rejected for. Here the file is
		// world-writable and contains no credential field, so this.data matches the
		// file and a save is a faithful round trip.
		const dir = fixtureDir("nostrip");
		const configPath = join(dir, "config.json");
		writeFileSync(configPath, JSON.stringify({ lb_strategy: "session" }));
		chmodSync(configPath, 0o666);
		try {
			const config = new Config(configPath);
			config.set("port", 9999);
			expect(JSON.parse(readFileSync(configPath, "utf8")).port).toBe(9999);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("adopts no planted secret on the second read, with no fixture chmod", () => {
		// The ordering half of SB23-2366, and the decisive case.
		//
		// There is deliberately NO chmod back to 0o666 here. The earlier version of
		// this test had one, justified as restoring the precondition, and that is
		// exactly what made it vacuous: readConfigData() brings a writable file to
		// 0600 at its own report site, so on a real boot the second read stats 0600,
		// strips nothing, and adopts the planted secret. The fixture was restoring
		// the condition the guard was supposed to survive without, so the test passed
		// against source that had the bug.
		//
		// Measured at dca5c7ea, which is this branch with the strip and without the
		// ordering fix: this probe read adoptedPlanted true. With the fix it reads
		// false. That is an authentication bypass against the local control endpoint,
		// not a disclosure.
		const configPath = writableConfig("second", 0o666);
		try {
			const config = new Config(configPath);
			// The file really is 0600 by now. If this ever stops holding, the test
			// below has quietly stopped testing the ordering.
			expect(statSync(configPath).mode & 0o022).toBe(0);

			const secret = config.getLocalControlSecret();

			expect(secret).toBeDefined();
			expect(secret).not.toBe("ATTACKER-CHOSEN");
		} finally {
			rmSync(join(configPath, ".."), { recursive: true, force: true });
		}
	});

	it("loses no field from the operator's file across a boot that filters", () => {
		// The absolute acceptance criterion on SB23-2366: no route is acceptable if
		// an operator's config file loses a field it had before the process started.
		//
		// Asserted as a key count and a byte comparison of the FILE, not as a thrown
		// error. A test that asserts a throw says nothing about what is on disk, and
		// what is on disk is the entire question. getLocalControlSecret() is the
		// trigger: it finds no secret, generates one, and calls set(), which is the
		// save that used to delete nine fields on the same boot.
		const dir = fixtureDir("keycount");
		const configPath = join(dir, "config.json");
		const operatorConfig = {
			lb_strategy: "session",
			port: 8080,
			pg_enabled: true,
			pg_host: "db.internal",
			pg_password: "operator-secret",
			openobserve_url: "https://o2.example.com",
			openobserve_token: "operator-o2-token",
			alert_webhook_url: "https://hooks.example.com/x",
			claude_projects_dir: "/Users/op/.claude/projects",
			github_read_token: "ghp_operator",
			outbound_proxy: "http://proxy.internal:3128",
			session_duration_ms: 18000000,
			retry_attempts: 3,
		};
		writeFileSync(configPath, JSON.stringify(operatorConfig, null, 2));
		chmodSync(configPath, 0o666);
		try {
			const bytesBefore = readFileSync(configPath);
			const keysBefore = Object.keys(
				JSON.parse(bytesBefore.toString("utf8")),
			).sort();
			expect(keysBefore).toHaveLength(13);

			const config = new Config(configPath);
			config.getLocalControlSecret();
			config.set("port", 9999);

			const bytesAfter = readFileSync(configPath);
			const keysAfter = Object.keys(
				JSON.parse(bytesAfter.toString("utf8")),
			).sort();

			// 13 in, 13 out. At dca5c7ea this read 5, being 4 of the operator's own
			// plus the freshly generated local_control_secret.
			expect(keysAfter).toHaveLength(13);
			expect(keysAfter).toEqual(keysBefore);
			expect(bytesAfter.equals(bytesBefore)).toBe(true);
			// The setting the caller asked for is in memory and nowhere else, which
			// is what the refusal message tells the operator.
			expect(config.get("port")).toBe(9999);
			expect(bytesAfter.toString("utf8")).not.toContain("9999");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("strips for a SECOND Config on the same path, after we chmodded it", () => {
		// The instance boundary, found by this PR's security reviewer at 6217144c.
		//
		// The first draft memoised writability per instance, and its docstring
		// argued for that: a later Config is entitled to a fresh reading of a file
		// the operator may have since fixed. That reasoning is wrong in the one case
		// that matters, because THE FIRST INSTANCE IS WHAT CHMODS THE FILE. A second
		// Config built microseconds later stats a file this process just made look
		// clean, strips nothing, and adopts the plant. Worse, its strippedFields is
		// empty, so its saveConfig() does not refuse and writes the attacker's values
		// back into a now-0600 file: the exact laundering saveConfig() declines to do
		// deliberately one method away.
		//
		// Measured by the reviewer with the per-instance memo: the second Config
		// returned the planted secret AND the attacker's DSN from
		// buildPgConnectionUrl(), and persisted a set() beside both.
		//
		// Not hypothetical. Three second-instance sites exist in the long-lived
		// server: packages/http-api/src/handlers/oauth.ts:878 and :971, and
		// packages/database/src/database-operations.ts:389, which calls
		// buildPgConnectionUrl() itself.
		const dir = fixtureDir("secondinstance");
		const configPath = join(dir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				lb_strategy: "session",
				local_control_secret: "ATTACKER-PLANTED-SECRET",
				pg_enabled: true,
				pg_host: "attacker.example.com",
				pg_password: "attacker-pw",
			}),
		);
		chmodSync(configPath, 0o666);
		try {
			const first = new Config(configPath);
			expect(first.getLocalControlSecret()).not.toBe("ATTACKER-PLANTED-SECRET");
			// The first instance has chmodded it. This is the precondition that makes
			// the second instance interesting, so assert it rather than assume it.
			expect(statSync(configPath).mode & 0o022).toBe(0);
			const bytesAfterFirst = readFileSync(configPath);

			const second = new Config(configPath);

			expect(second.get("lb_strategy")).toBe("session");
			expect(second.get("local_control_secret")).toBeUndefined();
			expect(second.get("pg_host")).toBeUndefined();
			expect(second.getLocalControlSecret()).not.toBe(
				"ATTACKER-PLANTED-SECRET",
			);
			expect(second.buildPgConnectionUrl()).toBeNull();
			// And the second instance must refuse to save too, or it launders the
			// plant into a file that now looks authoritative.
			second.set("port", 9999);
			expect(readFileSync(configPath).equals(bytesAfterFirst)).toBe(true);
			expect(readFileSync(configPath, "utf8")).not.toContain("9999");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("says the whole refusal, every time it refuses", () => {
		// Asserted with toBe against the entire string, not with toContain plus
		// not.toContain. A pair of those is an allowlist of what must be present with
		// no statement about what must be absent, and a mutation that ADDED a
		// sentence survived 193 passing tests in this same family: the message told
		// the operator something the code had not done, in a security line, with
		// every substring assertion still green.
		//
		// Twice, because the split this file keeps is diagnosis once per process,
		// outcome every time (SB23-2379, SB23-2357). Each refused save is a separate
		// lost write, so suppressing the second would hide a settings change that did
		// not persist. Three fields are stripped from this fixture.
		const configPath = writableConfig("refusal", 0o666);
		try {
			const config = new Config(configPath);
			const logs = captureLogs(() => {
				config.set("port", 9999);
				config.set("port", 10000);
			});
			const refusals = logs.filter(
				(event) =>
					event.level === "ERROR" && event.msg.startsWith("Config not saved:"),
			);
			expect(refusals).toHaveLength(2);
			expect(refusals[0].msg).toBe(refusalMessage(configPath, 3));
			expect(refusals[1].msg).toBe(refusalMessage(configPath, 3));
		} finally {
			rmSync(join(configPath, ".."), { recursive: true, force: true });
		}
	});
});
