import mergelog from "../../../../MERGELOG.md" with { type: "text" };

/**
 * Fork release and upstream-sync identity.
 *
 * This fork does not publish to npm. Releases are annotated `v*` git tags on
 * SijanC147/better-ccflare plus a private Homebrew tap, and `package.json`
 * deliberately lags the release (see docs/release.md). Every identity constant
 * the version widget needs therefore lives here rather than being derived from
 * a package manifest.
 */
export const FORK_REPO = "SijanC147/better-ccflare";
export const UPSTREAM_REPO = "tombii/better-ccflare";

/** Controller repository that runs the upstream maintainer workflow. */
export const MAINTAINER_REPO = "SijanC147/upstream-maintainer";

/**
 * Branch prefix the upstream maintainer controller uses for its sync PRs.
 * Mirrors the controller's own BRANCH_PREFIX.
 */
export const SYNC_BRANCH_PREFIX = "upstream-sync/";

/** Homebrew formula name, kept byte-identical to `.hextap.json` formula.name. */
export const HOMEBREW_FORMULA = "better-ccflare";

/**
 * Extract the `last-sync-sha` marker from a MERGELOG body.
 *
 * Exported separately from the module-level constant so the parser can be
 * tested against hit, miss and malformed inputs without a fixture file.
 */
export function parseLastSyncSha(text: string): string | null {
	const match = text.match(/<!--\s*last-sync-sha:\s*([0-9a-f]{7,40})\s*-->/);
	return match ? (match[1] ?? null) : null;
}

/**
 * The newest upstream commit merged into this fork, as recorded in MERGELOG.md
 * at the commit this binary was built from.
 *
 * Sourced through a Bun text import rather than runtime filesystem access or a
 * compile-time `--define`:
 *
 *  - It is a property of the source tree at the tagged commit, exactly like the
 *    version and commit defines, so it belongs in the build.
 *  - Bun inlines `with { type: "text" }` imports into the bundle, so the value
 *    survives `bun build --compile`. A Homebrew binary has no repository on
 *    disk, which rules out reading MERGELOG.md at runtime.
 *  - Unlike a third `--define`, it needs no change to apps/cli/build-standalone.ts
 *    and so does not touch the Hextap define contract that
 *    `.github/upstream-maintainer.yml` and `scripts/test-hextap-build.ts` gate.
 */
export const MERGED_UPSTREAM_SHA = parseLastSyncSha(mergelog);

/** Short form used in the dashboard footer. */
export function shortSha(sha: string | null): string | null {
	return sha ? sha.slice(0, 8) : null;
}

/** Canonical release-notes URL for a tag on a repository. */
export function releaseUrl(repo: string, tag: string): string {
	return `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`;
}

/** Canonical commit URL for a sha on a repository. */
export function commitUrl(repo: string, sha: string): string {
	return `https://github.com/${repo}/commit/${encodeURIComponent(sha)}`;
}
