/**
 * Child process for local-control-sidecar-two-process.test.ts (SB23-3809).
 *
 * Plays the server's half exactly as apps/server does it: construct a Config
 * on the given path, hand getServerLocalControlSecret() to a real AuthService,
 * and once listening publish it with publishLocalControlSecret(). API keys are active (countActiveApiKeys answers 1), so a
 * request authenticates only through isLocalControlRequest or a valid key, and
 * there is no valid key.
 *
 * Prints one line, the port it listens on, and never the secret. Listens on
 * 127.0.0.1 only, on a port the kernel picks, so it cannot collide with the
 * Homebrew service on 8080 or a dev server on 8081.
 */
import { Config, localControlNotifyHost } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import { AuthService } from "../../auth-service";

const configPath = process.argv[2];
if (!configPath) {
	throw new Error("usage: local-control-server.ts <config path>");
}

const config = new Config(configPath);
const secret = config.getServerLocalControlSecret();

// Only the three methods authenticateRequest() can reach with no valid key.
const dbOps = {
	countActiveApiKeys: async () => 1,
	getActiveApiKeys: async () => [],
	updateApiKeyUsage: () => {},
} as unknown as DatabaseOperations;
const auth = new AuthService(dbOps, undefined, secret);

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(req) {
		const path = new URL(req.url).pathname;
		const result = await auth.authenticateRequest(req, path, req.method);
		if (!result.isAuthenticated) {
			return Response.json({ error: result.error }, { status: 401 });
		}
		return Response.json({ usagePollTriggered: false });
	},
});

// Published once listening, as apps/server does, with the port it bound
// (SB23-4035).
const port = server.port;
if (typeof port !== "number") throw new Error("the fixture server has no port");
config.publishLocalControlSecret({
	host: localControlNotifyHost("127.0.0.1"),
	port,
	pid: process.pid,
});

console.log(`LOCAL_CONTROL_SERVER_PORT=${port}`);
