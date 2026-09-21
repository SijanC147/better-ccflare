import { describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logBus } from "@better-ccflare/logger";
import type { LogEvent } from "@better-ccflare/types";
import { Config } from "./index";

/**
 * SB23-2469. A config file this process could not read as config data is left
 * alone rather than replaced.
 *
 * The defect these pin, measured at eaa5859a before the fix: loadConfig() does
 * `this.data = this.readConfigData(...) ?? {}` and falls through, so a parse
 * failure leaves an empty config in memory, and saveConfig() serialises
 * this.data wholesale. getLocalControlSecret() reaches it on the first boot,
 * because it finds no secret in the empty data, generates one and calls set().
 * The issue's own five-key 0600 fixture, whose only defect is a trailing comma,
 * came back from disk as `{ "local_control_secret": "<uuid>" }` with pg_password
 * and openobserve_token gone and no log line saying a file had been replaced.
 *
 * Every assertion here reads the BYTES back off disk. "Something was logged" and
 * "the file still exists" both hold on the defect, so neither is evidence: the
 * defect writes a file and logs a parse error while doing it.
 *
 * What is deliberately NOT asserted: that the refusal state is module-scoped. It
 * is per-instance, mirroring strippedFields/strippedFrom, and the two-instance
 * case below passes because the second Config re-reads the same bytes and fails
 * the same parse on its own, not because any state is shared. See the
 * unparseableFrom docstring for why that differs from writableAtFirstRead.
 */

