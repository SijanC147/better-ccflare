import { describe, expect, it } from "bun:test";
import {
	CLAUDE_CODE_ENDPOINTS_CONFIG_KEY,
	CLAUDE_CODE_PERMISSION_MODES,
	type ClaudeCodeEndpointConfig,
	claudeCodeEndpointBasePath,
	DEFAULT_CLAUDE_CODE_MODELS,
	isValidClaudeCodeEndpointName,
	MAX_CLAUDE_CODE_CONCURRENCY,
	MAX_CLAUDE_CODE_EXTRA_ARGS,
	MAX_CLAUDE_CODE_MODELS,
	MAX_CLAUDE_CODE_TIMEOUT_MS,
	MIN_CLAUDE_CODE_TIMEOUT_MS,
	parseClaudeCodeEndpoints,
	resolveClaudeCodeEndpoint,
	validateClaudeCodeEndpointConfig,
} from "../claude-code-endpoints";

/**
 * Pure validation for `claude_code_endpoints`. Existence of the directory is
 * deliberately not checked here; the API handler does that.
 */

function refusal(input: unknown): string {
	const result = validateClaudeCodeEndpointConfig(input);
	if (result.ok) {
		throw new Error(
			`expected a refusal, got ${JSON.stringify(result.value)} for ${JSON.stringify(input)}`,
		);
	}
	return result.error;
}

describe("validateClaudeCodeEndpointConfig", () => {
	it("accepts a directory alone", () => {
		expect(validateClaudeCodeEndpointConfig({ directory: "/srv/app" })).toEqual(
			{ ok: true, value: { directory: "/srv/app" } },
		);
	});

	it("accepts every field and returns it unchanged", () => {
		const full: ClaudeCodeEndpointConfig = {
			directory: "/srv/app",
			description: "the app",
			models: ["default", "sonnet", "claude-opus-4-8[1m]"],
			permission_mode: "acceptEdits",
			extra_args: ["--bare", "--allowedTools", "Read"],
			max_concurrency: 4,
			timeout_ms: 120_000,
		};
		expect(validateClaudeCodeEndpointConfig(full)).toEqual({
			ok: true,
			value: full,
		});
	});

	it("accepts a Windows drive path as absolute", () => {
		expect(
			validateClaudeCodeEndpointConfig({ directory: "C:\\work\\app" }).ok,
		).toBe(true);
	});

	it("refuses anything but an object", () => {
		for (const input of [null, undefined, "x", 3, []]) {
			expect(refusal(input)).toBe("endpoint config must be an object");
		}
	});

	it("refuses an unknown field instead of dropping it", () => {
		expect(refusal({ directory: "/srv/app", permission_modes: "plan" })).toBe(
			"unknown endpoint field: permission_modes",
		);
	});

	it("requires a directory", () => {
		expect(refusal({})).toContain("directory is required");
		expect(refusal({ directory: "" })).toContain("directory is required");
		expect(refusal({ directory: 7 })).toContain("directory is required");
	});

	it("refuses a relative, NUL-bearing or oversized directory", () => {
		expect(refusal({ directory: "srv/app" })).toContain("absolute path");
		expect(refusal({ directory: "./app" })).toContain("absolute path");
		expect(refusal({ directory: "/srv/\0app" })).toContain("NUL");
		expect(refusal({ directory: `/${"a".repeat(4096)}` })).toContain("4096");
		expect(validateClaudeCodeEndpointConfig({ directory: "/a" }).ok).toBe(true);
		expect(
			validateClaudeCodeEndpointConfig({ directory: `/${"a".repeat(4095)}` })
				.ok,
		).toBe(true);
	});

	it("bounds description at 500 characters", () => {
		expect(refusal({ directory: "/a", description: 1 })).toContain(
			"description must be a string",
		);
		expect(
			refusal({ directory: "/a", description: "x".repeat(501) }),
		).toContain("500");
		expect(
			validateClaudeCodeEndpointConfig({
				directory: "/a",
				description: "x".repeat(500),
			}).ok,
		).toBe(true);
	});

	it("refuses empty, duplicated, malformed or oversized models", () => {
		expect(refusal({ directory: "/a", models: "sonnet" })).toContain(
			"must be an array",
		);
		expect(refusal({ directory: "/a", models: [] })).toContain("at least one");
		expect(
			refusal({ directory: "/a", models: ["sonnet", "sonnet"] }),
		).toContain("listed twice");
		expect(refusal({ directory: "/a", models: ["has space"] })).toContain(
			"model ids",
		);
		expect(refusal({ directory: "/a", models: [""] })).toContain("model ids");
		expect(refusal({ directory: "/a", models: [5] })).toContain("model ids");
		expect(refusal({ directory: "/a", models: ["-lead"] })).toContain(
			"model ids",
		);
		const tooMany = Array.from(
			{ length: MAX_CLAUDE_CODE_MODELS + 1 },
			(_, i) => `m${i}`,
		);
		expect(refusal({ directory: "/a", models: tooMany })).toContain(
			String(MAX_CLAUDE_CODE_MODELS),
		);
		expect(
			validateClaudeCodeEndpointConfig({
				directory: "/a",
				models: tooMany.slice(0, MAX_CLAUDE_CODE_MODELS),
			}).ok,
		).toBe(true);
	});

	it("accepts only the listed permission modes", () => {
		for (const mode of CLAUDE_CODE_PERMISSION_MODES) {
			expect(
				validateClaudeCodeEndpointConfig({
					directory: "/a",
					permission_mode: mode,
				}).ok,
			).toBe(true);
		}
		expect(refusal({ directory: "/a", permission_mode: "yolo" })).toContain(
			"permission_mode must be one of",
		);
		expect(refusal({ directory: "/a", permission_mode: 1 })).toContain(
			"permission_mode must be one of",
		);
	});

	it("bounds extra_args by count, length and content", () => {
		expect(refusal({ directory: "/a", extra_args: "--bare" })).toContain(
			"must be an array",
		);
		expect(refusal({ directory: "/a", extra_args: ["--ok", 3] })).toContain(
			"must be strings",
		);
		expect(refusal({ directory: "/a", extra_args: ["a\0b"] })).toContain("NUL");
		expect(
			refusal({ directory: "/a", extra_args: ["x".repeat(1025)] }),
		).toContain("1024");
		const tooMany = Array.from(
			{ length: MAX_CLAUDE_CODE_EXTRA_ARGS + 1 },
			() => "--x",
		);
		expect(refusal({ directory: "/a", extra_args: tooMany })).toContain(
			String(MAX_CLAUDE_CODE_EXTRA_ARGS),
		);
		expect(
			validateClaudeCodeEndpointConfig({
				directory: "/a",
				extra_args: ["--agent", "x".repeat(1024)],
			}).ok,
		).toBe(true);
		expect(
			validateClaudeCodeEndpointConfig({ directory: "/a", extra_args: [] }).ok,
		).toBe(true);
	});

	it("bounds max_concurrency to an integer from 1 to the maximum", () => {
		for (const bad of [
			0,
			-1,
			1.5,
			"2",
			Number.NaN,
			MAX_CLAUDE_CODE_CONCURRENCY + 1,
		]) {
			expect(refusal({ directory: "/a", max_concurrency: bad })).toContain(
				"max_concurrency",
			);
		}
		for (const good of [1, MAX_CLAUDE_CODE_CONCURRENCY]) {
			expect(
				validateClaudeCodeEndpointConfig({
					directory: "/a",
					max_concurrency: good,
				}).ok,
			).toBe(true);
		}
	});

	it("bounds timeout_ms to an integer between the minimum and maximum", () => {
		for (const bad of [
			MIN_CLAUDE_CODE_TIMEOUT_MS - 1,
			MAX_CLAUDE_CODE_TIMEOUT_MS + 1,
			15_000.5,
			"20000",
			Number.POSITIVE_INFINITY,
		]) {
			expect(refusal({ directory: "/a", timeout_ms: bad })).toContain(
				"timeout_ms",
			);
		}
		for (const good of [
			MIN_CLAUDE_CODE_TIMEOUT_MS,
			MAX_CLAUDE_CODE_TIMEOUT_MS,
		]) {
			expect(
				validateClaudeCodeEndpointConfig({ directory: "/a", timeout_ms: good })
					.ok,
			).toBe(true);
		}
	});
});

