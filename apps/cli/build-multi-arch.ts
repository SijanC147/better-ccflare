#!/usr/bin/env bun
import { join } from "node:path";
import { compileStandalone, prepareDashboardBuild } from "./build-standalone";
import { getAllHextapTargets } from "./hextap-targets";
import packageJson from "./package.json";
import { prepareEmbeddedWorkers } from "./prepare-workers";

const DEVELOPMENT_COMMIT = "0000000000000000000000000000000000000000";

await prepareDashboardBuild(packageJson.version, DEVELOPMENT_COMMIT);
await prepareEmbeddedWorkers();
const skip = (process.env.CCFLARE_SKIP_PLATFORMS ?? "")
	.split(",")
	.map((entry) => entry.trim())
	.filter(Boolean);

for (const target of getAllHextapTargets()) {
	if (skip.includes(target.bunTarget) || skip.includes(target.releaseBinary)) {
		console.log(`Skipping ${target.os}/${target.arch}...`);
		continue;
	}
	console.log(`Building ${target.os}/${target.arch}...`);
	await compileStandalone({
		target,
		output: join(import.meta.dir, "dist", target.releaseBinary),
		version: packageJson.version,
		commit: DEVELOPMENT_COMMIT,
	});
}
