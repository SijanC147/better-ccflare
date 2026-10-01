import { describe, expect, it } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@better-ccflare/config";

/**
 * SB23-3809, measured across two processes, which is the only place the defect
 * lived. An in-process test cannot show it: the second Config in one process
 * gets the first one's secret from the SB23-2489 memo whether or not anything
 * was published.
 *
 * The server is a child `bun` process running fixtures/local-control-server.ts:
 * a real Config, publishLocalControlSecret(), and a real AuthService with API
 * keys active. This process plays the CLI: a real Config on the same path,
 * getLocalControlSecret(), and the request the CLI's notify sends
 * (packages/cli-commands/src/commands/account.ts, notifyServersToForceResetRateLimit).
 * That function itself is not called, because it also posts to 8080 and 8081,
 * and 8080 is the production service.
 *
 * Before the sidecar, both configs below made the CLI send a value the server
 * did not hold: the trailing comma because the CLI generated its own, the
 * writable config because the CLI adopted the planted value the server had
 * stripped. Each case asserts the planted or wrong value is refused as well, so
 * a green run cannot come from a server that accepts anything.
 *
 * No secret reaches test output: the child prints only its port, and secrets
 * are compared by sending them, never with toBe.
 */

const TRAILING_COMMA = `{"lb_strategy":"session","pg_password":"operator-value",}`;
const PLANTED_VALUE = "PLANTED-FIXTURE-VALUE";
const HEADER = "x-better-ccflare-local-control-secret";
const NO_KEY_ERROR =
	"API key required. Include it in the 'x-api-key' header or Authorization: Bearer <key>";
const FIXTURE = join(import.meta.dir, "fixtures", "local-control-server.ts");

async function withServer(
	configBytes: string,
	mode: number,
	fn: (configPath: string, port: number) => Promise<void>,
): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-sidecar-2p-"));
	expect(dir.length).toBeGreaterThan(0);
	expect(dir.startsWith(tmpdir())).toBe(true);
	expect(dir.includes("better-ccflare-worktrees")).toBe(false);
	const configPath = join(dir, "better-ccflare.json");
	writeFileSync(configPath, configBytes, { mode });
	chmodSync(configPath, mode);
	const child = Bun.spawn([process.execPath, FIXTURE, configPath], {
		stdout: "pipe",
		stderr: "ignore",
	});
	try {
		await fn(configPath, await readPort(child.stdout));
	} finally {
		// SIGKILL and an ignored stderr: with SIGTERM and stderr piped, measured
		// 2026-10-01 on Bun 1.4.2, `child.exited` did not settle inside the 5 s
		// test timeout, and which of the two held it was not isolated.
		child.kill("SIGKILL");
		await child.exited;
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Read the child's stdout until its port line, or fail after 15 seconds. */
async function readPort(stdout: ReadableStream<Uint8Array>): Promise<number> {
	const reader = stdout.getReader();
	const decoder = new TextDecoder();
	let seen = "";
	const deadline = Date.now() + 15_000;
	try {
		while (Date.now() < deadline) {
			const timeout = new Promise<null>((resolve) =>
				setTimeout(() => resolve(null), deadline - Date.now()),
			);
			const chunk = await Promise.race([reader.read(), timeout]);
			if (chunk === null || chunk.done) break;
			seen += decoder.decode(chunk.value, { stream: true });
			const match = /LOCAL_CONTROL_SERVER_PORT=(\d+)/.exec(seen);
			if (match !== null && match[1] !== undefined) return Number(match[1]);
		}
	} finally {
		reader.releaseLock();
	}
	throw new Error("the child server never printed its port");
}

async function notify(port: number, secret: string): Promise<Response> {
	return fetch(
		`http://127.0.0.1:${port}/api/accounts/acc-1/force-reset-rate-limit`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json", [HEADER]: secret },
		},
	);
}

async function expectRefused(port: number, secret: string): Promise<void> {
	const response = await notify(port, secret);
	expect(response.status).toBe(401);
	expect(((await response.json()) as { error?: string }).error).toBe(
		NO_KEY_ERROR,
	);
}

describe("SB23-3809: the CLI's notify authenticates against a separate server process while saves are refused", () => {
	it("on a config with a trailing comma", async () => {
		await withServer(TRAILING_COMMA, 0o600, async (configPath, port) => {
			const cliSecret = new Config(configPath).getLocalControlSecret();

			expect((await notify(port, cliSecret)).status).toBe(200);
			await expectRefused(port, `${cliSecret}-not`);
			// The refusal held throughout: nothing reached the config.
			expect(readFileSync(configPath, "utf8")).toBe(TRAILING_COMMA);
		});
	});

	it("on a config other users could write, whose credentials were stripped", async () => {
		const bytes = JSON.stringify({
			lb_strategy: "session",
			pg_password: "operator-value",
			local_control_secret: PLANTED_VALUE,
		});
		await withServer(bytes, 0o666, async (configPath, port) => {
			const cliSecret = new Config(configPath).getLocalControlSecret();

			expect((await notify(port, cliSecret)).status).toBe(200);
			// The server minted its own; the planted value authenticates nothing.
			await expectRefused(port, PLANTED_VALUE);
			// Still the planted bytes: the strip refused every save.
			expect(readFileSync(configPath, "utf8")).toBe(bytes);
		});
	});
});
