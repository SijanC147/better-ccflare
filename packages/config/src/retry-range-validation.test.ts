import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RETRY_BOUNDS } from "@better-ccflare/core";
import { logBus } from "@better-ccflare/logger";
import type { LogEvent } from "@better-ccflare/types";
import { Config } from "./index";
import {
	resetRetryWarningsForTest,
	validateRuntimeRetry,
} from "./runtime-validation";

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

/**
 * Runs `fn` and returns the WARN messages it put on the log bus.
 *
 * Counting emitted warnings is the only way to pin the dedupe: every other
 * observable, including the returned adjustments, is identical with and without
 * it.
 */
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

	it("truncates a fractional attempts count DOWN, never up", () => {
		const retry = { attempts: 2.6, delayMs: 1000, backoff: 2 };
		validateRuntimeRetry(retry, { ...DEFAULTS });
		// 2, not 3. Rounding up would grant more attempts than were asked for.
		expect(retry.attempts).toBe(2);
	});

	it("does not flip transport retry on by rounding 1.6 up to 2", () => {
		// The case that makes the direction load-bearing. The consumer resolves
		// attempts with `Math.max(1, Math.floor(...))` and sets
		// `enabled = maxAttempts > 1` (packages/core/src/constants.ts:273), so
		// 1.6 floors to 1 and retry stays OFF. Rounding to 2 would turn it ON,
		// which is the inversion this issue exists to prevent.
		const retry = { attempts: 1.6, delayMs: 1000, backoff: 2 };
		validateRuntimeRetry(retry, { ...DEFAULTS });
		expect(retry.attempts).toBe(1);
		expect(retry.attempts).not.toBe(2);
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

	it("warns once for one misconfiguration, however many times it is called", () => {
		// The assertion the dedupe actually needs. The test below pins that the
		// RETURN value is not deduplicated, which was never the half at risk:
		// removing the dedupe entirely leaves that one green. This counts WARN
		// events on the log bus, so deleting the guard in warnOnce fails here.
		resetRetryWarningsForTest();
		const warnings = captureWarnings(() => {
			for (let i = 0; i < 5; i++) {
				validateRuntimeRetry(
					{ attempts: 99, delayMs: 1000, backoff: 2 },
					{ ...DEFAULTS },
				);
			}
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("retry_attempts");
	});

	it("warns again when the bad value changes to a different bad value", () => {
		// The dedupe key carries the values, not just the setting, so a second
		// distinct misconfiguration is not swallowed by the first.
		resetRetryWarningsForTest();
		const warnings = captureWarnings(() => {
			validateRuntimeRetry(
				{ attempts: 99, delayMs: 1000, backoff: 2 },
				{ ...DEFAULTS },
			);
			validateRuntimeRetry(
				{ attempts: -7, delayMs: 1000, backoff: 2 },
				{ ...DEFAULTS },
			);
		});
		expect(warnings).toHaveLength(2);
	});

	it("returns the adjustment on every call, not only the first", () => {
		// getRuntime() is called per request in the OAuth handlers and on every
		// read of the retry config card, so this function runs repeatedly. The
		// warning is deduplicated; the return value must not be, or a caller that
		// reports adjustments would see them vanish after the first request.
		resetRetryWarningsForTest();
		const first = validateRuntimeRetry(
			{ attempts: 99, delayMs: 1000, backoff: 2 },
			{ ...DEFAULTS },
		);
		const second = validateRuntimeRetry(
			{ attempts: 99, delayMs: 1000, backoff: 2 },
			{ ...DEFAULTS },
		);
		expect(first).toHaveLength(1);
		expect(second).toEqual(first);
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
		// A second, VALID env var in the same call. Without it this test passes
		// for the wrong reason: expecting 3 for attempts is indistinguishable
		// from the no-env default, so deleting the whole RETRY_ATTEMPTS parse
		// from getRuntime leaves it green. Asserting that delayMs still picks up
		// 250 proves the environment path actually ran.
		process.env.RETRY_DELAY_MS = "250";
		const { config, cleanup } = makeConfig();
		try {
			const runtime = config.getRuntime();
			expect(runtime.retry.attempts).toBe(3);
			expect(runtime.retry.delayMs).toBe(250);
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
