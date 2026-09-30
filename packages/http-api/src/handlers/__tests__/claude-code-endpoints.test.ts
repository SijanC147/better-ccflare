import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@better-ccflare/config";
import {
	CLAUDE_CODE_ENDPOINTS_CONFIG_KEY,
	OPENAI_GATEWAYS_CONFIG_KEY,
} from "@better-ccflare/types";
import { createClaudeCodeEndpointHandlers } from "../claude-code-endpoints";
import { createOpenAIGatewayHandlers } from "../openai-gateways";

/**
 * `/api/claude-code-endpoints`. Every test runs against a real `Config` on a
 * temp file and reads the file back, so what is asserted is what the next boot
 * would load, and against a real temp directory, because the handler stats it.
 */

const tmpDirs: string[] = [];

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTmp(label: string): string {
	const dir = mkdtempSync(join(tmpdir(), `better-ccflare-${label}-`));
	tmpDirs.push(dir);
	return dir;
}

function configWithFile(data: Record<string, unknown>): {
	config: Config;
	path: string;
} {
	const path = join(makeTmp("cce-config"), "config.json");
	writeFileSync(path, JSON.stringify(data));
	return { config: new Config(path), path };
}

function stored(path: string, key: string): unknown {
	const data = JSON.parse(readFileSync(path, "utf8")) as Record<
		string,
		unknown
	>;
	return data[key];
}

