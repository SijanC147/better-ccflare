/**
 * Tests for the GitHub read token config parameter.
 *
 * It exists because the version widget's unauthenticated calls share GitHub's
 * 60-requests-an-hour-per-IP limit with everything else on the machine, and the
 * sidebar reports the exhaustion as "Release check unavailable".
 *
 * It is a secret, so the same two things matter as for the maintainer token:
 * the environment wins over the persisted file, and getAllSettings() does not
 * carry it, because that method reads as though it were safe to serialize.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

const ENV_KEY = "BETTER_CCFLARE_GITHUB_TOKEN";
const created: string[] = [];

function configWith(data: Record<string, unknown>): Config {
	const dir = mkdtempSync(join(tmpdir(), "ccflare-github-read-token-"));
	created.push(dir);
	const path = join(dir, "config.json");
	writeFileSync(path, JSON.stringify(data));
	return new Config(path);
}

afterEach(() => {
	delete process.env[ENV_KEY];
	for (const dir of created.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("github read token", () => {
	it("is empty when nothing is configured", () => {
		const config = configWith({});
		expect(config.getGithubReadToken()).toBe("");
		expect(config.hasGithubReadToken()).toBe(false);
	});

	it("reads the persisted value", () => {
		const config = configWith({ github_read_token: "ghp_file" });
		expect(config.getGithubReadToken()).toBe("ghp_file");
		expect(config.hasGithubReadToken()).toBe(true);
	});

	it("lets the environment win over the file, like every other secret here", () => {
		process.env[ENV_KEY] = "ghp_env";
		const config = configWith({ github_read_token: "ghp_file" });
		expect(config.getGithubReadToken()).toBe("ghp_env");
	});

	it("is absent from getAllSettings(), with the other secrets", () => {
		const config = configWith({
			github_read_token: "ghp_file",
			upstream_maintainer_token: "github_pat_file",
			pg_password: "hunter2",
			lb_strategy: "session",
		});
		const settings = config.getAllSettings();
		expect(settings.github_read_token).toBeUndefined();
		expect(settings.upstream_maintainer_token).toBeUndefined();
		expect(settings.pg_password).toBeUndefined();
		// A non-secret is still there, so the assertions above mean something.
		expect(settings.lb_strategy).toBe("session");
	});

	it("is separate from the maintainer token", () => {
		// The scopes differ: this one reads public releases and needs none, while
		// the maintainer token authorizes a workflow dispatch on another
		// repository. Configuring one must not configure the other.
		const config = configWith({ github_read_token: "ghp_file" });
		expect(config.getGithubReadToken()).toBe("ghp_file");
		expect(config.getUpstreamMaintainerToken()).toBe("");
	});

	it("has no setter, so nothing reachable from the API can install one", () => {
		const config = configWith({});
		expect(
			(config as unknown as Record<string, unknown>).setGithubReadToken,
		).toBeUndefined();
	});
});
