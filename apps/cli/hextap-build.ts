import { isAbsolute } from "node:path";
import { compileStandalone, prepareDashboardBuild } from "./build-standalone";
import { getHextapTarget } from "./hextap-targets";
import { prepareEmbeddedWorkers } from "./prepare-workers";

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`${name} is required`);
	}
	return value;
}

const target = getHextapTarget(
	requiredEnvironment("HEXTAP_TARGET_OS"),
	requiredEnvironment("HEXTAP_TARGET_ARCH"),
);
const output = requiredEnvironment("HEXTAP_OUTPUT");
if (!isAbsolute(output)) {
	throw new Error("HEXTAP_OUTPUT must be absolute");
}
const version = requiredEnvironment("HEXTAP_VERSION");
const commit = requiredEnvironment("HEXTAP_COMMIT");

await prepareDashboardBuild(version, commit);
await prepareEmbeddedWorkers();
await compileStandalone({ target, output, version, commit });
