import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@better-ccflare/config";
import { OPENAI_GATEWAYS_CONFIG_KEY } from "@better-ccflare/types";
import {
	createOpenAIGatewayHandlers,
	MAX_OPENAI_GATEWAYS,
} from "../openai-gateways";

/**
 * `/api/openai-gateways` (SB23-2720). Every test runs against a real `Config`
 * on a temp file and reads the file back, so what is asserted is what the
 * next boot would load, not what an in-memory map happens to hold.
 */

const tmpDirs: string[] = [];

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function configWithFile(data: Record<string, unknown>): {
	config: Config;
	path: string;
} {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-gateways-"));
	tmpDirs.push(dir);
	const path = join(dir, "config.json");
	writeFileSync(path, JSON.stringify(data));
	return { config: new Config(path), path };
}

function storedGateways(path: string): unknown {
	const data = JSON.parse(readFileSync(path, "utf8")) as Record<
		string,
		unknown
	>;
	return data[OPENAI_GATEWAYS_CONFIG_KEY];
}

function put(body: unknown): Request {
	return new Request("http://localhost/api/openai-gateways/x", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

describe("openai gateways API", () => {
	it("round trips PUT, GET, DELETE, then 404", async () => {
		const { config, path } = configWithFile({});
		const handlers = createOpenAIGatewayHandlers(config);

		const created = await handlers.putGateway(
			put({ exclude_providers: ["anthropic-oauth"], description: "work" }),
			"work",
		);
		expect(created.status).toBe(200);
		expect(await created.json()).toEqual({
			name: "work",
			base_path: "/v1/gateways/work",
			exclude_providers: ["anthropic-oauth"],
			description: "work",
		});

		const listed = await handlers.listGateways().json();
		expect(listed).toEqual({
			gateways: [
				{
					name: "work",
					base_path: "/v1/gateways/work",
					exclude_providers: ["anthropic-oauth"],
					description: "work",
				},
			],
			errors: [],
		});
		expect(storedGateways(path)).toEqual({
			work: { exclude_providers: ["anthropic-oauth"], description: "work" },
		});

		const deleted = handlers.deleteGateway("work");
		expect(deleted.status).toBe(204);
		expect(storedGateways(path)).toEqual({});
		expect(
			((await handlers.listGateways().json()) as { gateways: unknown[] })
				.gateways,
		).toEqual([]);

		expect(handlers.deleteGateway("work").status).toBe(404);
	});

	it("refuses an invalid name with 400 and writes nothing", async () => {
		const { config, path } = configWithFile({});
		const handlers = createOpenAIGatewayHandlers(config);
		const response = await handlers.putGateway(put({}), "Bad Name");
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toContain(
			"invalid gateway name",
		);
		expect(storedGateways(path)).toBeUndefined();
	});

	it("refuses an unknown body field with the validator's error", async () => {
		const { config, path } = configWithFile({});
		const handlers = createOpenAIGatewayHandlers(config);
		const response = await handlers.putGateway(
			put({ exclude_provider: ["codex"] }),
			"work",
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "unknown gateway field: exclude_provider",
		});
		expect(storedGateways(path)).toBeUndefined();
	});

	it("refuses exclude_providers that is not an array", async () => {
		const { config, path } = configWithFile({});
		const handlers = createOpenAIGatewayHandlers(config);
		const response = await handlers.putGateway(
			put({ exclude_providers: "codex" }),
			"work",
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "exclude_providers must be an array",
		});
		expect(storedGateways(path)).toBeUndefined();
	});

	it("refuses a body that is not JSON", async () => {
		const { config } = configWithFile({});
		const handlers = createOpenAIGatewayHandlers(config);
		const response = await handlers.putGateway(put("{not json"), "work");
		expect(response.status).toBe(400);
	});

	it("leaves another gateway untouched on PUT", async () => {
		const other = { exclude_providers: ["codex"], description: "home" };
		const { config, path } = configWithFile({
			[OPENAI_GATEWAYS_CONFIG_KEY]: { home: other },
		});
		const handlers = createOpenAIGatewayHandlers(config);

		const response = await handlers.putGateway(
			put({ exclude_providers: ["anthropic-oauth"] }),
			"work",
		);
		expect(response.status).toBe(200);
		expect(storedGateways(path)).toEqual({
			home: other,
			work: { exclude_providers: ["anthropic-oauth"] },
		});
	});

	// Read-modify-write through `parseOpenAIGateways` would drop these, which
	// is a filter on load that deletes on save.
	it("keeps a stored entry that fails validation, on PUT and on DELETE of another", async () => {
		const broken = { exclude_provider: ["codex"] };
		const { config, path } = configWithFile({
			[OPENAI_GATEWAYS_CONFIG_KEY]: {
				typo: broken,
				"Bad Name": { description: "x" },
				home: { description: "home" },
			},
		});
		const handlers = createOpenAIGatewayHandlers(config);

		const listed = (await handlers.listGateways().json()) as {
			gateways: Array<{ name: string }>;
			errors: string[];
		};
		expect(listed.gateways.map((g) => g.name)).toEqual(["home"]);
		expect(listed.errors).toHaveLength(2);

		await handlers.putGateway(put({}), "work");
		expect(handlers.deleteGateway("home").status).toBe(204);

		expect(storedGateways(path)).toEqual({
			typo: broken,
			"Bad Name": { description: "x" },
			work: {},
		});
	});

	it("DELETE removes an entry that fails validation", async () => {
		const { config, path } = configWithFile({
			[OPENAI_GATEWAYS_CONFIG_KEY]: { typo: { exclude_provider: [] } },
		});
		const handlers = createOpenAIGatewayHandlers(config);
		expect(handlers.deleteGateway("typo").status).toBe(204);
		expect(storedGateways(path)).toEqual({});
	});

	it("refuses to overwrite a stored value that is not an object", async () => {
		const { config, path } = configWithFile({
			[OPENAI_GATEWAYS_CONFIG_KEY]: ["not", "a", "map"],
		});
		const handlers = createOpenAIGatewayHandlers(config);
		expect((await handlers.putGateway(put({}), "work")).status).toBe(409);
		expect(handlers.deleteGateway("work").status).toBe(409);
		expect(storedGateways(path)).toEqual(["not", "a", "map"]);
	});

	it("refuses a new gateway at the cap and still updates an existing one", async () => {
		const full: Record<string, unknown> = {};
		for (let i = 0; i < MAX_OPENAI_GATEWAYS; i++) full[`g${i}`] = {};
		const { config, path } = configWithFile({
			[OPENAI_GATEWAYS_CONFIG_KEY]: full,
		});
		const handlers = createOpenAIGatewayHandlers(config);

		const refused = await handlers.putGateway(put({}), "one-more");
		expect(refused.status).toBe(400);
		expect(await refused.json()).toEqual({
			error: `at most ${MAX_OPENAI_GATEWAYS} gateways can be configured; delete one first`,
		});
		expect(Object.keys(storedGateways(path) as object)).toHaveLength(
			MAX_OPENAI_GATEWAYS,
		);

		const updated = await handlers.putGateway(
			put({ description: "updated" }),
			"g0",
		);
		expect(updated.status).toBe(200);
		expect((storedGateways(path) as Record<string, unknown>).g0).toEqual({
			description: "updated",
		});
	});

	// Fails if the handler writes through `config.set` (scalars only, and the
	// wrong seam) instead of `setObjectSetting`: `set` throws here, and the
	// assertion requires exactly one `setObjectSetting` call carrying the map.
	it("writes only through setObjectSetting", async () => {
		const { config } = configWithFile({});
		const calls: Array<{ key: string; value: unknown }> = [];
		const original = config.setObjectSetting.bind(config);
		config.set = () => {
			throw new Error("config.set must not be used for gateways");
		};
		config.setObjectSetting = (key, value) => {
			calls.push({ key, value: structuredClone(value) });
			original(key, value);
		};
		const handlers = createOpenAIGatewayHandlers(config);

		const response = await handlers.putGateway(put({}), "work");
		expect(response.status).toBe(200);
		expect(calls).toEqual([
			{ key: OPENAI_GATEWAYS_CONFIG_KEY, value: { work: {} } },
		]);

		expect(handlers.deleteGateway("work").status).toBe(204);
		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual({ key: OPENAI_GATEWAYS_CONFIG_KEY, value: {} });
	});
});
