/**
 * SB23-3964: Codex carries three things from transformRequestBody to
 * processResponse (stream intent, the body-derived turn, the pending
 * continuation). On provider-wide maps keyed by request id they were swept
 * by age and capped by count, so a response arriving after the sweep, or
 * past the cap under load, lost its state silently. Keyed on the proxy's
 * per-attempt carrier they live exactly as long as the attempt.
 *
 * Each test drives the eviction the old maps performed (the age sweep or
 * the cap), with carrier-less filler traffic churning the provider-wide
 * map, and asserts the carrier kept the state. Run against the provider
 * before this change, which ignores the carrier argument, each one fails.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import { makeAccount } from "../../testing/account-fixture";
import type { ProviderRequestContext } from "../../types";
import { CodexProvider, recoverCodexMessagesContinuation } from "./provider";
import { CODEX_TURN_STATE_HEADER } from "./turn-state";

const account = makeAccount({ id: "acc-carrier", provider: "codex" });

function event(type: string, fields: Record<string, unknown>) {
	return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}

function completedWire(id: string): string {
	const output = [
		{
			type: "message",
			role: "assistant",
			id: "msg_upstream",
			status: "completed",
			content: [{ type: "output_text", text: "GPT answer" }],
		},
	];
	return (
		event("response.created", {
			response: { id: `resp_${id}`, model: "gpt-6-astra" },
		}) +
		event("response.content_part.added", {
			part: { type: "output_text", text: "" },
		}) +
		event("response.output_text.delta", { delta: "GPT answer" }) +
		event("response.completed", {
			response: {
				id: `resp_${id}`,
				model: "gpt-6-astra",
				status: "completed",
				output,
				usage: { input_tokens: 100, output_tokens: 5 },
			},
		})
	);
}

function messagesRequest(
	id: string,
	body: Record<string, unknown>,
	caller?: string,
): Request {
	const headers = new Headers({
		"content-type": "application/json",
		"x-better-ccflare-request-id": id,
	});
	if (caller) headers.set("x-better-ccflare-authenticated-caller", caller);
	return new Request("https://example.com/v1/messages", {
		method: "POST",
		headers,
		body: JSON.stringify({ model: "gpt-6-astra", max_tokens: 64, ...body }),
	});
}

function session(sessionId: string) {
	return { metadata: { user_id: JSON.stringify({ session_id: sessionId }) } };
}

/** `go`, then `n` tool_use/tool_result pairs: each n extends n - 1. */
function toolTurn(n: number) {
	return [
		{ role: "user", content: "go" },
		...Array.from({ length: n }, (_, i) => [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: `t${i}`, name: "x", input: {} }],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "" }],
			},
		]).flat(),
	];
}