function put(body: unknown): Request {
	return new Request("http://localhost/api/claude-code-endpoints/x", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

async function errorText(response: Response): Promise<string> {
	return JSON.stringify(await response.json());
}

describe("claude code endpoints API", () => {
	it("round trips PUT, GET, list, DELETE, then 404", async () => {
		const project = makeTmp("cce-project");
		const { config, path } = configWithFile({});
		const handlers = createClaudeCodeEndpointHandlers(config);

		const created = await handlers.putEndpoint(
			put({ directory: project, description: "demo", models: ["sonnet"] }),
			"demo",
		);
		expect(created.status).toBe(200);
		const expected = {
			name: "demo",
			directory: project,
			description: "demo",
			models: ["sonnet"],
			permission_mode: "bypassPermissions",
			extra_args: [],
			max_concurrency: 2,
			timeout_ms: 600_000,
			base_path: "/demo/v1",
			directory_exists: true,
		};
		expect(await created.json()).toEqual(expected);
		expect(stored(path, CLAUDE_CODE_ENDPOINTS_CONFIG_KEY)).toEqual({
			demo: { directory: project, description: "demo", models: ["sonnet"] },
		});

		const fetched = handlers.getEndpoint("demo");
		expect(fetched.status).toBe(200);
		expect(await fetched.json()).toEqual(expected);

		expect(await handlers.listEndpoints().json()).toEqual({
			endpoints: [expected],
			errors: [],
		});

		const deleted = handlers.deleteEndpoint("demo");
		expect(deleted.status).toBe(204);
		expect(stored(path, CLAUDE_CODE_ENDPOINTS_CONFIG_KEY)).toEqual({});
		expect(await handlers.listEndpoints().json()).toEqual({
			endpoints: [],
			errors: [],
		});
		expect(handlers.getEndpoint("demo").status).toBe(404);
		expect(handlers.deleteEndpoint("demo").status).toBe(404);
	});

	it("lists endpoints sorted by name", async () => {
		const project = makeTmp("cce-project");
		const { config } = configWithFile({});
		const handlers = createClaudeCodeEndpointHandlers(config);
		for (const name of ["zeta", "alpha", "mid"]) {
			const response = await handlers.putEndpoint(
				put({ directory: project }),
				name,
			);
			expect(response.status).toBe(200);
		}
		const body = (await handlers.listEndpoints().json()) as {
			endpoints: Array<{ name: string }>;
		};
		expect(body.endpoints.map((e) => e.name)).toEqual(["alpha", "mid", "zeta"]);
	});

	it("refuses a directory that does not exist with 400 and writes nothing", async () => {
		const missing = join(makeTmp("cce-project"), "not-there");
		const { config, path } = configWithFile({});
		const handlers = createClaudeCodeEndpointHandlers(config);
		const response = await handlers.putEndpoint(
			put({ directory: missing }),
			"demo",
		);
		expect(response.status).toBe(400);
		expect(await errorText(response)).toContain("does not exist");
		expect(stored(path, CLAUDE_CODE_ENDPOINTS_CONFIG_KEY)).toBeUndefined();
	});

	it("refuses a directory that is a file with 400 and writes nothing", async () => {
		const file = join(makeTmp("cce-project"), "file.txt");
		writeFileSync(file, "x");
		const { config, path } = configWithFile({});
		const handlers = createClaudeCodeEndpointHandlers(config);
		const response = await handlers.putEndpoint(
			put({ directory: file }),
			"demo",
		);
		expect(response.status).toBe(400);
		expect(await errorText(response)).toContain("is not a directory");
		expect(stored(path, CLAUDE_CODE_ENDPOINTS_CONFIG_KEY)).toBeUndefined();
	});

	it("refuses an invalid or reserved name, bad JSON and bad config with 400", async () => {
		const project = makeTmp("cce-project");
		const { config, path } = configWithFile({});
		const handlers = createClaudeCodeEndpointHandlers(config);
		for (const name of ["Bad Name", "api", "v1", "gateways", "-x"]) {
			const response = await handlers.putEndpoint(
				put({ directory: project }),
				name,
			);
			expect(response.status).toBe(400);
			expect(await errorText(response)).toContain("invalid endpoint name");
		}
		const badJson = await handlers.putEndpoint(put("{nope"), "demo");
		expect(badJson.status).toBe(400);
		expect(await errorText(badJson)).toContain("Invalid JSON body");

		const unknown = await handlers.putEndpoint(
			put({ directory: project, permission_modes: "plan" }),
			"demo",
		);
		expect(unknown.status).toBe(400);
		expect(await errorText(unknown)).toContain("unknown endpoint field");

		const relative = await handlers.putEndpoint(
			put({ directory: "relative/dir" }),
			"demo",
		);
		expect(relative.status).toBe(400);
		expect(await errorText(relative)).toContain("absolute path");

		expect(stored(path, CLAUDE_CODE_ENDPOINTS_CONFIG_KEY)).toBeUndefined();
	});

	it("refuses a name an OpenAI gateway already holds with 409", async () => {
		const project = makeTmp("cce-project");
		const { config, path } = configWithFile({
			[OPENAI_GATEWAYS_CONFIG_KEY]: { shared: { description: "gw" } },
		});
		const handlers = createClaudeCodeEndpointHandlers(config);
		const response = await handlers.putEndpoint(
			put({ directory: project }),
			"shared",
		);
		expect(response.status).toBe(409);
		expect(await errorText(response)).toContain("OpenAI gateway");
		expect(stored(path, CLAUDE_CODE_ENDPOINTS_CONFIG_KEY)).toBeUndefined();

		const other = await handlers.putEndpoint(
			put({ directory: project }),
			"unshared",
		);
		expect(other.status).toBe(200);
	});

	it("makes the gateway PUT refuse a name an endpoint holds with 409", async () => {
		const project = makeTmp("cce-project");
		const { config, path } = configWithFile({});
		const endpoints = createClaudeCodeEndpointHandlers(config);
		const gateways = createOpenAIGatewayHandlers(config);
		expect(
			(await endpoints.putEndpoint(put({ directory: project }), "shared"))
				.status,
		).toBe(200);

		const response = await gateways.putGateway(
			put({ description: "gw" }),
			"shared",
		);
		expect(response.status).toBe(409);
		expect(await errorText(response)).toContain("Claude Code endpoint");
		expect(stored(path, OPENAI_GATEWAYS_CONFIG_KEY)).toBeUndefined();

		expect(
			(await gateways.putGateway(put({ description: "gw" }), "free")).status,
		).toBe(200);
	});

	it("replaces an existing endpoint in place", async () => {
		const project = makeTmp("cce-project");
		const { config, path } = configWithFile({});
		const handlers = createClaudeCodeEndpointHandlers(config);
		await handlers.putEndpoint(put({ directory: project }), "demo");
		const second = await handlers.putEndpoint(
			put({ directory: project, permission_mode: "plan" }),
			"demo",
		);
		expect(second.status).toBe(200);
		expect(stored(path, CLAUDE_CODE_ENDPOINTS_CONFIG_KEY)).toEqual({
			demo: { directory: project, permission_mode: "plan" },
		});
	});

	it("leaves a hand-edited invalid entry on disk, names it in errors, and deletes it on request", async () => {
		const project = makeTmp("cce-project");
		const { config, path } = configWithFile({
			[CLAUDE_CODE_ENDPOINTS_CONFIG_KEY]: {
				broken: { directory: "relative", models: [] },
			},
		});
		const handlers = createClaudeCodeEndpointHandlers(config);

		const before = (await handlers.listEndpoints().json()) as {
			endpoints: unknown[];
			errors: string[];
		};
		expect(before.endpoints).toEqual([]);
		expect(before.errors).toHaveLength(1);
		expect(before.errors[0]).toContain("endpoint broken:");

		await handlers.putEndpoint(put({ directory: project }), "good");
		expect(stored(path, CLAUDE_CODE_ENDPOINTS_CONFIG_KEY)).toEqual({
			broken: { directory: "relative", models: [] },
			good: { directory: project },
		});

		expect(handlers.deleteEndpoint("broken").status).toBe(204);
		expect(stored(path, CLAUDE_CODE_ENDPOINTS_CONFIG_KEY)).toEqual({
			good: { directory: project },
		});
	});

	it("reports directory_exists false once the directory is gone", async () => {
		const parent = makeTmp("cce-project");
		const project = join(parent, "child");
		mkdirSync(project);
		const { config } = configWithFile({});
		const handlers = createClaudeCodeEndpointHandlers(config);
		await handlers.putEndpoint(put({ directory: project }), "demo");
		rmSync(project, { recursive: true });

		const body = (await handlers.getEndpoint("demo").json()) as {
			directory_exists: boolean;
		};
		expect(body.directory_exists).toBe(false);
	});

	it("refuses to overwrite a key that is not an object", async () => {
		const project = makeTmp("cce-project");
		const { config, path } = configWithFile({
			[CLAUDE_CODE_ENDPOINTS_CONFIG_KEY]: ["oops"],
		});
		const handlers = createClaudeCodeEndpointHandlers(config);
		const response = await handlers.putEndpoint(
			put({ directory: project }),
			"demo",
		);
		expect(response.status).toBe(409);
		expect(handlers.deleteEndpoint("demo").status).toBe(409);
		expect(stored(path, CLAUDE_CODE_ENDPOINTS_CONFIG_KEY)).toEqual(["oops"]);
	});
});
