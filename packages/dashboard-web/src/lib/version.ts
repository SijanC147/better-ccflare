// Read version directly from root package.json at build time
// The root package.json is the single source of truth for the version
import packageJson from "../../../../package.json";

export function getVersion(): string {
	const version = packageJson.version;
	return version.startsWith("v") ? version : `v${version}`;
}

export const version = getVersion();
