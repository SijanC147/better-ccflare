import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RETRY_BOUNDS } from "@better-ccflare/core";
import { Config } from "./index";
import { validateRuntimeRetry } from "./runtime-validation";

/**
 * SB23-1980. The three `retry_*` keys reached `RuntimeConfig` through a bare
 * `typeof value === "number"` on the config file and a bare `parseInt` on the
 * environment, with no range check at either. These tests pin the clamp, and
 * in particular pin that an out-of-range value does NOT become the default.
 *
 * The distinction matters because the default sits at the aggressive end for
 * this family: 3 attempts is more than 0. A fallback-to-default would turn an
 * operator's request for fewer retries into more of them, which is the defect
 * PR #113 fixed at the consumer (SB23-1959).
 */

const RETRY_ENV_KEYS = [
	"RETRY_ATTEMPTS",
	"RETRY_DELAY_MS",
	"RETRY_BACKOFF",
] as const;

let saved: Record<string, string | undefined> = {};

function makeConfig(initial?: Record<string, unknown>): {
	config: Config;
	cleanup: () => void;
} {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-retry-range-"));
	const path = join(dir, "config.json");
	if (initial) writeFileSync(path, JSON.stringify(initial));
	return {
		config: new Config(path),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

const DEFAULTS = { attempts: 3, delayMs: 1000, backoff: 2 };

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

describe("validateRuntimeRetry", () => {
	it("leaves an in-range value alone and reports no adjustment", () => {
		const retry = { attempts: 2, delayMs: 500, backoff: 1.5 };
		const adjustments = validateRuntimeRetry(retry, { ...DEFAULTS });
		expect(adjustments).toEqual([]);
		expect(retry).toEqual({ attempts: 2, delayMs: 500, backoff: 1.5 });
	});

	it("accepts retry_attempts 0, which is how an operator asks for no retries", () => {
		const retry = { attempts: 0, delayMs: 1000, backoff: 2 };
		const adjustments = validateRuntimeRetry(retry, { ...DEFAULTS });
		expect(adjustments).toEqual([]);
		// The value that matters. `min: 1`, copied from db_retry_attempts, would
		// have moved this to 1, and the old code moved it to 3.
		expect(retry.attempts).toBe(0);
	});

	it("clamps a negative attempts count to the minimum, not to the default", () => {
		const retry = { attempts: -1, delayMs: 1000, backoff: 2 };
		validateRuntimeRetry(retry, { ...DEFAULTS });
		expect(retry.attempts).toBe(RETRY_BOUNDS.attempts.min);
		expect(retry.attempts).not.toBe(DEFAULTS.attempts);
	});

	it("clamps an attempts count above the ceiling down to the ceiling", () => {
		const retry = { attempts: 99, delayMs: 1000, backoff: 2 };
		const adjustments = validateRuntimeRetry(retry, { ...DEFAULTS });
		expect(retry.attempts).toBe(RETRY_BOUNDS.attempts.max);
		expect(adjustments).toHaveLength(1);
		expect(adjustments[0].received).toBe(99);
		expect(adjustments[0].applied).toBe(RETRY_BOUNDS.attempts.max);
		expect(adjustments[0].key).toContain("retry_attempts");
	});

	it("clamps a negative delay to the minimum, not to the default", () => {
		const retry = { attempts: 3, delayMs: -500, backoff: 2 };
		validateRuntimeRetry(retry, { ...DEFAULTS });
		expect(retry.delayMs).toBe(RETRY_BOUNDS.delayMs.min);
		expect(retry.delayMs).not.toBe(DEFAULTS.delayMs);
	});

	it("raises a backoff below 1 to 1, not to the default of 2", () => {
		const retry = { attempts: 3, delayMs: 1000, backoff: 0.5 };
		validateRuntimeRetry(retry, { ...DEFAULTS });
		// 0.5 would shrink the delay on each retry. 1 is a constant delay, the
		// nearest legal reading. 2 would be twice what was asked for.
		expect(retry.backoff).toBe(1);
		expect(retry.backoff).not.toBe(DEFAULTS.backoff);
	});

	it("keeps a fractional backoff, which is a legitimate multiplier", () => {
		const retry = { attempts: 3, delayMs: 1000, backoff: 1.5 };
		validateRuntimeRetry(retry, { ...DEFAULTS });
		expect(retry.backoff).toBe(1.5);
	});

	it("rounds a fractional attempts count to a whole number", () => {
		const retry = { attempts: 2.6, delayMs: 1000, backoff: 2 };
		validateRuntimeRetry(retry, { ...DEFAULTS });
		expect(retry.attempts).toBe(3);
	});

	it("falls back to the default for NaN and says so in the adjustment", () => {
		// The one input with no direction to clamp toward. It reaches here from
		// `parseInt("abc", 10)`, and `typeof NaN === "number"` let it past the
		// config-file check too.
		const retry = { attempts: Number.NaN, delayMs: 1000, backoff: 2 };
		const adjustments = validateRuntimeRetry(retry, { ...DEFAULTS });
		expect(retry.attempts).toBe(DEFAULTS.attempts);
		expect(adjustments).toHaveLength(1);
		expect(adjustments[0].reason).toBe("not a number");
	});

	it("clamps Infinity to the ceiling rather than treating it as unset", () => {
		const retry = {
			attempts: Number.POSITIVE_INFINITY,
			delayMs: 1000,
			backoff: 2,
		};
		validateRuntimeRetry(retry, { ...DEFAULTS });
		expect(retry.attempts).toBe(RETRY_BOUNDS.attempts.max);
	});
});

describe("getRuntime applies the bounds to both sources", () => {
	it("clamps a config-file value", () => {
		const { config, cleanup } = makeConfig({ retry_attempts: 99 });
		try {
			expect(config.getRuntime().retry.attempts).toBe(
				RETRY_BOUNDS.attempts.max,
			);
		} finally {
			cleanup();
		}
	});

	it("keeps retry_attempts 0 from the config file", () => {
		const { config, cleanup } = makeConfig({ retry_attempts: 0 });
		try {
			// The acceptance line of SB23-1980: not 3.
			expect(config.getRuntime().retry.attempts).toBe(0);
		} finally {
			cleanup();
		}
	});

	it("clamps an environment value", () => {
		process.env.RETRY_DELAY_MS = "-500";
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getRuntime().retry.delayMs).toBe(RETRY_BOUNDS.delayMs.min);
		} finally {
			cleanup();
		}
	});

	it("falls back to the default for an unparseable environment value", () => {
		// parseInt("abc", 10) is NaN, which the old bare check admitted.
		process.env.RETRY_ATTEMPTS = "abc";
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getRuntime().retry.attempts).toBe(3);
		} finally {
			cleanup();
		}
	});

	it("clamps the config file after it has overridden the environment", () => {
		// Precedence first, bounds second. If the clamp ran before the file
		// override, this would read 2 rather than the ceiling.
		process.env.RETRY_ATTEMPTS = "2";
		const { config, cleanup } = makeConfig({ retry_attempts: 99 });
		try {
			expect(config.getRuntime().retry.attempts).toBe(
				RETRY_BOUNDS.attempts.max,
			);
		} finally {
			cleanup();
		}
	});
});
