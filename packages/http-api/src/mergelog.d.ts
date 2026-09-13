/**
 * Ambient type for Bun's text imports.
 *
 * `import text from "…/MERGELOG.md" with { type: "text" }` is resolved and
 * inlined by Bun's bundler, which tsc knows nothing about — see
 * services/fork-identity.ts for why the merged-upstream sha is sourced that way.
 */
declare module "*.md" {
	const contents: string;
	export default contents;
}
