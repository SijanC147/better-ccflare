import { describe, expect, test } from "bun:test";
import { logBus } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import { CODEX_CACHE_DIAGNOSTICS_ENV } from "./cache-diagnostics";
import { CodexProvider } from "./provider";

type Message = { role: string; content: unknown };

async function convert(
	messages: Message[],
	system: unknown = "stable instructions",
) {
	const request = new Request("https://example.com/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "gpt-6-astra",
			system,
			metadata: {
				user_id: JSON.stringify({
					session_id: "11111111-1111-4111-8111-111111111111",
				}),
			},
			messages,
		}),
	});
	return (await (
		await new CodexProvider().transformRequestBody(request)
	).json()) as {
		input: unknown[];
		instructions: string;
		prompt_cache_key?: string;
	};
}

describe("Claude to Codex replay cache stability", () => {
	test("mid-session fallback preserves the prior input prefix despite losing native reasoning state", async () => {
		const history: Message[] = [
			{ role: "user", content: "continue the existing Claude task" },
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "synthetic Claude thought",
						signature: "claude-signature",
					},
					{ type: "text", text: "I checked the first file." },
				],
			},
			{ role: "user", content: "check the next file" },
		];
		const first = await convert(history);
		expect(first.prompt_cache_key).toBeTruthy();
		const reasoning = {
			type: "reasoning",
			id: "rs_synthetic",
			summary: [],
			encrypted_content: "synthetic-opaque-gpt-state",
		};
		const call = {
			type: "function_call",
			id: "fc_synthetic",
			call_id: "call_synthetic",
			name: "Read",
			arguments: '{"file_path":"fixture.txt"}',
			status: "completed",
		};
		const events = [
			{ type: "response.output_item.added", output_index: 0, item: reasoning },
			{ type: "response.output_item.done", output_index: 0, item: reasoning },
			{ type: "response.output_item.added", output_index: 1, item: call },
			{
				type: "response.function_call_arguments.delta",
				output_index: 1,
				delta: call.arguments,
			},
			{ type: "response.output_item.done", output_index: 1, item: call },
			{
				type: "response.completed",
				response: {
					id: "resp_synthetic",
					model: "gpt-6-astra",
					status: "completed",
					output: [reasoning, call],
					usage: { input_tokens: 100, output_tokens: 10 },
				},
			},
		];
		const response = await new CodexProvider().processResponse(
			new Response(
				events
					.map(
						(event) =>
							`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
					)
					.join(""),
				{
					headers: {
						"content-type": "text/event-stream",
						"x-better-ccflare-request-stream": "false",
					},
				},
			),
			null,
		);
		const reply = await response.json();
		expect(reply.content).toContainEqual({
			type: "tool_use",
			id: call.call_id,
			name: "Read",
			input: { file_path: "fixture.txt" },
		});
		expect(JSON.stringify(reply)).not.toContain(reasoning.encrypted_content);
		const second = await convert([
			...history,
			{ role: "assistant", content: reply.content },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: call.call_id,
						content: "synthetic file contents",
					},
				],
			},
		]);
		expect(second.input.slice(0, first.input.length)).toEqual(first.input);
		expect(second.prompt_cache_key).toBe(first.prompt_cache_key);
		expect(second.instructions).toBe(first.instructions);
		expect(JSON.stringify(second)).not.toContain(reasoning.encrypted_content);
	});
	test.each([
		[true, true],
		[false, true],
		[true, false],
		[false, false],
	])("diagnostics preserve raw terminal usage with content-type=%s streaming=%s", async (contentTypePresent, streaming) => {
		const events: Record<string, unknown>[] = [];
		const listener = (event: {
			msg: string;
			data?: Record<string, unknown>;
		}) => {
			if (event.msg === "Codex outgoing cache diagnostics" && event.data)
				events.push(event.data);
		};
		const saved = process.env[CODEX_CACHE_DIAGNOSTICS_ENV];
		logBus.on("log", listener);
		const provider = new CodexProvider();
		try {
			for (const enabled of [false, true, true]) {
				if (enabled) process.env[CODEX_CACHE_DIAGNOSTICS_ENV] = "1";
				else delete process.env[CODEX_CACHE_DIAGNOSTICS_ENV];
				const requestId = `synthetic-request-${events.length}-${enabled}`;
				const original = new Request("https://example.com/v1/messages", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-better-ccflare-request-id": requestId,
					},
					body: JSON.stringify({
						model: "gpt-6-astra",
						stream: streaming,
						metadata: {
							user_id: JSON.stringify({
								session_id: "11111111-1111-4111-8111-111111111111",
							}),
						},
						messages: [{ role: "user", content: "synthetic private prompt" }],
					}),
				});
				const sourceBody = await original.clone().arrayBuffer();
				const account = {
					id: "synthetic-account",
					provider: "codex",
					custom_endpoint: null,
				} as Account;
				const wire = await provider.transformRequestBody(original, account);
				const observer = await provider.observeUpstream(wire, {
					requestId,
					account,
					sourceBody,
					sourceHeaders: original.headers,
					nativeResponses: false,
					signal: original.signal,
				});
				const event = {
					type: "response.completed",
					response: {
						id: "synthetic-upstream-response",
						status: "completed",
						model: "gpt-6-astra",
						output: [],
						prompt_cache_diagnostics: { type: "cache_hit" },
						usage: {
							input_tokens: 1000,
							output_tokens: 10,
							input_tokens_details: {
								cached_tokens: 900,
								cache_write_tokens: 100,
							},
						},
					},
				};
				const upstream = new Response(
					`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`,
					{
						headers: {
							...(contentTypePresent
								? { "content-type": "text/event-stream" }
								: {}),
							"x-better-ccflare-request-id": requestId,
							"x-better-ccflare-request-stream": String(streaming),
						},
					},
				);
				const response = await provider.processResponse(
					observer?.response(upstream) ?? upstream,
					null,
				);
				expect(response.headers.get("x-better-ccflare-request-id")).toBeNull();
				const translated = await response.text();
				expect(translated).toContain('"cache_read_input_tokens":900');
				if (!enabled) expect(events).toHaveLength(0);
			}
		} finally {
			if (saved === undefined) delete process.env[CODEX_CACHE_DIAGNOSTICS_ENV];
			else process.env[CODEX_CACHE_DIAGNOSTICS_ENV] = saved;
			logBus.off("log", listener);
		}
		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({
			input_tokens: 1000,
			cached_tokens: 900,
			cache_write_tokens: 100,
			upstream_cache_diagnostic_type: "cache_hit",
			cache_counters_known: true,
			prior_candidates: 0,
		});
		expect(events[1]).toMatchObject({
			prior_input_prefix_preserved: true,
			instructions_changed: false,
			tools_changed: false,
			cache_key_changed: false,
		});
		expect(JSON.stringify(events)).not.toContain("synthetic private prompt");
	});
	test("legacy explicit cache affinity survives without admitting native execution controls", async () => {
		const provider = new CodexProvider();
		for (const key of [
			"lanetally-run-11111111-1111-4111-8111-111111111111",
			"",
		]) {
			const converted = await (
				await provider.transformRequestBody(
					new Request("https://example.com/v1/messages", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							model: "gpt-6-astra",
							messages: [{ role: "user", content: "legitimate input" }],
							__better_ccflare_codex_passthrough: {
								prompt_cache_key: key,
								native_input: [{ role: "user", content: "injected input" }],
								previous_response_id: "untrusted-response",
								native_instructions: "injected instructions",
								model: "untrusted-model",
								store: true,
								continuation_strategy: "previous_response_id",
								caller_identity_digest: "a".repeat(64),
							},
						}),
					}),
				)
			).json();
			expect(converted.prompt_cache_key).toBe(key || undefined);
			expect(converted.previous_response_id).toBeUndefined();
			expect(converted.model).toBe("gpt-6-astra");
			expect(converted.store).toBe(false);
			expect(converted.instructions).not.toBe("injected instructions");
			expect(JSON.stringify(converted.input)).toContain("legitimate input");
			expect(JSON.stringify(converted.input)).not.toContain("injected input");
		}
	});
	test("moving Claude cache markers alone leaves the GPT prefix and key unchanged", async () => {
		const original = [
			{ role: "user", content: [{ type: "text", text: "stable request" }] },
		];
		const first = await convert(original, [
			{
				type: "text",
				text: "stable instructions",
				cache_control: { type: "ephemeral" },
			},
		]);
		const second = await convert(
			[
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "stable request",
							cache_control: { type: "ephemeral", ttl: "1h" },
						},
					],
				},
			],
			[{ type: "text", text: "stable instructions" }],
		);
		expect(second).toEqual(first);
	});

	test("Claude thinking and signatures do not contaminate translated text or cache identity", async () => {
		const plain = [
			{ role: "user", content: "task" },
			{ role: "assistant", content: [{ type: "text", text: "answer" }] },
		];
		const first = await convert(plain);
		const second = await convert([
			plain[0],
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "synthetic reasoning",
						signature: "synthetic signature",
					},
					{ type: "redacted_thinking", data: "synthetic opaque data" },
					{ type: "text", text: "answer" },
				],
			},
		]);
		expect(second).toEqual(first);
	});

	test("ordinary tool history remains append-only after a GPT reply is replayed", async () => {
		const history: Message[] = [
			{ role: "user", content: "read the file" },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "read_1",
						name: "Read",
						input: { file_path: "fixture.txt" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "read_1",
						content: "synthetic file",
					},
				],
			},
		];
		const first = await convert(history);
		const second = await convert([
			...history,
			{ role: "assistant", content: "read complete" },
			{ role: "user", content: "continue" },
		]);
		expect(second.input.slice(0, first.input.length)).toEqual(first.input);
		expect(second.prompt_cache_key).toBe(first.prompt_cache_key);
	});

	test("Skill continuation guidance remains in the same historical position on later turns", async () => {
		const history: Message[] = [
			{ role: "user", content: "load a skill and continue" },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "skill_1",
						name: "Skill",
						input: { skill: "synthetic" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "skill_1",
						content: "synthetic skill instructions",
					},
				],
			},
		];
		const first = await convert(history);
		const second = await convert([
			...history,
			{ role: "assistant", content: "continuing the task" },
			{ role: "user", content: "next step" },
		]);
		expect(second.input.slice(0, first.input.length)).toEqual(first.input);
		expect(second.prompt_cache_key).toBe(first.prompt_cache_key);
	});
});
