/**
 * Kitty panel launch mode for `better-ccflare tui` (SB23-2259).
 *
 * The panel is a launch mode on top of the plain terminal UI, never the only
 * way to render it: kitty is a cask on macOS, a distro package on Linux and
 * absent on Windows, and a panel cannot open over SSH. So detection decides
 * whether to try, and every failure falls back to the in-window loop unless
 * `--panel` asked for the panel explicitly.
 *
 * Rules measured with kitten 0.48.2 and 0.49.1 on macOS (the `kitty-panels`
 * skill, and this host):
 * - Detect by `KITTY_WINDOW_ID` plus `kitten` on PATH plus a TTY. `TERM=
 *   xterm-kitty` alone is carried to remote hosts by `kitten ssh`, and
 *   `KITTY_LISTEN_ON` is absent on a default kitty config.
 * - The panel gets its own socket. The parent's `KITTY_LISTEN_ON` is the
 *   user's terminal and is never addressed.
 * - Never `--detach`: on 0.48.2 the detached child dies with
 *   `Unknown flag: --edge`. A detached spawn with ignored stdio is the
 *   `nohup ... &` that works.
 * - The child is started with `--no-panel`, or it would detect kitty again and
 *   open panels forever.
 * - `--single-instance` makes a second launch open a second panel in the same
 *   instance, so an existing live socket means "already running".
 */
