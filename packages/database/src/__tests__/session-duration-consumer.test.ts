import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "@better-ccflare/config";
import { TIME_CONSTANTS } from "@better-ccflare/core";
import { DatabaseOperations } from "../database-operations";

/**
 * SB23-2040. `updateAccountUsage` read the resolved session window with `||`,
 * so a configured `session_duration_ms: 0` was discarded in favour of five
 * hours before it ever reached `AccountRepository.incrementUsage`.
 *
 * The clamp in `getRuntime()` is tested in `packages/config`, but that only
 * proves 0 survives into `RuntimeConfig`. These tests prove the consumer reads
 * it, which is the half that was actually broken: mutating `??` back to `||`
 * must fail here.
 *
 * The repository is stubbed rather than driven through SQL because the value
 * under test is the argument, not what the SQL does with it. What the SQL does
 * with it is argued in `packages/core/src/session-bounds.ts`.
 */

type UsageSpy = { incrementUsage: (id: string, durationMs: number) => void };

let dir: string;
let savedDatabaseUrl: string | undefined;
let savedConfigHome: string | undefined;

function makeOps(runtime?: Partial<RuntimeConfig>): {
	ops: DatabaseOperations;
	calls: number[];
} {
	const ops = new DatabaseOperations(join(dir, "test.db"));
	const calls: number[] = [];

	// Replace the repository before any call, so nothing reaches real SQL. The
	// cast is the narrowest one that names the member being replaced.
	(ops as unknown as { accounts: UsageSpy }).accounts = {
		incrementUsage: (_id: string, durationMs: number) => {
			calls.push(durationMs);
		},
	};

	if (runtime) ops.setRuntimeConfig(runtime as RuntimeConfig);
	return { ops, calls };
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "better-ccflare-session-consumer-"));
	// Cleared so the constructor takes the SQLite path rather than PostgreSQL,
	// and pointed at a temp tree so the lazy `new Config()` cannot read the
	// operator's real config file.
	savedDatabaseUrl = process.env.DATABASE_URL;
	savedConfigHome = process.env.XDG_CONFIG_HOME;
	delete process.env.DATABASE_URL;
	process.env.XDG_CONFIG_HOME = dir;
});

afterEach(() => {
	if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
	else process.env.DATABASE_URL = savedDatabaseUrl;
	if (savedConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = savedConfigHome;
	rmSync(dir, { recursive: true, force: true });
});

describe("updateAccountUsage passes the configured session window through", () => {
	it("passes 0 rather than substituting five hours", async () => {
		const { ops, calls } = makeOps({ sessionDurationMs: 0 });

		await ops.updateAccountUsage("acct-1");

		expect(calls).toEqual([0]);
		expect(calls[0]).not.toBe(
			TIME_CONSTANTS.ANTHROPIC_SESSION_DURATION_DEFAULT,
		);
	});

	it("passes a small non-zero window unchanged", async () => {
		const { ops, calls } = makeOps({ sessionDurationMs: 1 });

		await ops.updateAccountUsage("acct-1");

		expect(calls).toEqual([1]);
	});

	it("falls back to five hours only when no runtime was ever set", async () => {
		const { ops, calls } = makeOps();

		await ops.updateAccountUsage("acct-1");

		expect(calls).toEqual([TIME_CONSTANTS.ANTHROPIC_SESSION_DURATION_DEFAULT]);
	});
});
