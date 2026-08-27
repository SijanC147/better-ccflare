/**
 * discovery-scheduler.test.ts
 *
 * Smoke tests for DiscoveryScheduler.runOnce().
 * Uses a temp projects directory and a minimal stub DatabaseOperations.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ResolverManager } from "@better-ccflare/core";
import { DiscoveryScheduler } from "../discovery-scheduler";

// ---------------------------------------------------------------------------
// Minimal stub for DatabaseOperations
// ---------------------------------------------------------------------------

function makeFakeDb(overrides: Partial<ReturnType<typeof makeStubDb>> = {}) {
	return makeStubDb(overrides);
}

function makeStubDb(overrides: Partial<{
	listProjects: () => Promise<unknown[]>;
	upsertProjectsFromDiscovery: (rows: unknown[]) => Promise<{ added: number; updated: number; unchanged: number }>;
	updateProject: (id: string, fields: unknown) => Promise<unknown>;
	rebuildResolver: () => Promise<void>;
	setDiscoveryRunner: (fn: (() => Promise<unknown>) | null) => void;
	getProjectsCaseSensitive: () => boolean;
	resolverManager: ResolverManager;
}> = {}) {
	const manager = new ResolverManager();
	return {
		listProjects: overrides.listProjects ?? (() => Promise.resolve([])),
		upsertProjectsFromDiscovery:
			overrides.upsertProjectsFromDiscovery ??
			(() => Promise.resolve({ added: 0, updated: 0, unchanged: 0 })),
		updateProject: overrides.updateProject ?? (() => Promise.resolve({})),
		rebuildResolver: overrides.rebuildResolver ?? (() => Promise.resolve()),
		setDiscoveryRunner: overrides.setDiscoveryRunner ?? (() => {}),
		getProjectsCaseSensitive:
			overrides.getProjectsCaseSensitive ?? (() => false),
		get resolverManager() {
			return overrides.resolverManager ?? manager;
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal JSONL session file for an encoded project dir. */
function createProjectDir(
	projectsDir: string,
	encodedName: string,
	cwd: string,
): void {
	const dir = path.join(projectsDir, encodedName);
	mkdirSync(dir, { recursive: true });
	const session = { cwd, timestamp: new Date().toISOString() };
	writeFileSync(path.join(dir, "session1.jsonl"), JSON.stringify(session) + "\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DiscoveryScheduler.runOnce()", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(path.join(os.tmpdir(), "discovery-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("empty projects dir → ScanResult all zeros", async () => {
		const db = makeFakeDb();
		const scheduler = new DiscoveryScheduler(db as never, 999_999, tmpDir);

		const result = await scheduler.runOnce();

		expect(result.added).toBe(0);
		expect(result.updated).toBe(0);
		expect(result.unchanged).toBe(0);
		expect(result.total).toBe(0);
	});

	test("valid project → upsertProjectsFromDiscovery called with canonical path", async () => {
		// Create a real project directory with a JSONL file.
		const canonicalPath = "/tmp/my-project";
		const encodedName = "-tmp-my-project";
		createProjectDir(tmpDir, encodedName, canonicalPath);

		const captured: unknown[] = [];
		const db = makeFakeDb({
			upsertProjectsFromDiscovery: (rows) => {
				captured.push(...rows);
				return Promise.resolve({ added: 1, updated: 0, unchanged: 0 });
			},
		});

		const scheduler = new DiscoveryScheduler(db as never, 999_999, tmpDir);
		const result = await scheduler.runOnce();

		expect(result.added).toBe(1);
		expect(result.total).toBeGreaterThanOrEqual(1);
		expect(captured.length).toBeGreaterThanOrEqual(1);
		const row = captured[0] as { canonicalPath: string };
		expect(row.canonicalPath).toBe(canonicalPath);
	});

	test("sentinel path is filtered out", async () => {
		// Create a project whose cwd resolves to /private/var/folders/... (tmpdir sentinel).
		const sentinelCwd = path.join(os.tmpdir(), "some-claude-thing");
		const encodedName = sentinelCwd.replace(/\//g, "-").replace(/^-/, "");
		createProjectDir(tmpDir, encodedName, sentinelCwd);

		const captured: unknown[] = [];
		const db = makeFakeDb({
			upsertProjectsFromDiscovery: (rows) => {
				captured.push(...rows);
				return Promise.resolve({ added: 0, updated: 0, unchanged: rows.length });
			},
		});

		const scheduler = new DiscoveryScheduler(db as never, 999_999, tmpDir);
		await scheduler.runOnce();

		// The sentinel path must not appear in the upsert call.
		const paths = captured.map((r) => (r as { canonicalPath: string }).canonicalPath);
		expect(paths).not.toContain(sentinelCwd);
	});

	test("start/stop registers and de-registers discovery runner", () => {
		let registered: (() => Promise<unknown>) | null | undefined;
		const db = makeFakeDb({
			setDiscoveryRunner: (fn) => {
				registered = fn;
			},
		});

		const scheduler = new DiscoveryScheduler(db as never, 999_999, tmpDir);
		scheduler.start();
		expect(typeof registered).toBe("function");

		scheduler.stop();
		expect(registered).toBeNull();
	});
});
