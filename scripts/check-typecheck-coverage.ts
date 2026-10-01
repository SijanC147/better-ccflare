#!/usr/bin/env bun
/**
 * Fails when a tracked TypeScript file is in no typecheck target the root `typecheck` chain runs.
 *
 * SB23-3758. Coverage of the typecheck chain was checked only by hand. SB23-2304 (#277) and
 * SB23-3689 (#282) each closed a gap and each ran a recount that found files its issue had not
 * named: SB23-3689 listed 4 ungated files and the recount at `41bdcaf5` found 8. Nothing stopped
 * the next `bench/`-style directory or root-level script from sitting outside every target, and
 * `bun run typecheck` cannot see it, because a file no program includes produces no diagnostic.
 *
 * WHAT IT COMPUTES:
 *   tracked   `git ls-files` for `*.ts`, `*.tsx`, `*.mts`, `*.cts`
 *   covered   the union, over every tsconfig the root `typecheck` script REACHES through its
 *             `&&` chain, of that program's source files. That is the list
 *             `tsc --listFilesOnly -p <config>` prints: root files plus everything they import.
 *             The chain is walked from `typecheck` itself, never from every `typecheck:*`
 *             defined, so a target nothing invokes contributes nothing (SB23-2387's shape).
 *   ungated   tracked minus covered
 *
 * IT FAILS (exit 1) WHEN:
 *   - an ungated file is not in the allowlist;
 *   - an allowlist entry is not ungated, either because a target now covers it or because it is
 *     no longer tracked, so the allowlist cannot rot into a list of files that are fine;
 *   - a `typecheck` or `typecheck:*` script is defined that the chain never reaches. Its files
 *     may be covered elsewhere today, but a target that runs nowhere is the second half of a gate
 *     forgotten, which is how `packages/errors` sat ungated until SB23-2387.
 *
 * IT CANNOT RUN (exit 2, which is never a pass) WHEN:
 *   - a chain part is anything but `bun run <script>` or `bunx tsc --noEmit [-p <path>]`, so a
 *     new chain shape fails loudly instead of being skipped;
 *   - a target's tsconfig cannot be read or parsed, matches no inputs, or carries options
 *     diagnostics. A program that fails to build lists nothing, which would read as zero
 *     coverage. That fails in the safe direction, by over-reporting, but an instrument that
 *     cannot build its program is not measuring the tree, so it says so;
 *   - `git ls-files` fails, or lists no TypeScript file at all. Once the allowlist empties, an
 *     empty population would otherwise pass as a clean tree;
 *   - the allowlist is missing, malformed, has an entry without a reason, or has a duplicate.
 *
 * WHAT IT DOES NOT CATCH, stated so a pass is not over-read:
 *   - a file that is in a program but not semantically checked. The root config and the
 *     dashboard config set `skipLibCheck: true`, so the tracked `.d.ts` files those programs
 *     include (measured 2026-10-01: `packages/dashboard-web/src/embedded.d.ts`,
 *     `packages/dashboard-web/src/global.d.ts`, `packages/http-api/src/mergelog.d.ts`) are
 *     listed and count as covered, while tsc skips their bodies. Program membership is the
 *     definition SB23-3758 asked for.
 *   - whether CI runs the chain at all. That is the `Typecheck` step in `.github/workflows/ci.yml`.
 *
 * WHY THE TYPESCRIPT API AND NOT `bunx tsc --listFilesOnly`: same program, same file list, and
 * spawning `bunx` with a fixture as its working directory would fetch TypeScript from npm,
 * because a fixture has no `node_modules`. In-process, every target resolves the one
 * TypeScript this repository pins.
 *
 * The allowlist is `scripts/typecheck-coverage-allowlist.json` under the root being checked:
 * `[{ "path": "<repo-relative>", "reason": "<why no target can reach it>" }]`.
 *
 * Usage: bun run scripts/check-typecheck-coverage.ts [--root <repo root>]
 * Exit 0 clean, 1 drift found, 2 the check could not run.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const NAME = "check-typecheck-coverage";
const ROOT_SCRIPT = "typecheck";
const ALLOWLIST_RELATIVE = "scripts/typecheck-coverage-allowlist.json";
const TRACKED_PATHSPECS = ["*.ts", "*.tsx", "*.mts", "*.cts"];

function cannotRun(message: string): never {
	console.error(`${NAME}: cannot run: ${message}`);
	process.exit(2);
}

function parseArgs(argv: string[]): string {
	let root = path.resolve(import.meta.dir, "..");
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--root" && argv[i + 1] !== undefined) {
			root = path.resolve(argv[++i] as string);
		} else {
			cannotRun(`unknown argument ${argv[i]}`);
		}
	}
	if (!existsSync(root)) cannotRun(`root ${root} does not exist`);
	return realpathSync(root);
}

const started = performance.now();
const root = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------------------------
// Walk the chain.

function readScripts(): Record<string, string> {
	const pkgPath = path.join(root, "package.json");
	let pkg: { scripts?: Record<string, string> };
	try {
		pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	} catch (error) {
		cannotRun(`could not read ${pkgPath}: ${(error as Error).message}`);
	}
	if (!pkg.scripts || typeof pkg.scripts !== "object") cannotRun(`${pkgPath} has no scripts`);
	return pkg.scripts;
}

const scripts = readScripts();

/** tsconfig absolute path -> the script that runs it, first one reached wins. */
const targets = new Map<string, string>();
const reached = new Set<string>();

