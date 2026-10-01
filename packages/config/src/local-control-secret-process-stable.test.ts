import { describe, expect, it } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

/**
 * SB23-2489. While a save is refused, every Config in one process returns the
 * same local_control_secret for one config path.
 *
 * Before the fix the secret was per INSTANCE while a save was refused: stable on
 * one Config, different on the next one built in the same process, because the
 * generated value could not be written and nothing else held it. The refusal
 * messages said "regenerated on every boot", one level coarser than the truth.
 *
 * What these tests are NOT evidence of, stated so a green line is not read as
 * more: the CLI runs as a separate process and reads the secret from the file,
 * which a refused save never writes, so a CLI still cannot learn the server's
 * secret while the refusal holds. No in-process memo can change that, and the
 * refusal messages now say so. Tracked separately.
 *
 * Every fixture lives under mkdtemp, and every Config names its path except the
 * one test that must reproduce oauth.ts's no-argument construction, which
 * redirects XDG_CONFIG_HOME and asserts where the path resolved before it
 * asserts anything else.
 */

/** Valid JSON with one defect, so the load refuses and every save is refused. */
const TRAILING_COMMA = `{"lb_strategy":"session","pg_password":"operator-secret",}`;

function withFixture(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-secret-stable-"));
	expect(dir.length).toBeGreaterThan(0);
	expect(dir.startsWith(tmpdir())).toBe(true);
	expect(dir.includes("better-ccflare-worktrees")).toBe(false);
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function seed(path: string, bytes: string, mode = 0o600): string {
	writeFileSync(path, bytes, { mode });
	chmodSync(path, mode);
	return path;
}

describe("SB23-2489 — one local_control_secret per process while saves are refused", () => {
	it("returns one secret from two instances on an unparseable config", () => {
		withFixture((dir) => {
			const path = seed(join(dir, "better-ccflare.json"), TRAILING_COMMA);

			const first = new Config(path).getLocalControlSecret();
			const second = new Config(path).getLocalControlSecret();

			expect(first.length).toBeGreaterThan(0);
			expect(second).toBe(first);
			// The refusal still holds: nothing was written, so the value lives only
			// in this process.
			expect(readFileSync(path, "utf8")).toBe(TRAILING_COMMA);
		});
	});

	/**
	 * The strip refusal (SB23-2366) rather than the parse refusal. A config other
	 * local users can write loads its settings and drops local_control_secret, so
	 * the planted value must not come back, and the generated one must be shared.
	 */
	it("returns one secret from two instances on a config other users can write", () => {
		withFixture((dir) => {
			const path = seed(
				join(dir, "better-ccflare.json"),
				JSON.stringify({
					lb_strategy: "session",
					local_control_secret: "ATTACKER-CHOSEN",
				}),
				0o666,
			);

			const first = new Config(path).getLocalControlSecret();
			const second = new Config(path).getLocalControlSecret();

			expect(first).not.toBe("ATTACKER-CHOSEN");
			expect(second).toBe(first);
			expect(readFileSync(path, "utf8")).not.toContain(first);
		});
	});

	/**
	 * The construction packages/http-api/src/handlers/oauth.ts uses on every
	 * request (`new Config()` with no argument), beside the one apps/server uses
	 * for the container Config whose secret AuthService holds.
	 *
	 * The OAuth handlers themselves never call getLocalControlSecret(): the flow
	 * they build reads only getRuntime(). So this is the proof at the
	 * construction, not through a request, and it is stated that way rather than
	 * dressed up as an HTTP test that would read no secret at all.
	 */
	it("gives no-argument instances, built the way oauth.ts builds them, the server's secret", () => {
		withFixture((dir) => {
			const saved = {
				BETTER_CCFLARE_CONFIG_PATH: process.env.BETTER_CCFLARE_CONFIG_PATH,
				ccflare_CONFIG_PATH: process.env.ccflare_CONFIG_PATH,
				XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
			};
			delete process.env.BETTER_CCFLARE_CONFIG_PATH;
			delete process.env.ccflare_CONFIG_PATH;
			process.env.XDG_CONFIG_HOME = dir;
			try {
				mkdirSync(join(dir, "better-ccflare"), { mode: 0o700 });
				const path = seed(
					join(dir, "better-ccflare", "better-ccflare.json"),
					TRAILING_COMMA,
				);

				const server = new Config();
				const requestOne = new Config();
				const requestTwo = new Config();

				// Where they resolved, before anything about secrets: a no-argument
				// Config that fell through to the operator's real file is the incident
				// #159 exists for.
				for (const config of [server, requestOne, requestTwo]) {
					expect(config.getConfigPath()).toBe(path);
					expect(config.getConfigPath().startsWith(dir)).toBe(true);
				}

				const held = server.getLocalControlSecret();
				expect(requestOne.getLocalControlSecret()).toBe(held);
				expect(requestTwo.getLocalControlSecret()).toBe(held);
				expect(readFileSync(path, "utf8")).toBe(TRAILING_COMMA);
			} finally {
				for (const [name, value] of Object.entries(saved)) {
					if (value === undefined) delete process.env[name];
					else process.env[name] = value;
				}
			}
		});
	});

	/**
	 * A remembered secret still goes through set(), the same as a generated one,
	 * so an instance that can save persists the value it returns rather than
	 * handing out one that exists only in memory. Without that, a repaired file
	 * would stay secret-less for the rest of the process, because the memo would
	 * keep answering and nothing would ever write.
	 *
	 * Not a claim that the CLI recovers while the server runs: the server reads
	 * its secret once at startup, on an instance whose saves stay refused, and
	 * nothing in it asks a repaired instance for the secret.
	 */
	it("persists the process's secret once a later instance can save", () => {
		withFixture((dir) => {
			const path = seed(join(dir, "better-ccflare.json"), TRAILING_COMMA);
			const held = new Config(path).getLocalControlSecret();

			// The operator repairs the file. The repaired file has no secret, because
			// the refused process never wrote one.
			seed(path, `{"lb_strategy":"session"}`);

			const repaired = new Config(path);
			expect(repaired.getLocalControlSecret()).toBe(held);
			expect(JSON.parse(readFileSync(path, "utf8")).local_control_secret).toBe(
				held,
			);
		});
	});

	/**
	 * The memo fills only the gap where a fresh value would otherwise be minted.
	 * A value in the instance's own data, or one the disk re-read finds, still
	 * wins, which is the #379 race: a CLI racing the server's first boot may
	 * persist its own secret after an instance was constructed.
	 *
	 * Kills two mutations at once: the memo consulted before the disk re-read
	 * (`late` would return `held`), and the memo consulted before this.data
	 * (`fresh` would return `held`).
	 */
	it("still prefers a secret on disk over one this process remembers", () => {
		withFixture((dir) => {
			const path = join(dir, "better-ccflare.json");
			const late = new Config(path);
			const held = new Config(path).getLocalControlSecret();

			seed(
				path,
				JSON.stringify({ local_control_secret: "written-by-the-cli" }),
			);

			expect(late.getLocalControlSecret()).toBe("written-by-the-cli");
			const fresh = new Config(path);
			expect(fresh.getLocalControlSecret()).toBe("written-by-the-cli");
			expect(held).not.toBe("written-by-the-cli");
		});
	});

	/**
	 * Why every returned value is recorded, not only generated ones. A secret
	 * the process read from a healthy file at startup is the one AuthService
	 * holds, so a later instance that finds the file broken must return it rather
	 * than mint one that matches nothing.
	 *
	 * The first value wins, because the first call in the server process is
	 * apps/server's, whose answer AuthService keeps. A later instance that reads
	 * a different value from the file returns that value, and must not make the
	 * process forget the one AuthService holds.
	 */
	it("keeps the startup secret when the file breaks later", () => {
		withFixture((dir) => {
			const path = seed(
				join(dir, "better-ccflare.json"),
				JSON.stringify({ local_control_secret: "read-at-startup" }),
			);
			expect(new Config(path).getLocalControlSecret()).toBe("read-at-startup");

			seed(path, JSON.stringify({ local_control_secret: "written-later" }));
			expect(new Config(path).getLocalControlSecret()).toBe("written-later");

			seed(path, TRAILING_COMMA);

			expect(new Config(path).getLocalControlSecret()).toBe("read-at-startup");
			expect(readFileSync(path, "utf8")).toBe(TRAILING_COMMA);
		});
	});

	/**
	 * The disk re-read is the #379 race as it happens in production: apps/server
	 * builds its Config, the CLI then persists a secret, and the server's first
	 * getLocalControlSecret() finds it on disk. AuthService keeps that value, so
	 * it has to be the one remembered, not only values read from this.data.
	 */
	it("records a secret first found by the disk re-read", () => {
		withFixture((dir) => {
			const path = join(dir, "better-ccflare.json");
			const server = new Config(path);
			seed(
				path,
				JSON.stringify({ local_control_secret: "persisted-by-the-cli" }),
			);
			expect(server.getLocalControlSecret()).toBe("persisted-by-the-cli");

			seed(path, TRAILING_COMMA);

			expect(new Config(path).getLocalControlSecret()).toBe(
				"persisted-by-the-cli",
			);
		});
	});

	/** Keyed by path. A memo keyed on anything coarser hands one file's secret to another. */
	it("keeps the secrets of two different config paths apart", () => {
		withFixture((dir) => {
			const one = seed(join(dir, "one.json"), TRAILING_COMMA);
			const two = seed(join(dir, "two.json"), TRAILING_COMMA);

			const secretOne = new Config(one).getLocalControlSecret();
			const secretTwo = new Config(two).getLocalControlSecret();

			expect(secretTwo).not.toBe(secretOne);
			expect(new Config(one).getLocalControlSecret()).toBe(secretOne);
			expect(new Config(two).getLocalControlSecret()).toBe(secretTwo);
		});
	});
});
