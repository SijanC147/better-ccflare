import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPOSITORY_ROOT = join(import.meta.dir, "..");
const TOOLKIT_SHA = "67898bb09280a5325b89c1b23a70f2fc8b64ffae";
const TOOLKIT_TAG = "v0.4.1";

function read(relativePath: string): string {
	return readFileSync(join(REPOSITORY_ROOT, relativePath), "utf8");
}

describe("Hextap schema-2 repository contract", () => {
	it("keeps source and tap manifests byte-identical", () => {
		const source = read(".hextap.json");
		expect(read(".hextap/tap-registration.json")).toBe(source);
		const manifest = JSON.parse(source);

		expect(manifest).toMatchObject({
			schema: 2,
			formula: {
				name: "better-ccflare",
				class: "BetterCcflare",
				description:
					"Claude API proxy with intelligent load balancing across multiple accounts",
				binary: "better-ccflare",
				assets: {
					darwin_arm64: "better-ccflare-macos-arm64.tar.gz",
					darwin_amd64: "better-ccflare-macos-x86_64.tar.gz",
				},
			},
			release: {
				build_script: "scripts/hextap-build",
				profile: {
					runtime: "bun",
					runtime_version: "1.3.14",
					install: {
						argv: ["bun", "install", "--frozen-lockfile"],
					},
				},
				targets: {
					darwin_arm64: {
						binary: "better-ccflare-macos-arm64",
						archive: "better-ccflare-macos-arm64.tar.gz",
						archive_contents: "binary",
					},
					darwin_amd64: {
						binary: "better-ccflare-macos-x86_64",
						archive: "better-ccflare-macos-x86_64.tar.gz",
						archive_contents: "binary",
					},
					linux_arm64: { binary: "better-ccflare-linux-arm64" },
					linux_amd64: { binary: "better-ccflare-linux-amd64" },
					windows_amd64: {
						binary: "better-ccflare-windows-x64.exe",
					},
				},
			},
			homebrew: {
				formula_profile: "better-ccflare",
				service_enabled: true,
			},
		});
	});

	it("pins one explicit Hextap release caller and removes the legacy publisher", () => {
		const caller = read(".github/workflows/hextap-release.yml");
		expect(caller).toContain(`release-go.yml@${TOOLKIT_SHA} # ${TOOLKIT_TAG}`);
		expect(caller).toContain(
			"op_service_account_token: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}",
		);
		expect(caller).not.toContain("secrets: inherit");
		expect(() => read(".github/workflows/release.yml")).toThrow();

		const activeWorkflows = readdirSync(
			join(REPOSITORY_ROOT, ".github/workflows"),
		).filter((name) => /\.ya?ml$/.test(name));
		const tagResponders = activeWorkflows.filter((name) =>
			read(`.github/workflows/${name}`).includes('tags:\n      - "v*"'),
		);
		expect(tagResponders).toEqual(["hextap-release.yml"]);
	});

	it("pins Bun quality CI and the exact owned ruleset checks", () => {
		const ci = read(".github/workflows/ci.yml");
		expect(ci).toContain(
			"oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
		);
		expect(ci).toContain('bun-version: "1.3.14"');
		expect(ci).toContain("name: Bun and release tooling");
		expect(ci).toContain("name: Hextap release contract");
		expect(ci).toContain(`ref: ${TOOLKIT_SHA}`);
		expect(ci).toContain(
			'BUN_INSTALL_CACHE_DIR="$RUNNER_TEMP/bun-runtime-cache"',
		);
		expect(ci).toContain("sudo -n unshare --net --");

		const ruleset = JSON.parse(read(".hextap/rulesets/main.json"));
		const required = ruleset.rules.find(
			(rule: { type: string }) => rule.type === "required_status_checks",
		);
		expect(required.parameters.required_status_checks).toEqual([
			{ context: "Bun and release tooling" },
			{ context: "Hextap release contract" },
		]);
		expect(ruleset.bypass_actors ?? []).toEqual([]);
	});
});
