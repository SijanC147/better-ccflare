import {
	Conflict,
	Forbidden,
	InternalServerError,
	NotFound,
	TooManyRequests,
} from "@better-ccflare/errors";
import { Logger } from "@better-ccflare/logger";
import type { AuthService } from "../services/auth-service";
import {
	commitUrl,
	FORK_REPO,
	HOMEBREW_FORMULA,
	MAINTAINER_REPO,
	MERGED_UPSTREAM_SHA,
	shortSha,
	UPSTREAM_REPO,
} from "../services/fork-identity";
import type { VersionStatusService } from "../services/version-status-service";
import { errorResponse, jsonResponse } from "../utils/http-error";

const log = new Logger("VersionStatus");

/**
 * Process exit code used to hand control back to the supervisor after a
 * successful self-update.
 *
 * Deliberately non-zero. The Homebrew service this fork ships installs a
 * launchd plist with `KeepAlive { SuccessfulExit: false }`, which relaunches the
 * binary only when it exits non-zero — `process.exit(0)`, as /api/admin/restart
 * uses, would leave the service stopped. Self-update is gated on a Homebrew
 * installation (see isHomebrewInstall), so the launchd posture is the one that
 * applies whenever this code can run at all.
 */
const RESTART_EXIT_CODE = 75;

/** Minimum gap between upstream-maintainer dispatches from this process. */
const DISPATCH_COOLDOWN_MS = 5 * 60 * 1000;

/** Wall-clock ceiling on a `brew upgrade` run. */
const UPGRADE_TIMEOUT_MS = 10 * 60 * 1000;

export interface SelfUpdateEnvironment {
	/** Absolute path of the running executable. */
	execPath: string;
	/** Spawns the upgrade; injected so tests never shell out. */
	runUpgrade: () => Promise<{ exitCode: number; output: string }>;
	/** Hands control back to the supervisor; injected for tests. */
	scheduleRestart: () => void;
}

/** The manual command an operator runs when self-update is unavailable. */
export const MANUAL_UPDATE_COMMAND = `brew upgrade ${HOMEBREW_FORMULA}`;

/**
 * True when the running executable lives inside a Homebrew prefix.
 *
 * Checked against the executable path rather than a config value: a binary
 * outside the Cellar was not installed by Homebrew, so `brew upgrade` would
 * either do nothing or replace a different copy than the one serving this
 * request.
 */
export function isHomebrewInstall(execPath: string): boolean {
	return (
		execPath.includes("/Cellar/") ||
		execPath.startsWith("/opt/homebrew/") ||
		execPath.startsWith("/usr/local/Homebrew/") ||
		execPath.startsWith("/home/linuxbrew/")
	);
}

/** Default upgrade runner: a fixed argv, no shell, nothing interpolated. */
async function spawnBrewUpgrade(): Promise<{
	exitCode: number;
	output: string;
}> {
	// Every element is a compile-time constant. No request field reaches argv,
	// and there is no shell, so there is nothing for a quoting bug to escape.
	const child = Bun.spawn(["brew", "upgrade", HOMEBREW_FORMULA], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const timeout = setTimeout(() => child.kill(), UPGRADE_TIMEOUT_MS);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { exitCode, output: `${stdout}${stderr}`.trim().slice(-4000) };
	} finally {
		clearTimeout(timeout);
	}
}

export function createVersionStatusHandler(
	service: VersionStatusService,
	options: {
		localVersion: string;
		localCommit: string;
		selfUpdateEnabled: boolean;
		dispatchEnabled: boolean;
		execPath?: string;
	},
) {
	const execPath = options.execPath ?? process.execPath;
	return async (url: URL): Promise<Response> => {
		const force = url.searchParams.get("refresh") === "1";
		const result = await service.getStatus(force);

		return jsonResponse({
			local: {
				version: options.localVersion,
				commit: options.localCommit,
				commitShort: shortSha(options.localCommit),
				commitUrl: /^[0-9a-f]{7,40}$/.test(options.localCommit)
					? commitUrl(FORK_REPO, options.localCommit)
					: null,
				mergedUpstreamSha: MERGED_UPSTREAM_SHA,
				mergedUpstreamShaShort: shortSha(MERGED_UPSTREAM_SHA),
				mergedUpstreamShaUrl: MERGED_UPSTREAM_SHA
					? commitUrl(UPSTREAM_REPO, MERGED_UPSTREAM_SHA)
					: null,
				forkRepoUrl: `https://github.com/${FORK_REPO}`,
				upstreamRepoUrl: `https://github.com/${UPSTREAM_REPO}`,
			},
			fork: result.snapshot?.fork ?? null,
			upstream: result.snapshot?.upstream ?? null,
			syncPr: result.snapshot?.syncPr ?? null,
			capabilities: {
				// Whether the buttons exist at all. Both are opt-in; see
				// docs/version-status-widget.md.
				selfUpdate: options.selfUpdateEnabled && isHomebrewInstall(execPath),
				selfUpdateBlockedReason:
					options.selfUpdateEnabled && !isHomebrewInstall(execPath)
						? "not a Homebrew installation"
						: null,
				dispatch: options.dispatchEnabled,
				manualUpdateCommand: MANUAL_UPDATE_COMMAND,
			},
			remote: {
				available: result.snapshot !== null && !result.stale,
				stale: result.stale,
				error: result.error,
				checkedAt: result.snapshot?.checkedAt ?? null,
			},
		});
	};
}

