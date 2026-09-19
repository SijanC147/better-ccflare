/**
 * SB23-2355. `ResolverSnapshot.resolve` used to end in `path.resolve`, which
 * completes a non-absolute input against `process.cwd()`. The cwd belongs to
 * the proxy process, so the attribution a request received was a function of
 * where the operator started the server: invisible to every client and written
 * to no log.
 *
 * Measured 2026-09-19 against a `VACUUM INTO` copy of the live database with
 * 787 project rows. `"~/Code/tab-genius"` resolved to null under the Homebrew
 * service's cwd of `/`, and to `da27e8303a860a36` under a cwd inside a
 * worktree that had a `projects` row. Non-null, plausible, and wrong.
 *
 * The first block is the one that kills the mutation, and it does so without
 * touching `process.cwd()` at all: the snapshot holds one project whose
 * canonical path IS the current working directory, so removing the guard makes
 * every relative input prefix-match that project. A test that only ever ran in
 * one directory, with no project row for it, would pass either way.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResolverSnapshot } from "../project-resolver";

const CWD_PROJECT_ID = "cwd0000000000000";

/**
 * A snapshot in which the process's own working directory is a real project.
 * Stored canonical paths are lowercased when case-insensitive, which is what
 * darwin installs run, so the fixture mirrors that rather than the literal.
 */
function snapshotWhereCwdIsAProject(cwd: string = process.cwd()) {
	return ResolverSnapshot.build(
		[
			{
				id: CWD_PROJECT_ID,
				canonicalPath: cwd.toLowerCase(),
				enabled: true,
			},
		],
		[],
		{ caseSensitive: false, homeDir: null },
	);
}

describe("a non-absolute hint never resolves (SB23-2355)", () => {
	// Each of these reaches the resolver today: a tilde path from the 19 configs
	// counted for SB23-2268, a plain relative path, and a bare project NAME,
	// which arrives through the `cwdHint ?? project` fallback at
	// packages/proxy/src/proxy.ts:530 and response-handler.ts:222.
	const NON_ABSOLUTE = [
		"~/Code/tab-genius",
		"~",
		"Code/tab-genius",
		"./Code/tab-genius",
		"../sibling",
		"tab-genius",
	];

	for (const raw of NON_ABSOLUTE) {
		test(`${JSON.stringify(raw)} resolves to all nulls even when cwd is itself a project`, () => {
			const snapshot = snapshotWhereCwdIsAProject();
			const result = snapshot.resolve(raw);

			// Without the guard, path.resolve lands every one of these under the
			// cwd, which this snapshot has a project row for, so projectId would
			// be CWD_PROJECT_ID. The negative assertion is what makes the
			// mutation die rather than merely reporting null.
			expect(result.projectId).toBeNull();
			expect(result.projectId).not.toBe(CWD_PROJECT_ID);
			expect(result.worktreePath).toBeNull();
			expect(result.matchedRuleId).toBeNull();
			expect(result.matchedProjectPath).toBeNull();
		});
	}

	test("a worktree rule cannot rescue a non-absolute hint either", () => {
		// The rule walk runs before the prefix walk, so a guard placed after it
		// would still attribute. A glob matching anything proves the guard runs
		// first.
		const snapshot = ResolverSnapshot.build(
			[{ id: CWD_PROJECT_ID, canonicalPath: "/anything", enabled: true }],
			[
				{
					id: "rule-any",
					kind: "glob",
					pattern: "**",
					parentProjectId: CWD_PROJECT_ID,
					priority: 100,
					enabled: true,
					compileError: null,
				},
			],
			{ caseSensitive: false, homeDir: null },
		);

		expect(snapshot.resolve("~/Code/tab-genius").matchedRuleId).toBeNull();
		expect(snapshot.resolve("~/Code/tab-genius").projectId).toBeNull();
	});
});

describe("an absolute hint is unchanged (SB23-2355)", () => {
	const ABSOLUTE = "/users/someone/code/widget";

	function snapshotFor(canonicalPath: string) {
		return ResolverSnapshot.build(
			[{ id: "widget00000000000", canonicalPath, enabled: true }],
			[],
			{ caseSensitive: false, homeDir: null },
		);
	}

	test("an exact absolute path still resolves to its project", () => {
		const result = snapshotFor(ABSOLUTE).resolve(ABSOLUTE);
		expect(result.projectId).toBe("widget00000000000");
		expect(result.matchedProjectPath).toBe(ABSOLUTE);
	});

	test("an absolute path below the project still prefix-matches", () => {
		const result = snapshotFor(ABSOLUTE).resolve(`${ABSOLUTE}/packages/core`);
		expect(result.projectId).toBe("widget00000000000");
	});

	test("an absolute path with a trailing slash still resolves", () => {
		const result = snapshotFor(ABSOLUTE).resolve(`${ABSOLUTE}/`);
		expect(result.projectId).toBe("widget00000000000");
	});

	test("an absolute path with a redundant segment is still normalized", () => {
		// path.isAbsolute is a syntactic check, so it must not short-circuit the
		// normalization that follows it.
		const result = snapshotFor(ABSOLUTE).resolve(
			"/users/someone/code/./other/../widget",
		);
		expect(result.projectId).toBe("widget00000000000");
	});

	test("blank and nullish input keep returning all nulls", () => {
		const snapshot = snapshotFor(ABSOLUTE);
		for (const raw of [null, undefined, "", "   "]) {
			expect(snapshot.resolve(raw).projectId).toBeNull();
		}
	});
});

describe("the result does not depend on process.cwd() (SB23-2355)", () => {
	test("the same non-absolute input is null from two different directories", () => {
		// Acceptance 1 asks for two working directories rather than one reading.
		// The chdir is asserted to have taken effect before anything is measured:
		// a chdir that silently failed would produce a null that proves nothing.
		const original = process.cwd();
		const scratch = realpathSync(mkdtempSync(join(tmpdir(), "btcf-2355-")));

		expect(scratch.length).toBeGreaterThan(0);
		expect(scratch).not.toBe(original);

		const readings: Array<{ cwd: string; projectId: string | null }> = [];
		try {
			for (const dir of [original, scratch]) {
				process.chdir(dir);
				const observed = realpathSync(process.cwd());
				expect(observed).toBe(dir);

				// Rebuild per directory so the cwd of the moment is a project row.
				const snapshot = snapshotWhereCwdIsAProject(observed);
				readings.push({
					cwd: observed,
					projectId: snapshot.resolve("~/Code/tab-genius").projectId,
				});
			}
		} finally {
			process.chdir(original);
			rmSync(scratch, { recursive: true, force: true });
		}

		expect(readings).toHaveLength(2);
		expect(readings[0]?.cwd).not.toBe(readings[1]?.cwd);
		expect(readings[0]?.projectId).toBeNull();
		expect(readings[1]?.projectId).toBeNull();
	});
});
