/**
 * Claude Code project endpoints: answers OpenAI `chat/completions` and
 * `models` requests by running the host's `claude -p` inside a project
 * directory and translating its stream-json output. Only text reaches the
 * client; tool activity stays inside the CLI.
 */
import crypto from "node:crypto";
import fs, { existsSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { Logger } from "@better-ccflare/logger";
import {
	CLAUDE_CODE_BIN_ENV,
	CLAUDE_CODE_DEFAULT_MODEL_ID,
	claudeCodeHostRefusalMessage,
	claudeCodeMachineHostnames,
	isClaudeCodeHostAllowed,
	type ResolvedClaudeCodeEndpoint,
} from "@better-ccflare/types";
import type {
	ChatCompletion,
	ChatCompletionChunk,
	ChatCompletionRequest,
	ChatUsage,
} from "../chat/types";
import {
	conversationKey,
	flattenConversation,
	type NormalizedMessage,
	normalizeMessages,
	systemText,
} from "./prompt";
import {
	putClaudeCodeSession,
	resetClaudeCodeSessions,
	takeClaudeCodeSession,
} from "./sessions";
import {
	type ClaudeCodeUsage,
	type ClaudeStreamEvent,
	parseStreamJsonLine,
} from "./stream-json";

export interface ClaudeCodeRunnerDeps {
	/** CLI binary. Defaults to `$BETTER_CCFLARE_CLAUDE_BIN`, then `claude`. */
	bin?: string;
	/** Delay between SIGTERM and SIGKILL of the process group. Default 5000. */
	killGraceMs?: number;
	/** Session id for a new conversation. Default `crypto.randomUUID`. */
	newSessionId?: () => string;
	/**
	 * Host names allowed besides IP literals, `localhost` and this machine's
	 * own name: the `claude_code_allowed_hosts` config key.
	 */
	allowedHosts?: readonly string[];
	/** This machine's name. Default `os.hostname()`. */
	hostname?: string;
	/**
	 * Streaming only: how long to hold the response headers waiting for the
	 * first text or failure, so an early failure still gets its real status.
	 * After it the stream starts as 200 and keep-alives flow. Default 10000.
	 */
	firstEventWaitMs?: number;
	/** Streaming only: interval of SSE keep-alive comments. Default 15000. */
	keepAliveMs?: number;
	/**
	 * Arms the endpoint's `timeout_ms` timer at spawn and returns its cancel.
	 * Default `setTimeout`. A test passes its own to fire the timeout at a
	 * chosen point, such as after the first text, which a wall-clock timer
	 * cannot promise on a loaded machine (SB23-3785).
	 */
	armTimeout?: (fire: () => void, ms: number) => () => void;
}

const armTimeoutWithTimer = (fire: () => void, ms: number): (() => void) => {
	const timer = setTimeout(fire, ms);
	return () => clearTimeout(timer);
};

const log = new Logger("claude-code-endpoints");

const DEFAULT_KILL_GRACE_MS = 5000;
const DEFAULT_KEEPALIVE_MS = 15_000;
const DEFAULT_FIRST_EVENT_WAIT_MS = 10_000;
const STDERR_KEEP_CHARS = 500;
const OWNED_BY = "claude-code";

/** Running `claude` processes per endpoint name. */
const activeByEndpoint = new Map<string, number>();

export function resetClaudeCodeRunnerStateForTests(): void {
	activeByEndpoint.clear();
	resetClaudeCodeSessions();
}

function jsonResponse(
	status: number,
	body: unknown,
	extraHeaders?: Record<string, string>,
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...extraHeaders },
	});
}

function errorBody(
	message: string,
	type: string,
	code: string | null,
	param: string | null = null,
) {
	return { error: { message, type, param, code } };
}

function invalidRequest(
	status: number,
	message: string,
	param: string | null,
	code: string | null = null,
): Response {
	return jsonResponse(
		status,
		errorBody(message, "invalid_request_error", code, param),
	);
}

// ── Run: one `claude` process, reported as events ─────────────────────────

type RunError = {
	kind: "error";
	status: number;
	message: string;
	type: string;
	code: string;
	/** True once the model produced anything: text, a tool call, a subagent. */
	afterActivity: boolean;
	headers?: Record<string, string>;
};

