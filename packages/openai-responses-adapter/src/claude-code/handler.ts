/**
 * Claude Code project endpoints: answers OpenAI `chat/completions` and
 * `models` requests by running the host's `claude -p` inside a project
 * directory and translating its stream-json output. Only text reaches the
 * client; tool activity stays inside the CLI.
 */
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import {
	CLAUDE_CODE_BIN_ENV,
	CLAUDE_CODE_DEFAULT_MODEL_ID,
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
}

const DEFAULT_KILL_GRACE_MS = 5000;
const KEEPALIVE_MS = 15_000;
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
): RunError {
	return { kind: "error", status, message, type, code };
}

interface LaunchInput {
	endpoint: ResolvedClaudeCodeEndpoint;
	argv: string[];
	prompt: string;
	sessionId: string;
	signal: AbortSignal;
	killGraceMs: number;
}

function launch(input: LaunchInput): Launch | Response {
	const { endpoint, argv, prompt, signal, killGraceMs } = input;

	const running = activeByEndpoint.get(endpoint.name) ?? 0;
	if (running >= endpoint.max_concurrency) {
		return jsonResponse(
			429,
			errorBody(
				`Endpoint "${endpoint.name}" is already running ${running} Claude Code request(s), its limit.`,
				"rate_limit_error",
				"rate_limit_exceeded",
			),
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
		return jsonResponse(
			502,
			errorBody(
				`Could not start Claude Code: ${err instanceof Error ? err.message : String(err)}`,
				"api_error",
				"claude_code_spawn_failed",
			),
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

	const timeoutTimer = setTimeout(() => {
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
		clearTimeout(timeoutTimer);
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
						separatePending = true;
						return [];
					case "partial-text":
						sawPartial = true;
						return [textOut(ev.text)];
					case "assistant-text":
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
				);
				return;
			}
			if (aborted) {
				yield runError(
					499,
					"api_error",
					"client_closed_request",
					"The client closed the request; Claude Code was killed.",
				);
				return;
			}
			if (final?.isError || code !== 0 || (!final && emitted === "")) {
				const reason = final?.isError
					? `Claude Code reported an error${final.text ? `: ${final.text}` : "."}`
					: code !== 0
						? `Claude Code exited with code ${code}.`
						: "Claude Code exited without producing a result.";
				yield runError(
					502,
					"api_error",
					"claude_code_failed",
					tail
						? `${reason}\nstderr (last ${STDERR_KEEP_CHARS} chars): ${tail}`
						: reason,
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
	const sessionId = resumeId ?? (deps.newSessionId ?? crypto.randomUUID)();
	const prompt = resumeId ? lastMessage.text : flattenConversation(messages);
	const system = systemText(messages);

	const bin = deps.bin ?? resolveClaudeCodeBin();
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
		...(resumeId ? ["--resume", resumeId] : ["--session-id", sessionId]),
		...(system ? ["--append-system-prompt", system] : []),
		...endpoint.extra_args,
	];

	const started = launch({
		endpoint,
		argv,
		prompt,
		sessionId,
		signal: req.signal,
		killGraceMs: deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
	});
	if (started instanceof Response) return started;

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

	if (body.stream !== true) {
		let text = "";
		try {
			for await (const ev of started.events) {
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
			}
		} finally {
			started.dispose();
		}
		return jsonResponse(
			502,
			errorBody(
				"Claude Code ended without a result.",
				"api_error",
				"claude_code_failed",
			),
		);
	}

	// Streaming: hold the headers until there is text, a result or a failure,
	// so a CLI that dies at startup still gets a real status code.
	const iterator = started.events;
	let first: IteratorResult<RunEvent, void>;
	do {
		first = await iterator.next();
	} while (!first.done && first.value.kind === "session");
	if (first.done) {
		started.dispose();
		return jsonResponse(
			502,
			errorBody(
				"Claude Code ended without a result.",
				"api_error",
				"claude_code_failed",
			),
		);
	}
	if (first.value.kind === "error") {
		started.dispose();
		return errorResponseFor(first.value);
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

	let pending: RunEvent | null = first.value;
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
			}, KEEPALIVE_MS);
		},
		async pull(controller) {
			const finish = () => {
				finished = true;
				if (keepAlive) clearInterval(keepAlive);
				started.dispose();
				controller.close();
			};
			if (!roleSent) {
				roleSent = true;
				controller.enqueue(
					frame(chunk({ role: "assistant", content: "" }, null)),
				);
			}
			let ev: RunEvent | null = pending;
			pending = null;
			while (ev?.kind === "session" || ev === null) {
				const next = await iterator.next();
				if (next.done) {
					controller.enqueue(
						frame(
							errorBody(
								"Claude Code ended without a result.",
								"api_error",
								"claude_code_failed",
							),
						),
					);
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					finish();
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
				controller.enqueue(frame(errorBody(ev.message, ev.type, ev.code)));
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				finish();
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
		},
		async cancel() {
			if (keepAlive) clearInterval(keepAlive);
			started.dispose();
			if (!finished) await iterator.return(undefined).catch(() => {});
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
