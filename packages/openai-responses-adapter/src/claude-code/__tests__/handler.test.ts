import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import {
	CLAUDE_CODE_BIN_ENV,
	type ResolvedClaudeCodeEndpoint,
} from "@better-ccflare/types";
import {
	handleClaudeCodeEndpointRequest,
	resetClaudeCodeRunnerStateForTests,
} from "../handler";
import {
	type FakeClaude,
	type FakeMode,
	isAlive,
	makeFakeClaude,
	waitFor,
} from "./fake-claude";

let fake: FakeClaude | null = null;

function setup(
	mode: FakeMode,
	overrides: Partial<ResolvedClaudeCodeEndpoint> = {},
	fakeOptions: { textDeltas?: string[]; resultText?: string } = {},
) {
	fake = makeFakeClaude({ mode, ...fakeOptions });
	const endpoint: ResolvedClaudeCodeEndpoint = {
		name: "proj",
		directory: fake.projectDir,
		description: null,
		models: ["default", "opus", "sonnet"],
		permission_mode: "bypassPermissions",
		extra_args: [],
		max_concurrency: 2,
		timeout_ms: 30_000,
		...overrides,
	};
	return { endpoint, bin: fake.bin };
}

function chatRequest(body: unknown, signal?: AbortSignal): Request {
	return new Request("http://localhost/proj/v1/chat/completions", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
}

function call(
	ctx: ReturnType<typeof setup>,
	body: unknown,
	signal?: AbortSignal,
): Promise<Response> {
	return handleClaudeCodeEndpointRequest(
		chatRequest(body, signal),
		"/chat/completions",
		ctx.endpoint,
		{ bin: ctx.bin, killGraceMs: 300 },
	);
}

function flag(argv: string[], name: string): string | undefined {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}

beforeEach(() => resetClaudeCodeRunnerStateForTests());
afterEach(() => {
	fake?.cleanup();
	fake = null;
});

describe("GET /models", () => {
	test("lists the endpoint's models as owned by claude-code", async () => {
		const ctx = setup("ok");
		const res = await handleClaudeCodeEndpointRequest(
			new Request("http://localhost/proj/v1/models"),
			"/models",
			ctx.endpoint,
			{ bin: ctx.bin },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			object: string;
			data: Array<{ id: string; object: string; owned_by: string }>;
		};
		expect(body.object).toBe("list");
		expect(body.data.map((m) => m.id)).toEqual(["default", "opus", "sonnet"]);
		expect(body.data.every((m) => m.owned_by === "claude-code")).toBe(true);
		expect(fake?.invocations()).toEqual([]);
	});

	test("an unknown path is a 404 and never starts the CLI", async () => {
		const ctx = setup("ok");
		const res = await handleClaudeCodeEndpointRequest(
			new Request("http://localhost/proj/v1/embeddings", { method: "POST" }),
			"/embeddings",
			ctx.endpoint,
			{ bin: ctx.bin },
		);
		expect(res.status).toBe(404);
		expect(fake?.invocations()).toEqual([]);
	});
});

describe("request validation", () => {
	test("an unknown model is a 404 model_not_found naming the valid ids", async () => {
		const ctx = setup("ok");
		const res = await call(ctx, {
			model: "gpt-4",
			messages: [{ role: "user", content: "hi" }],
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as {
			error: { code: string; message: string };
		};
		expect(body.error.code).toBe("model_not_found");
		expect(body.error.message).toContain("default, opus, sonnet");
		expect(fake?.invocations()).toEqual([]);
	});

	const messages = [{ role: "user", content: "hi" }];
	const refusals: Array<[string, Record<string, unknown>]> = [
		["n greater than 1", { n: 2 }],
		["tools", { tools: [{ type: "function", function: { name: "x" } }] }],
		["functions", { functions: [{ name: "x" }] }],
		[
			"an image part",
			{
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "look" },
							{
								type: "image_url",
								image_url: { url: "data:image/png;base64,AA" },
							},
						],
					},
				],
			},
		],
		[
			"a tool message",
			{
				messages: [
					...messages,
					{ role: "tool", content: "x", tool_call_id: "1" },
				],
			},
		],
		[
			"an assistant-last conversation",
			{ messages: [...messages, { role: "assistant", content: "x" }] },
		],
	];
	for (const [name, extra] of refusals) {
		test(`400 for ${name}, without starting the CLI`, async () => {
			const ctx = setup("ok");
			const res = await call(ctx, { model: "opus", messages, ...extra });
			expect(res.status).toBe(400);
			expect(fake?.invocations()).toEqual([]);
		});
	}

	test("an empty tools array is accepted", async () => {
		const ctx = setup("ok");
		const res = await call(ctx, { model: "opus", messages, tools: [] });
		expect(res.status).toBe(200);
	});
});

