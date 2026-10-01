import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, localControlNotifyHost } from "@better-ccflare/config";
import { postLocalControl } from "../local-control-notify";

/**
 * SB23-4035, against real listeners. The CLI used to post its
 * local_control_secret to localhost:8080 and localhost:8081, so whichever of
 * the two another local user bound received it. Now the server publishes the
 * socket it listens on beside the secret and the CLI posts there alone.
 *
 * Every listener here is a Bun.serve on a kernel-chosen port, so none of them
 * can be the Homebrew service on 8080 or a dev server on 8081. Each one
 * records whether a request reached it and whether it carried the secret, as
 * booleans, so no secret reaches test output. Every Config names its path
 * under mkdtemp.
 */

const SECRET = "NOTIFY-FIXTURE-VALUE";
const HEADER = "x-better-ccflare-local-control-secret";
const PATH = "/api/accounts/acc-1/force-reset-rate-limit";

interface Listener {
	port: number;
	/** One entry per request received: whether it carried SECRET. */
	received: boolean[];
	stop: () => void;
}

const live: Listener[] = [];
const dirs: string[] = [];

afterEach(() => {
	for (const listener of live.splice(0)) listener.stop();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function listen(hostname: string, port = 0): Listener {
	const received: boolean[] = [];
	const server = Bun.serve({
		hostname,
		port,
		fetch(req) {
			received.push(req.headers.get(HEADER) === SECRET);
			return Response.json({ usagePollTriggered: true });
		},
	});
	const bound = server.port;
	if (typeof bound !== "number") throw new Error("listener has no port");
	const listener = { port: bound, received, stop: () => server.stop(true) };
	live.push(listener);
	return listener;
}

/** A config holding SECRET with `port` configured, under mkdtemp. */
function configWithPort(port: number): string {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-notify-"));
	expect(dir.length).toBeGreaterThan(0);
	expect(dir.startsWith(tmpdir())).toBe(true);
	expect(dir.includes("better-ccflare-worktrees")).toBe(false);
	dirs.push(dir);
	const path = join(dir, "better-ccflare.json");
	writeFileSync(path, JSON.stringify({ local_control_secret: SECRET, port }), {
		mode: 0o600,
	});
	chmodSync(path, 0o600);
	return path;
}

/** The address the server publishes for a bind host, which must be a literal. */
function notifyHost(bindHost: string): string {
	const host = localControlNotifyHost(bindHost);
	if (host === null) throw new Error(`${bindHost} maps to no literal address`);
	return host;
}

/** A pid that has exited and been reaped. */
async function exitedPid(): Promise<number> {
	const child = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
	await child.exited;
	return child.pid;
}

const savedHost = process.env.BETTER_CCFLARE_HOST;
afterEach(() => {
	// Bun stores `undefined` as the string "undefined", so restore by delete.
	if (savedHost === undefined) delete process.env.BETTER_CCFLARE_HOST;
	else process.env.BETTER_CCFLARE_HOST = savedHost;
});

describe("SB23-4035: the CLI notifies only the socket the server published", () => {
	it("sends nothing to a listener on a second port, and exactly one notify to the published one", async () => {
		const server = listen("127.0.0.1");
		// Bound where the old code would have posted: the configured port, which
		// is not the server's.
		const squatter = listen("127.0.0.1");
		const path = configWithPort(squatter.port);
		new Config(path).publishLocalControlSecret({
			host: notifyHost("127.0.0.1"),
			port: server.port,
			pid: process.pid,
		});

		const outcome = await postLocalControl(new Config(path), PATH);

		expect(outcome.kind).toBe("answered");
		expect(server.received).toEqual([true]);
		expect(squatter.received).toEqual([]);
	});

	/**
	 * The same port in the other address family. A server bound to 0.0.0.0
	 * does not hold [::1], which anyone may bind, and the name localhost
	 * reached [::1] first when measured. The server here binds 127.0.0.1, the
	 * address 0.0.0.0 maps to, so the test opens nothing beyond loopback.
	 */
	it("sends nothing to a listener on the published port in the other address family", async () => {
		const server = listen("127.0.0.1");
		const squatter = listen("::1", server.port);
		const path = configWithPort(server.port);
		new Config(path).publishLocalControlSecret({
			host: notifyHost("0.0.0.0"),
			port: server.port,
			pid: process.pid,
		});

		await postLocalControl(new Config(path), PATH);

		expect(server.received).toEqual([true]);
		expect(squatter.received).toEqual([]);
	});

	it("sends nothing anywhere once the server that published has exited", async () => {
		const freed = listen("127.0.0.1");
		const configured = listen("127.0.0.1");
		const path = configWithPort(configured.port);
		const pid = await exitedPid();
		new Config(path).publishLocalControlSecret({
			host: "127.0.0.1",
			port: freed.port,
			pid,
		});

		const outcome = await postLocalControl(new Config(path), PATH);

		expect(outcome.kind).toBe("not-sent");
		expect(freed.received).toEqual([]);
		expect(configured.received).toEqual([]);
	});

	it("sends exactly one notify to the configured port when nothing is published", async () => {
		delete process.env.BETTER_CCFLARE_HOST;
		const configured = listen("127.0.0.1");
		const other = listen("127.0.0.1");
		const path = configWithPort(configured.port);

		const outcome = await postLocalControl(new Config(path), PATH);

		expect(outcome.kind).toBe("answered");
		expect(configured.received).toEqual([true]);
		expect(other.received).toEqual([]);
	});
});
