import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@better-ccflare/config";
import { TIME_CONSTANTS } from "@better-ccflare/core";
import { createConfigHandlers } from "../config";

/**
 * `GET /api/config` used to read `settings.sessionDurationMs` off the object
 * from `getAllSettings()`, which holds the snake_case config data. That
 * property was therefore always `undefined` and the endpoint reported the
 * fallback on every install, a stock one included.
 *
 * The two constants differ by a factor of five, so the endpoint said one hour
 * while the session logic used five (SB23-2048). These tests assert the
 * reported value against what the config resolves, never against a literal, so
 * they cannot pass by matching whichever constant happens to be wired in.
 */

const tmpDirs: string[] = [];

function configWithFile(data: Record<string, unknown>): Config {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-session-"));
	tmpDirs.push(dir);
	const path = join(dir, "config.json");
	writeFileSync(path, JSON.stringify(data));
	return new Config(path);
}

async function reportedSessionDuration(config: Config): Promise<number> {
	const handlers = createConfigHandlers(config, {
		port: 8080,
		tlsEnabled: false,
	});
	const body = (await handlers.getConfig().json()) as {
		sessionDurationMs: number;
	};
	return body.sessionDurationMs;
}

afterEach(() => {
	while (tmpDirs.length > 0) {
		rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
	}
});

describe("GET /api/config session duration", () => {
	it("reports the configured value, not the fallback", async () => {
		// Deliberately not a round number and not either constant, so a
		// regression cannot pass by coincidence.
		const configured = 7_200_123;
		const config = configWithFile({ session_duration_ms: configured });

		expect(await reportedSessionDuration(config)).toBe(configured);
	});

	it("agrees with the value the session logic uses", async () => {
		// The property that matters. Asserted against getRuntime() rather than a
		// literal: if the two ever diverge again, this fails whatever the numbers
		// happen to be.
		const config = configWithFile({ session_duration_ms: 1_234_567 });

		expect(await reportedSessionDuration(config)).toBe(
			config.getRuntime().sessionDurationMs,
		);
	});

	it("agrees with the session logic on a stock install too", async () => {
		// The old defect was NOT invisible on defaults. It reported the one-hour
		// fallback while the logic used the five-hour default, so an install that
		// had configured nothing was still wrong by a factor of five.
		const config = configWithFile({});

		const reported = await reportedSessionDuration(config);
		expect(reported).toBe(config.getRuntime().sessionDurationMs);
		expect(reported).not.toBe(
			TIME_CONSTANTS.ANTHROPIC_SESSION_DURATION_FALLBACK,
		);
	});

	it("reports a configured 0 as 0 rather than reading it as absent", async () => {
		// SB23-2040 made 0 a legal value meaning every request opens a new
		// session. A `||` anywhere on this path would turn it back into a default.
		const config = configWithFile({ session_duration_ms: 0 });

		expect(await reportedSessionDuration(config)).toBe(0);
	});
});
