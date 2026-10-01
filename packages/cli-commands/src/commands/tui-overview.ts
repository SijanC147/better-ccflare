/**
 * `better-ccflare tui overview`: every account's usage windows in a terminal
 * (SB23-2259).
 *
 * The numbers come from the running server's `GET /api/accounts`, the same
 * response the dashboard renders, and the rows come from the same builder in
 * `@better-ccflare/core`, so the terminal and the browser cannot disagree about
 * a window. This module never opens the database and never starts a server:
 * a second process on the database is a locking hazard, and a second
 * computation path would drift.
 *
 * Pure rendering: ANSI sequences and `padEnd`, no React, no Ink, no child
 * process, so the five compiled release targets gain no runtime dependency.
 */
import {
	collectAnthropicUsageRows,
	displayLabel,
	formatWindowName,
	severityColor,
	type UsageDisplay,
} from "@better-ccflare/core";
import type {
	AccountResponse,
	AnthropicUsageData,
} from "@better-ccflare/types";

export const DEFAULT_TUI_PORT = 8080;
export const OVERVIEW_FETCH_TIMEOUT_MS = 5000;

/** The sentence the server answers a keyless request with (`auth-service.ts`). */
export const API_KEY_REQUIRED_SENTENCE =
	"API key required. Include it in the 'x-api-key' header or Authorization: Bearer <key>";

export type OverviewFetchResult =
	| { ok: true; accounts: AccountResponse[] }
	| {
			ok: false;
			kind:
				| "unauthorized"
				| "forbidden"
				| "unreachable"
				| "timeout"
				| "http"
				| "invalid";
			message: string;
	  };