type RunEvent =
	| { kind: "session" }
	| { kind: "text"; text: string }
	| {
			kind: "done";
			sessionId: string;
			usage: ClaudeCodeUsage | null;
			resultText: string | null;
	  }
	| RunError;

interface Launch {
	events: AsyncGenerator<RunEvent, void, undefined>;
	/** Idempotent. Kills the process group if it is still running. */
	dispose: () => void;
}

/**
 * Where the `claude` CLI is, for a server that usually runs under launchd,
 * whose PATH is only /usr/bin:/bin:/usr/sbin:/sbin. Measured 2026-09-30: the
 * Homebrew service plist sets no PATH, and the official installer puts the
 * CLI in ~/.local/bin, so a bare "claude" is ENOENT under the service while
 * working in every terminal. Order: the explicit override, then PATH, then
 * the installer's and Homebrew's locations, then ~/bin.
 */
export function resolveClaudeCodeBin(
	env: Record<string, string | undefined> = process.env,
	which: (cmd: string) => string | null = (cmd) => Bun.which(cmd),
	exists: (path: string) => boolean = existsSync,
	home: string = os.homedir(),
): string {
	const explicit = env[CLAUDE_CODE_BIN_ENV];
	if (explicit) return explicit;
	const onPath = which("claude");
	if (onPath) return onPath;
	for (const candidate of [
		`${home}/.local/bin/claude`,
		"/opt/homebrew/bin/claude",
		"/usr/local/bin/claude",
		`${home}/bin/claude`,
	]) {
		if (exists(candidate)) return candidate;
	}
	return "claude";
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// already gone
		}
	}
}

function runError(
	status: number,
	type: string,
	code: string,
	message: string,
	afterActivity = false,
	headers?: Record<string, string>,
): RunError {
	return { kind: "error", status, message, type, code, afterActivity, headers };
}

interface LaunchInput {
	endpoint: ResolvedClaudeCodeEndpoint;
	argv: string[];
	prompt: string;
	sessionId: string;
	signal: AbortSignal;
	killGraceMs: number;
	armTimeout: (fire: () => void, ms: number) => () => void;
}

