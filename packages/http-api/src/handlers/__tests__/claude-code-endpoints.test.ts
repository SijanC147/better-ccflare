import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Config } from "@better-ccflare/config";
import {
	CLAUDE_CODE_ALLOWED_HOSTS_CONFIG_KEY,
	CLAUDE_CODE_DIRECTORY_ROOTS_CONFIG_KEY,
	CLAUDE_CODE_ENDPOINTS_CONFIG_KEY,
	checkClaudeCodeExtraArgs,
	claudeCodeDirectoryRootsMessage,
	claudeCodeHostRefusalMessage,
	OPENAI_GATEWAYS_CONFIG_KEY,
} from "@better-ccflare/types";
import {
	type ClaudeCodeHostFacts,
	createClaudeCodeEndpointHandlers,
	loadClaudeCodeEndpointState,
	MAX_CLAUDE_CODE_ENDPOINTS,
} from "../claude-code-endpoints";
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

const WORKTREE = realpathSync(join(import.meta.dir, "../../../../.."));

/**
 * Resolved through symlinks, because the handler judges a directory by where
 * it lands: macOS's tmpdir is `/var/...`, which is `/private/var/...`, and a
 * fixture path that differs from its own realpath would pass or fail the roots
 * check for that reason rather than the one under test.
 */
function makeTmp(label: string): string {
	const dir = realpathSync(
		mkdtempSync(join(tmpdir(), `better-ccflare-${label}-`)),
	);
	if (dir.length === 0 || dir.startsWith(WORKTREE)) {
		throw new Error(`fixture dir ${JSON.stringify(dir)} is unsafe`);
	}
	tmpDirs.push(dir);
	return dir;
}

/** Every fixture sits under the real tmpdir, so that is the default root. */
const FACTS: ClaudeCodeHostFacts = {
	homeDir: realpathSync(tmpdir()),
	hostname: "test-host.local",
};

function handlersFor(config: Config, facts: ClaudeCodeHostFacts = FACTS) {
	return createClaudeCodeEndpointHandlers(config, facts);
}

