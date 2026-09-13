/**
 * Tests for the upstream-maintainer configuration endpoint.
 *
 * The token enables the dispatch feature, so what matters is that it cannot
 * escape and cannot be installed: the read reports booleans and never the value,
 * and there is no setter on the handler at all.
 */

import { describe, expect, it } from "bun:test";
import type { Config } from "@better-ccflare/config";
import { createUpstreamMaintainerConfigHandlers } from "../config-upstream-maintainer";

const TOKEN = "github_pat_11NOTAREALTOKENvalue0000000000";
const ENV_KEY = "BETTER_CCFLARE_UPSTREAM_MAINTAINER_TOKEN";

function configStub(stored = "") {
	return {
		getUpstreamMaintainerToken: () => stored,
		hasUpstreamMaintainerToken: () => stored.length > 0,
	} as unknown as Config;
}

describe("GET /api/config/upstream-maintainer", () => {
	it("reports the boolean and never the token", async () => {
		const handlers = createUpstreamMaintainerConfigHandlers(configStub(TOKEN));
		const response = handlers.getUpstreamMaintainerConfig();
		const text = await response.text();

		expect(response.status).toBe(200);
		expect(JSON.parse(text)).toEqual({
			tokenSet: true,
			tokenFromEnvironment: false,
			controllerRepo: "SijanC147/upstream-maintainer",
		});
		expect(text).not.toContain(TOKEN);
		// No field carries the value under any name.
		expect(text).not.toContain("github_pat");
	});

	it("reports false when nothing is configured", async () => {
		const handlers = createUpstreamMaintainerConfigHandlers(configStub(""));
		const body = await handlers.getUpstreamMaintainerConfig().json();
		expect((body as { tokenSet: boolean }).tokenSet).toBe(false);
	});

	it("distinguishes an environment-supplied token", async () => {
		// The environment wins over the config file, so the dashboard has to be
		// able to explain why editing the stored value changed nothing.
		process.env[ENV_KEY] = TOKEN;
		try {
			const handlers = createUpstreamMaintainerConfigHandlers(
				configStub(TOKEN),
			);
			const body = (await handlers.getUpstreamMaintainerConfig().json()) as {
				tokenFromEnvironment: boolean;
			};
			expect(body.tokenFromEnvironment).toBe(true);
		} finally {
			delete process.env[ENV_KEY];
		}
	});

	it("exposes no way to write the token", () => {
		// The operator edits the config file. Nothing reachable from the dashboard
		// may install or overwrite a token that authorizes a dispatch on another
		// repository, so this handler set is read-only by construction.
		const handlers = createUpstreamMaintainerConfigHandlers(configStub(""));
		expect(Object.keys(handlers)).toEqual(["getUpstreamMaintainerConfig"]);
	});
});