/**
 * POST /api/admin/self-update — run `brew upgrade` and hand control back to the
 * supervisor.
 *
 * Four independent gates, all fail-closed:
 *  1. `BETTER_CCFLARE_ENABLE_SELF_UPDATE=1` in the server's environment. Not a
 *     RuntimeConfig field on purpose: the dashboard can POST config values, so a
 *     config flag would let an authenticated dashboard user switch on command
 *     execution at runtime. An environment variable needs operator access to the
 *     process. Without it the endpoint answers 404, as if it did not exist.
 *  2. Dashboard authentication must actually be enabled (at least one active API
 *     key). Without that, an unauthenticated caller on the listening port could
 *     trigger a package upgrade and a process restart.
 *  3. The running executable must be inside a Homebrew prefix.
 *  4. A fixed argv with no shell: ["brew", "upgrade", "better-ccflare"].
 */
export function createSelfUpdateHandler(
	authService: AuthService,
	options: {
		enabled: boolean;
		environment?: Partial<SelfUpdateEnvironment>;
	},
) {
	const execPath = options.environment?.execPath ?? process.execPath;
	const runUpgrade = options.environment?.runUpgrade ?? spawnBrewUpgrade;
	const scheduleRestart =
		options.environment?.scheduleRestart ??
		(() => {
			setTimeout(() => {
				log.info("Exiting after self-update so the supervisor relaunches");
				process.exit(RESTART_EXIT_CODE);
			}, 250);
		});

	return async (): Promise<Response> => {
		if (!options.enabled) {
			return errorResponse(NotFound("Not found"));
		}
		if (!(await authService.isAuthenticationEnabled())) {
			return errorResponse(
				Forbidden(
					"Self-update requires dashboard authentication to be enabled. " +
						"Generate an API key first, or run manually: " +
						MANUAL_UPDATE_COMMAND,
				),
			);
		}
		if (!isHomebrewInstall(execPath)) {
			return errorResponse(
				Conflict(
					"Self-update is only supported for Homebrew installations. " +
						`Run manually: ${MANUAL_UPDATE_COMMAND}`,
				),
			);
		}

		log.info("Self-update requested; running the Homebrew upgrade");
		let outcome: { exitCode: number; output: string };
		try {
			outcome = await runUpgrade();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error(`Self-update failed to start: ${message}`);
			return errorResponse(
				InternalServerError(`Upgrade could not be started: ${message}`),
			);
		}

		if (outcome.exitCode !== 0) {
			log.error(`Self-update failed with exit code ${outcome.exitCode}`);
			return errorResponse(
				InternalServerError(
					`Upgrade failed (exit ${outcome.exitCode}). Output: ${outcome.output}`,
				),
			);
		}

		log.info("Self-update succeeded; restarting");
		scheduleRestart();
		return jsonResponse(
			{
				message: "Upgrade complete; restarting",
				command: MANUAL_UPDATE_COMMAND,
				output: outcome.output,
			},
			202,
		);
	};
}

/**
 * POST /api/upstream/sync-dispatch — ask the upstream maintainer controller to
 * open a sync PR.
 *
 * The controller token is the opt-in: with no
 * `BETTER_CCFLARE_UPSTREAM_MAINTAINER_TOKEN` in the server environment the
 * endpoint answers 404. The token is read from the environment only, is never
 * part of a response body, and is never logged.
 */
export function createUpstreamDispatchHandler(
	authService: Pick<AuthService, "isAuthenticationEnabled">,
	options: {
		token?: string;
		fetchImpl?: typeof fetch;
		now?: () => number;
		cooldownMs?: number;
	},
) {
	const fetchImpl = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now;
	const cooldownMs = options.cooldownMs ?? DISPATCH_COOLDOWN_MS;
	let lastDispatchAt = 0;

	return async (): Promise<Response> => {
		if (!options.token) {
			return errorResponse(NotFound("Not found"));
		}
		// Same posture as self-update: an outward-facing side effect that spends
		// the controller's token must not be reachable without authentication on
		// a port this proxy already listens on.
		if (!(await authService.isAuthenticationEnabled())) {
			return errorResponse(
				Forbidden(
					"Dispatching an upstream sync requires dashboard authentication " +
						"to be enabled. Generate an API key first.",
				),
			);
		}

		const elapsed = now() - lastDispatchAt;
		if (lastDispatchAt !== 0 && elapsed < cooldownMs) {
			const waitSeconds = Math.ceil((cooldownMs - elapsed) / 1000);
			return errorResponse(
				TooManyRequests(
					`An upstream sync was dispatched recently; retry in ${waitSeconds}s`,
				),
			);
		}

		try {
			const response = await fetchImpl(
				`https://api.github.com/repos/${MAINTAINER_REPO}/dispatches`,
				{
					method: "POST",
					headers: {
						Accept: "application/vnd.github+json",
						"X-GitHub-Api-Version": "2022-11-28",
						"User-Agent": "better-ccflare-version-status",
						"Content-Type": "application/json",
						Authorization: `Bearer ${options.token}`,
					},
					body: JSON.stringify({
						event_type: "sync-upstream",
						client_payload: { target: FORK_REPO },
					}),
					signal: AbortSignal.timeout(10_000),
				},
			);

			if (response.status === 204 || response.ok) {
				lastDispatchAt = now();
				log.info(`Dispatched sync-upstream to ${MAINTAINER_REPO}`);
				return jsonResponse(
					{
						message: "Upstream sync dispatched",
						repository: MAINTAINER_REPO,
					},
					202,
				);
			}

			// Report the status only. The response body of a failed dispatch can
			// echo request details, and the token must never reach the client.
			log.error(`Upstream dispatch rejected with status ${response.status}`);
			return errorResponse(
				InternalServerError(
					`GitHub rejected the dispatch with status ${response.status}`,
				),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error(`Upstream dispatch failed: ${message}`);
			return errorResponse(InternalServerError(`Dispatch failed: ${message}`));
		}
	};
}
