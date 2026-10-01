/**
 * `better-ccflare tui [dashboard]`: the CLI's one positional subcommand
 * (SB23-2259). `apps/cli/src/main.ts` hands everything after `tui` to
 * `parseTuiArgs`, so `tui overview --port 8081` reads 8081 as the server to
 * query, never as a port to bind.
 */
import {
	DEFAULT_TUI_PORT,
	type FetchLike,
	fetchOverview,
	type LoopIO,
	type LoopSignal,
	renderOverview,
	runOverviewLoop,
} from "./tui-overview";

/** Dashboards `tui` can render. Each further one is its own issue. */
export const TUI_DASHBOARDS = ["overview"] as const;
export type TuiDashboard = (typeof TUI_DASHBOARDS)[number];

export const DEFAULT_TUI_INTERVAL_SECONDS = 5;

export interface TuiOptions {
	dashboard: TuiDashboard;
	/** Full base URL of the server; wins over `port`. */
	url: string | null;
	/** Port of a server on 127.0.0.1; else PORT, else 8080. */
	port: number | null;
	/** Admin API key; else BETTER_CCFLARE_API_KEY. */
	apiKey: string | null;
	/** Print once and exit even on a TTY. */
	once: boolean;
	intervalSeconds: number;
	help: boolean;
}

export type TuiParseResult =
	| { ok: true; options: TuiOptions }
	| { ok: false; message: string };

const VALUE_FLAGS = new Set(["--url", "--port", "--api-key", "--interval"]);
const BOOLEAN_FLAGS = new Set(["--once", "--help", "-h"]);

function parsePort(raw: string): number | null {
	if (!/^\d+$/.test(raw)) return null;
	const port = Number(raw);
	return port >= 1 && port <= 65535 ? port : null;
}

/**
 * Parse the arguments after `tui`. Pure: returns an error message rather than
 * printing or exiting, so every branch is testable.
 *
 * Strict where `parseArgs` is not: an unknown flag is an error here, because
 * a silently ignored typo in a monitoring command reads as a working one.
 */
export function parseTuiArgs(args: string[]): TuiParseResult {
	const options: TuiOptions = {
		dashboard: "overview",
		url: null,
		port: null,
		apiKey: null,
		once: false,
		intervalSeconds: DEFAULT_TUI_INTERVAL_SECONDS,
		help: false,
	};
	let dashboardSeen = false;

	for (let i = 0; i < args.length; i++) {
		const raw = args[i];
		if (!raw.startsWith("-")) {
			if (dashboardSeen) {
				return { ok: false, message: `Unexpected argument: ${raw}` };
			}
			if (!(TUI_DASHBOARDS as readonly string[]).includes(raw)) {
				return {
					ok: false,
					message: `Unknown dashboard: ${raw}. Known dashboards: ${TUI_DASHBOARDS.join(", ")}`,
				};
			}
			options.dashboard = raw as TuiDashboard;
			dashboardSeen = true;
			continue;
		}

		const eq = raw.indexOf("=");
		const flag = eq > 0 ? raw.slice(0, eq) : raw;
		if (BOOLEAN_FLAGS.has(flag)) {
			if (eq > 0) {
				return { ok: false, message: `${flag} takes no value` };
			}
			if (flag === "--once") options.once = true;
			else options.help = true;
			continue;
		}
		if (!VALUE_FLAGS.has(flag)) {
			return {
				ok: false,
				message: `Unknown option for tui: ${flag}. See better-ccflare tui --help`,
			};
		}
		let value: string;
		if (eq > 0) {
			value = raw.slice(eq + 1);
		} else {
			const next = args[i + 1];
			if (next === undefined || next.startsWith("--")) {
				return { ok: false, message: `${flag} requires a value` };
			}
			value = next;
			i++;
		}

		switch (flag) {
			case "--url": {
				const url = parseBaseUrl(value);
				if (!url) {
					return {
						ok: false,
						message: `Invalid --url: ${value}. Use http://host:port or https://host:port`,
					};
				}
				options.url = url;
				break;
			}
			case "--port": {
				const port = parsePort(value);
				if (port === null) {
					return {
						ok: false,
						message: `Invalid port: ${value}. Port must be a number between 1 and 65535`,
					};
				}
				options.port = port;
				break;
			}
			case "--api-key":
				if (value.length === 0) {
					return { ok: false, message: "--api-key requires a value" };
				}
				options.apiKey = value;
				break;
			case "--interval": {
				const seconds = Number(value);
				if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) {
					return {
						ok: false,
						message: `Invalid --interval: ${value}. Use seconds between 1 and 3600`,
					};
				}
				options.intervalSeconds = seconds;
				break;
			}
		}
	}

	return { ok: true, options };
}

/** A normalised http(s) base URL without a trailing slash, or null. */
export function parseBaseUrl(raw: string): string | null {
	try {
		const url = new URL(raw);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
	} catch {
		return null;
	}
}

/**
 * The server to query: `--url`, else 127.0.0.1 on `--port`, else on `PORT`
 * (which the CLI has already loaded from the same `.env` the Homebrew service
 * reads), else 8080.
 */
