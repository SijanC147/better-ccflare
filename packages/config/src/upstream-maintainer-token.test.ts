/**
 * Tests for the upstream-maintainer token config parameter.
 *
 * It is a secret, so the two things worth proving are that the environment wins
 * over the persisted file (the convention every other secret here follows) and
 * that getAllSettings() does not carry it — that method reads as though it were
 * safe to serialize, and a future caller handing it to a settings endpoint must
 * not ship a token with it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

const ENV_KEY = "BETTER_CCFLARE_UPSTREAM_MAINTAINER_TOKEN";
const created: string[] = [];

function configWith(data: Record<string, unknown>): Config {
	const dir = mkdtempSync(join(tmpdir(), "ccflare-maintainer-token-"));
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

describe("upstream maintainer token", () => {
	it("is empty when nothing is configured", () => {
		const config = configWith({});
		expect(config.getUpstreamMaintainerToken()).toBe("");
		expect(config.hasUpstreamMaintainerToken()).toBe(false);
	});

	it("reads the persisted value", () => {
		const config = configWith({ upstream_maintainer_token: "github_pat_file" });
		expect(config.getUpstreamMaintainerToken()).toBe("github_pat_file");
		expect(config.hasUpstreamMaintainerToken()).toBe(true);
	});

	it("lets the environment win over the file, like every other secret here", () => {
		process.env[ENV_KEY] = "github_pat_env";
		const config = configWith({ upstream_maintainer_token: "github_pat_file" });
		expect(config.getUpstreamMaintainerToken()).toBe("github_pat_env");
	});

	it("has no setter, so nothing reachable from the API can install one", () => {
		// Unlike pg_password, this value has no write path at all. The token
		// authorizes a workflow dispatch on another repository, so the operator
		// writes it into the config file and nothing else can.
		const config = configWith({});
		expect(
			(config as unknown as Record<string, unknown>).setUpstreamMaintainerToken,
		).toBeUndefined();
	});

	it("is absent from getAllSettings(), with the other secrets", () => {
		const config = configWith({
			upstream_maintainer_token: "github_pat_file",
			pg_password: "hunter2",
			local_control_secret: "a-local-secret",
			lb_strategy: "session",
		});
		const settings = config.getAllSettings();

		expect(settings.upstream_maintainer_token).toBeUndefined();
		expect(settings.pg_password).toBeUndefined();
		expect(settings.local_control_secret).toBeUndefined();
		// Non-secret settings still come through.
		expect(settings.lb_strategy).toBe("session");
		expect(JSON.stringify(settings)).not.toContain("github_pat_file");
		expect(JSON.stringify(settings)).not.toContain("hunter2");
	});
});
