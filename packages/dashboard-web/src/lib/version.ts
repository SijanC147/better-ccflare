import packageJson from "../../../../package.json";

declare const __BETTER_CCFLARE_VERSION__: string | undefined;
declare const __BETTER_CCFLARE_COMMIT__: string | undefined;

/** Normalize the dashboard's visible application version. */
export function displayVersion(rawVersion: string): string {
	return rawVersion.startsWith("v") ? rawVersion : `v${rawVersion}`;
}

/** Build the dashboard identity from release-injected values. */
export function dashboardBuildIdentity(
	rawVersion: string,
	rawCommit: string,
): { version: string; commit: string } {
	return { version: displayVersion(rawVersion), commit: rawCommit };
}

const identity = dashboardBuildIdentity(
	typeof __BETTER_CCFLARE_VERSION__ !== "undefined"
		? __BETTER_CCFLARE_VERSION__
		: packageJson.version,
	typeof __BETTER_CCFLARE_COMMIT__ !== "undefined"
		? __BETTER_CCFLARE_COMMIT__
		: "development",
);

export const version = identity.version;
export const commit = identity.commit;

/**
 * Compatibility alias for upstream callers. Prefer the `version` export.
 * Kept additive during the 2026-08 upstream sync: upstream replaced the
 * `version`/`commit` exports with a `getVersion()` function, but navigation.tsx
 * and the Hextap dashboard-identity contract both rely on the exports, and the
 * commit half has no upstream equivalent.
 */
export function getVersion(): string {
	return version;
}