function resolveProject(arg: string | undefined): string {
	const resolved = path.resolve(root, arg ?? "tsconfig.json");
	if (existsSync(resolved) && statSync(resolved).isDirectory()) {
		return path.join(resolved, "tsconfig.json");
	}
	return resolved;
}

function walk(name: string): void {
	if (reached.has(name)) return;
	reached.add(name);
	const body = scripts[name];
	if (typeof body !== "string") cannotRun(`the chain runs script "${name}", which is not defined`);
	for (const part of body.split("&&").map((s) => s.trim())) {
		const run = part.match(/^bun run (\S+)$/);
		if (run) {
			walk(run[1] as string);
			continue;
		}
		const tsc = part.match(/^bunx tsc --noEmit(?: -p (\S+))?$/);
		if (tsc) {
			const project = resolveProject(tsc[1]);
			if (!targets.has(project)) targets.set(project, name);
			continue;
		}
		cannotRun(
			`script "${name}" has a chain part this check does not understand: ${JSON.stringify(part)}. ` +
				"Teach the walker the new shape rather than letting it skip a target.",
		);
	}
}

walk(ROOT_SCRIPT);

const unchained = Object.keys(scripts)
	.filter((name) => name === ROOT_SCRIPT || name.startsWith(`${ROOT_SCRIPT}:`))
	.filter((name) => !reached.has(name))
	.sort();

// ---------------------------------------------------------------------------------------------
// Build each target's program and collect what it lists.

const realpathCache = new Map<string, string>();
function real(file: string): string {
	let cached = realpathCache.get(file);
	if (cached === undefined) {
		try {
			cached = realpathSync(file);
		} catch {
			cached = file;
		}
		realpathCache.set(file, cached);
	}
	return cached;
}

function formatDiagnostic(d: ts.Diagnostic): string {
	const text = ts.flattenDiagnosticMessageText(d.messageText, " ");
	return d.file ? `${path.relative(root, d.file.fileName)}: TS${d.code}: ${text}` : `TS${d.code}: ${text}`;
}

/** covered realpath -> repo-relative tsconfig of the first target that lists it. */
const covered = new Map<string, string>();
const perTarget: string[] = [];

for (const [project, script] of targets) {
	const label = path.relative(root, project) || "tsconfig.json";
	if (!existsSync(project)) cannotRun(`script "${script}" runs ${label}, which does not exist`);
	const parsed = ts.getParsedCommandLineOfConfigFile(
		project,
		{},
		{
			...ts.sys,
			onUnRecoverableConfigFileDiagnostic: (d) => cannotRun(`${label}: ${formatDiagnostic(d)}`),
		},
	);
	if (!parsed) cannotRun(`${label} could not be parsed`);
	if (parsed.errors.length > 0) {
		cannotRun(`${label}: ${parsed.errors.map(formatDiagnostic).join("; ")}`);
	}
	const program = ts.createProgram({
		rootNames: parsed.fileNames,
		options: parsed.options,
		projectReferences: parsed.projectReferences,
		configFileParsingDiagnostics: ts.getConfigFileParsingDiagnostics(parsed),
	});
	const optionsDiagnostics = program.getOptionsDiagnostics();
	if (optionsDiagnostics.length > 0) {
		cannotRun(`${label}: ${optionsDiagnostics.map(formatDiagnostic).join("; ")}`);
	}
	const files = program.getSourceFiles();
	perTarget.push(`${label}\t${files.length}`);
	for (const sourceFile of files) {
		const key = real(sourceFile.fileName);
		if (!covered.has(key)) covered.set(key, label);
	}
}

// ---------------------------------------------------------------------------------------------
// Tracked files and the allowlist.