function configWithFile(data: Record<string, unknown>): {
	config: Config;
	path: string;
} {
	// Not resolved: Config refuses a file under /private/var on macOS, where
	// tmpdir() is the /var symlink it allows.
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-cce-config-"));
	tmpDirs.push(dir);
	const path = join(dir, "config.json");
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

function put(body: unknown, host = "localhost"): Request {
	return new Request(`http://${host}/api/claude-code-endpoints/x`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

function del(host = "localhost"): Request {
	return new Request(`http://${host}/api/claude-code-endpoints/x`, {
		method: "DELETE",
	});
}

async function errorText(response: Response): Promise<string> {
	return JSON.stringify(await response.json());
}

describe("claude code endpoints API", () => {
	it("round trips PUT, GET, list, DELETE, then 404", async () => {
		const project = makeTmp("cce-project");
		const { config, path } = configWithFile({});
		const handlers = handlersFor(config);

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

		const deleted = handlers.deleteEndpoint(del(), "demo");
		expect(deleted.status).toBe(204);
		expect(stored(path, CLAUDE_CODE_ENDPOINTS_CONFIG_KEY)).toEqual({});
		expect(await handlers.listEndpoints().json()).toEqual({
			endpoints: [],
			errors: [],
		});
		expect(handlers.getEndpoint("demo").status).toBe(404);
		expect(handlers.deleteEndpoint(del(), "demo").status).toBe(404);
	});

	it("lists endpoints sorted by name", async () => {
		const project = makeTmp("cce-project");
		const { config } = configWithFile({});
		const handlers = handlersFor(config);
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
		const handlers = handlersFor(config);
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
		const handlers = handlersFor(config);
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
		const handlers = handlersFor(config);
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
		const handlers = handlersFor(config);
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
		const endpoints = handlersFor(config);
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
		const handlers = handlersFor(config);
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
		const handlers = handlersFor(config);

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

		expect(handlers.deleteEndpoint(del(), "broken").status).toBe(204);
		expect(stored(path, CLAUDE_CODE_ENDPOINTS_CONFIG_KEY)).toEqual({
			good: { directory: project },
		});
	});

	it("reports directory_exists false once the directory is gone", async () => {
		const parent = makeTmp("cce-project");
		const project = join(parent, "child");
		mkdirSync(project);
		const { config } = configWithFile({});
		const handlers = handlersFor(config);
		await handlers.putEndpoint(put({ directory: project }), "demo");
		rmSync(project, { recursive: true });

		const body = (await handlers.getEndpoint("demo").json()) as {
			directory_exists: boolean;
		};
		expect(body.directory_exists).toBe(false);
	});

	it("caps the stored endpoints, counting invalid entries, but still replaces one at the cap", async () => {
		const project = makeTmp("cce-project");
		const seeded: Record<string, unknown> = {};
		for (let i = 0; i < MAX_CLAUDE_CODE_ENDPOINTS - 1; i++) {
			seeded[`e${i}`] = { directory: "/srv/seeded" };
		}
		seeded.broken = { directory: "relative" };
		const { config, path } = configWithFile({
			[CLAUDE_CODE_ENDPOINTS_CONFIG_KEY]: seeded,
		});
		const handlers = handlersFor(config);

		const refused = await handlers.putEndpoint(
			put({ directory: project }),
			"one-too-many",
		);
		expect(refused.status).toBe(400);
		expect(await errorText(refused)).toContain(
			String(MAX_CLAUDE_CODE_ENDPOINTS),
		);
		expect(
			Object.keys(
				stored(path, CLAUDE_CODE_ENDPOINTS_CONFIG_KEY) as Record<
					string,
					unknown
				>,
			),
		).toHaveLength(MAX_CLAUDE_CODE_ENDPOINTS);

		const replaced = await handlers.putEndpoint(
			put({ directory: project }),
			"e0",
		);
		expect(replaced.status).toBe(200);
	});

	it("refuses to overwrite a key that is not an object", async () => {
		const project = makeTmp("cce-project");
		const { config, path } = configWithFile({
			[CLAUDE_CODE_ENDPOINTS_CONFIG_KEY]: ["oops"],
		});
		const handlers = handlersFor(config);
		const response = await handlers.putEndpoint(
			put({ directory: project }),
			"demo",
		);
		expect(response.status).toBe(409);
		expect(handlers.deleteEndpoint(del(), "demo").status).toBe(409);
		expect(stored(path, CLAUDE_CODE_ENDPOINTS_CONFIG_KEY)).toEqual(["oops"]);
	});
});

describe("claude code endpoints API: Host allowlist (SB23-3408 item 6)", () => {
	async function expectHostRefusal(response: Response): Promise<void> {
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: claudeCodeHostRefusalMessage("evil.example"),
			config_key: CLAUDE_CODE_ALLOWED_HOSTS_CONFIG_KEY,
		});
	}

	it("refuses PUT and DELETE from a foreign Host with 403 and leaves the file untouched", async () => {
		const project = makeTmp("cce-project");
		const { config, path } = configWithFile({
			[CLAUDE_CODE_ENDPOINTS_CONFIG_KEY]: { keep: { directory: project } },
		});
		const handlers = handlersFor(config);
		const before = readFileSync(path, "utf8");

		await expectHostRefusal(
			await handlers.putEndpoint(
				put({ directory: project }, "evil.example"),
				"demo",
			),
		);
		await expectHostRefusal(
			handlers.deleteEndpoint(del("evil.example"), "keep"),
		);
		// Refused before the name and the body are read.
		await expectHostRefusal(
			await handlers.putEndpoint(put("{nope", "evil.example"), "Bad Name"),
		);

		expect(readFileSync(path, "utf8")).toBe(before);
		expect(stored(path, CLAUDE_CODE_ENDPOINTS_CONFIG_KEY)).toEqual({
			keep: { directory: project },
		});
	});

	it("refuses rebinding-style names that only contain an allowed one", async () => {
		const project = makeTmp("cce-project");
		const { config, path } = configWithFile({});
		const handlers = handlersFor(config);
		for (const host of [
			"localhost.evil.example",
			"127.0.0.1.nip.io",
			"test-host.evil.example",
		]) {
			const response = await handlers.putEndpoint(
				put({ directory: project }, host),
				"demo",
			);
			expect(response.status).toBe(403);
		}
		expect(stored(path, CLAUDE_CODE_ENDPOINTS_CONFIG_KEY)).toBeUndefined();
	});

	it("allows the same foreign Host once it is listed in the config", async () => {
		const project = makeTmp("cce-project");
		const { config, path } = configWithFile({
			[CLAUDE_CODE_ALLOWED_HOSTS_CONFIG_KEY]: ["evil.example"],
		});
		const handlers = handlersFor(config);
		const created = await handlers.putEndpoint(
			put({ directory: project }, "evil.example"),
			"demo",
		);
		expect(created.status).toBe(200);
		expect(stored(path, CLAUDE_CODE_ENDPOINTS_CONFIG_KEY)).toEqual({
			demo: { directory: project },
		});
		expect(handlers.deleteEndpoint(del("evil.example"), "demo").status).toBe(
			204,
		);
		expect(stored(path, CLAUDE_CODE_ENDPOINTS_CONFIG_KEY)).toEqual({});
	});

	it("allows IP literals, localhost and the machine's own names", async () => {
		const project = makeTmp("cce-project");
		const { config } = configWithFile({});
		const handlers = handlersFor(config);
		for (const host of [
			"127.0.0.1:8080",
			"192.168.1.20",
			"[::1]:8080",
			"localhost:8080",
			"test-host",
			"TEST-HOST.local",
		]) {
			const response = await handlers.putEndpoint(
				put({ directory: project }, host),
				"demo",
			);
			expect({ host, status: response.status }).toEqual({
				host,
				status: 200,
			});
		}
	});
});

describe("claude code endpoints API: directory roots (SB23-3408 item 7)", () => {
	/** A root and a sibling outside it, with the roots key naming the root. */
	function rootedConfig(extra: Record<string, unknown> = {}) {
		const root = makeTmp("cce-root");
		const outside = makeTmp("cce-outside");
		const { config, path } = configWithFile({
			[CLAUDE_CODE_DIRECTORY_ROOTS_CONFIG_KEY]: [root],
			...extra,
		});
		return { root, outside, config, path };
	}

	it("refuses a directory outside the roots with 400 and writes nothing", async () => {
		const { outside, root, config, path } = rootedConfig();
		const handlers = handlersFor(config);
		const response = await handlers.putEndpoint(
			put({ directory: outside }),
			"demo",
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: claudeCodeDirectoryRootsMessage(outside, [root]),
		});
		expect(stored(path, CLAUDE_CODE_ENDPOINTS_CONFIG_KEY)).toBeUndefined();
	});

	it("refuses a '..' path that climbs out of the root", async () => {
		const { outside, root, config, path } = rootedConfig();
		const handlers = handlersFor(config);
		const climbing = join(root, "..", basename(outside));
		const response = await handlers.putEndpoint(
			put({ directory: `${root}/../${basename(outside)}` }),
			"demo",
		);
		expect(climbing).toBe(outside);
		expect(response.status).toBe(400);
		expect(await errorText(response)).toContain(
			CLAUDE_CODE_DIRECTORY_ROOTS_CONFIG_KEY,
		);
		expect(stored(path, CLAUDE_CODE_ENDPOINTS_CONFIG_KEY)).toBeUndefined();
	});

	it("refuses a symlink inside the root that points outside it", async () => {
		const { outside, root, config, path } = rootedConfig();
		const link = join(root, "link");
		symlinkSync(outside, link);
		const handlers = handlersFor(config);
		const response = await handlers.putEndpoint(
			put({ directory: link }),
			"demo",
		);
		expect(response.status).toBe(400);
		expect(await errorText(response)).toContain(
			CLAUDE_CODE_DIRECTORY_ROOTS_CONFIG_KEY,
		);
		expect(stored(path, CLAUDE_CODE_ENDPOINTS_CONFIG_KEY)).toBeUndefined();
	});

	it("accepts the root itself and a directory inside it", async () => {
		const { root, config, path } = rootedConfig();
		const inside = join(root, "project");
		mkdirSync(inside);
		const handlers = handlersFor(config);
		expect(
			(await handlers.putEndpoint(put({ directory: inside }), "inner")).status,
		).toBe(200);
		expect(
			(await handlers.putEndpoint(put({ directory: root }), "top")).status,
		).toBe(200);
		expect(stored(path, CLAUDE_CODE_ENDPOINTS_CONFIG_KEY)).toEqual({
			inner: { directory: inside },
			top: { directory: root },
		});
	});

	it("defaults the root to the home directory when the key is unset", async () => {
		const home = makeTmp("cce-home");
		const outside = makeTmp("cce-outside");
		const { config, path } = configWithFile({});
		const handlers = handlersFor(config, {
			homeDir: home,
			hostname: "test-host.local",
		});
		const refused = await handlers.putEndpoint(
			put({ directory: outside }),
			"demo",
		);
		expect(refused.status).toBe(400);
		expect(await refused.json()).toEqual({
			error: claudeCodeDirectoryRootsMessage(outside, [home]),
		});
		expect(stored(path, CLAUDE_CODE_ENDPOINTS_CONFIG_KEY)).toBeUndefined();
		expect(
			(await handlers.putEndpoint(put({ directory: home }), "demo")).status,
		).toBe(200);
	});

	it("keeps stored entries the new rules refuse across an unrelated PUT, and never serves them", async () => {
		const root = makeTmp("cce-root");
		const outside = makeTmp("cce-outside");
		const project = join(root, "project");
		mkdirSync(project);
		const seeded = {
			hooks: { directory: project, extra_args: ["--settings", "{}"] },
			escaped: { directory: outside },
		};
		const { config, path: seededPath } = configWithFile({
			[CLAUDE_CODE_DIRECTORY_ROOTS_CONFIG_KEY]: [root],
			[CLAUDE_CODE_ENDPOINTS_CONFIG_KEY]: seeded,
		});
		const handlers = handlersFor(config);

		const created = await handlers.putEndpoint(
			put({ directory: project }),
			"good",
		);
		expect(created.status).toBe(200);
		expect(stored(seededPath, CLAUDE_CODE_ENDPOINTS_CONFIG_KEY)).toEqual({
			...seeded,
			good: { directory: project },
		});

		const listed = (await handlers.listEndpoints().json()) as {
			endpoints: Array<{ name: string }>;
			errors: string[];
		};
		expect(listed.endpoints.map((e) => e.name)).toEqual(["good"]);
		expect(listed.errors).toEqual([
			`endpoint hooks: ${checkClaudeCodeExtraArgs(["--settings", "{}"])}`,
			`endpoint escaped: ${claudeCodeDirectoryRootsMessage(outside, [root])}`,
		]);
		expect(handlers.getEndpoint("hooks").status).toBe(404);
		expect(handlers.getEndpoint("escaped").status).toBe(404);
		expect(handlers.getEndpoint("good").status).toBe(200);

		// DELETE is still the way to clear either one.
		expect(handlers.deleteEndpoint(del(), "escaped").status).toBe(204);
		expect(stored(seededPath, CLAUDE_CODE_ENDPOINTS_CONFIG_KEY)).toEqual({
			hooks: seeded.hooks,
			good: { directory: project },
		});
	});
});