import { execFile, spawn } from "node:child_process";
import {
	accessSync,
	constants,
	lstatSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PANEL_INSTANCE_GROUP = "better-ccflare-tui";
export const PANEL_EDGES = ["right", "left", "top", "bottom"] as const;
export type PanelEdge = (typeof PANEL_EDGES)[number];
export const DEFAULT_PANEL_EDGE: PanelEdge = "right";
/** A per-account table is taller than wide: 60 columns on a side edge. */
export const PANEL_COLUMNS = 60;
/** On a top or bottom edge the table needs height instead. */
export const PANEL_LINES = 20;
export const PANEL_START_TIMEOUT_MS = 5000;
/** Set in the panel child's environment to its own socket path. */
export const IN_PANEL_ENV = "BETTER_CCFLARE_TUI_PANEL_SOCKET";

/** `auto` tries the panel when detection passes; `force` fails without it. */
export type PanelMode = "auto" | "force" | "off";

const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

/** The flag wins over BETTER_CCFLARE_TUI_PANEL; `0`, `false`, `no`, `off` disable. */
export function resolvePanelMode(
	flag: "force" | "off" | null,
	env: Record<string, string | undefined>,
): PanelMode {
	if (flag) return flag;
	const value = env.BETTER_CCFLARE_TUI_PANEL?.trim().toLowerCase();
	return value && FALSE_VALUES.has(value) ? "off" : "auto";
}

/** The flag wins over BETTER_CCFLARE_TUI_PANEL_EDGE; default `right`. */
export function resolvePanelEdge(
	flag: string | null,
	env: Record<string, string | undefined>,
): { ok: true; edge: PanelEdge } | { ok: false; message: string } {
	const raw = flag ?? env.BETTER_CCFLARE_TUI_PANEL_EDGE ?? DEFAULT_PANEL_EDGE;
	const value = raw.trim().toLowerCase();
	if ((PANEL_EDGES as readonly string[]).includes(value)) {
		return { ok: true, edge: value as PanelEdge };
	}
	const source = flag ? "--panel-edge" : "BETTER_CCFLARE_TUI_PANEL_EDGE";
	return {
		ok: false,
		message: `Invalid ${source}: ${raw}. Use one of ${PANEL_EDGES.join(", ")}`,
	};
}

export type KittyDetection =
	| { ok: true; kitten: string }
	| { ok: false; reason: string };

/**
 * Whether a kitty panel can open from here. Three signals, nothing else, and
 * the reason names the one that failed so `--panel` can report it.
 */
export function detectKittyPanelHost(
	env: Record<string, string | undefined>,
	which: (command: string) => string | null,
	isTTY: boolean,
): KittyDetection {
	if (!env.KITTY_WINDOW_ID) {
		return {
			ok: false,
			reason:
				"KITTY_WINDOW_ID is not set, so this is not a kitty window (TERM=xterm-kitty alone is also true over kitten ssh)",
		};
	}
	const kitten = which("kitten");
	if (!kitten) {
		return { ok: false, reason: "kitten is not on PATH" };
	}
	if (!isTTY) {
		return { ok: false, reason: "stdout is not a terminal" };
	}
	return { ok: true, kitten };
}

/**
 * The command that re-runs this CLI: the binary itself when compiled (Bun
 * reports the embedded entry under `/$bunfs/` or `B:/~BUN/`), else the Bun
 * runtime plus the script it is running.
 */
export function resolveSelfCommand(
	argv: readonly string[],
	execPath: string,
): string[] {
	const script = argv[1];
	if (
		!script ||
		script.startsWith("/$bunfs/") ||
		script.startsWith("B:/~BUN/") ||
		script.startsWith("B:\\~BUN\\")
	) {
		return [execPath];
	}
	return [execPath, script];
}

/**
 * The panel's own control socket. Per user, because on Linux the temporary
 * directory is a shared /tmp; and kept under the 104-byte `sun_path` limit
 * macOS puts on a unix socket path, which a long TMPDIR can exceed.
 */
export function panelSocketPath(tmpdir: string, uid: number | null): string {
	const name = `better-ccflare-tui${uid == null ? "" : `-${uid}`}.sock`;
	const preferred = join(tmpdir, name);
	return Buffer.byteLength(preferred) <= 100 ? preferred : join("/tmp", name);
}

export interface PanelLaunch {
	kitten: string;
	edge: PanelEdge;
	socket: string;
	/** How to re-run this CLI; see resolveSelfCommand. */
	self: string[];
	dashboard: string;
	baseUrl: string;
	intervalSeconds: number;
}

/** The full argv for `kitten panel` running this CLI's live loop inside it. */
export function buildPanelCommand(launch: PanelLaunch): string[] {
	const size =
		launch.edge === "left" || launch.edge === "right"
			? `--columns=${PANEL_COLUMNS}`
			: `--lines=${PANEL_LINES}`;
	return [
		launch.kitten,
		"panel",
		`--edge=${launch.edge}`,
		size,
		"--layer=top",
		"--single-instance",
		"--instance-group",
		PANEL_INSTANCE_GROUP,
		"-o",
		"allow_remote_control=socket-only",
		`--listen-on=unix:${launch.socket}`,
		...launch.self,
		"tui",
		launch.dashboard,
		"--no-panel",
		"--url",
		launch.baseUrl,
		"--interval",
		String(launch.intervalSeconds),
	];
}

/** What `launchInPanel` needs from the machine, injectable for tests. */
export interface PanelDeps {
	which(command: string): string | null;
	/** Start the panel detached with ignored stdio; reject if it cannot start. */
	spawnDetached(
		argv: string[],
		env: Record<string, string | undefined>,
	): {
		/** null while running; else "code N" or "signal SIGxxx". */
		exited(): string | null;
		error(): Error | null;
	};
	/** True when a unix socket file exists at the path. */
	socketExists(path: string): boolean;
	/** True when a kitty instance answers on the socket. */
	probeSocket(kitten: string, path: string): Promise<boolean>;
	removeStaleSocket(path: string): void;
	sleep(ms: number): Promise<void>;
	tmpdir: string;
	uid: number | null;
	argv: readonly string[];
	execPath: string;
}

export type PanelLaunchResult =
	| { ok: true; socket: string; alreadyRunning: boolean }
	| { ok: false; message: string };

/**
 * Open the dashboard in a kitty panel, or report the one already open.
 * Resolves once the panel's socket exists, so the caller can print it.
 */
export async function launchInPanel(
	launch: Omit<PanelLaunch, "socket" | "self">,
	apiKey: string | null,
	env: Record<string, string | undefined>,
	deps: PanelDeps,
	timeoutMs = PANEL_START_TIMEOUT_MS,
): Promise<PanelLaunchResult> {
	const socket = panelSocketPath(deps.tmpdir, deps.uid);
	if (deps.socketExists(socket)) {
		if (await deps.probeSocket(launch.kitten, socket)) {
			return { ok: true, socket, alreadyRunning: true };
		}
		deps.removeStaleSocket(socket);
	}

	const argv = buildPanelCommand({
		...launch,
		socket,
		self: resolveSelfCommand(deps.argv, deps.execPath),
	});
	// The key travels in the environment, never in argv, where `ps` shows it.
	const childEnv: Record<string, string | undefined> = { ...env };
	if (apiKey) childEnv.BETTER_CCFLARE_API_KEY = apiKey;
	// Tells the child its footer cannot say "q": a panel never gets the keyboard.
	childEnv[IN_PANEL_ENV] = socket;
	const child = deps.spawnDetached(argv, childEnv);

	const step = 100;
	for (let waited = 0; waited < timeoutMs; waited += step) {
		await deps.sleep(step);
		const error = child.error();
		if (error) {
			return { ok: false, message: `kitten panel failed: ${error.message}` };
		}
		if (deps.socketExists(socket)) {
			return { ok: true, socket, alreadyRunning: false };
		}
		const exit = child.exited();
		if (exit !== null && exit !== "code 0") {
			return { ok: false, message: `kitten panel exited with ${exit}` };
		}
	}
	return {
		ok: false,
		message: `the kitty panel did not open its socket ${socket} within ${timeoutMs / 1000}s`,
	};
}

function whichOnPath(command: string, path: string | undefined): string | null {
	for (const dir of (path ?? "").split(":")) {
		if (!dir) continue;
		const candidate = join(dir, command);
		try {
			// X_OK is true for a directory, so a directory named kitten is not one.
			if (!statSync(candidate).isFile()) continue;
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// not here, or not executable
		}
	}
	return null;
}

export function defaultPanelDeps(
	env: Record<string, string | undefined>,
): PanelDeps {
	return {
		which: (command) => whichOnPath(command, env.PATH),
		spawnDetached(argv, childEnv) {
			let exit: string | null = null;
			let spawnError: Error | null = null;
			const child = spawn(argv[0], argv.slice(1), {
				detached: true,
				stdio: "ignore",
				env: childEnv,
			});
			child.on("error", (error) => {
				spawnError = error;
			});
			child.on("exit", (code, signal) => {
				exit = code !== null ? `code ${code}` : `signal ${signal}`;
			});
			child.unref();
			return { exited: () => exit, error: () => spawnError };
		},
		socketExists(path) {
			try {
				return lstatSync(path).isSocket();
			} catch {
				return false;
			}
		},
		probeSocket(kitten, path) {
			return new Promise((resolve) => {
				execFile(
					kitten,
					["@", "--to", `unix:${path}`, "ls"],
					{ timeout: 2000 },
					(error) => resolve(!error),
				);
			});
		},
		removeStaleSocket(path) {
			try {
				if (lstatSync(path).isSocket()) unlinkSync(path);
			} catch {
				// already gone
			}
		},
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		tmpdir: tmpdir(),
		uid: typeof process.getuid === "function" ? process.getuid() : null,
		argv: process.argv,
		execPath: process.execPath,
	};
}