describe("Codex per-request state survives the old maps' eviction on the carrier", () => {
	test("stream intent: an untagged response after the 30 s sweep keeps stream:false", async () => {
		const start = Date.now();
		try {
			const provider = new CodexProvider();
			const carrier: ProviderRequestContext = {};
			await provider.transformRequestBody(
				messagesRequest("stream-held", {
					stream: false,
					messages: [{ role: "user", content: "hi" }],
				}),
				account,
				carrier,
			);
			// The old map swept entries older than 30 s on the next transform.
			setSystemTime(new Date(start + 31_000));
			await provider.transformRequestBody(
				messagesRequest("stream-filler", {
					stream: true,
					messages: [{ role: "user", content: "filler" }],
				}),
				account,
			);
			// No x-better-ccflare-request-stream header: the stored intent is the
			// only source. Lost, it defaults to streaming.
			const response = await provider.processResponse(
				new Response(completedWire("stream-held"), {
					headers: {
						"content-type": "text/event-stream",
						"x-better-ccflare-request-id": "stream-held",
					},
				}),
				account,
				undefined,
				undefined,
				carrier,
			);
			expect(response.headers.get("content-type")).toContain(
				"application/json",
			);
			const body = (await response.json()) as { content: { text: string }[] };
			expect(body.content[0].text).toBe("GPT answer");
		} finally {
			setSystemTime();
		}
	});

	test("messages turn: a response after the 10 min sweep still files its token for the next request", async () => {
		let now = 1_000_000;
		const provider = new CodexProvider({ now: () => now });
		const opening: ProviderRequestContext = {};
		await provider.transformRequestBody(
			messagesRequest("turn-open", {
				...session("5e550000-0000-4000-8000-00000000c301"),
				messages: toolTurn(0),
			}),
			account,
			opening,
		);
		// MESSAGES_TURN_PENDING_TTL_MS is 10 min; the next transform sweeps.
		now += 10 * 60 * 1000 + 1;
		await provider.transformRequestBody(
			messagesRequest("turn-filler", {
				...session("5e550000-0000-4000-8000-00000000c302"),
				messages: toolTurn(0),
			}),
			account,
		);
		const answered = await provider.processResponse(
			new Response(completedWire("turn-open"), {
				headers: {
					"content-type": "text/event-stream",
					"x-better-ccflare-request-id": "turn-open",
					"x-better-ccflare-request-stream": "false",
					[CODEX_TURN_STATE_HEADER]: "issued-token",
				},
			}),
			account,
			undefined,
			undefined,
			opening,
		);
		await answered.text();
		const followUp = await provider.transformRequestBody(
			messagesRequest("turn-next", {
				...session("5e550000-0000-4000-8000-00000000c301"),
				messages: toolTurn(1),
			}),
			account,
			{},
		);
		expect(followUp.headers.get(CODEX_TURN_STATE_HEADER)).toBe("issued-token");
	});

	describe("pending continuation", () => {
		const old = process.env.CCFLARE_CODEX_MESSAGES_CONTINUATION;
		const oldModels = process.env.CCFLARE_CODEX_MESSAGES_CONTINUATION_MODELS;
		beforeEach(() => {
			delete process.env.CCFLARE_CODEX_MESSAGES_CONTINUATION_MODELS;
			process.env.CCFLARE_CODEX_MESSAGES_CONTINUATION = "1";
		});
		afterEach(() => {
			if (oldModels === undefined)
				delete process.env.CCFLARE_CODEX_MESSAGES_CONTINUATION_MODELS;
			else process.env.CCFLARE_CODEX_MESSAGES_CONTINUATION_MODELS = oldModels;
			if (old === undefined)
				delete process.env.CCFLARE_CODEX_MESSAGES_CONTINUATION;
			else process.env.CCFLARE_CODEX_MESSAGES_CONTINUATION = old;
		});

		const caller = "a".repeat(64);
		const history = [
			{ role: "user", content: "original task" },
			{ role: "assistant", content: [{ type: "text", text: "prior answer" }] },
			{ role: "user", content: "continue" },
		];
		const replay = [
			...history,
			{ role: "assistant", content: [{ type: "text", text: "GPT answer" }] },
			{ role: "user", content: "next turn" },
		];
		const base = {
			stream: false,
			system: [
				{
					type: "text",
					text: "stable system",
					cache_control: { type: "ephemeral" },
				},
			],
		};

		test("a completion past the pending cap still commits the chain the next request continues", async () => {
			// continuationMaxLanes 1 caps pending continuations at 2.
			const provider = new CodexProvider({ continuationMaxLanes: 1 });
			const first: ProviderRequestContext = {};
			await provider.transformRequestBody(
				messagesRequest(
					"cont-one",
					{
						...base,
						...session("11111111-1111-4111-8111-111111111111"),
						messages: history,
					},
					caller,
				),
				account,
				first,
			);
			for (let i = 0; i < 3; i++) {
				await provider.transformRequestBody(
					messagesRequest(
						`cont-filler-${i}`,
						{
							...base,
							...session(`22222222-2222-4222-8222-22222222222${i}`),
							messages: history,
						},
						caller,
					),
					account,
				);
			}
			const finished = await provider.processResponse(
				new Response(completedWire("cont-one"), {
					headers: {
						"content-type": "text/event-stream",
						"x-better-ccflare-request-id": "cont-one",
						"x-better-ccflare-request-stream": "false",
					},
				}),
				account,
				undefined,
				undefined,
				first,
			);
			await finished.text();
			await Promise.resolve();
			const next = (await (
				await provider.transformRequestBody(
					messagesRequest(
						"cont-two",
						{
							...base,
							...session("11111111-1111-4111-8111-111111111111"),
							messages: replay,
						},
						caller,
					),
					account,
					{},
				)
			).json()) as { previous_response_id?: string };
			expect(next.previous_response_id).toBe("resp_cont-one");
		});

		test("a rejected continuation's full-history re-transform keeps its state on the same carrier", async () => {
			const provider = new CodexProvider();
			const sid = "33333333-3333-4333-8333-333333333333";
			const send = async (
				id: string,
				messages: unknown[],
				carrier: ProviderRequestContext,
			) =>
				(await (
					await provider.transformRequestBody(
						messagesRequest(id, { ...base, ...session(sid), messages }, caller),
						account,
						carrier,
					)
				).json()) as { previous_response_id?: string };
			const finish = async (id: string, carrier: ProviderRequestContext) => {
				const response = await provider.processResponse(
					new Response(completedWire(id), {
						headers: {
							"content-type": "text/event-stream",
							"x-better-ccflare-request-id": id,
							"x-better-ccflare-request-stream": "false",
						},
					}),
					account,
					undefined,
					undefined,
					carrier,
				);
				await response.text();
				await Promise.resolve();
				return response;
			};
			const one: ProviderRequestContext = {};
			await send("rec-one", history, one);
			await finish("rec-one", one);
			const retry: ProviderRequestContext = {};
			expect((await send("rec-two", replay, retry)).previous_response_id).toBe(
				"resp_rec-one",
			);
			const recovered = await recoverCodexMessagesContinuation(
				provider,
				new Response(
					JSON.stringify({
						error: {
							type: "invalid_request_error",
							code: "previous_response_not_found",
						},
					}),
					{ status: 400 },
				),
				messagesRequest(
					"rec-two",
					{ ...base, ...session(sid), messages: replay },
					caller,
				),
				account,
				retry,
			);
			if (!recovered) throw new Error("missing full-history recovery");
			expect(
				((await recovered.json()) as { previous_response_id?: string })
					.previous_response_id,
			).toBeUndefined();
			// The re-transform's pending continuation answers the retried request's
			// response only if it was written to the carrier that response reads.
			const answered = await finish("rec-two", retry);
			expect(answered.headers.get("x-better-ccflare-continuation-result")).toBe(
				"cold",
			);
		});
	});
});