describe("argv", () => {
	test("default model passes no --model; fresh session gets --session-id; cwd is the project directory", async () => {
		const ctx = setup("ok", {
			permission_mode: "acceptEdits",
			extra_args: ["--bare", "--allowedTools", "Read"],
		});
		const res = await call(ctx, {
			model: "default",
			messages: [{ role: "user", content: "hi there" }],
		});
		expect(res.status).toBe(200);
		const [inv] = fake?.invocations() ?? [];
		expect(inv).toBeDefined();
		const argv = inv?.argv ?? [];
		expect(argv.slice(0, 6)).toEqual([
			"-p",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--permission-mode",
		]);
		expect(flag(argv, "--permission-mode")).toBe("acceptEdits");
		expect(argv).not.toContain("--model");
		expect(argv).not.toContain("--resume");
		expect(flag(argv, "--session-id")).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(argv.slice(-3)).toEqual(["--bare", "--allowedTools", "Read"]);
		expect(inv?.stdin).toBe("hi there");
		expect(fs.realpathSync(inv?.cwd ?? "")).toBe(
			fs.realpathSync(ctx.endpoint.directory),
		);
	});

	test("a named model passes --model, and system messages go to --append-system-prompt", async () => {
		const ctx = setup("ok");
		await call(ctx, {
			model: "opus",
			messages: [
				{ role: "system", content: "Be terse." },
				{ role: "developer", content: [{ type: "text", text: "No emoji." }] },
				{ role: "user", content: "hi" },
			],
		});
		const [inv] = fake?.invocations() ?? [];
		expect(flag(inv?.argv ?? [], "--model")).toBe("opus");
		expect(flag(inv?.argv ?? [], "--append-system-prompt")).toBe(
			"Be terse.\n\nNo emoji.",
		);
		expect(inv?.stdin).toBe("hi");
	});
});