export function resolveBaseUrl(
	options: Pick<TuiOptions, "url" | "port">,
	env: Record<string, string | undefined>,
): string {
	if (options.url) return options.url;
	const port =
		options.port ?? (env.PORT ? parsePort(env.PORT) : null) ?? DEFAULT_TUI_PORT;
	return `http://127.0.0.1:${port}`;
}

export function resolveApiKey(
	options: Pick<TuiOptions, "apiKey">,
	env: Record<string, string | undefined>,
): string | null {
	return options.apiKey ?? (env.BETTER_CCFLARE_API_KEY || null);
}

export function tuiHelpText(): string {
	return `
Usage: better-ccflare tui [dashboard] [options]

Dashboards:
  overview            Every account's 5-hour, weekly and per-model weekly
                      usage (default)

Options:
  --url <url>         Server to read from (default: http://127.0.0.1:<port>)
  --port <number>     Port of a server on 127.0.0.1 (default: PORT or 8080)
  --api-key <key>     Admin API key, when API keys are configured
                      (default: BETTER_CCFLARE_API_KEY)
  --once              Print once and exit, even in a terminal
  --interval <secs>   Seconds between repaints in live mode (default: 5)

Reads GET /api/accounts from the running server. It never opens the
database and never starts a server.
`;
}

export interface TuiStdout {
	write(text: string): unknown;
	isTTY?: boolean;
	columns?: number;
}

export interface TuiDeps {
	env: Record<string, string | undefined>;
	stdout: TuiStdout & LoopIO["stdout"];
	stderr: { write(text: string): unknown };
	fetch?: FetchLike;
	now: () => number;
	/** The live loop's terminal, signal and timer access. */
	loop?: Omit<LoopIO, "stdout" | "stderr" | "now">;
	/**
	 * Called once, just before the live loop takes the terminal, so the CLI's
	 * own signal handlers can stand down. Not called for a one-shot print,
	 * where those handlers are still what ends a Ctrl-C during the fetch.
	 */
	onLiveStart?: () => void;
}

function processLoopIO(): Omit<LoopIO, "stdout" | "stderr" | "now"> {
	return {
		stdin: process.stdin.isTTY ? process.stdin : null,
		onSignal: (signal: LoopSignal, handler: () => void) => {
			process.on(signal, handler);
			return () => {
				process.removeListener(signal, handler);
			};
		},
		setTimer: (callback, ms) => setTimeout(callback, ms),
		clearTimer: (handle) =>
			clearTimeout(handle as ReturnType<typeof setTimeout>),
	};
}

export function defaultTuiDeps(): TuiDeps {
	return {
		env: process.env,
		stdout: process.stdout,
		stderr: process.stderr,
		now: () => Date.now(),
		loop: processLoopIO(),
	};
}

/** Colour only on a TTY, and never under NO_COLOR (https://no-color.org). */
export function useColor(stdout: TuiStdout, env: TuiDeps["env"]): boolean {
	return stdout.isTTY === true && !env.NO_COLOR;
}

/** Width for a render: the terminal's, or 100 columns when piped. */
export function terminalWidth(stdout: TuiStdout): number {
	return stdout.isTTY && stdout.columns ? stdout.columns : 100;
}

/**
 * Run `better-ccflare tui`. Returns the process exit code; the caller exits.
 */
export async function runTui(
	options: TuiOptions,
	deps: TuiDeps = defaultTuiDeps(),
): Promise<number> {
	if (options.help) {
		deps.stdout.write(tuiHelpText());
		return 0;
	}
	const baseUrl = resolveBaseUrl(options, deps.env);
	const apiKey = resolveApiKey(options, deps.env);

	const fetchOnce = () => fetchOverview(baseUrl, apiKey, { fetch: deps.fetch });

	// The first read happens here in every mode, so a server that is down or a
	// wrong key exits 1 in the calling terminal before anything takes it over.
	const result = await fetchOnce();
	if (!result.ok) {
		deps.stderr.write(`❌ ${result.message}\n`);
		return 1;
	}

	// Live when stdout is a terminal, once otherwise (`| cat`, a file, cron),
	// matching `top`. `--once` forces the single print on a terminal.
	if (deps.stdout.isTTY === true && !options.once && deps.loop) {
		deps.onLiveStart?.();
		return runOverviewLoop({
			baseUrl,
			intervalMs: options.intervalSeconds * 1000,
			color: useColor(deps.stdout, deps.env),
			initial: result.accounts,
			fetchOnce,
			quitHint: `q or Ctrl-C to quit; refreshes every ${options.intervalSeconds}s`,
			io: {
				...deps.loop,
				stdout: deps.stdout,
				stderr: deps.stderr,
				now: deps.now,
			},
		});
	}

	deps.stdout.write(
		renderOverview(result.accounts, {
			width: terminalWidth(deps.stdout),
			color: useColor(deps.stdout, deps.env),
			now: deps.now(),
			baseUrl,
		}),
	);
	return 0;
}
