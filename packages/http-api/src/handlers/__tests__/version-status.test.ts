/**
 * Tests for the version-status handlers.
 *
 * The two write capabilities carry the risk, so their gates get the most
 * attention: disabled means 404 as if the endpoint did not exist, an install
 * that Homebrew does not own is refused, authentication must be on, and neither
 * the controller token nor a shell-interpolated argument can reach anything.
 */
import { describe, expect, it } from "bun:test";
import type { AuthService } from "../../services/auth-service";
import { VersionStatusService } from "../../services/version-status-service";
import { createVersionCheckHandler } from "../version";
import {
	createSelfUpdateHandler,
	createUpstreamDispatchHandler,
	createVersionStatusHandler,
	isHomebrewInstall,
	MANUAL_UPDATE_COMMAND,
} from "../version-status";

const BREW_EXEC =
	"/opt/homebrew/Cellar/better-ccflare/3.9.0/bin/better-ccflare";
const LOCAL_EXEC = "/Users/someone/Code/better-ccflare/node_modules/.bin/bun";

function authStub(enabled: boolean) {
	return {
		isAuthenticationEnabled: async () => enabled,
	} as unknown as AuthService;
}

function unreachableService() {
	return new VersionStatusService({
		currentVersion: "3.9.0",
		mergedSha: "ea0e332097ed8f6b2d214f0433ec1024752afadd",
		fetchImpl: (async () => {
			throw new Error("network unreachable");
		}) as unknown as typeof fetch,
	});
}

function okService(forkTag: string) {
	return new VersionStatusService({
		currentVersion: "3.9.0",
		mergedSha: "ea0e332097ed8f6b2d214f0433ec1024752afadd",
		fetchImpl: (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/repos/SijanC147/better-ccflare/releases/latest")) {
				return new Response(JSON.stringify({ tag_name: forkTag }));
			}
			if (url.includes("/pulls?state=open")) return new Response("[]");
			return new Response("{}", { status: 500 });
		}) as unknown as typeof fetch,
	});
}

describe("isHomebrewInstall", () => {
	it("accepts a Cellar path and a Homebrew prefix", () => {
		expect(isHomebrewInstall(BREW_EXEC)).toBe(true);
		expect(isHomebrewInstall("/opt/homebrew/bin/better-ccflare")).toBe(true);
		expect(
			isHomebrewInstall("/home/linuxbrew/.linuxbrew/bin/better-ccflare"),
		).toBe(true);
	});

	it("rejects anything else", () => {
		expect(isHomebrewInstall(LOCAL_EXEC)).toBe(false);
		expect(isHomebrewInstall("/usr/local/bin/better-ccflare")).toBe(false);
	});
});