describe("loadClaudeCodeEndpointState", () => {
	it("serves only in-root valid entries and reports the rest", () => {
		const root = makeTmp("cce-root");
		const outside = makeTmp("cce-outside");
		const { config } = configWithFile({
			[CLAUDE_CODE_DIRECTORY_ROOTS_CONFIG_KEY]: [root],
			[CLAUDE_CODE_ALLOWED_HOSTS_CONFIG_KEY]: ["Proxy.Example"],
			[CLAUDE_CODE_ENDPOINTS_CONFIG_KEY]: {
				inside: { directory: root },
				escaped: { directory: outside },
			},
		});
		expect(loadClaudeCodeEndpointState(config, FACTS)).toEqual({
			endpoints: { inside: { directory: root } },
			errors: [
				`endpoint escaped: ${claudeCodeDirectoryRootsMessage(outside, [root])}`,
			],
			allowedHosts: ["proxy.example"],
		});
	});

	it("reports a bad allowed-hosts or roots value and falls back to the home directory", () => {
		const home = makeTmp("cce-home");
		const outside = makeTmp("cce-outside");
		const facts = { homeDir: home, hostname: "test-host.local" };
		const endpoints = {
			[CLAUDE_CODE_ENDPOINTS_CONFIG_KEY]: {
				home: { directory: home },
				escaped: { directory: outside },
			},
		};
		const escapedError = `endpoint escaped: ${claudeCodeDirectoryRootsMessage(outside, [home])}`;

		const notArrays = configWithFile({
			...endpoints,
			[CLAUDE_CODE_ALLOWED_HOSTS_CONFIG_KEY]: "evil.example",
			[CLAUDE_CODE_DIRECTORY_ROOTS_CONFIG_KEY]: "/",
		}).config;
		expect(loadClaudeCodeEndpointState(notArrays, facts)).toEqual({
			endpoints: { home: { directory: home } },
			errors: [
				`${CLAUDE_CODE_ALLOWED_HOSTS_CONFIG_KEY} must be an array of host names`,
				`${CLAUDE_CODE_DIRECTORY_ROOTS_CONFIG_KEY} must be a non-empty array of absolute paths; using the home directory`,
				escapedError,
			],
			allowedHosts: [],
		});

		const badEntries = configWithFile({
			...endpoints,
			[CLAUDE_CODE_ALLOWED_HOSTS_CONFIG_KEY]: ["ok.example", "evil.example:80"],
			[CLAUDE_CODE_DIRECTORY_ROOTS_CONFIG_KEY]: ["/", "relative"],
		}).config;
		expect(loadClaudeCodeEndpointState(badEntries, facts)).toEqual({
			endpoints: { home: { directory: home } },
			errors: [
				`${CLAUDE_CODE_ALLOWED_HOSTS_CONFIG_KEY} entry "evil.example:80" is not a host name (no scheme, port or path)`,
				`${CLAUDE_CODE_DIRECTORY_ROOTS_CONFIG_KEY} entry "relative" is not an absolute path; using the home directory`,
				escapedError,
			],
			allowedHosts: ["ok.example"],
		});

		const empty = configWithFile({
			...endpoints,
			[CLAUDE_CODE_DIRECTORY_ROOTS_CONFIG_KEY]: [],
		}).config;
		expect(loadClaudeCodeEndpointState(empty, facts).errors).toEqual([
			`${CLAUDE_CODE_DIRECTORY_ROOTS_CONFIG_KEY} must be a non-empty array of absolute paths; using the home directory`,
			escapedError,
		]);
	});
});