describe("responses", () => {
	test("non-stream returns one chat.completion with the result text and usage", async () => {
		const ctx = setup(
			"ok",
			{},
			{ textDeltas: ["Hel", "lo"], resultText: "Hello" },
		);
		const res = await call(ctx, {
			model: "sonnet",
			messages: [{ role: "user", content: "hi" }],
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			object: string;
			model: string;
			choices: Array<{
				message: { role: string; content: string };
				finish_reason: string;
			}>;
			usage: {
				prompt_tokens: number;
				completion_tokens: number;
				total_tokens: number;
				prompt_tokens_details: { cached_tokens: number };
			};
		};
		expect(body.object).toBe("chat.completion");
		expect(body.model).toBe("sonnet");
		expect(body.choices[0]?.message).toMatchObject({
			role: "assistant",
			content: "Hello",
		});
		expect(body.choices[0]?.finish_reason).toBe("stop");
		expect(body.usage).toEqual({
			prompt_tokens: 15,
			completion_tokens: 5,
			total_tokens: 20,
			prompt_tokens_details: { cached_tokens: 3 },
		});
	});

	test("stream emits role, text deltas, stop, a usage chunk and [DONE]", async () => {
		const ctx = setup("ok", {}, { textDeltas: ["A", "B", "C"] });
		const res = await call(ctx, {
			model: "opus",
			stream: true,
			stream_options: { include_usage: true },
			messages: [{ role: "user", content: "hi" }],
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const raw = await res.text();
		const frames = raw
			.split("\n\n")
			.map((f) => f.trim())
			.filter(Boolean);
		expect(frames[frames.length - 1]).toBe("data: [DONE]");
		const chunks = frames
			.slice(0, -1)
			.map((f) => JSON.parse(f.replace(/^data: /, "")));
		expect(chunks[0].choices[0].delta).toEqual({
			role: "assistant",
			content: "",
		});
		const text = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
		expect(text).toBe("ABC");
		const stop = chunks.find((c) => c.choices[0]?.finish_reason === "stop");
		expect(stop).toBeDefined();
		const usageChunk = chunks[chunks.length - 1];
		expect(usageChunk.choices).toEqual([]);
		expect(usageChunk.usage.total_tokens).toBe(20);
		expect(chunks.every((c) => c.model === "opus")).toBe(true);
		expect(new Set(chunks.map((c) => c.id)).size).toBe(1);
	});

	test("stream without include_usage has no usage chunk", async () => {
		const ctx = setup("ok");
		const res = await call(ctx, {
			model: "opus",
			stream: true,
			messages: [{ role: "user", content: "hi" }],
		});
		const raw = await res.text();
		expect(raw).not.toContain('"usage"');
		expect(raw.trimEnd().endsWith("data: [DONE]")).toBe(true);
	});
});

describe("session resume", () => {
	test("the second turn resumes the session and sends only the last message", async () => {
		const ctx = setup("ok", {}, { textDeltas: ["Answer one"] });
		const first = await call(ctx, {
			model: "opus",
			messages: [{ role: "user", content: "question one" }],
		});
		const firstBody = (await first.json()) as {
			choices: Array<{ message: { content: string } }>;
		};
		const reply = firstBody.choices[0]?.message.content ?? "";
		expect(reply).toBe("Answer one");

		await call(ctx, {
			model: "opus",
			messages: [
				{ role: "user", content: "question one" },
				{ role: "assistant", content: reply },
				{ role: "user", content: "question two" },
			],
		});
		const [a, b] = fake?.invocations() ?? [];
		const firstId = flag(a?.argv ?? [], "--session-id");
		expect(firstId).toBeDefined();
		expect(flag(b?.argv ?? [], "--resume")).toBe(firstId);
		expect(b?.argv).not.toContain("--session-id");
		expect(b?.stdin).toBe("question two");
	});

	test("a streamed first turn is resumable too", async () => {
		const ctx = setup("ok", {}, { textDeltas: ["Streamed ", "reply"] });
		const res = await call(ctx, {
			model: "opus",
			stream: true,
			messages: [{ role: "user", content: "q1" }],
		});
		await res.text();
		await call(ctx, {
			model: "opus",
			messages: [
				{ role: "user", content: "q1" },
				{ role: "assistant", content: "Streamed reply" },
				{ role: "user", content: "q2" },
			],
		});
		const [a, b] = fake?.invocations() ?? [];
		expect(flag(b?.argv ?? [], "--resume")).toBe(
			flag(a?.argv ?? [], "--session-id"),
		);
		expect(b?.stdin).toBe("q2");
	});

	test("a miss starts a new session with the whole history flattened", async () => {
		const ctx = setup("ok");
		await call(ctx, {
			model: "opus",
			messages: [
				{ role: "system", content: "Be brief." },
				{ role: "user", content: "first" },
				{ role: "assistant", content: "second" },
				{ role: "user", content: "third" },
			],
		});
		const [inv] = fake?.invocations() ?? [];
		expect(inv?.argv).toContain("--session-id");
		expect(inv?.argv).not.toContain("--resume");
		expect(inv?.stdin).toBe("User: first\n\nAssistant: second\n\nUser: third");
	});

	test("a different endpoint name never resumes another endpoint's session", async () => {
		const ctx = setup("ok", {}, { textDeltas: ["r"] });
		await call(ctx, {
			model: "opus",
			messages: [{ role: "user", content: "q1" }],
		});
		const other = { ...ctx, endpoint: { ...ctx.endpoint, name: "other" } };
		await call(other, {
			model: "opus",
			messages: [
				{ role: "user", content: "q1" },
				{ role: "assistant", content: "r" },
				{ role: "user", content: "q2" },
			],
		});
		const [, b] = fake?.invocations() ?? [];
		expect(b?.argv).not.toContain("--resume");
	});
});

describe("review round 1", () => {
	test("a text/plain POST (a browser simple request) is a 415 and never starts the CLI", async () => {
		const ctx = setup("ok");
		const res = await handleClaudeCodeEndpointRequest(
			new Request("http://localhost/proj/v1/chat/completions", {
				method: "POST",
				headers: { "content-type": "text/plain" },
				body: JSON.stringify({
					model: "opus",
					messages: [{ role: "user", content: "rm -rf" }],
				}),
			}),
			"/chat/completions",
			ctx.endpoint,
			{ bin: ctx.bin },
		);
		expect(res.status).toBe(415);
		expect(fake?.invocations() ?? []).toHaveLength(0);
	});

	test("a cross-site browser request is a 403 and never starts the CLI", async () => {
		const ctx = setup("ok");
		const res = await handleClaudeCodeEndpointRequest(
			new Request("http://localhost/proj/v1/chat/completions", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"sec-fetch-site": "cross-site",
				},
				body: JSON.stringify({
					model: "opus",
					messages: [{ role: "user", content: "hi" }],
				}),
			}),
			"/chat/completions",
			ctx.endpoint,
			{ bin: ctx.bin },
		);
		expect(res.status).toBe(403);
		expect(fake?.invocations() ?? []).toHaveLength(0);
	});

	test("a stored conversation state is resumed at most once", async () => {
		const ctx = setup("ok", {}, { textDeltas: ["r"] });
		await call(ctx, {
			model: "opus",
			messages: [{ role: "user", content: "q1" }],
		});
		const turnTwo = {
			model: "opus",
			messages: [
				{ role: "user", content: "q1" },
				{ role: "assistant", content: "r" },
				{ role: "user", content: "q2" },
			],
		};
		await call(ctx, turnTwo);
		// A regenerate resends the same history: it must not resume a session
		// that already holds the dropped turn.
		await call(ctx, turnTwo);
		const [, b, c] = fake?.invocations() ?? [];
		expect(b?.argv).toContain("--resume");
		expect(c?.argv).not.toContain("--resume");
	});

	test("moving an endpoint to another directory never resumes the old session", async () => {
		const ctx = setup("ok", {}, { textDeltas: ["r"] });
		await call(ctx, {
			model: "opus",
			messages: [{ role: "user", content: "q1" }],
		});
		const moved = {
			...ctx,
			endpoint: { ...ctx.endpoint, directory: `${ctx.endpoint.directory}/..` },
		};
		await call(moved, {
			model: "opus",
			messages: [
				{ role: "user", content: "q1" },
				{ role: "assistant", content: "r" },
				{ role: "user", content: "q2" },
			],
		});
		const [, b] = fake?.invocations() ?? [];
		expect(b?.argv).not.toContain("--resume");
	});
});

describe("binary selection", () => {
	test("BETTER_CCFLARE_CLAUDE_BIN is used when no bin is injected", async () => {
		const ctx = setup("ok");
		const previous = process.env[CLAUDE_CODE_BIN_ENV];
		process.env[CLAUDE_CODE_BIN_ENV] = ctx.bin;
		try {
			const res = await handleClaudeCodeEndpointRequest(
				chatRequest({
					model: "opus",
					messages: [{ role: "user", content: "hi" }],
				}),
				"/chat/completions",
				ctx.endpoint,
			);
			expect(res.status).toBe(200);
			expect(fake?.invocations().length).toBe(1);
		} finally {
			if (previous === undefined) delete process.env[CLAUDE_CODE_BIN_ENV];
			else process.env[CLAUDE_CODE_BIN_ENV] = previous;
		}
	});
});

describe("failures", () => {
	test("non-zero exit is a 502 carrying the stderr tail", async () => {
		const ctx = setup("exit3");
		const res = await call(ctx, {
			model: "opus",
			messages: [{ role: "user", content: "hi" }],
		});
		expect(res.status).toBe(502);
		const body = (await res.json()) as {
			error: { message: string; code: string };
		};
		expect(body.error.code).toBe("claude_code_failed");
		expect(body.error.message).toContain("exited with code 3");
		expect(body.error.message).toContain("boom: something broke");
	});

	test("a result with is_error is a 502 carrying its text", async () => {
		const ctx = setup("is-error");
		const res = await call(ctx, {
			model: "opus",
			messages: [{ role: "user", content: "hi" }],
		});
		expect(res.status).toBe(502);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toContain("model overloaded");
	});

	test("a missing binary is a 502, not a crash", async () => {
		const ctx = setup("ok");
		const res = await handleClaudeCodeEndpointRequest(
			chatRequest({
				model: "opus",
				messages: [{ role: "user", content: "hi" }],
			}),
			"/chat/completions",
			ctx.endpoint,
			{ bin: `${ctx.endpoint.directory}/does-not-exist` },
		);
		expect(res.status).toBe(502);
	});

	test("stream: a failure before any text still gets a real status", async () => {
		const ctx = setup("exit3");
		const res = await call(ctx, {
			model: "opus",
			stream: true,
			messages: [{ role: "user", content: "hi" }],
		});
		expect(res.status).toBe(502);
	});

	test("the failed request releases its concurrency slot", async () => {
		const ctx = setup("exit3", { max_concurrency: 1 });
		for (let i = 0; i < 3; i++) {
			const res = await call(ctx, {
				model: "opus",
				messages: [{ role: "user", content: "hi" }],
			});
			expect(res.status).toBe(502);
		}
	});
});

describe("concurrency, timeout and abort", () => {
	test("over max_concurrency is a 429 with retry-after 5; aborting frees the slot", async () => {
		const ctx = setup("hang", { max_concurrency: 1 });
		const abort = new AbortController();
		const body = { model: "opus", messages: [{ role: "user", content: "hi" }] };
		const inFlight = call(ctx, body, abort.signal);
		await waitFor(() => (fake?.invocations().length ?? 0) === 1);

		const refused = await call(ctx, body);
		expect(refused.status).toBe(429);
		expect(refused.headers.get("retry-after")).toBe("5");
		const refusedBody = (await refused.json()) as {
			error: { type: string; code: string };
		};
		expect(refusedBody.error.code).toBe("rate_limit_exceeded");
		expect(fake?.invocations().length).toBe(1);

		abort.abort();
		await inFlight;
		const again = call(
			{ ...ctx, endpoint: { ...ctx.endpoint, timeout_ms: 400 } },
			body,
		);
		expect((await again).status).toBe(504);
	});

	test("timeout kills the whole process group and answers 504", async () => {
		const ctx = setup("hang", { timeout_ms: 400 });
		const res = await call(ctx, {
			model: "opus",
			messages: [{ role: "user", content: "hi" }],
		});
		expect(res.status).toBe(504);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("timeout");
		const [inv] = fake?.invocations() ?? [];
		await waitFor(
			() => !isAlive(inv?.pid ?? 0) && !isAlive(inv?.childPid ?? 0),
		);
	});

	test("a process that ignores SIGTERM is killed after the grace period", async () => {
		const ctx = setup("ignore-term", { timeout_ms: 300 });
		const started = Date.now();
		const res = await call(ctx, {
			model: "opus",
			messages: [{ role: "user", content: "hi" }],
		});
		expect(res.status).toBe(504);
		// timeout 300ms + killGraceMs 300ms: the answer cannot come earlier.
		expect(Date.now() - started).toBeGreaterThanOrEqual(550);
		const [inv] = fake?.invocations() ?? [];
		await waitFor(
			() => !isAlive(inv?.pid ?? 0) && !isAlive(inv?.childPid ?? 0),
		);
	});

	test("client abort kills the process group", async () => {
		const ctx = setup("hang");
		const abort = new AbortController();
		const pending = call(
			ctx,
			{ model: "opus", messages: [{ role: "user", content: "hi" }] },
			abort.signal,
		);
		await waitFor(() => (fake?.invocations().length ?? 0) === 1);
		const [inv] = fake?.invocations() ?? [];
		expect(isAlive(inv?.pid ?? 0)).toBe(true);
		expect(isAlive(inv?.childPid ?? 0)).toBe(true);
		abort.abort();
		await pending;
		await waitFor(
			() => !isAlive(inv?.pid ?? 0) && !isAlive(inv?.childPid ?? 0),
		);
	});

	test("stream: a timeout after text ends the stream with an error frame", async () => {
		const ctx = setup("hang-after-text", { timeout_ms: 500 });
		const res = await call(ctx, {
			model: "opus",
			stream: true,
			messages: [{ role: "user", content: "hi" }],
		});
		expect(res.status).toBe(200);
		const raw = await res.text();
		expect(raw).toContain('"content":"Hello"');
		expect(raw).toContain('"code":"timeout"');
		expect(raw.trimEnd().endsWith("data: [DONE]")).toBe(true);
		const [inv] = fake?.invocations() ?? [];
		await waitFor(
			() => !isAlive(inv?.pid ?? 0) && !isAlive(inv?.childPid ?? 0),
		);
	});

	test("stream: cancelling the response body kills the process group", async () => {
		const ctx = setup("hang-after-text");
		const res = await call(ctx, {
			model: "opus",
			stream: true,
			messages: [{ role: "user", content: "hi" }],
		});
		const reader = res.body?.getReader();
		await reader?.read();
		const [inv] = fake?.invocations() ?? [];
		expect(isAlive(inv?.pid ?? 0)).toBe(true);
		await reader?.cancel();
		await waitFor(
			() => !isAlive(inv?.pid ?? 0) && !isAlive(inv?.childPid ?? 0),
		);
	});
});
