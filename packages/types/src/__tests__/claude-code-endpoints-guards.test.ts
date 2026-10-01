import { describe, expect, it } from "bun:test";
import {
	CLAUDE_CODE_ALLOWED_HOSTS_CONFIG_KEY,
	checkClaudeCodeExtraArgs,
	claudeCodeMachineHostnames,
	isClaudeCodeHostAllowed,
	isPathWithinRoots,
	parseClaudeCodeAllowedHosts,
	validateClaudeCodeEndpointConfig,
} from "../claude-code-endpoints";

/**
 * The SB23-3408 guards on the command-execution surface: the Host allowlist
 * (item 6), and the `extra_args` flag allowlist plus the directory-roots
 * containment check (item 7).
 */

describe("isClaudeCodeHostAllowed", () => {
	const machine = claudeCodeMachineHostnames("Seans-Mac-Studio-218.local");

	it("derives the full, short and .local forms of the machine name, lowercased", () => {
		expect(machine).toEqual([
			"seans-mac-studio-218.local",
			"seans-mac-studio-218",
		]);
		expect(claudeCodeMachineHostnames("Box")).toEqual(["box", "box.local"]);
		expect(claudeCodeMachineHostnames("")).toEqual([]);
	});

	it("accepts IP literals, localhost, the machine's names and the extras", () => {
		for (const host of [
			"127.0.0.1",
			"192.168.1.20",
			"0.0.0.0",
			"255.255.255.255",
			"[::1]",
			"[fe80::1]",
			"localhost",
			"LOCALHOST",
			"localhost.",
			"seans-mac-studio-218.local",
			"seans-mac-studio-218",
			"SEANS-MAC-STUDIO-218.LOCAL",
			"Seans-Mac-Studio-218",
			"proxy.example",
		]) {
			expect({
				host,
				ok: isClaudeCodeHostAllowed(host, machine, ["proxy.example"]),
			}).toEqual({ host, ok: true });
		}
	});

	it("refuses foreign names, rebinding-style names, bad IPs and no host", () => {
		for (const host of [
			"evil.example",
			"localhost.evil.example",
			"127.0.0.1.nip.io",
			"999.1.1.1",
			"256.0.0.1",
			"seans-mac-studio-218.evil.example",
			"other-mac.local",
			"[]",
			"",
			null,
		]) {
			expect({
				host,
				ok: isClaudeCodeHostAllowed(host, machine, ["proxy.example"]),
			}).toEqual({ host, ok: false });
		}
	});

	it("does not treat an extra as allowed until it is listed", () => {
		expect(isClaudeCodeHostAllowed("proxy.example", machine, [])).toBe(false);
		expect(
			isClaudeCodeHostAllowed("proxy.example", machine, ["proxy.example"]),
		).toBe(true);
	});
});

describe("parseClaudeCodeAllowedHosts", () => {
	it("treats an absent key as empty", () => {
		expect(parseClaudeCodeAllowedHosts(undefined)).toEqual({
			hosts: [],
			errors: [],
		});
		expect(parseClaudeCodeAllowedHosts(null)).toEqual({
			hosts: [],
			errors: [],
		});
	});

	it("normalizes and keeps plain host names and IP literals", () => {
		expect(
			parseClaudeCodeAllowedHosts([
				"Proxy.Example",
				" lan-box ",
				"10.0.0.5",
				"host.",
			]),
		).toEqual({
			hosts: ["proxy.example", "lan-box", "10.0.0.5", "host"],
			errors: [],
		});
	});

	it("refuses a scheme, a port, a path or a non-string, and names each", () => {
		const bad = [
			"https://proxy.example",
			"proxy.example:8080",
			"proxy.example/path",
			"",
			7,
		];
		const result = parseClaudeCodeAllowedHosts(["ok.example", ...bad]);
		expect(result.hosts).toEqual(["ok.example"]);
		expect(result.errors).toHaveLength(bad.length);
		bad.forEach((entry, i) => {
			expect(result.errors[i]).toBe(
				`${CLAUDE_CODE_ALLOWED_HOSTS_CONFIG_KEY} entry ${JSON.stringify(entry)} is not a host name (no scheme, port or path)`,
			);
		});
	});

	it("reports a value that is not an array", () => {
		expect(parseClaudeCodeAllowedHosts("proxy.example")).toEqual({
			hosts: [],
			errors: [
				`${CLAUDE_CODE_ALLOWED_HOSTS_CONFIG_KEY} must be an array of host names`,
			],
		});
	});
});