function launch(input: LaunchInput): Launch | RunError {
	const { endpoint, argv, prompt, signal, killGraceMs, armTimeout } = input;

	const running = activeByEndpoint.get(endpoint.name) ?? 0;
	if (running >= endpoint.max_concurrency) {
		return runError(
			429,
			"rate_limit_error",
			"rate_limit_exceeded",
			`Endpoint "${endpoint.name}" is already running ${running} Claude Code request(s), its limit.`,
			false,
			{ "retry-after": "5" },
		);
	}

	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(argv, {
			cwd: endpoint.directory,
			env: process.env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			// Own process group, so a timeout or disconnect can kill the CLI and
			// everything it started.
			detached: true,
		});
	} catch (err) {
		// The reason names host paths, so it goes to the log, not the client.
		log.warn(
			`Claude Code endpoint "${endpoint.name}" could not start the CLI: ${err instanceof Error ? err.message : String(err)}`,
		);
		return runError(
			502,
			"api_error",
			"claude_code_spawn_failed",
			"Could not start Claude Code; the server log has the reason.",
		);
	}
	const pid = proc.pid;
	activeByEndpoint.set(endpoint.name, running + 1);

	let exited = false;
	let timedOut = false;
	let aborted = false;
	let disposed = false;
	let escalate: ReturnType<typeof setTimeout> | undefined;
	proc.exited.then(() => {
		exited = true;
	});

	// Signals the whole process group even after `claude` itself has exited:
	// a command the model started in the background (a dev server, a watcher)
	// is still in the group, and nothing else would stop it. The escalation
	// targets the group too, so a grandchild that ignores SIGTERM is killed.
	// Signalling a group that is already empty is a swallowed ESRCH.
	const terminate = () => {
		killGroup(pid, "SIGTERM");
		if (!escalate) {
			escalate = setTimeout(() => killGroup(pid, "SIGKILL"), killGraceMs);
			(escalate as { unref?: () => void }).unref?.();
		}
	};

	const cancelTimeout = armTimeout(() => {
		timedOut = true;
		terminate();
	}, endpoint.timeout_ms);
	const onAbort = () => {
		aborted = true;
		terminate();
	};
	if (signal.aborted) onAbort();
	else signal.addEventListener("abort", onAbort, { once: true });

	const dispose = () => {
		if (disposed) return;
		disposed = true;
		cancelTimeout();
		signal.removeEventListener("abort", onAbort);
		const left = (activeByEndpoint.get(endpoint.name) ?? 1) - 1;
		if (left <= 0) activeByEndpoint.delete(endpoint.name);
		else activeByEndpoint.set(endpoint.name, left);
		terminate();
	};

	// The prompt goes through stdin, never argv, so its size and content cannot
	// hit argument limits or be read from the process table.
	const stdin = proc.stdin as { write(d: string): unknown; end(): unknown };
	try {
		Promise.resolve(stdin.write(prompt)).catch(() => {});
		Promise.resolve(stdin.end()).catch(() => {});
	} catch {
		// The process may already have exited; its exit status reports why.
	}

	let stderrTail = "";
	const stderrDone = (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
			stderrTail = (stderrTail + decoder.decode(chunk, { stream: true })).slice(
				-STDERR_KEEP_CHARS * 4,
			);
		}
	})().catch(() => {});

	async function* events(): AsyncGenerator<RunEvent, void, undefined> {
		let sessionId = input.sessionId;
		let emitted = "";
		let active = false;
		let sawPartial = false;
		let separatePending = false;
		let result: Extract<ClaudeStreamEvent, { kind: "result" }> | null = null;

		const textOut = (text: string): RunEvent => {
			const prefix = separatePending && emitted.length > 0 ? "\n\n" : "";
			separatePending = false;
			emitted += prefix + text;
			return { kind: "text", text: prefix + text };
		};

		try {
			const decoder = new TextDecoder();
			let buffer = "";
			const handle = (line: string): RunEvent[] => {
				const ev = parseStreamJsonLine(line);
				if (!ev) return [];
				switch (ev.kind) {
					case "init":
						if (ev.sessionId) sessionId = ev.sessionId;
						return [{ kind: "session" }];
					case "text-block-start":
						active = true;
						separatePending = true;
						return [];
					case "activity":
						active = true;
						return [];
					case "partial-text":
						active = true;
						sawPartial = true;
						return [textOut(ev.text)];
					case "assistant-text":
						active = true;
						// With partials on, the full message repeats what the deltas
						// already sent; it is only the source when they are absent.
						if (sawPartial) return [];
						separatePending = true;
						return [textOut(ev.text)];
					case "result":
						result = ev;
						return [];
					default:
						return [];
				}
			};

			for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
				buffer += decoder.decode(chunk, { stream: true });
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					for (const out of handle(line)) yield out;
					newline = buffer.indexOf("\n");
				}
			}
			for (const out of handle(buffer)) yield out;

			const code = await proc.exited;
			await stderrDone;
			const tail = stderrTail.slice(-STDERR_KEEP_CHARS);
			const afterActivity = active || emitted !== "";
			const final = result as Extract<
				ClaudeStreamEvent,
				{ kind: "result" }
			> | null;

			if (timedOut) {
				yield runError(
					504,
					"timeout_error",
					"timeout",
					`Claude Code did not finish within ${endpoint.timeout_ms} ms and was killed.`,
					afterActivity,
				);
				return;
			}
			if (aborted) {
				yield runError(
					499,
					"api_error",
					"client_closed_request",
					"The client closed the request; Claude Code was killed.",
					afterActivity,
				);
				return;
			}
			if (final?.isError || code !== 0 || (!final && emitted === "")) {
				const reason = final?.isError
					? `Claude Code reported an error${final.text ? `: ${final.text}` : "."}`
					: code !== 0
						? `Claude Code exited with code ${code}.`
						: "Claude Code exited without producing a result.";
				// stderr can carry host paths, environment details and file
				// contents, and these endpoints can be public, so it is logged
				// and never sent (SB23-3408, item 4).
				log.warn(
					`Claude Code endpoint "${endpoint.name}" failed: ${reason}${tail ? ` stderr (last ${STDERR_KEEP_CHARS} chars): ${tail}` : ""}`,
				);
				yield runError(
					502,
					"api_error",
					"claude_code_failed",
					`${reason} The server log has the CLI's stderr.`,
					afterActivity,
				);
				return;
			}
			if (final && emitted === "" && final.text) yield textOut(final.text);
			yield {
				kind: "done",
				sessionId: final?.sessionId ?? sessionId,
				usage: final?.usage ?? null,
				resultText: final?.text ?? null,
			};
		} finally {
			dispose();
		}
	}

	return { events: events(), dispose };
}

