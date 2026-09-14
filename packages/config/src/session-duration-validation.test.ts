import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_DURATION_BOUNDS, TIME_CONSTANTS } from "@better-ccflare/core";
import { logBus } from "@better-ccflare/logger";
import type { LogEvent } from "@better-ccflare/types";
import { Config } from "./index";
import {
	resetRetryWarningsForTest,
	validateRuntimeSessionDuration,
} from "./runtime-validation";

/**
 * SB23-2040. `session_duration_ms` reached `RuntimeConfig` with no range check
 * at either source, and the consumer at
 * `packages/database/src/database-operations.ts` read it with `||`, so a
 * configured 0 became five hours.
 *
 * Every case below asserts the outcome is NOT the default, because the default
 * sits at the aggressive end for this setting: five hours is the longest
 * window, and the values being mishandled are all requests for the shortest.
 */

const DEFAULT_MS = TIME_CONSTANTS.SESSION_DURATION_DEFAULT;
const MIN = SESSION_DURATION_BOUNDS.min;

let savedEnv: string | undefined;

function makeConfig(initial?: Record<string, unknown>): {
	config: Config;
	cleanup: () => void;
} {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-session-duration-"));
	const path = join(dir, "config.json");
	if (initial) writeFileSync(path, JSON.stringify(initial));
	return {
		config: new Config(path),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

/**
 * Runs `fn` and returns the WARN messages it put on the log bus.
 *
 * Counting emitted warnings is the only way to pin the dedupe: every other
 * observable, the returned adjustment included, is identical with and without
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
	savedEnv = process.env.SESSION_DURATION_MS;
	delete process.env.SESSION_DURATION_MS;
	resetRetryWarningsForTest();
});

afterEach(() => {
	if (savedEnv === undefined) delete process.env.SESSION_DURATION_MS;
	else process.env.SESSION_DURATION_MS = savedEnv;
	resetRetryWarningsForTest();
});

describe("validateRuntimeSessionDuration", () => {
	it("leaves 0 alone, because 0 means no session grouping", () => {
		const runtime = { sessionDurationMs: 0 };
		const adjustment = validateRuntimeSessionDuration(runtime, DEFAULT_MS);

		expect(runtime.sessionDurationMs).toBe(0);
		expect(runtime.sessionDurationMs).not.toBe(DEFAULT_MS);
		expect(adjustment).toBeNull();
	});

	it("clamps a negative to the minimum, not to the default", () => {
		const runtime = { sessionDurationMs: -1 };
		const adjustment = validateRuntimeSessionDuration(runtime, DEFAULT_MS);

		expect(runtime.sessionDurationMs).toBe(MIN);
		expect(runtime.sessionDurationMs).not.toBe(DEFAULT_MS);
		expect(adjustment?.received).toBe(-1);
		expect(adjustment?.applied).toBe(MIN);
	});

	it("applies the default for NaN and names it in the warning", () => {
		const runtime = { sessionDurationMs: Number.NaN };
		const adjustments: Array<
			NonNullable<ReturnType<typeof validateRuntimeSessionDuration>>
		> = [];
		const warnings = captureWarnings(() => {
			const result = validateRuntimeSessionDuration(runtime, DEFAULT_MS);
			if (result) adjustments.push(result);
		});

		expect(runtime.sessionDurationMs).toBe(DEFAULT_MS);
		expect(adjustments[0]?.reason).toBe("not a number");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("session_duration_ms");
		expect(warnings[0]).toContain("SESSION_DURATION_MS");
		expect(warnings[0]).toContain("not a number");
		expect(warnings[0]).toContain(String(DEFAULT_MS));
	});

	it("floors a fraction rather than rounding it up", () => {
		// 0.6 rounds to 1 and floors to 0. Flooring is the direction that cannot
		// hand back a longer window than the operator wrote.
		const runtime = { sessionDurationMs: 0.6 };
		validateRuntimeSessionDuration(runtime, DEFAULT_MS);

		expect(runtime.sessionDurationMs).toBe(0);
	});

	it("does not clamp a very large value, because there is no maximum", () => {
		const week = 7 * 24 * 60 * 60 * 1000;
		const runtime = { sessionDurationMs: week * 52 };
		const adjustment = validateRuntimeSessionDuration(runtime, DEFAULT_MS);

		expect(runtime.sessionDurationMs).toBe(week * 52);
		expect(adjustment).toBeNull();
	});

	it("warns once per distinct misconfiguration, not once per call", () => {
		const warnings = captureWarnings(() => {
			for (let i = 0; i < 5; i++) {
				validateRuntimeSessionDuration({ sessionDurationMs: -1 }, DEFAULT_MS);
			}
		});

		expect(warnings).toHaveLength(1);

		// A different bad value is a different misconfiguration and warns again,
		// rather than being swallowed by the first.
		const second = captureWarnings(() => {
			validateRuntimeSessionDuration({ sessionDurationMs: -2 }, DEFAULT_MS);
		});
		expect(second).toHaveLength(1);
	});
});

describe("getRuntime() resolves session_duration_ms through the clamp", () => {
	it("keeps a config-file 0 instead of substituting five hours", () => {
		const { config, cleanup } = makeConfig({ session_duration_ms: 0 });
		try {
			expect(config.getRuntime().sessionDurationMs).toBe(0);
			expect(config.getRuntime().sessionDurationMs).not.toBe(DEFAULT_MS);
		} finally {
			cleanup();
		}
	});

	it("keeps an environment 0 instead of substituting five hours", () => {
		process.env.SESSION_DURATION_MS = "0";
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getRuntime().sessionDurationMs).toBe(0);
		} finally {
			cleanup();
		}
	});

	it("clamps a config-file negative to the minimum", () => {
		const { config, cleanup } = makeConfig({ session_duration_ms: -5000 });
		try {
			expect(config.getRuntime().sessionDurationMs).toBe(MIN);
			expect(config.getRuntime().sessionDurationMs).not.toBe(DEFAULT_MS);
		} finally {
			cleanup();
		}
	});

	it("applies the default for an unparseable SESSION_DURATION_MS", () => {
		// `parseInt("abc", 10)` is NaN, and `typeof NaN === "number"`, so nothing
		// before this pass rejected it.
		process.env.SESSION_DURATION_MS = "abc";
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getRuntime().sessionDurationMs).toBe(DEFAULT_MS);
		} finally {
			cleanup();
		}
	});

	it("lets the config file's 0 win over a valid environment value", () => {
		// The file is applied after the environment, and the clamp runs after
		// both, so an explicit 0 in the file must survive the whole chain.
		process.env.SESSION_DURATION_MS = "60000";
		const { config, cleanup } = makeConfig({ session_duration_ms: 0 });
		try {
			expect(config.getRuntime().sessionDurationMs).toBe(0);
		} finally {
			cleanup();
		}
	});
});