describe("parseClaudeCodeEndpoints", () => {
	it("reads valid entries and reports each invalid one by name", () => {
		const parsed = parseClaudeCodeEndpoints({
			good: { directory: "/srv/good" },
			"Bad Name": { directory: "/srv/x" },
			api: { directory: "/srv/reserved" },
			typo: { directory: "/srv/typo", permission_modes: "plan" },
			relative: { directory: "rel" },
		});
		expect(parsed.endpoints).toEqual({ good: { directory: "/srv/good" } });
		expect(parsed.errors).toEqual([
			'invalid endpoint name "Bad Name"',
			'invalid endpoint name "api"',
			"endpoint typo: unknown endpoint field: permission_modes",
			'endpoint relative: directory must be an absolute path; got "rel"',
		]);
	});

	it("treats an absent key as empty and a non-object as one error", () => {
		expect(parseClaudeCodeEndpoints(undefined)).toEqual({
			endpoints: {},
			errors: [],
		});
		expect(parseClaudeCodeEndpoints(null)).toEqual({
			endpoints: {},
			errors: [],
		});
		for (const raw of [[], "x", 3]) {
			expect(parseClaudeCodeEndpoints(raw)).toEqual({
				endpoints: {},
				errors: [`${CLAUDE_CODE_ENDPOINTS_CONFIG_KEY} must be an object`],
			});
		}
	});
});

describe("names and resolution", () => {
	it("shares the gateway name rules and refuses reserved first segments", () => {
		expect(isValidClaudeCodeEndpointName("my-project_2")).toBe(true);
		for (const bad of [
			"",
			"Upper",
			"-lead",
			"a/b",
			"a b",
			"api",
			"v1",
			"gateways",
			3,
		]) {
			expect(isValidClaudeCodeEndpointName(bad)).toBe(false);
		}
		expect(claudeCodeEndpointBasePath("proj")).toBe("/proj/v1");
	});

	it("fills every default when only a directory is stored", () => {
		expect(resolveClaudeCodeEndpoint("p", { directory: "/srv/p" })).toEqual({
			name: "p",
			directory: "/srv/p",
			description: null,
			models: [...DEFAULT_CLAUDE_CODE_MODELS],
			permission_mode: "bypassPermissions",
			extra_args: [],
			max_concurrency: 2,
			timeout_ms: 600_000,
		});
	});
});