// A `GIT_DIR`, `GIT_WORK_TREE` or `GIT_INDEX_FILE` inherited from a hook or a wrapper overrides
// `-C`, so `ls-files` would read another index and could report nothing with exit 0.
const gitEnv = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"].includes(key)),
);
const lsFiles = Bun.spawnSync(["git", "-C", root, "ls-files", "-z", "--", ...TRACKED_PATHSPECS], {
	env: gitEnv,
});
if (lsFiles.exitCode !== 0) {
	cannotRun(`git ls-files failed in ${root}: ${lsFiles.stderr.toString().trim()}`);
}
const tracked = lsFiles.stdout.toString().split("\0").filter(Boolean).sort();
// The floor. With the allowlist emptied, an `ls-files` that lists nothing would otherwise read as
// a clean tree, which is the same shape as #226's unreachable strict branch. A wrong root, a
// sparse checkout or an empty index lists nothing; no real tree this gate guards does.
if (tracked.length === 0) {
	cannotRun(`git ls-files listed no TypeScript files in ${root}, so there is nothing to measure`);
}
const trackedSet = new Set(tracked);

function coverOf(relative: string): string | undefined {
	return covered.get(real(path.join(root, relative)));
}

const ungated = tracked.filter((file) => coverOf(file) === undefined);
const ungatedSet = new Set(ungated);

type AllowlistEntry = { path: string; reason: string };

function readAllowlist(): AllowlistEntry[] {
	const file = path.join(root, ALLOWLIST_RELATIVE);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		cannotRun(`could not read the allowlist ${ALLOWLIST_RELATIVE}: ${(error as Error).message}`);
	}
	if (!Array.isArray(raw)) cannotRun(`${ALLOWLIST_RELATIVE} must be a JSON array`);
	const seen = new Set<string>();
	return raw.map((entry, index) => {
		const where = `${ALLOWLIST_RELATIVE} entry ${index}`;
		if (!entry || typeof entry !== "object") cannotRun(`${where} is not an object`);
		const { path: entryPath, reason } = entry as Record<string, unknown>;
		if (typeof entryPath !== "string" || entryPath.trim() === "") {
			cannotRun(`${where} has no "path"`);
		}
		if (typeof reason !== "string" || reason.trim() === "") {
			cannotRun(`${where} (${entryPath}) has no "reason". Every exemption says why no target can reach it.`);
		}
		if (seen.has(entryPath)) cannotRun(`${where} repeats ${entryPath}`);
		seen.add(entryPath);
		return { path: entryPath, reason };
	});
}

const allowlist = readAllowlist();
const allowlisted = new Set(allowlist.map((entry) => entry.path));

// ---------------------------------------------------------------------------------------------
// Verdict.

const problems: string[] = [];

for (const file of ungated) {
	if (allowlisted.has(file)) continue;
	problems.push(
		`UNGATED    ${file}\n` +
			"           No program the root `typecheck` chain runs lists this file. Add it to a target's\n" +
			"           include, or give it a tsconfig and chain that target from `typecheck`.",
	);
}

for (const entry of allowlist) {
	if (ungatedSet.has(entry.path)) continue;
	if (!trackedSet.has(entry.path)) {
		problems.push(
			`GONE       ${entry.path}\n` +
				`           Allowlisted but no longer tracked. Remove it from ${ALLOWLIST_RELATIVE}.`,
		);
	} else {
		problems.push(
			`COVERED    ${entry.path}\n` +
				`           Allowlisted but ${coverOf(entry.path)} now lists it. Remove it from ${ALLOWLIST_RELATIVE}.`,
		);
	}
}

for (const name of unchained) {
	problems.push(
		`UNCHAINED  ${name}\n` +
			"           Defined but the root `typecheck` chain never runs it. Chain it, or delete it.",
	);
}

const seconds = ((performance.now() - started) / 1000).toFixed(1);
const summary =
	`${targets.size} targets, ${tracked.length} tracked, ${tracked.length - ungated.length} covered, ` +
	`${ungated.length} ungated (${allowlist.length} allowlisted), ${seconds}s`;

if (problems.length > 0) {
	console.error(`${NAME}: ${problems.length} problem${problems.length === 1 ? "" : "s"}\n`);
	for (const problem of problems) console.error(`${problem}\n`);
	console.error(`${NAME}: ${summary}`);
	process.exit(1);
}

if (process.env.CHECK_TYPECHECK_COVERAGE_VERBOSE) {
	for (const line of perTarget.sort()) console.log(line);
}
console.log(`${NAME}: ok: ${summary}`);
