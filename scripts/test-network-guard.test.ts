/**
 * Tests for the `bun test` network guard, `scripts/test-network-guard.ts`.
 *
 * Nothing here imports the guard. It is reached through the global handle it
 * publishes, so the first test fails if `bunfig.toml` stops preloading it: an
 * import would install the guard itself and pass either way.
 *
 * Every refused attempt is recorded and charged to the running test by the
 * guard's global `afterEach`, so each test that provokes one takes it back
 * with `takeRefused()` and asserts on it. The one case that must not is run in
 * a child `bun test`, because the failure it proves is the parent's afterEach
 * failing a test, and Bun 1.4.2's `test.failing` does not invert a hook error
 * (measured: it reports the test as failed).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { dirname } from "node:path";

const REPO_ROOT = dirname(import.meta.dir);

interface GuardHandle {
	takeRefused(): string[];
	isLoopbackHost(host: string): boolean;
	blockedFetchTarget(
		input: unknown,
		init?: RequestInit & { proxy?: string; unix?: string },
	): string | null;
}

const guard = (globalThis as Record<symbol, unknown>)[
	Symbol.for("better-ccflare.test-network-guard")
] as GuardHandle | undefined;

function handle(): GuardHandle {
	if (!guard) {
		throw new Error(
			"the network guard is not loaded: bunfig.toml must preload scripts/test-network-guard.ts",
		);
	}
	return guard;
}

describe("network guard: installed by bunfig.toml", () => {
	test("the preload published its handle", () => {
		expect(guard).toBeDefined();
	});

	test("a fetch to api.anthropic.com rejects, naming the URL and this file", async () => {
		let message = "";
		try {
			await fetch("https://api.anthropic.com/");
		} catch (error) {
			message = (error as Error).message;
		}
		const refused = handle().takeRefused();

		expect(message).toStartWith(
			"network-guard: a test in scripts/test-network-guard.test.ts tried to reach https://api.anthropic.com/ via fetch, ",
		);
		expect(refused).toEqual([message]);
	});

	// The half that matters most. Production code catches a failed fetch and
	// carries on: 39 of the 44 attempts measured on SB23-3493 failed no test
	// when the fetch alone was blocked. The guard's global afterEach must fail
	// the test anyway, so the fixture's test, which catches the rejection and
	// asserts that it did, has to fail.
	async function runChild(fixture: string) {
		const child = Bun.spawn([process.execPath, "test", `./${fixture}`], {
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			timeout: 60_000,
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { exitCode, output: stdout + stderr };
	}

	test("an attempt the code swallows still fails its test", async () => {
		const fixture = "scripts/fixtures/network-guard-swallowed.ts";
		const { exitCode, output } = await runChild(fixture);

		expect(output).toContain(
			`network-guard: a test in ${fixture} tried to reach https://api.anthropic.com/v1/messages via fetch, `,
		);
		expect(output).toContain("(fail) an attempt the code swallows");
		expect(output).toContain(" 0 pass\n 1 fail\n");
		expect(exitCode).toBe(1);
	});

	// An attempt made in a file-level afterAll lands after the last test's
	// afterEach, so only the guard's global afterAll can charge it. Without
	// this case, deleting that hook survived the whole file (PR #260 review).
	test("an attempt swallowed in a file-level afterAll still fails the run", async () => {
		const fixture = "scripts/fixtures/network-guard-swallowed-in-afterall.ts";
		const { exitCode, output } = await runChild(fixture);

		expect(output).toContain(
			`network-guard: a test in ${fixture} tried to reach https://api.anthropic.com/v1/models via fetch, `,
		);
		expect(output).toContain(" 1 pass\n 1 fail\n");
		expect(exitCode).toBe(1);
	});
});

describe("network guard: loopback stays reachable", () => {
	let server: ReturnType<typeof Bun.serve>;

	beforeAll(() => {
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("local"),
		});
	});

	afterAll(() => {
		server.stop(true);
	});

	test("a Bun.serve server on 127.0.0.1 answers through the guarded fetch", async () => {
		const response = await fetch(`http://127.0.0.1:${server.port}/x`);
		expect(await response.text()).toBe("local");
		expect(handle().takeRefused()).toEqual([]);
	});

	test("localhost reaches the same server", async () => {
		const response = await fetch(`http://localhost:${server.port}/x`);
		expect(await response.text()).toBe("local");
		expect(handle().takeRefused()).toEqual([]);
	});
});

describe("network guard: what counts as loopback", () => {
	test.each([
		"localhost",
		"LOCALHOST",
		"api.localhost",
		"127.0.0.1",
		"127.4.5.6",
		"::1",
		"[::1]",
		"0.0.0.0",
		"localhost.",
		"[::ffff:7f00:1]",
	])("%s is loopback", (host) => {
		expect(handle().isLoopbackHost(host)).toBe(true);
	});

	test.each([
		"api.anthropic.com",
		"localhost.evil.example",
		"127.evil.example",
		"128.0.0.1",
		"10.0.0.1",
		"192.168.1.10",
		"[::2]",
		"[::ffff:a00:1]",
	])("%s is not loopback", (host) => {
		expect(handle().isLoopbackHost(host)).toBe(false);
	});
});

describe("network guard: which fetch targets are refused", () => {
	test("an external URL is refused, as a string, a URL or a Request", () => {
		const { blockedFetchTarget } = handle();
		const url = "https://api.anthropic.com/v1/messages";
		expect(blockedFetchTarget(url)).toBe(url);
		expect(blockedFetchTarget(new URL(url))).toBe(url);
		expect(blockedFetchTarget(new Request(url))).toBe(url);
		// Bun's fetch also sends a bare object carrying `url`, the shape of a
		// Request from another realm or library (PR #260 review, must-fix 1).
		expect(blockedFetchTarget({ url })).toBe(url);
	});

	test("an IPv4 loopback spelled another way is normalised and allowed", () => {
		expect(handle().blockedFetchTarget("http://127.1:9/")).toBeNull();
	});

	test("non-network schemes and unix sockets are allowed", () => {
		const { blockedFetchTarget } = handle();
		expect(blockedFetchTarget("data:text/plain,hi")).toBeNull();
		expect(blockedFetchTarget("file:///etc/hosts")).toBeNull();
		expect(
			blockedFetchTarget("http://api.anthropic.com/", { unix: "/tmp/s.sock" }),
		).toBeNull();
	});

	test("a loopback proxy makes any URL allowed, an external proxy does not", () => {
		const { blockedFetchTarget } = handle();
		expect(
			blockedFetchTarget("https://outbound.invalid/x", {
				proxy: "http://127.0.0.1:3128",
			}),
		).toBeNull();
		expect(
			blockedFetchTarget("http://127.0.0.1:1/x", {
				proxy: "http://proxy.example:3128",
			}),
		).toBe("http://127.0.0.1:1/x (via proxy http://proxy.example:3128/)");
	});
});

describe("network guard: the non-fetch clients", () => {
	function refusedVia(via: string, run: () => unknown): string[] {
		expect(run).toThrow(`via ${via}`);
		return handle().takeRefused();
	}

	test("node:https request", () => {
		const refused = refusedVia("node:https request", () =>
			https.request("https://api.anthropic.com/"),
		);
		expect(refused).toHaveLength(1);
		expect(refused[0]).toContain("tried to reach https://api.anthropic.com/");
	});

	test("node:https get with an options object", () => {
		const refused = refusedVia("node:https get", () =>
			https.get({ hostname: "api.anthropic.com", path: "/" }),
		);
		expect(refused).toHaveLength(1);
	});

	test("node:http request to a bare ::1 host keeps the address whole", () => {
		const request = http.request({ host: "::1", port: 9 });
		request.on("error", () => {});
		request.destroy();
		expect(handle().takeRefused()).toEqual([]);
	});

	test("node:net Socket#connect on a socket built directly", () => {
		const refused = refusedVia("node:net Socket#connect", () =>
			new net.Socket().connect(443, "api.anthropic.com"),
		);
		expect(refused).toHaveLength(1);
	});

	test("node:net connect", () => {
		const refused = refusedVia("node:net connect", () =>
			net.connect({ host: "api.anthropic.com", port: 443 }),
		);
		expect(refused).toHaveLength(1);
	});

	test("Bun.connect", () => {
		const refused = refusedVia("Bun.connect", () =>
			Bun.connect({
				hostname: "api.anthropic.com",
				port: 443,
				socket: { data() {} },
			}),
		);
		expect(refused).toHaveLength(1);
	});

	test("WebSocket", () => {
		const refused = refusedVia(
			"WebSocket",
			() => new WebSocket("wss://api.anthropic.com/socket"),
		);
		expect(refused).toHaveLength(1);
	});
});