describe("GET /api/version/status", () => {
	it("reports local identity and says the remote check failed", async () => {
		const handler = createVersionStatusHandler(unreachableService(), {
			localVersion: "3.9.0",
			localCommit: "3839c07d4f0f449a7b311c211d5fc6528aaaaaaa",
			selfUpdateEnabled: false,
			dispatchEnabled: false,
			execPath: LOCAL_EXEC,
		});

		const response = await handler(
			new URL("http://localhost/api/version/status"),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, never>;

		// Local identity must survive a total GitHub outage: the widget has to
		// render something rather than break the sidebar.
		expect(body.local.version).toBe("3.9.0");
		expect(body.local.mergedUpstreamSha).toMatch(/^[0-9a-f]{40}$/);
		expect(body.local.mergedUpstreamShaUrl).toContain(
			"github.com/tombii/better-ccflare/commit/",
		);
		expect(body.local.commitUrl).toContain(
			"github.com/SijanC147/better-ccflare/commit/",
		);
		expect(body.fork).toBeNull();
		expect(body.upstream).toBeNull();
		expect(body.remote.available).toBe(false);
		expect(body.remote.error).toContain("network unreachable");
	});

	it("never advertises self-update outside a Homebrew install", async () => {
		const handler = createVersionStatusHandler(okService("v3.9.1"), {
			localVersion: "3.9.0",
			localCommit: "development",
			selfUpdateEnabled: true,
			dispatchEnabled: true,
			execPath: LOCAL_EXEC,
		});
		const body = (await (
			await handler(new URL("http://localhost/api/version/status"))
		).json()) as Record<string, never>;

		expect(body.fork.updateAvailable).toBe(true);
		expect(body.capabilities.selfUpdate).toBe(false);
		expect(body.capabilities.selfUpdateBlockedReason).toBe(
			"not a Homebrew installation",
		);
		expect(body.capabilities.manualUpdateCommand).toBe(MANUAL_UPDATE_COMMAND);
		// A non-sha commit gets no link rather than a broken one.
		expect(body.local.commitUrl).toBeNull();
	});

	it("advertises self-update on a Homebrew install when enabled", async () => {
		const handler = createVersionStatusHandler(okService("v3.9.1"), {
			localVersion: "3.9.0",
			localCommit: "development",
			selfUpdateEnabled: true,
			dispatchEnabled: false,
			execPath: BREW_EXEC,
		});
		const body = (await (
			await handler(new URL("http://localhost/api/version/status"))
		).json()) as Record<string, never>;
		expect(body.capabilities.selfUpdate).toBe(true);
		expect(body.capabilities.dispatch).toBe(false);
	});
});

describe("GET /api/version/check", () => {
	it("reports this fork's latest release rather than upstream's npm version", async () => {
		// The fetch stub answers only the fork's releases endpoint, so a response
		// at all proves the handler no longer reads registry.npmjs.org.
		const response = await createVersionCheckHandler(okService("v3.9.1"))();
		expect(response.status).toBe(200);
		const body = (await response.json()) as { version: string };
		// The bare semver shape the dashboard has always consumed, "v" trimmed.
		expect(body.version).toBe("3.9.1");
	});

	it("fails with the remote error when no release can be read", async () => {
		const response = await createVersionCheckHandler(unreachableService())();
		expect(response.status).toBe(500);
		expect(await response.text()).toContain("network unreachable");
	});
});

describe("POST /api/admin/self-update", () => {
	it("answers 404 when the capability is not enabled", async () => {
		let ran = false;
		const handler = createSelfUpdateHandler(authStub(true), {
			enabled: false,
			environment: {
				execPath: BREW_EXEC,
				runUpgrade: async () => {
					ran = true;
					return { exitCode: 0, output: "" };
				},
				scheduleRestart: () => {},
			},
		});
		const response = await handler();
		expect(response.status).toBe(404);
		expect(ran).toBe(false);
	});

	it("refuses when dashboard authentication is off", async () => {
		let ran = false;
		const handler = createSelfUpdateHandler(authStub(false), {
			enabled: true,
			environment: {
				execPath: BREW_EXEC,
				runUpgrade: async () => {
					ran = true;
					return { exitCode: 0, output: "" };
				},
				scheduleRestart: () => {},
			},
		});
		const response = await handler();
		expect(response.status).toBe(403);
		expect(ran).toBe(false);
		expect(await response.text()).toContain(MANUAL_UPDATE_COMMAND);
	});

	it("refuses when the binary is not Homebrew-installed", async () => {
		let ran = false;
		const handler = createSelfUpdateHandler(authStub(true), {
			enabled: true,
			environment: {
				execPath: LOCAL_EXEC,
				runUpgrade: async () => {
					ran = true;
					return { exitCode: 0, output: "" };
				},
				scheduleRestart: () => {},
			},
		});
		const response = await handler();
		expect(response.status).toBe(409);
		expect(ran).toBe(false);
	});

	it("runs the upgrade and hands control to the supervisor", async () => {
		let restarted = false;
		const handler = createSelfUpdateHandler(authStub(true), {
			enabled: true,
			environment: {
				execPath: BREW_EXEC,
				runUpgrade: async () => ({
					exitCode: 0,
					output: "==> Upgrading better-ccflare",
				}),
				scheduleRestart: () => {
					restarted = true;
				},
			},
		});
		const response = await handler();
		expect(response.status).toBe(202);
		expect(restarted).toBe(true);
	});

	it("reports a failed upgrade and does not restart", async () => {
		let restarted = false;
		const handler = createSelfUpdateHandler(authStub(true), {
			enabled: true,
			environment: {
				execPath: BREW_EXEC,
				runUpgrade: async () => ({
					exitCode: 1,
					output: "No available formula",
				}),
				scheduleRestart: () => {
					restarted = true;
				},
			},
		});
		const response = await handler();
		expect(response.status).toBe(500);
		expect(restarted).toBe(false);
		expect(await response.text()).toContain("No available formula");
	});
});

describe("POST /api/upstream/sync-dispatch", () => {
	const TOKEN = "ghp_notarealtokenvalue";

	function dispatchStub(status: number) {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetchImpl = (async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			requests.push({ url: String(input), init });
			return new Response(null, { status });
		}) as unknown as typeof fetch;
		return { fetchImpl, requests };
	}

	it("answers 404 with no token configured", async () => {
		const { fetchImpl, requests } = dispatchStub(204);
		const handler = createUpstreamDispatchHandler(authStub(true), {
			fetchImpl,
		});
		expect((await handler()).status).toBe(404);
		expect(requests).toHaveLength(0);
	});

	it("refuses when dashboard authentication is off", async () => {
		const { fetchImpl, requests } = dispatchStub(204);
		const handler = createUpstreamDispatchHandler(authStub(false), {
			token: TOKEN,
			fetchImpl,
		});
		expect((await handler()).status).toBe(403);
		expect(requests).toHaveLength(0);
	});

	it("posts a fixed repository_dispatch payload to the controller", async () => {
		const { fetchImpl, requests } = dispatchStub(204);
		const handler = createUpstreamDispatchHandler(authStub(true), {
			token: TOKEN,
			fetchImpl,
		});
		const response = await handler();
		expect(response.status).toBe(202);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(
			"https://api.github.com/repos/SijanC147/upstream-maintainer/dispatches",
		);
		expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
			event_type: "sync-upstream",
			client_payload: { target: "SijanC147/better-ccflare" },
		});
	});

	it("never returns or echoes the token", async () => {
		const { fetchImpl } = dispatchStub(401);
		const handler = createUpstreamDispatchHandler(authStub(true), {
			token: TOKEN,
			fetchImpl,
		});
		const failed = await handler();
		expect(failed.status).toBe(500);
		expect(await failed.text()).not.toContain(TOKEN);

		const { fetchImpl: okFetch } = dispatchStub(204);
		const okHandler = createUpstreamDispatchHandler(authStub(true), {
			token: TOKEN,
			fetchImpl: okFetch,
		});
		expect(await (await okHandler()).text()).not.toContain(TOKEN);
	});

	it("enforces a cooldown between dispatches", async () => {
		let clock = 1_000_000;
		const { fetchImpl, requests } = dispatchStub(204);
		const handler = createUpstreamDispatchHandler(authStub(true), {
			token: TOKEN,
			fetchImpl,
			now: () => clock,
			cooldownMs: 60_000,
		});
		expect((await handler()).status).toBe(202);
		clock += 10_000;
		expect((await handler()).status).toBe(429);
		expect(requests).toHaveLength(1);
		clock += 60_000;
		expect((await handler()).status).toBe(202);
		expect(requests).toHaveLength(2);
	});

	it("reports only the status when GitHub rejects the dispatch", async () => {
		const { fetchImpl } = dispatchStub(403);
		const handler = createUpstreamDispatchHandler(authStub(true), {
			token: TOKEN,
			fetchImpl,
		});
		const response = await handler();
		expect(response.status).toBe(500);
		expect(await response.text()).toContain("403");
	});
});