// ── OpenAI shapes ─────────────────────────────────────────────────────────

function toChatUsage(usage: ClaudeCodeUsage | null): ChatUsage {
	const u = usage ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
	const prompt = u.input + u.cacheRead + u.cacheCreation;
	return {
		prompt_tokens: prompt,
		completion_tokens: u.output,
		total_tokens: prompt + u.output,
		prompt_tokens_details: { cached_tokens: u.cacheRead },
	};
}

function errorResponseFor(error: RunError): Response {
	return jsonResponse(
		error.status,
		errorBody(error.message, error.type, error.code),
		error.headers,
	);
}

/**
 * A `--resume` that failed before the model produced anything is retried
 * once as a fresh session (SB23-3408, item 1): the session file is gone or
 * the CLI refused it, and nothing ran. Once the model has produced output it
 * may have run tools, so replaying the turn could repeat their effects.
 */
function isResumeRetryable(
	next: IteratorResult<RunEvent, void> | RunError,
): boolean {
	const error = "kind" in next ? next : next.done ? null : next.value;
	return (
		error?.kind === "error" &&
		error.code === "claude_code_failed" &&
		!error.afterActivity
	);
}

function modelsResponse(endpoint: ResolvedClaudeCodeEndpoint): Response {
	const created = Math.floor(Date.now() / 1000);
	return jsonResponse(200, {
		object: "list",
		data: endpoint.models.map((id) => ({
			id,
			object: "model",
			created,
			owned_by: OWNED_BY,
		})),
	});
}

// ── Entry point ───────────────────────────────────────────────────────────

/**
 * `rest` is the path after `/v1`, e.g. `/chat/completions` or `/models`.
 */
