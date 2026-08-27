import { compileStandalone, prepareDashboardBuild } from "./build-standalone";
import { getHextapTarget } from "./hextap-targets";
import packageJson from "./package.json";
import { prepareEmbeddedWorkers } from "./prepare-workers";

const DEVELOPMENT_COMMIT = "0000000000000000000000000000000000000000";
const os =
	process.platform === "darwin"
		? "darwin"
		: process.platform === "win32"
			? "windows"
			: "linux";
const arch = process.arch === "arm64" ? "arm64" : "amd64";
const target = getHextapTarget(os, arch);
const executable = os === "windows" ? "better-ccflare.exe" : "better-ccflare";

await prepareDashboardBuild(packageJson.version, DEVELOPMENT_COMMIT);
await prepareEmbeddedWorkers();
await compileStandalone({
	target,
	output: `${import.meta.dir}/dist/${executable}`,
	version: packageJson.version,
	commit: DEVELOPMENT_COMMIT,
});
