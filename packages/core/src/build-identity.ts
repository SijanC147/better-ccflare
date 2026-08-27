const CORE_VERSION = "(0|[1-9][0-9]*)";
const PRERELEASE_IDENTIFIER =
	"(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const VERSION_PATTERN = new RegExp(
	`^${CORE_VERSION}\\.${CORE_VERSION}\\.${CORE_VERSION}(-${PRERELEASE_IDENTIFIER}(\\.${PRERELEASE_IDENTIFIER})*)?$`,
);
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Validate and return a normalized Hextap release version. */
export function normalizeBuildVersion(version: string): string {
	if (!VERSION_PATTERN.test(version)) {
		throw new Error(`invalid normalized build version: ${version}`);
	}
	return version;
}

/** Validate and return a full lowercase Git source commit. */
export function normalizeBuildCommit(commit: string): string {
	if (!COMMIT_PATTERN.test(commit)) {
		throw new Error(`invalid full build commit: ${commit}`);
	}
	return commit;
}

/** Format the exact identity line consumed by Hextap native verification. */
export function formatBuildIdentity(version: string, commit: string): string {
	return `better-ccflare ${version} (commit ${commit})`;
}