describe("checkClaudeCodeExtraArgs", () => {
	it("accepts allowed flags with their values", () => {
		for (const args of [
			["--bare", "--allowedTools", "Read", "Edit"],
			["--effort", "high"],
			["--effort=high"],
			["--tools", "Read", "--bare"],
			["--allowedTools=Read"],
			[],
		]) {
			expect({ args, error: checkClaudeCodeExtraArgs(args) }).toEqual({
				args,
				error: null,
			});
			expect(
				validateClaudeCodeEndpointConfig({ directory: "/a", extra_args: args })
					.ok,
			).toBe(true);
		}
	});

	it("refuses every dangerous flag by name, alone and after an allowed flag", () => {
		for (const flag of [
			"--settings",
			"--mcp-config",
			"--plugin-dir",
			"--add-dir",
			"--agents",
			"--dangerously-skip-permissions",
			"--append-system-prompt",
			"--system-prompt",
			"--resume",
			"--output-format",
			"--model",
			"--permission-mode",
			"--debug-file",
		]) {
			for (const args of [
				[flag, "value"],
				[`${flag}=value`],
				["--bare", flag, "value"],
				["--allowedTools", "Read", flag],
			]) {
				const error = checkClaudeCodeExtraArgs(args);
				expect({
					args,
					refused: error?.startsWith(
						`extra_args may not contain ${JSON.stringify(flag)};`,
					),
				}).toEqual({ args, refused: true });
				const result = validateClaudeCodeEndpointConfig({
					directory: "/a",
					extra_args: args,
				});
				expect(result).toEqual({ ok: false, error: error as string });
			}
		}
	});

	it("refuses a bare positional, which the CLI would read as a prompt", () => {
		expect(checkClaudeCodeExtraArgs(["hello"])).toBe(
			'extra_args entry "hello" is not a flag or a flag\'s value',
		);
		expect(checkClaudeCodeExtraArgs(["--effort", "high", "hello"])).toBe(
			'extra_args entry "hello" is not a flag or a flag\'s value',
		);
		expect(checkClaudeCodeExtraArgs(["--bare", "hello"])).toBe(
			'extra_args entry "hello" is not a flag or a flag\'s value',
		);
	});

	it("refuses a value on a flag that takes none", () => {
		expect(checkClaudeCodeExtraArgs(["--bare=x"])).toBe(
			"--bare takes no value",
		);
	});

	it("refuses a flag missing its value, or a value starting with '-'", () => {
		expect(checkClaudeCodeExtraArgs(["--effort"])).toBe(
			"--effort needs a value",
		);
		expect(checkClaudeCodeExtraArgs(["--effort", "-x"])).toBe(
			"--effort needs a value",
		);
		expect(checkClaudeCodeExtraArgs(["--effort="])).toBe(
			"--effort= needs a value",
		);
		expect(checkClaudeCodeExtraArgs(["--allowedTools"])).toBe(
			"--allowedTools needs at least one value",
		);
		expect(checkClaudeCodeExtraArgs(["--allowedTools", "--bare"])).toBe(
			"--allowedTools needs at least one value",
		);
	});
});

describe("isPathWithinRoots", () => {
	it("accepts the root itself and anything below it", () => {
		expect(isPathWithinRoots("/home/a", ["/home/a"])).toBe(true);
		expect(isPathWithinRoots("/home/a/", ["/home/a"])).toBe(true);
		expect(isPathWithinRoots("/home/a", ["/home/a/"])).toBe(true);
		expect(isPathWithinRoots("/home/a/x/y", ["/home/a"])).toBe(true);
		expect(isPathWithinRoots("/home/a/./x//y/", ["/home/a"])).toBe(true);
		expect(isPathWithinRoots("/home/a/x/../y", ["/home/a"])).toBe(true);
	});

	it("refuses a '..' escape and a sibling sharing a prefix", () => {
		expect(isPathWithinRoots("/home/a/../../etc", ["/home/a"])).toBe(false);
		expect(isPathWithinRoots("/home/a/..", ["/home/a"])).toBe(false);
		expect(isPathWithinRoots("/home/ab", ["/home/a"])).toBe(false);
		expect(isPathWithinRoots("/home/ab/x", ["/home/a/"])).toBe(false);
		expect(isPathWithinRoots("/home", ["/home/a"])).toBe(false);
	});

	it("treats / as containing everything", () => {
		expect(isPathWithinRoots("/", ["/"])).toBe(true);
		expect(isPathWithinRoots("/etc", ["/"])).toBe(true);
		expect(isPathWithinRoots("/home/a/../../etc", ["/"])).toBe(true);
	});

	it("matches any of several roots, and refuses a relative path or root", () => {
		expect(isPathWithinRoots("/srv/x", ["/home/a", "/srv"])).toBe(true);
		expect(isPathWithinRoots("relative/x", ["/"])).toBe(false);
		expect(isPathWithinRoots("/srv/x", ["relative"])).toBe(false);
		expect(isPathWithinRoots("/srv/x", [])).toBe(false);
	});
});