/** The issue's fixture, verbatim. Its only defect is the trailing comma. */
const TRAILING_COMMA = `{"lb_strategy":"session","pg_enabled":true,"pg_host":"db.internal","pg_password":"operator-secret","openobserve_token":"operator-o2-token",}`;

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
 * A fixture directory asserted to be a temp directory and not a checkout before
 * anything runs in it, because a fixture path that resolved wrong is how a
 * sub-agent twice wrote into a live config in this very family (#145, #220).
 *
 * Every Config in this file is constructed with an explicit path for the same
 * reason: `new Config()` with no argument falls through to resolveConfigPath()
 * and lands on the operator's real config.
 */
function withFixture(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-unparseable-"));
	expect(dir.length).toBeGreaterThan(0);
	expect(dir.startsWith(tmpdir())).toBe(true);
	expect(dir.includes("better-ccflare-worktrees")).toBe(false);
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Write a config fixture at 0600, so the SB23-2351 strip never runs and the only thing under test is the parse. */
function seed(dir: string, name: string, bytes: string): string {
	const path = join(dir, name);
	writeFileSync(path, bytes, { mode: 0o600 });
	return path;
}

describe("SB23-2469 — a config that cannot be read is not replaced", () => {
	/**
	 * The first-boot test, written BEFORE the refusal tests deliberately.
	 *
	 * It is the one that fails if the refusal is keyed on "the load produced no
	 * data" rather than on "a file was read and not understood". An absent config
	 * also produces no data, and refusing there bricks a fresh install: nothing
	 * is ever persisted, and local_control_secret rotates on every restart
	 * forever. mem:a-boolean-cannot-hold-three-outcomes is this shape.
	 *
	 * It passes structurally rather than by luck. loadConfig() gates the whole
	 * read on existsSync() and an absent file takes the else branch, which never
	 * calls readConfigData(), so unparseableFrom cannot be set. The test exists
	 * because that is a property of the code that a later edit can remove.
	 */
	it("still creates and persists a config on first boot, when the file is absent", () => {
		withFixture((dir) => {
			const path = join(dir, "better-ccflare.json");
			expect(existsSync(path)).toBe(false);

			const config = new Config(path);
			const secret = config.getLocalControlSecret();

			expect(existsSync(path)).toBe(true);
			const onDisk = readFileSync(path, "utf8");
			expect(JSON.parse(onDisk).local_control_secret).toBe(secret);
		});
	});

	/** The other half of the same boundary: a config that CAN be read still saves. */
	it("still writes a setting back to a config that parsed", () => {
		withFixture((dir) => {
			const path = seed(
				dir,
				"better-ccflare.json",
				`{"lb_strategy":"session"}`,
			);

			new Config(path).set("lb_strategy", "round-robin");

			expect(JSON.parse(readFileSync(path, "utf8")).lb_strategy).toBe(
				"round-robin",
			);
		});
	});

	it("leaves the operator's file byte-identical after a boot plus a set()", () => {
		withFixture((dir) => {
			const path = seed(dir, "better-ccflare.json", TRAILING_COMMA);

			const config = new Config(path);
			// The call that reaches the defect on a real first boot: no secret in
			// the empty data, so it generates one and calls set().
			config.getLocalControlSecret();
			config.set("lb_strategy", "round-robin");

			expect(readFileSync(path, "utf8")).toBe(TRAILING_COMMA);
		});
	});

	/**
	 * The named credentials, asserted separately from the byte comparison above.
	 *
	 * Not redundant with it: byte-identity is one assertion that fails for any
	 * reason at all, and if it ever has to be relaxed, this is the line that says
	 * what the issue was actually about. The measured defect deleted exactly
	 * these.
	 */
	it("does not delete the operator's credentials", () => {
		withFixture((dir) => {
			const path = seed(dir, "better-ccflare.json", TRAILING_COMMA);

			new Config(path).getLocalControlSecret();

			const onDisk = readFileSync(path, "utf8");
			expect(onDisk).toContain("operator-secret");
			expect(onDisk).toContain("operator-o2-token");
			expect(onDisk).toContain("db.internal");
		});
	});

	/**
	 * The two-instance case PR #220's review demanded of its own fix.
	 *
	 * It passes because the second Config re-reads the same bytes and fails the
	 * same parse on its own, NOT because any state is shared between instances.
	 * That is stated here rather than left to be inferred from a green line: this
	 * test is not evidence that the refusal state needs module scope, and reading
	 * it as such is how a per-instance memo would get "confirmed" by a test that
	 * never distinguished the two.
	 *
	 * It is still worth running. It pins the reachable shape from the long-lived
	 * server, where packages/http-api/src/handlers/oauth.ts:878 and :971 and
	 * packages/database/src/database-operations.ts:389 each build their own
	 * Config.
	 */
	it("cannot be laundered back by a second Config in the same process", () => {
		withFixture((dir) => {
			const path = seed(dir, "better-ccflare.json", TRAILING_COMMA);

			const first = new Config(path);
			first.getLocalControlSecret();

			const second = new Config(path);
			second.set("lb_strategy", "round-robin");
			second.getLocalControlSecret();

			expect(readFileSync(path, "utf8")).toBe(TRAILING_COMMA);
		});
	});

	/**
	 * JSON.parse succeeds on all of these, so the parse catch never sees them and
	 * the cast to ConfigData was the only thing calling them an object.
	 *
	 * `null` is the one that matters: four bytes, no syntax error anywhere, and
	 * readConfigData() returns the same null a parse failure returns, so the
	 * caller's `?? {}` produces the identical empty config and the identical
	 * wholesale overwrite. Second site of mem:a-successful-parse-can-yield-null
	 * in this repository.
	 *
	 * An array is included because it IS an object: a bare `typeof parsed !==
	 * "object"` test passes it through, and JSON.stringify of an array drops every
	 * named property a set() adds, so each write is lost silently.
	 */
	const validJsonThatIsNotAnObject: Array<[string, string]> = [
		["null", "null"],
		["a boolean", "true"],
		["a number", "7"],
		["a string", `"hello"`],
		["an array", "[1,2]"],
	];

	for (const [label, bytes] of validJsonThatIsNotAnObject) {
		it(`leaves a config holding ${label} byte-identical`, () => {
			withFixture((dir) => {
				const path = seed(dir, "better-ccflare.json", bytes);

				const config = new Config(path);
				config.getLocalControlSecret();
				config.set("lb_strategy", "round-robin");

				expect(readFileSync(path, "utf8")).toBe(bytes);
			});
		});
	}

	/**
	 * A file that exists and cannot be READ, as distinct from one that cannot be
	 * parsed. Both destroy the operator's file without the refusal; they are
	 * separate branches and this is the one nothing covered.
	 *
	 * It exists because mutation (g) on this PR survived. The first draft caught
	 * the read failure and the stat failure in one try/catch and set no flag for
	 * either, so an unreadable config was still replaced. Adding the flag to that
	 * shared catch also passed every test, which is what said the tests could not
	 * tell the two branches apart.
	 *
	 * Reachable with no attacker and no exotic filesystem: mode 0000 on a file we
	 * own. statSync succeeds, so the non-regular-file guard passes, and
	 * readFileSync throws EACCES. Measured as uid 501: stat ok, open() errno 13.
	 *
	 * The set() is what reaches the overwrite here rather than
	 * getLocalControlSecret(). restrictConfigFile() brings the file to 0600
	 * during the same load, so the re-read inside getLocalControlSecret()
	 * succeeds and finds the existing secret, and no save follows. this.data is
	 * still empty from the failed load, so the next ordinary set() is what
	 * serialises that empty config over the file.
	 */
	it("leaves a config it could not read byte-identical", () => {
		withFixture((dir) => {
			const bytes = `{"lb_strategy":"session","pg_password":"operator-secret"}`;
			const path = seed(dir, "better-ccflare.json", bytes);
			chmodSync(path, 0o000);

			const config = new Config(path);
			config.set("lb_strategy", "round-robin");

			// Readable again: restrictConfigFile() chmodded it during the load.
			expect(readFileSync(path, "utf8")).toBe(bytes);
		});
	});

	/**
	 * An empty file is a parse failure, and this is a deliberate behaviour change
	 * disclosed rather than hidden: before this, `touch better-ccflare.json`
	 * produced a config that was silently replaced on the next set(). It is now
	 * left alone and the process runs on defaults.
	 *
	 * Refusing is the right direction because an empty file is indistinguishable
	 * from a file truncated by an interrupted write, which is data loss already in
	 * progress. The operator's route out is to remove the file, which the refusal
	 * message names.
	 */
	it("leaves an empty config file alone rather than adopting it", () => {
		withFixture((dir) => {
			const path = seed(dir, "better-ccflare.json", "");

			new Config(path).getLocalControlSecret();

			expect(readFileSync(path, "utf8")).toBe("");
		});
	});

	/**
	 * The refusal says what it costs, not merely that it happened.
	 *
	 * Asserted on the substance rather than on the whole string, because unlike
	 * the three messages config-file-mode.test.ts pins with toBe, this one is not
	 * a claim about three subsystems agreeing. What matters is that the operator
	 * is told the file was left alone, that the secret is not being persisted, and
	 * what to do.
	 */
	it("tells the operator the file was left alone and the secret is not persisted", () => {
		withFixture((dir) => {
			const path = seed(dir, "better-ccflare.json", TRAILING_COMMA);

			const events = captureLogs(() => {
				new Config(path).getLocalControlSecret();
			});

			const errors = events
				.filter((event) => event.level === "ERROR")
				.map((event) => event.msg);

			const refusal = errors.find((msg) => msg.startsWith("Config not saved:"));
			expect(refusal).toBeDefined();
			expect(refusal).toContain(path);
			expect(refusal).toContain("running on defaults");
			expect(refusal).toContain("local_control_secret is regenerated");

			const diagnosis = errors.find((msg) =>
				msg.startsWith("Failed to parse config file:"),
			);
			expect(diagnosis).toBeDefined();
			expect(diagnosis).toContain("no setting is written back");
		});
	});

	/**
	 * The shape is named, and null is named as null rather than as an object.
	 *
	 * `typeof null` is "object", so a describeJsonShape() that forgot the null
	 * case would tell an operator holding a four-byte `null` file that it holds an
	 * object, which reads as "the file is fine".
	 */
	it("names the shape a non-object config actually holds", () => {
		withFixture((dir) => {
			const nullPath = seed(dir, "null.json", "null");
			const arrayPath = seed(dir, "array.json", "[1,2]");

			const events = captureLogs(() => {
				new Config(nullPath).getLocalControlSecret();
				new Config(arrayPath).getLocalControlSecret();
			});
			const errors = events
				.filter((event) => event.level === "ERROR")
				.map((event) => event.msg);

			expect(
				errors.find(
					(msg) => msg.includes(nullPath) && msg.includes("not an object"),
				),
			).toContain("it is null");
			expect(
				errors.find(
					(msg) => msg.includes(arrayPath) && msg.includes("not an object"),
				),
			).toContain("it is an array");
		});
	});

	/**
	 * The two diagnoses are distinguishable from each other.
	 *
	 * Both refuse and both leave the file alone, so an operator reading the log
	 * has only the wording to tell "I could not open this" from "I opened it and
	 * it is not JSON", and those call for different actions: check the
	 * permissions, or fix the syntax.
	 *
	 * Pinned because the first draft used "could not read" for both. One word, in
	 * a security message, describing something other than what the code did,
	 * which is #182's shape at small scale. Asserted on the discriminating
	 * phrases rather than on the whole string, so ordinary rewording does not
	 * fail it but collapsing the two back into one does.
	 */
	it("says something different for a file it could not open and one it could not parse", () => {
		withFixture((dir) => {
			const unreadable = seed(dir, "unreadable.json", `{"a":1}`);
			chmodSync(unreadable, 0o000);
			const unparseable = seed(dir, "unparseable.json", TRAILING_COMMA);

			const events = captureLogs(() => {
				new Config(unreadable);
				new Config(unparseable);
			});
			const errors = events
				.filter((event) => event.level === "ERROR")
				.map((event) => event.msg);

			const readFailure = errors.find((msg) => msg.includes(unreadable));
			const parseFailure = errors.find((msg) => msg.includes(unparseable));
			expect(readFailure).toBeDefined();
			expect(parseFailure).toBeDefined();

			expect(readFailure).toContain("could not be read");
			expect(readFailure).toContain("permissions");
			expect(parseFailure).toContain("could not understand");
			expect(parseFailure).toContain("Fix the syntax");

			// The decisive assertion: neither one carries the other's wording.
			expect(parseFailure).not.toContain("could not be read");
			expect(readFailure).not.toContain("could not understand");
		});
	});

	/**
	 * A refused save does not leave the setting silently missing from the process
	 * too: this.data still carries it, so the running process behaves as asked and
	 * only the persistence is lost. That is what the refusal message promises with
	 * "held in memory for this process only", and a message promising something
	 * the code does not do is #182's defect.
	 */
	it("still applies the setting in memory while refusing to persist it", () => {
		withFixture((dir) => {
			const path = seed(dir, "better-ccflare.json", TRAILING_COMMA);

			const config = new Config(path);
			config.set("lb_strategy", "round-robin");

			expect(config.get("lb_strategy")).toBe("round-robin");
			expect(readFileSync(path, "utf8")).toBe(TRAILING_COMMA);
		});
	});
});
