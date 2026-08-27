import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	normalizeBuildCommit,
	normalizeBuildVersion,
} from "@better-ccflare/core";
import type { HextapTarget } from "./hextap-targets";

const PROJECT_ROOT = join(import.meta.dir, "../..");
const ENTRYPOINT = join(import.meta.dir, "src/main.ts");

export interface StandaloneBuildOptions {
	target: HextapTarget;
	output: string;
	version: string;
	commit: string;
}

async function run(command: string[], environment?: Record<string, string>) {
	const child = Bun.spawn({
		cmd: command,
		cwd: PROJECT_ROOT,
		env: environment ? { ...process.env, ...environment } : process.env,
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await child.exited;
	if (exitCode !== 0) {
		throw new Error(`command failed with exit code ${exitCode}: ${command[1]}`);
	}
}

/** Build dashboard assets with the same version and commit as the native CLI. */
export async function prepareDashboardBuild(
	version: string,
	commit: string,
): Promise<void> {
	normalizeBuildVersion(version);
	normalizeBuildCommit(commit);
	await run([process.execPath, "run", "build:dashboard"], {
		BETTER_CCFLARE_BUILD_VERSION: version,
		BETTER_CCFLARE_BUILD_COMMIT: commit,
	});
}

/** Compile one standalone executable without shell interpolation. */
export async function compileStandalone({
	target,
	output,
	version,
	commit,
}: StandaloneBuildOptions): Promise<void> {
	normalizeBuildVersion(version);
	normalizeBuildCommit(commit);
	await mkdir(dirname(output), { recursive: true });
	await run([
		process.execPath,
		"build",
		ENTRYPOINT,
		"--compile",
		`--outfile=${output}`,
		`--target=${target.bunTarget}`,
		"--minify",
		"--define",
		`__BETTER_CCFLARE_VERSION__=${JSON.stringify(version)}`,
		"--define",
		`__BETTER_CCFLARE_COMMIT__=${JSON.stringify(commit)}`,
	]);
}
