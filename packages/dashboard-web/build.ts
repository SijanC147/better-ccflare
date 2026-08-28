#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import plugin from "bun-plugin-tailwind";
import packageJson from "../../package.json";

console.log("\n🚀 Building dashboard...\n");

const outdir = path.join(process.cwd(), "dist");

if (existsSync(outdir)) {
	console.log(`🗑️ Cleaning previous build at ${outdir}`);
	await rm(outdir, { recursive: true, force: true });
}

const start = performance.now();

// Release identity precedence. Hextap supplies BETTER_CCFLARE_BUILD_VERSION /
// BETTER_CCFLARE_BUILD_COMMIT from the tagged git tag and source commit; those are
// exact and must win. CCFLARE_BUILD_SUFFIX (upstream) appends SemVer build metadata
// (e.g. "3.5.44+zp2"), which Hextap's version normalization rejects — so it is only
// valid for non-Hextap developer builds. Supplying both is a contradiction, not a
// precedence question, so fail closed rather than silently picking one.
const releaseBuildVersion = process.env.BETTER_CCFLARE_BUILD_VERSION;
const releaseBuildCommit = process.env.BETTER_CCFLARE_BUILD_COMMIT;
const buildSuffix = process.env.CCFLARE_BUILD_SUFFIX;

if (releaseBuildVersion && buildSuffix) {
	throw new Error(
		"CCFLARE_BUILD_SUFFIX cannot be combined with Hextap build identity " +
			"(BETTER_CCFLARE_BUILD_VERSION). Hextap rejects SemVer build metadata.",
	);
}

const buildVersion = releaseBuildVersion
	? releaseBuildVersion
	: buildSuffix
		? `${packageJson.version}+${buildSuffix}`
		: packageJson.version;
const buildCommit = releaseBuildCommit ?? "development";

const entrypoints = ["src/index.html"];
console.log(`📄 Building dashboard from ${entrypoints[0]}\n`);

const result = await Bun.build({
	entrypoints,
	outdir,
	plugins: [plugin],
	minify: true,
	target: "browser",
	sourcemap: "linked",
	splitting: true,
	define: {
		"process.env.NODE_ENV": JSON.stringify("production"),
		__BETTER_CCFLARE_VERSION__: JSON.stringify(buildVersion),
		__BETTER_CCFLARE_COMMIT__: JSON.stringify(buildCommit),
	},
});

// Generate manifest.json with asset mappings
const manifest: Record<string, string> = {};
for (const output of result.outputs) {
	const relativePath = path.relative(outdir, output.path);
	const publicPath = `/${relativePath}`;
	manifest[publicPath] = publicPath;
}

await writeFile(
	path.join(outdir, "manifest.json"),
	JSON.stringify(manifest, null, 2),
);

const end = performance.now();
const buildTime = (end - start).toFixed(2);

console.log(`✅ Dashboard build completed in ${buildTime}ms\n`);
console.log(`📦 Output files:`);
result.outputs.forEach((output) => {
	console.log(`   - ${path.relative(process.cwd(), output.path)}`);
});

// Fix webmanifest icon paths (Bun doesn't rewrite references inside JSON)
for (const output of result.outputs) {
	const fileName = path.basename(output.path);
	if (fileName.endsWith(".webmanifest")) {
		const content = await readFile(output.path, "utf-8");
		const hashedIcon = result.outputs.find((o) =>
			path.basename(o.path).startsWith("apple-touch-icon"),
		);
		if (hashedIcon) {
			const updated = content.replace(
				"./apple-touch-icon.png",
				`./${path.basename(hashedIcon.path)}`,
			);
			await writeFile(output.path, updated);
			console.log(
				`\n🔧 Fixed webmanifest icon path → ${path.basename(hashedIcon.path)}`,
			);
		}
	}
}

// Generate embedded assets TypeScript file
console.log(`\n📦 Generating embedded assets...`);
const { embedAssets } = await import("./embed.ts");
const embeddedCode = await embedAssets();
await writeFile(path.join(process.cwd(), "dist", "embedded.ts"), embeddedCode);
console.log(`✅ Embedded assets generated at dist/embedded.ts`);
