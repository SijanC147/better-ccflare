/**
 * Tests for the upstream-maintainer token configuration endpoints.
 *
 * The token is what enables the dispatch feature, so the cases that matter are
 * the ones where it could escape: the GET reports a boolean and never the value,
 * the POST echoes a boolean and never the value, and a rejected value is not
 * quoted back in the error.
 */

import { describe, expect, it } from "bun:test";
import type { Config } from "@better-ccflare/config";
import { createUpstreamMaintainerConfigHandlers } from "../config-upstream-maintainer";

const TOKEN = "github_pat_11NOTAREALTOKENvalue0000000000";

function configStub(initial = "") {
	let stored = initial;
	const config = {
		getUpstreamMaintainerToken: () => stored,
		hasUpstreamMaintainerToken: () => stored.length > 0,
		setUpstreamMaintainerToken: (token: string) => {
			stored = token;
		},
	} as unknown as Config;
	return { config, read: () => stored };
}

function post(body: unknown): Request {
	return new Request("http://localhost/api/config/upstream-maintainer", {
		method: "POST",
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

describe("GET /api/config/upstream-maintainer", () => {
	it("reports the boolean and never the token", async () => {
		const { config } = configStub(TOKEN);
		const handlers = createUpstreamMaintainerConfigHandlers(config);
		const response = handlers.getUpstreamMaintainerConfig();
		const text = await response.text();

		expect(response.status).toBe(200);
		expect(JSON.parse(text).tokenSet).toBe(true);
		expect(text).not.toContain(TOKEN);
		expect(text).not.toContain('token":"');
	});

	it("reports false when nothing is configured", () => {
		const { config } = configStub("");
		const handlers = createUpstreamMaintainerConfigHandlers(config);
		const body = handlers.getUpstreamMaintainerConfig();
		expect(body.status).toBe(200);
	});
});

describe("POST /api/config/upstream-maintainer", () => {
	it("stores a token and answers with the boolean only", async () => {
		const { config, read } = configStub("");
		const handlers = createUpstreamMaintainerConfigHandlers(config);
		const response = await handlers.setUpstreamMaintainerConfig(
			post({ token: TOKEN }),
		);
		const text = await response.text();

		expect(response.status).toBe(200);
		expect(JSON.parse(text).tokenSet).toBe(true);
		expect(read()).toBe(TOKEN);
		expect(text).not.toContain(TOKEN);
	});

	it("clears the token with an empty string", async () => {
		const { config, read } = configStub(TOKEN);
		const handlers = createUpstreamMaintainerConfigHandlers(config);
		const response = await handlers.setUpstreamMaintainerConfig(
			post({ token: "" }),
		);
		expect(response.status).toBe(200);
		expect(JSON.parse(await response.text()).tokenSet).toBe(false);
		expect(read()).toBe("");
	});

	it("rejects a non-string token", async () => {
		const { config, read } = configStub("");
		const handlers = createUpstreamMaintainerConfigHandlers(config);
		const response = await handlers.setUpstreamMaintainerConfig(
			post({ token: 12345 }),
		);
		expect(response.status).toBe(400);
		expect(read()).toBe("");
	});

	it("rejects a token with whitespace without echoing it", async () => {
		const { config, read } = configStub("");
		const handlers = createUpstreamMaintainerConfigHandlers(config);
		const response = await handlers.setUpstreamMaintainerConfig(
			post({ token: "ghp_abc\ndef" }),
		);
		expect(response.status).toBe(400);
		expect(await response.text()).not.toContain("ghp_abc");
		expect(read()).toBe("");
	});

	it("rejects an over-long token", async () => {
		const { config, read } = configStub("");
		const handlers = createUpstreamMaintainerConfigHandlers(config);
		const response = await handlers.setUpstreamMaintainerConfig(
			post({ token: "g".repeat(513) }),
		);
		expect(response.status).toBe(400);
		expect(read()).toBe("");
	});

	it("rejects a malformed body", async () => {
		const { config } = configStub("");
		const handlers = createUpstreamMaintainerConfigHandlers(config);
		const response = await handlers.setUpstreamMaintainerConfig(
			post("not json"),
		);
		expect(response.status).toBe(400);
	});
});
