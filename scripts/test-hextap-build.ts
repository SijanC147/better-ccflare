import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VERSION = "3.8.2-rc.1";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const REPOSITORY_ROOT = join(import.meta.dir, "..");
const targetOS = process.platform === "darwin" ? "darwin" : "linux";
const targetArch = process.arch === "arm64" ? "arm64" : "amd64";

function sha256(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const digest = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("error", reject);
		stream.on("data", (chunk) => digest.update(chunk));
		stream.on("end", () => resolve(digest.digest("hex")));
	});
}

async function runAdapter(output: string): Promise<void> {
	const child = Bun.spawn({
		cmd: ["/bin/bash", join(REPOSITORY_ROOT, "scripts/hextap-build")],
		cwd: REPOSITORY_ROOT,
		env: {
			...process.env,
			HEXTAP_TARGET_OS: targetOS,
			HEXTAP_TARGET_ARCH: targetArch,
			HEXTAP_OUTPUT: output,
			HEXTAP_VERSION: VERSION,
			HEXTAP_COMMIT: COMMIT,
		},
		stdin: "ignore",
		stdout: "ignore",
		stderr: "inherit",
	});
	assert.equal(await child.exited, 0, "Hextap adapter failed");
}

const testRoot = await mkdtemp(join(tmpdir(), "better-ccflare-hextap-"));
try {
	const firstDirectory = join(testRoot, "first");
	const secondDirectory = join(testRoot, "second");
	await mkdir(firstDirectory);
	await mkdir(secondDirectory);
	const executableName = targetOS === "windows" ? "better-ccflare.exe" : "better-ccflare";
	const first = join(firstDirectory, executableName);
	const second = join(secondDirectory, executableName);

	await runAdapter(first);
	await runAdapter(second);
	assert.equal(await sha256(first), await sha256(second), "build is not deterministic");

	const dashboardDirectory = join(
		REPOSITORY_ROOT,
		"packages/dashboard-web/dist",
	);
	const dashboardJavaScript = await Promise.all(
		(await readdir(dashboardDirectory))
			.filter((name) => name.endsWith(".js"))
			.map((name) => readFile(join(dashboardDirectory, name), "utf8")),
	);
	assert(
		dashboardJavaScript.some(
			(asset) => asset.includes(VERSION) && asset.includes(COMMIT),
		),
		"dashboard did not embed the release version and commit",
	);

	const version = Bun.spawnSync([first, "--version"], {
		cwd: testRoot,
		env: { PATH: process.env.PATH ?? "" },
	});
	assert.equal(version.exitCode, 0);
	assert.equal(version.stderr.toString(), "");
	assert.equal(
		version.stdout.toString().replace(/\r\n$/, "\n"),
		`better-ccflare ${VERSION} (commit ${COMMIT})\n`,
	);
} finally {
	await rm(testRoot, { recursive: true, force: true });
}

console.log("Hextap adapter determinism and identity passed");