export async function handleClaudeCodeEndpointRequest(
	req: Request,
	rest: string,
	endpoint: ResolvedClaudeCodeEndpoint,
	deps: ClaudeCodeRunnerDeps = {},
): Promise<Response> {
	const path = rest.length > 1 ? rest.replace(/\/+$/, "") : rest;
	if (path === "/models") {
		if (req.method !== "GET") {
			return invalidRequest(
				405,
				"Use GET /models.",
				null,
				"method_not_allowed",
			);
		}
		return modelsResponse(endpoint);
	}
	if (path !== "/chat/completions") {
		return invalidRequest(
			404,
			`${req.method} ${rest || "/"} is not served by Claude Code endpoint "${endpoint.name}". Use POST /chat/completions or GET /models.`,
			null,
			"unknown_endpoint",
		);
	}
	if (req.method !== "POST") {
		return invalidRequest(
			405,
			"Use POST /chat/completions.",
			null,
			"method_not_allowed",
		);
	}

	// A page that rebinds its own domain to this machine passes the
	// content-type and Sec-Fetch-Site checks below, because to the browser it
	// is same-origin; its Host is still its own name (SB23-3408, item 6).
	let hostname: string | null = null;
	try {
		hostname = new URL(req.url).hostname || null;
	} catch {
		hostname = null;
	}
	if (
		!isClaudeCodeHostAllowed(
			hostname,
			claudeCodeMachineHostnames(deps.hostname ?? os.hostname()),
			deps.allowedHosts ?? [],
		)
	) {
		return invalidRequest(
			403,
			claudeCodeHostRefusalMessage(hostname),
			null,
			"host_not_allowed",
		);
	}

	// This endpoint runs commands on the host, so it must not be reachable by
	// a browser's no-preflight POST: a `text/plain` body is a CORS "simple
	// request" that any web page can send to localhost, and Bun parses it as
	// JSON all the same. Requiring the JSON content type forces a preflight,
	// which this server never approves, and Sec-Fetch-Site catches browsers
	// that send it anyway (SB23-3407 review, finding 1).
	const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
	if (!contentType.trim().startsWith("application/json")) {
		return invalidRequest(
			415,
			"Content-Type must be application/json.",
			null,
			"unsupported_media_type",
		);
	}
	if (req.headers.get("sec-fetch-site") === "cross-site") {
		return invalidRequest(
			403,
			"Cross-site browser requests are refused on Claude Code endpoints.",
			null,
			"cross_site_refused",
		);
	}

	let body: ChatCompletionRequest;
	try {
		body = (await req.json()) as ChatCompletionRequest;
	} catch {
		return invalidRequest(400, "The request body is not valid JSON.", null);
	}
	if (typeof body !== "object" || body === null) {
		return invalidRequest(400, "The request body must be a JSON object.", null);
	}

	if (typeof body.model !== "string" || body.model === "") {
		return invalidRequest(400, "model is required.", "model");
	}
	if (!endpoint.models.includes(body.model)) {
		return invalidRequest(
			404,
			`The model "${body.model}" is not served by this endpoint. Use one of: ${endpoint.models.join(", ")}.`,
			"model",
			"model_not_found",
		);
	}
	if (typeof body.n === "number" && body.n > 1) {
		return invalidRequest(400, "n greater than 1 is not supported.", "n");
	}
	if (Array.isArray(body.tools) && body.tools.length > 0) {
		return invalidRequest(
			400,
			"tools are not supported: Claude Code runs its own tools inside the project.",
			"tools",
		);
	}
	if (Array.isArray(body.functions) && body.functions.length > 0) {
		return invalidRequest(
			400,
			"functions are not supported: Claude Code runs its own tools inside the project.",
			"functions",
		);
	}
	const normalized = normalizeMessages(body.messages);
	if (!normalized.ok) {
		return invalidRequest(400, normalized.message, normalized.param);
	}
	const messages = normalized.messages;

	// A hit means everything before the last user message is already in a
	// Claude Code session, so only that message is sent.
	const history = messages.slice(0, -1);
	// The directory is part of the scope, so moving an endpoint to another
	// directory never resumes a session id that project has not seen.
	const sessionScope = `${endpoint.name}\u0000${endpoint.directory}`;
	const lastMessage = messages[messages.length - 1] as NormalizedMessage;
	const resumeId =
		history.length > 0
			? takeClaudeCodeSession(conversationKey(sessionScope, history))
			: null;
	const system = systemText(messages);
	const bin = deps.bin ?? resolveClaudeCodeBin();
	const killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
	const armTimeout = deps.armTimeout ?? armTimeoutWithTimer;

	// The system prompt goes through a 0600 file in a private directory, never
	// argv, where `ps` shows it and Linux caps one argument at 128 KiB
	// (SB23-3408, item 2). `--append-system-prompt-file` is a hidden option in
	// claude 2.1.286 (absent from --help, present in the binary). The
	// directory belongs to the request, not to one run, because a resume
	// retry needs the file too; release() removes it.
	let promptDir: string | null = null;
	let systemFile: string | null = null;
	if (system) {
		try {
			promptDir = fs.mkdtempSync(
				nodePath.join(os.tmpdir(), "ccflare-claude-code-"),
			);
			systemFile = nodePath.join(promptDir, "system-prompt.txt");
			fs.writeFileSync(systemFile, system, { mode: 0o600, flag: "wx" });
		} catch (err) {
			if (promptDir) fs.rmSync(promptDir, { recursive: true, force: true });
			log.warn(
				`Claude Code endpoint "${endpoint.name}" could not write the system prompt file: ${err instanceof Error ? err.message : String(err)}`,
			);
			return jsonResponse(
				500,
				errorBody(
					"Could not prepare the system prompt; the server log has the reason.",
					"api_error",
					"claude_code_prompt_failed",
				),
			);
		}
	}

	const startRun = (resume: string | null): Launch | RunError => {
		const sessionId = resume ?? (deps.newSessionId ?? crypto.randomUUID)();
		const argv = [
			bin,
			"-p",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--permission-mode",
			endpoint.permission_mode,
			...(body.model === CLAUDE_CODE_DEFAULT_MODEL_ID
				? []
				: ["--model", body.model]),
			...(resume ? ["--resume", resume] : ["--session-id", sessionId]),
			...(systemFile ? ["--append-system-prompt-file", systemFile] : []),
			...endpoint.extra_args,
		];
		return launch({
			endpoint,
			argv,
			prompt: resume ? lastMessage.text : flattenConversation(messages),
			sessionId,
			signal: req.signal,
			killGraceMs,
			armTimeout,
		});
	};

	let current: Launch | null = null;
	let released = false;
	/** Idempotent: kills the current run and removes the prompt directory. */
	const release = () => {
		current?.dispose();
		if (released) return;
		released = true;
		if (promptDir) fs.rmSync(promptDir, { recursive: true, force: true });
	};

	/** The first event that is not `session`, from the current run. */
	const nextMeaningful = async (): Promise<IteratorResult<RunEvent, void>> => {
		let next: IteratorResult<RunEvent, void>;
		do {
			next = await (current as Launch).events.next();
		} while (!next.done && next.value.kind === "session");
		return next;
	};

	const firstRun = startRun(resumeId);
	if (!("events" in firstRun)) {
		release();
		return errorResponseFor(firstRun);
	}
	current = firstRun;

	/**
	 * The first meaningful event, retrying a failed resume once (item 1).
	 * Resolves to a RunError when the retry itself could not start.
	 */
	const firstEvent = async (): Promise<
		IteratorResult<RunEvent, void> | RunError
	> => {
		const next = await nextMeaningful();
		if (
			!resumeId ||
			released ||
			req.signal.aborted ||
			!isResumeRetryable(next)
		) {
			return next;
		}
		current?.dispose();
		log.info(
			`Claude Code endpoint "${endpoint.name}": resuming session ${resumeId} failed before any model output; retrying once as a new session`,
		);
		const retry = startRun(null);
		if (!("events" in retry)) return retry;
		current = retry;
		return nextMeaningful();
	};

	const remember = (id: string, reply: string) => {
		putClaudeCodeSession(
			conversationKey(sessionScope, [
				...messages,
				{ role: "assistant", text: reply },
			]),
			id,
		);
	};

	const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`;
	const created = Math.floor(Date.now() / 1000);
	const model = body.model;
	const endedWithoutResult = () =>
		errorBody(
			"Claude Code ended without a result.",
			"api_error",
			"claude_code_failed",
		);

	if (body.stream !== true) {
		try {
			const first = await firstEvent();
			if ("kind" in first) return errorResponseFor(first);
			if (first.done) return jsonResponse(502, endedWithoutResult());
			let text = "";
			let ev: RunEvent | null = first.value;
			while (ev) {
				if (ev.kind === "text") text += ev.text;
				else if (ev.kind === "error") return errorResponseFor(ev);
				else if (ev.kind === "done") {
					// The final answer, not the narration between tool calls.
					const reply = ev.resultText || text;
					remember(ev.sessionId, reply);
					const completion: ChatCompletion = {
						id: completionId,
						object: "chat.completion",
						created,
						model,
						choices: [
							{
								index: 0,
								message: { role: "assistant", content: reply, refusal: null },
								finish_reason: "stop",
								logprobs: null,
							},
						],
						usage: toChatUsage(ev.usage),
					};
					return jsonResponse(200, completion);
				}
				const next = await (current as Launch).events.next();
				ev = next.done ? null : next.value;
			}
			return jsonResponse(502, endedWithoutResult());
		} finally {
			release();
		}
	}

	// Streaming: hold the headers for a bounded time, so a CLI that dies at
	// startup still gets a real status code. A long tool-use stretch before
	// the first text would otherwise send no bytes at all, and clients and
	// proxies with an idle or first-byte timeout (Cloudflare gives up at 100
	// s) drop the request, so after the wait the stream starts and
	// keep-alive comments flow until text arrives (SB23-3408, item 3).
	const firstPromise = firstEvent();
	// Awaited again in pull(); this only keeps a rejection that lands after a
	// cancel from being reported as unhandled.
	firstPromise.catch(() => {});
	let waitTimer: ReturnType<typeof setTimeout> | undefined;
	let raced: Awaited<typeof firstPromise> | "waiting";
	try {
		raced = await Promise.race([
			firstPromise,
			new Promise<"waiting">((resolve) => {
				waitTimer = setTimeout(
					() => resolve("waiting"),
					deps.firstEventWaitMs ?? DEFAULT_FIRST_EVENT_WAIT_MS,
				);
			}),
		]);
	} catch (err) {
		clearTimeout(waitTimer);
		release();
		log.warn(
			`Claude Code endpoint "${endpoint.name}" failed before its first event: ${err instanceof Error ? err.message : String(err)}`,
		);
		return jsonResponse(502, endedWithoutResult());
	}
	clearTimeout(waitTimer);
	if (raced !== "waiting") {
		if ("kind" in raced) {
			release();
			return errorResponseFor(raced);
		}
		if (raced.done) {
			release();
			return jsonResponse(502, endedWithoutResult());
		}
		if (raced.value.kind === "error") {
			release();
			return errorResponseFor(raced.value);
		}
	}

	const includeUsage = body.stream_options?.include_usage === true;
	const encoder = new TextEncoder();
	const chunk = (
		delta: ChatCompletionChunk["choices"][0]["delta"],
		finish: "stop" | null,
	): ChatCompletionChunk => ({
		id: completionId,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
		...(includeUsage ? { usage: null } : {}),
	});
	const frame = (data: unknown) =>
		encoder.encode(`data: ${JSON.stringify(data)}\n\n`);

	let firstPending = true;
	let sent = "";
	let roleSent = false;
	let keepAlive: ReturnType<typeof setInterval> | undefined;
	let finished = false;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			keepAlive = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(": keep-alive\n\n"));
				} catch {
					// closed
				}
			}, deps.keepAliveMs ?? DEFAULT_KEEPALIVE_MS);
		},
		async pull(controller) {
			try {
				const finish = () => {
					finished = true;
					if (keepAlive) clearInterval(keepAlive);
					release();
					controller.close();
				};
				const fail = (body: unknown) => {
					controller.enqueue(frame(body));
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					finish();
				};
				if (!roleSent) {
					roleSent = true;
					controller.enqueue(
						frame(chunk({ role: "assistant", content: "" }, null)),
					);
				}
				let ev: RunEvent | null = null;
				if (firstPending) {
					firstPending = false;
					const first = await firstPromise;
					if ("kind" in first) {
						fail(errorBody(first.message, first.type, first.code));
						return;
					}
					if (!first.done) ev = first.value;
				}
				while (ev === null || ev.kind === "session") {
					const next = await (current as Launch).events.next();
					if (next.done) {
						fail(endedWithoutResult());
						return;
					}
					ev = next.value;
				}
				if (ev.kind === "text") {
					sent += ev.text;
					controller.enqueue(frame(chunk({ content: ev.text }, null)));
					return;
				}
				if (ev.kind === "error") {
					fail(errorBody(ev.message, ev.type, ev.code));
					return;
				}
				remember(ev.sessionId, sent);
				controller.enqueue(frame(chunk({}, "stop")));
				if (includeUsage) {
					controller.enqueue(
						frame({
							id: completionId,
							object: "chat.completion.chunk",
							created,
							model,
							choices: [],
							usage: toChatUsage(ev.usage),
						}),
					);
				}
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				finish();
			} catch (err) {
				// Nothing above is expected to throw; if it does, the run and the
				// prompt directory are still released and the timer stops.
				log.warn(
					`Claude Code endpoint "${endpoint.name}" stream failed: ${err instanceof Error ? err.message : String(err)}`,
				);
				if (keepAlive) clearInterval(keepAlive);
				release();
				if (!finished) {
					finished = true;
					try {
						controller.enqueue(frame(endedWithoutResult()));
						controller.enqueue(encoder.encode("data: [DONE]\n\n"));
						controller.close();
					} catch {
						// already closed
					}
				}
			}
		},
		async cancel() {
			if (keepAlive) clearInterval(keepAlive);
			const run = current;
			release();
			if (!finished) await run?.events.return(undefined).catch(() => {});
		},
	});

	return new Response(stream, {
		status: 200,
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive",
		},
	});
}
