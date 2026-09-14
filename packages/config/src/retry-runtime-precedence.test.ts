import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

/**
 * These tests pin the reason `retry_attempts`, `retry_delay_ms` and
 * `retry_backoff` were inert even after something read them.
 *
 * apps/server built its RuntimeConfig field by field with
 * `config.get(key, default)`. `get` reads the config file alone, so the three
 * RETRY_* environment variables were parsed in this package and then thrown
 * away. `get` also persists its default into the config file on a miss, so the
 * first boot wrote `retry_attempts: 3` to disk and every later boot preferred
 * that written value over the operator's environment variable.
 *
 * `getRuntime()` is the resolver that applies the documented precedence.
 */

const RETRY_ENV_KEYS = [
	"RETRY_ATTEMPTS",
	"RETRY_DELAY_MS",
	"RETRY_BACKOFF",
] as const;

let saved: Record<string, string | undefined> = {};

function makeConfig(initial?: Record<string, unknown>): {
	config: Config;
	path: string;
	cleanup: () => void;
} {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-retry-"));
	const path = join(dir, "config.json");
	if (initial) writeFileSync(path, JSON.stringify(initial));
	return {
		config: new Config(path),
		path,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

beforeEach(() => {
	saved = {};
	for (const key of RETRY_ENV_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of RETRY_ENV_KEYS) {
		const value = saved[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("retry settings precedence", () => {
	it("uses the documented defaults when nothing is set", () => {
		const { config, cleanup } = makeConfig();
		try {
			const runtime = config.getRuntime();
			expect(runtime.retry.attempts).toBe(3);
			expect(runtime.retry.delayMs).toBe(1000);
			expect(runtime.retry.backoff).toBe(2);
		} finally {
			cleanup();
		}
	});

	it("honours RETRY_ATTEMPTS, RETRY_DELAY_MS and RETRY_BACKOFF", () => {
		process.env.RETRY_ATTEMPTS = "7";
		process.env.RETRY_DELAY_MS = "250";
		process.env.RETRY_BACKOFF = "1.5";
		const { config, cleanup } = makeConfig();
		try {
			const runtime = config.getRuntime();
			expect(runtime.retry.attempts).toBe(7);
			expect(runtime.retry.delayMs).toBe(250);
			expect(runtime.retry.backoff).toBe(1.5);
		} finally {
			cleanup();
		}
	});

	it("lets the config file outrank the environment", () => {
		process.env.RETRY_ATTEMPTS = "7";
		const { config, cleanup } = makeConfig({ retry_attempts: 4 });
		try {
			expect(config.getRuntime().retry.attempts).toBe(4);
		} finally {
			cleanup();
		}
	});

	it("config.get discards the environment, which is why the server must not use it", () => {
		// This is the defect, asserted rather than described. If someone
		// rebuilds RuntimeConfig out of config.get calls again, this fails.
		process.env.RETRY_ATTEMPTS = "7";
		const { config, cleanup } = makeConfig();
		try {
			// getRuntime first, so this reads a config file that config.get has
			// not yet written to. See the next test for why the order matters.
			expect(config.getRuntime().retry.attempts).toBe(7);
			expect(config.get("retry_attempts", 3)).toBe(3);
		} finally {
			cleanup();
		}
	});

	it("config.get writes its default to disk and permanently shadows the environment", () => {
		// The half of the defect that made it survive a restart. `get` calls
		// `set` on a miss and `set` saves immediately, so merely reading the key
		// through `get` writes 3 into the config file. The file outranks the
		// environment, so from that moment the operator's RETRY_ATTEMPTS loses,
		// in this process and in every later one, to a value nobody chose.
		process.env.RETRY_ATTEMPTS = "7";
		const { config, path, cleanup } = makeConfig();
		try {
			expect(config.getRuntime().retry.attempts).toBe(7);

			config.get("retry_attempts", 3);

			const onDisk = JSON.parse(readFileSync(path, "utf8"));
			expect(onDisk.retry_attempts).toBe(3);
			expect(config.getRuntime().retry.attempts).toBe(3);
			expect(new Config(path).getRuntime().retry.attempts).toBe(3);
		} finally {
			cleanup();
		}
	});
});