export type FetchLike = (
	input: string,
	init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

/** Read the error message out of the server's JSON error body, if it has one. */
async function serverErrorMessage(response: Response): Promise<string | null> {
	try {
		const body = (await response.json()) as {
			error?: { message?: unknown } | string;
		};
		if (typeof body?.error === "string") return body.error;
		const message = body?.error?.message;
		return typeof message === "string" && message.length > 0 ? message : null;
	} catch {
		return null;
	}
}

/**
 * Fetch the account list the dashboard's Overview renders.
 *
 * Every failure is a value, not a throw, so the one-shot path and the live
 * loop can each decide what a failure means for them.
 */
export async function fetchOverview(
	baseUrl: string,
	apiKey: string | null,
	options: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<OverviewFetchResult> {
	const doFetch: FetchLike = options.fetch ?? (fetch as unknown as FetchLike);
	const timeoutMs = options.timeoutMs ?? OVERVIEW_FETCH_TIMEOUT_MS;
	const headers: Record<string, string> = { accept: "application/json" };
	if (apiKey) headers["x-api-key"] = apiKey;

	let response: Response;
	try {
		response = await doFetch(`${baseUrl}/api/accounts`, {
			headers,
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		const name = error instanceof Error ? error.name : "";
		if (name === "TimeoutError" || name === "AbortError") {
			return {
				ok: false,
				kind: "timeout",
				message: `no answer from ${baseUrl} within ${Math.round(timeoutMs / 1000)}s`,
			};
		}
		return {
			ok: false,
			kind: "unreachable",
			message: `server not running on ${baseUrl}`,
		};
	}

	if (response.status === 401) {
		const detail = await serverErrorMessage(response);
		if (!apiKey) {
			return {
				ok: false,
				kind: "unauthorized",
				message: `${detail ?? API_KEY_REQUIRED_SENTENCE}. Pass --api-key <key> or set BETTER_CCFLARE_API_KEY.`,
			};
		}
		// The /api router answers a valid key without admin access with 401,
		// not 403 (`Unauthorized(authzResult.reason)` in router.ts), so a
		// refused key is reported the same way whether it is wrong or merely
		// not an admin key, with the server's own reason.
		return {
			ok: false,
			kind: "unauthorized",
			message: `The server refused the API key: ${detail ?? "unauthorized"}. /api/accounts needs an admin key (better-ccflare --generate-api-key <name> --admin).`,
		};
	}
	if (response.status === 403) {
		return {
			ok: false,
			kind: "forbidden",
			message:
				"This API key lacks admin access; /api/accounts needs an admin key (better-ccflare --generate-api-key <name> --admin).",
		};
	}
	if (!response.ok) {
		const detail = await serverErrorMessage(response);
		return {
			ok: false,
			kind: "http",
			message: `GET ${baseUrl}/api/accounts returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
		};
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}
	if (!Array.isArray(body)) {
		return {
			ok: false,
			kind: "invalid",
			message: `GET ${baseUrl}/api/accounts did not return an account list; is ${baseUrl} a better-ccflare server?`,
		};
	}
	return { ok: true, accounts: body as AccountResponse[] };
}

/** One usage window of one account, ready to print. */
export interface OverviewRow {
	label: string;
	utilization: number | null;
	severity: "critical" | "warning" | "normal";
	resetTime: string | null;
	isActive: boolean;
}

export interface OverviewAccount {
	name: string;
	provider: string;
	status: string;
	isPrimary: boolean;
	rows: OverviewRow[];
	/** Shown in place of rows when the account has none. */
	note: string | null;
}

function hasAnthropicStyleUsage(usageData: unknown): boolean {
	if (usageData == null || typeof usageData !== "object") return false;
	return (
		"five_hour" in usageData ||
		"seven_day" in usageData ||
		Array.isArray((usageData as { limits?: unknown }).limits)
	);
}

function toOverviewRow(row: UsageDisplay): OverviewRow {
	return {
		label: displayLabel(row),
		utilization: row.utilization,
		severity: severityColor(row.severity, row.utilization),
		resetTime: row.resetTime,
		isActive: row.isActive === true,
	};
}

function accountStatus(account: AccountResponse): string {
	if (account.paused) {
		return account.pauseReason ? `paused (${account.pauseReason})` : "paused";
	}
	if (account.requiresReauth) return "reauth needed";
	return account.rateLimitStatus || "OK";
}

/**
 * Pick the rows the dashboard's account card shows for this account.
 *
 * Anthropic and Codex carry the full window payload and go through the shared
 * row builder: the 5-hour row, the Weekly row and every per-model weekly row
 * from `limits[]` (Fable among them). Fable is a `weekly_scoped` limit, never
 * the flat `seven_day_fable` key, which is null on every current plan.
 *
 * Every other provider shows the server's representative scalar only
 * (`usageUtilization` / `usageWindow`); their payload shapes differ per
 * provider and the dashboard decodes each separately.
 */
export function buildOverviewAccount(
	account: AccountResponse,
): OverviewAccount {
	const base = {
		name: account.name,
		provider: account.provider,
		status: accountStatus(account),
		isPrimary: account.isPrimary === true,
	};
	const isCodex = account.provider === "codex";
	const usageData = account.usageData as unknown;

	if (
		(account.provider === "anthropic" || isCodex) &&
		hasAnthropicStyleUsage(usageData)
	) {
		const rows = collectAnthropicUsageRows(usageData as AnthropicUsageData, {
			utilization: account.usageUtilization ?? null,
			resetTime: account.rateLimitReset,
		});
		// Codex: the dashboard keeps the 5-hour row only when the payload really
		// reported one (Pro accounts report the weekly window alone), rather than
		// the fallback-filled row the builder adds. Mirror it.
		const fiveHour = (
			usageData as {
				five_hour?: { utilization?: unknown; resets_at?: unknown } | null;
			}
		).five_hour;
		const codexHasRealFiveHour =
			typeof fiveHour?.utilization === "number" &&
			typeof fiveHour?.resets_at === "string";
		const shown = isCodex
			? rows.filter((r) => r.window !== "five_hour" || codexHasRealFiveHour)
			: rows;
		return { ...base, rows: shown.map(toOverviewRow), note: null };
	}

	if (
		(account.provider === "anthropic" || isCodex) &&
		account.usageRateLimitedUntil != null
	) {
		return {
			...base,
			rows: [],
			note: `usage API rate limited until ${formatClock(new Date(account.usageRateLimitedUntil))}`,
		};
	}

	if (
		account.usageUtilization != null &&
		account.usageWindow &&
		!(isCodex && account.usageWindow === "five_hour")
	) {
		return {
			...base,
			rows: [
				toOverviewRow({
					utilization: account.usageUtilization,
					window: account.usageWindow,
					resetTime: account.rateLimitReset,
					label: formatWindowName(account.usageWindow),
				}),
			],
			note: null,
		};
	}

	return { ...base, rows: [], note: "no usage data yet" };
}

/** HH:MM:SS in local time, always on the 24-hour clock. */
export function formatClock(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** "resets in 2h 13m", "resets in 3d 4h"; empty when there is no reset time. */
export function formatResetIn(resetTime: string | null, nowMs: number): string {
	if (!resetTime) return "";
	const at = Date.parse(resetTime);
	if (Number.isNaN(at)) return "";
	const remaining = at - nowMs;
	if (remaining <= 0) return "resetting";
	const minutes = Math.ceil(remaining / 60_000);
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const mins = minutes % 60;
	if (days > 0) return `resets in ${days}d ${hours}h`;
	if (hours > 0) return `resets in ${hours}h ${mins}m`;
	return `resets in ${mins}m`;
}

export function formatPercent(utilization: number | null): string {
	return utilization == null ? "N/A" : `${utilization.toFixed(0)}%`;
}

const ANSI = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
};

const SEVERITY_COLOR = {
	critical: ANSI.red,
	warning: ANSI.yellow,
	normal: ANSI.green,
} as const;

export interface RenderOptions {
	/** Terminal width in columns; every line is cut to it. */
	width: number;
	/** ANSI colour; off under NO_COLOR and when stdout is not a TTY. */
	color: boolean;
	now: number;
	baseUrl: string;
	/** Extra lines under the table: the live loop's key hint or an error. */
	footer?: string[];
}

function cut(text: string, width: number): string {
	return text.length > width ? text.slice(0, Math.max(0, width)) : text;
}

function bar(utilization: number | null, width: number): string {
	if (width <= 0) return "";
	const clamped =
		utilization == null ? 0 : Math.min(100, Math.max(0, utilization));
	const filled = Math.round((clamped / 100) * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

/**
 * Render the Overview as text: a header, then one block per account with one
 * line per usage window. Pure: the same input always gives the same string, so
 * the live loop can repaint it and a test can assert it.
 */
export function renderOverview(
	accounts: AccountResponse[],
	options: RenderOptions,
): string {
	const width = Math.max(20, Math.floor(options.width));
	const paint = (code: string, text: string) =>
		options.color && text.length > 0 ? `${code}${text}${ANSI.reset}` : text;
	const built = accounts.map(buildOverviewAccount);
	const lines: string[] = [];

	const title = "better-ccflare overview";
	const stamp = formatClock(new Date(options.now));
	const meta = `${options.baseUrl}  ${stamp}`;
	const header =
		title.length + 2 + meta.length <= width
			? `${title}${" ".repeat(width - title.length - meta.length)}${meta}`
			: cut(`${title}  ${stamp}`, width);
	lines.push(paint(ANSI.bold, header));
	lines.push("");

	if (built.length === 0) {
		lines.push(cut("No accounts. Add one with --add-account.", width));
	}

	// Capped so the marker, label and percent always fit: a panel can be
	// narrower than the longest per-model label.
	const labelWidth = Math.max(
		4,
		Math.min(
			24,
			width - 8,
			Math.max(
				6,
				...built.flatMap((account) => account.rows.map((r) => r.label.length)),
			),
		),
	);
	const resetWidth = Math.max(
		0,
		...built.flatMap((account) =>
			account.rows.map((r) => formatResetIn(r.resetTime, options.now).length),
		),
	);
	// "* " active marker, label, two spaces, "100%", two spaces, bar, two spaces, reset.
	const fixed =
		2 + labelWidth + 2 + 4 + 2 + (resetWidth > 0 ? 2 + resetWidth : 0);
	const barWidth = Math.min(30, width - fixed);

	for (const account of built) {
		const marker = account.isPrimary ? " (next)" : "";
		const title = cut(
			`${account.name}  ${account.provider}  ${account.status}${marker}`,
			width,
		);
		const nameEnd = Math.min(title.length, account.name.length);
		lines.push(
			paint(ANSI.bold, title.slice(0, nameEnd)) + title.slice(nameEnd),
		);
		if (account.rows.length === 0) {
			lines.push(paint(ANSI.dim, cut(`  ${account.note ?? "-"}`, width)));
		}
		for (const row of account.rows) {
			const label = cut(row.label, labelWidth).padEnd(labelWidth);
			const percent = formatPercent(row.utilization).padStart(4);
			const reset = formatResetIn(row.resetTime, options.now);
			const segments: string[] = [
				`${row.isActive ? "* " : "  "}${label}  `,
				paint(SEVERITY_COLOR[row.severity], percent),
			];
			let used = 2 + labelWidth + 2 + 4;
			if (barWidth >= 4 && used + 2 + barWidth <= width) {
				segments.push(
					"  ",
					paint(SEVERITY_COLOR[row.severity], bar(row.utilization, barWidth)),
				);
				used += 2 + barWidth;
			}
			if (reset.length > 0 && used + 2 < width) {
				segments.push(paint(ANSI.dim, cut(`  ${reset}`, width - used)));
			}
			lines.push(segments.join(""));
		}
		lines.push("");
	}

	for (const line of options.footer ?? []) {
		lines.push(paint(ANSI.dim, cut(line, width)));
	}
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return `${lines.join("\n")}\n`;
}

/** Alternate screen on, cursor hidden; and the exact reverse. */
export const ENTER_SCREEN = "\x1b[?1049h\x1b[?25l";
export const LEAVE_SCREEN = "\x1b[?25h\x1b[?1049l";
const HOME = "\x1b[H";
const CLEAR_LINE_END = "\x1b[K";
const CLEAR_BELOW = "\x1b[J";
const CTRL_C = "\x03";

/** Repaint shortly after start: a fresh kitty panel reports 63x18 at first. */
export const SETTLE_REPAINT_MS = 300;

export type LoopSignal = "SIGTERM" | "SIGHUP" | "SIGINT" | "SIGWINCH";

/** Everything the live loop touches outside itself, injected so it can be tested. */
export interface LoopIO {
	stdout: {
		write(text: string, callback?: () => void): unknown;
		columns?: number;
		rows?: number;
	};
	stderr: { write(text: string): unknown };
	/** Read for `q` and Ctrl-C when it is a TTY; null inside a panel or a pipe. */
	stdin: {
		isTTY?: boolean;
		setRawMode?(mode: boolean): unknown;
		on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
		removeListener(
			event: "data",
			listener: (chunk: Buffer | string) => void,
		): unknown;
		resume(): unknown;
		pause(): unknown;
	} | null;
	/** Register a signal handler; returns its unregister function. */
	onSignal(signal: LoopSignal, handler: () => void): () => void;
	setTimer(callback: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
	now(): number;
}

export interface LoopOptions {
	baseUrl: string;
	intervalMs: number;
	color: boolean;
	/** The rows already fetched by the caller's preflight. */
	initial: AccountResponse[];
	fetchOnce: () => Promise<OverviewFetchResult>;
	/** The last footer line: how to leave. */
	quitHint: string;
	io: LoopIO;
}

/**
 * Repaint the Overview every `intervalMs` until `q`, Ctrl-C, SIGINT, SIGTERM
 * or SIGHUP, then restore the terminal and resolve with the exit code.
 *
 * Inside a kitty panel the keyboard never arrives (focus policy
 * `not-allowed`), so SIGTERM and SIGHUP are the only way out there: closing
 * the panel over its socket sends SIGHUP. A transient fetch failure keeps the
 * last good table on screen with the error under it; an authentication
 * failure exits 1, because retrying cannot fix a wrong key.
 */
export function runOverviewLoop(options: LoopOptions): Promise<number> {
	const { io } = options;
	let accounts = options.initial;
	let lastGoodAt = io.now();
	let lastError: string | null = null;
	let timer: unknown = null;
	let settleTimer: unknown = null;
	let stopped = false;
	const unregister: Array<() => void> = [];

	return new Promise<number>((resolve) => {
		const paint = () => {
			if (stopped) return;
			const footer: string[] = [];
			if (lastError) {
				footer.push(
					`! ${lastError}; showing data from ${formatClock(new Date(lastGoodAt))}`,
				);
			}
			footer.push(options.quitHint);
			const frame = renderOverview(accounts, {
				// A pty with no size reports 0 columns; treat it as unknown.
				width: io.stdout.columns || 80,
				color: options.color,
				now: io.now(),
				baseUrl: options.baseUrl,
				footer,
			});
			let lines = frame.replace(/\n$/, "").split("\n");
			const rows = io.stdout.rows;
			if (rows && rows > 1 && lines.length > rows) {
				lines = lines.slice(0, rows);
			}
			io.stdout.write(
				`${HOME}${lines.join(`${CLEAR_LINE_END}\n`)}${CLEAR_LINE_END}${CLEAR_BELOW}`,
			);
		};

		const stop = (code: number, message?: string) => {
			if (stopped) return;
			stopped = true;
			if (timer !== null) io.clearTimer(timer);
			if (settleTimer !== null) io.clearTimer(settleTimer);
			for (const off of unregister) off();
			if (io.stdin) {
				io.stdin.removeListener("data", onKey);
				if (io.stdin.isTTY) io.stdin.setRawMode?.(false);
				io.stdin.pause();
			}
			io.stdout.write(LEAVE_SCREEN, () => {
				if (message) io.stderr.write(`❌ ${message}\n`);
				resolve(code);
			});
		};

		const onKey = (chunk: Buffer | string) => {
			const text = chunk.toString();
			if (text.includes("q") || text.includes("Q") || text.includes(CTRL_C)) {
				stop(0);
			}
		};

		const tick = async () => {
			timer = null;
			try {
				const result = await options.fetchOnce();
				if (stopped) return;
				if (result.ok) {
					accounts = result.accounts;
					lastGoodAt = io.now();
					lastError = null;
				} else if (
					result.kind === "unauthorized" ||
					result.kind === "forbidden"
				) {
					stop(1, result.message);
					return;
				} else {
					lastError = result.message;
				}
				paint();
			} catch (error) {
				// The terminal is in raw mode on the alternate screen; an escaping
				// throw would leave it there.
				stop(1, error instanceof Error ? error.message : String(error));
				return;
			}
			timer = io.setTimer(() => void tick(), options.intervalMs);
		};

		io.stdout.write(ENTER_SCREEN);
		for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
			unregister.push(io.onSignal(signal, () => stop(0)));
		}
		unregister.push(io.onSignal("SIGWINCH", paint));
		if (io.stdin?.isTTY) {
			io.stdin.setRawMode?.(true);
			io.stdin.on("data", onKey);
			io.stdin.resume();
		}

		paint();
		settleTimer = io.setTimer(() => {
			settleTimer = null;
			paint();
		}, SETTLE_REPAINT_MS);
		timer = io.setTimer(() => void tick(), options.intervalMs);
	});
}
