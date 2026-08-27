import { resolve } from "node:path";
import { compileStandalone, prepareDashboardBuild } from "./build-standalone";
import { getHextapTarget } from "./hextap-targets";
import packageJson from "./package.json";
import { prepareEmbeddedWorkers } from "./prepare-workers";

const DEVELOPMENT_COMMIT = "0000000000000000000000000000000000000000";
const [os, arch, outputArgument] = process.argv.slice(2);
if (!os || !arch || !outputArgument) {
	throw new Error("usage: bun run build-target.ts OS ARCH OUTPUT");
}

await prepareDashboardBuild(packageJson.version, DEVELOPMENT_COMMIT);
await prepareEmbeddedWorkers();
await compileStandalone({
	target: getHextapTarget(os, arch),
	output: resolve(import.meta.dir, outputArgument),
	version: packageJson.version,
	commit: DEVELOPMENT_COMMIT,
});
