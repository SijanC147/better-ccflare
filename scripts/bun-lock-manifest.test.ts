import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";

/**
 * SB23-2530. `bun.lock` records each workspace's own manifest fields, and the Bun that CI pins
 * (1.3.14) never writes some of them, so CI cannot see them drift. This test can: it compares
 * the lock with every workspace manifest under whatever Bun is running.
 *
 * Measured 2026-10-01 in scratch copies of the tree at b9446617, one manifest field changed per
 * copy, then `bun install` and `bun install --frozen-lockfile` under Bun 1.3.14 and 1.4.2:
 *
 *   field changed     1.3.14 plain    1.4.2 plain    --frozen-lockfile, both versions
 *   version           not written     written        passes: drift invisible to CI
 *   bin               not written     not written    passes: drift invisible to everyone
 *   root name         not written     not written    passes: drift invisible to everyone
 *   dependency range  written         written        passes: dirty tree, CI blind
 *   peer / optional   written         written        passes: dirty tree, CI blind
 *   name (non-root)   written         written        FAILS: CI catches it
 *
 * `version` is the SB23-2491 instance: `apps/cli` sat at 3.23.0 in the lock against 3.24.0 in
 * its manifest for two releases. The root workspace's `name` was a live instance found by this
 * test: `ccflare` in the lock against `better-ccflare` in the manifest since the project rename
 * in 3e6644fb (2025-10-01), a year with every gate green. A lock generated from nothing names
 * it `better-ccflare` on both versions, and correcting it by hand was checked first: neither
 * version rewrites it back, and `--frozen-lockfile` passes on both.
 *
 * Two lock header fields are pinned here as well, because a regenerated lock changes them:
 *   - `lockfileVersion`: Bun 1.4.2 writes 2 when it generates a lock from nothing, and Bun
 *     1.3.14 cannot read version 2 (`UnknownLockfileVersion`, then `--frozen-lockfile` exits 1),
 *     so a lock regenerated on a newer Bun breaks CI and the Hextap release install. A plain
 *     `bun install` on either version keeps version 1.
 *   - `configVersion`: the tracked lock says 0 and a lock generated from nothing says 1 on both
 *     versions. It selects install defaults, so regenerating the lock changes how dependencies
 *     are laid out. Neither version changes it on a plain install.
 */

const repoRoot = path.resolve(import.meta.dir, "..");

type LockWorkspace = {
	name?: string;
	version?: string;
	bin?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
};

type Lock = {
	lockfileVersion: number;
	configVersion: number;
	workspaces: Record<string, LockWorkspace>;
};

type Manifest = LockWorkspace & { workspaces?: string[]; bin?: string | Record<string, string> };

function readLock(): Lock {
	const text = readFileSync(path.join(repoRoot, "bun.lock"), "utf8");
	// `bun.lock` is JSON with trailing commas, which is what this parser accepts.
	const { config, error } = ts.parseConfigFileTextToJson("bun.lock", text);
	if (error) throw new Error(`bun.lock did not parse: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`);
	return config as Lock;
}

function readManifest(workspace: string): Manifest {
	return JSON.parse(readFileSync(path.join(repoRoot, workspace, "package.json"), "utf8")) as Manifest;
}

/** A string `bin` is shorthand for one binary named after the package. */
function normaliseBin(manifest: Manifest): Record<string, string> | undefined {
	if (manifest.bin === undefined) return undefined;
	if (typeof manifest.bin === "string") return { [manifest.name ?? ""]: manifest.bin };
	return manifest.bin;
}

/** Empty maps and absent maps read the same, because the lock omits an empty one. */
function nonEmpty(map: Record<string, string> | undefined): Record<string, string> | undefined {
	return map !== undefined && Object.keys(map).length > 0 ? map : undefined;
}

describe("bun.lock agrees with every workspace manifest", () => {
	const lock = readLock();

	test("the lock lists exactly the workspaces the root manifest declares", () => {
		const root = readManifest("");
		const declared = new Set<string>([""]);
		for (const pattern of root.workspaces ?? []) {
			for (const match of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: repoRoot })) {
				declared.add(path.dirname(match));
			}
		}
		expect(Object.keys(lock.workspaces).sort()).toEqual([...declared].sort());
	});

	for (const workspace of Object.keys(readLock().workspaces).sort()) {
		test(`${workspace === "" ? "the root workspace" : workspace} matches its package.json`, () => {
			const manifest = readManifest(workspace);
			const entry = lock.workspaces[workspace] ?? {};
			// Each field compared on its own, so a failure names the field that drifted.
			expect({ field: "name", lock: entry.name }).toEqual({ field: "name", lock: manifest.name });
			// Neither Bun records the ROOT workspace's version, in the tracked lock or in a lock
			// generated from nothing on 1.3.14 or 1.4.2, so there is nothing to compare there.
			const version = workspace === "" ? undefined : manifest.version;
			expect({ field: "version", lock: entry.version }).toEqual({ field: "version", lock: version });
			expect({ field: "bin", lock: entry.bin }).toEqual({ field: "bin", lock: normaliseBin(manifest) });
			for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
				expect({ field, lock: nonEmpty(entry[field]) }).toEqual({ field, lock: nonEmpty(manifest[field]) });
			}
		});
	}

	test("the lock format is one the pinned Bun can read", () => {
		// Bun 1.3.14 refuses lockfileVersion 2, which Bun 1.4.2 writes when it generates a lock
		// from nothing. Regenerate on the pinned Bun, or move the pin first (ci.yml and
		// .hextap.json `runtime_version`).
		expect(lock.lockfileVersion).toBe(1);
	});

	test("the lock keeps the install defaults it was created with", () => {
		// configVersion 0 is what this lock has always said. A lock generated from nothing says
		// 1 on both Bun versions, which changes install defaults; that is a decision for a PR of
		// its own, not a side effect of deleting the lock.
		expect(lock.configVersion).toBe(0);
	});
});
