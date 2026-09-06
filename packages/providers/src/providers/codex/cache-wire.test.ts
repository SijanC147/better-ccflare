import { describe, expect, test } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { CodexCacheDiagnostics } from "./cache-diagnostics";
import {
	type CacheFacts,
	cacheDigest,
	sanitizeCacheFacts,
} from "./cache-telemetry";
import { observeCodexWire } from "./cache-wire";

const body = {
	model: "synthetic-model",
	input: [{ role: "user", content: "PRIVATE-PROMPT-SENTINEL" }],
	instructions: "PRIVATE-INSTRUCTIONS-SENTINEL",
	prompt_cache_key: "PRIVATE-CACHE-KEY-SENTINEL",
};
const terminal = {
	id: "resp_synthetic",
	status: "completed",
	output: [],
	usage: {
		input_tokens: 100,
		input_tokens_details: { cached_tokens: 0 },
		output_tokens: 2,
	},
};
const event = (response = terminal) =>
	`event: response.completed\r\ndata: ${JSON.stringify({ type: "response.completed", response })}\r\n\r\n`;
const encoded = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;

function harness() {
	const rows: CacheFacts[] = [];
	const emit = (row: CacheFacts) => rows.push(sanitizeCacheFacts(row));
	const diagnostics = new CodexCacheDiagnostics(emit, Date.now, emit);
	const start = async (
		id: string,
		native = false,
		wireBody: unknown = body,
		signal = new AbortController().signal,
	) => {
		const request = new Request("https://example.invalid/responses", {
			method: "POST",
			body: JSON.stringify(wireBody),
		});
		const observer = await observeCodexWire(
			diagnostics,
			request,
			{
				requestId: id,
				account: { id: "PRIVATE-ACCOUNT-SENTINEL" } as Account,
				sourceBody: encoded({
					messages: body.input,
					system: body.instructions,
				}),
				sourceHeaders: new Headers({
					authorization: "PRIVATE-TOKEN-SENTINEL",
					"x-lanetally-agent-id": "PRIVATE-AGENT-SENTINEL",
					"x-lanetally-conversation-id": "PRIVATE-CONVERSATION-SENTINEL",
					"x-lanetally-gateway-request-digest": "a".repeat(64),
					"x-lanetally-gateway-attempt-digest": "b".repeat(64),
				}),
				nativeResponses: native,
				signal,
			},
			() => "PRIVATE-SESSION-SENTINEL",
		);
		expect(await request.json()).toEqual(wireBody);
		return observer;
	};
	return { start, rows };
}

describe("cache capture at final wire boundary", () => {
	test.each([
		false,
		true,
	])("same raw counters and identity on native=%s with SSE and JSON", async (native) => {
		const { start, rows } = harness();
		for (const sse of [true, false]) {
			const observer = await start(`request-${sse}`, native);
			const payload = sse ? event() : JSON.stringify(terminal);
			const response = observer.response(
				new Response(payload, {
					headers: {
						"content-type": sse ? "text/event-stream" : "application/json",
						"x-request-id": "upstream-id",
					},
				}),
			);
			expect(await response.text()).toBe(payload);
		}
		const done = rows.filter((row) => row.event === "completed");
		expect(done).toHaveLength(2);
		expect(done[0]).toMatchObject({
			path: native ? "native" : "legacy",
			cache_counters_known: true,
			cached_tokens: 0,
			cache_write_tokens: null,
			upstream_request_digest: cacheDigest("upstream-id"),
			upstream_response_digest: cacheDigest(terminal.id),
			agent_digest: cacheDigest("PRIVATE-AGENT-SENTINEL"),
			identity_source: "caller",
			gateway_request_digest: "a".repeat(64),
			gateway_attempt_digest: "b".repeat(64),
		});
		expect(done[1].prior_input_prefix_preserved).toBe(true);
		expect(JSON.stringify(rows)).not.toContain("PRIVATE-");
	});

	test("captures final rewrites and repeated attempts separately, including pre-header errors", async () => {
		const { start, rows } = harness();
		const first = await start("request");
		const refused = new Response("PRIVATE-ERROR-SENTINEL", { status: 429 });
		expect(first.response(refused)).toBe(refused);
		const second = await start("request", true, {
			...body,
			input: [],
			previous_response_id: "PRIVATE-PREVIOUS-ID",
			reasoning: { effort: "high" },
		});
		await second
			.response(
				new Response(JSON.stringify(terminal), {
					headers: { "content-type": "application/json" },
				}),
			)
			.text();
		const third = await start("request");
		third.error(new Error("PRIVATE-TRANSPORT-SENTINEL"));
		const prepared = rows.filter((row) => row.event === "prepared");
		expect(new Set(prepared.map((row) => row.attempt_digest)).size).toBe(3);
		expect(new Set(prepared.map((row) => row.request_digest)).size).toBe(1);
		expect(prepared[1]).toMatchObject({
			input_items: 0,
			previous_response_present: true,
		});
		expect(prepared[0].input_digest).not.toBe(prepared[1].input_digest);
		expect(prepared[0].source_input_digest).toBe(
			prepared[1].source_input_digest,
		);
		expect(
			rows
				.filter((row) =>
					["upstream_error", "completed", "transport_error"].includes(
						String(row.event),
					),
				)
				.map((row) => row.event),
		).toEqual(["upstream_error", "completed", "transport_error"]);
		expect(JSON.stringify(rows)).not.toContain("PRIVATE-");
	});

	test("handles chunked missing-content-type SSE and keeps missing counters unknown", async () => {
		const { start, rows } = harness();
		const observer = await start("chunked", true);
		const payload = event({
			...terminal,
			usage: { input_tokens: 100 },
		} as typeof terminal);
		const bytes = new TextEncoder().encode(payload);
		let index = 0;
		const upstream = new Response(
			new ReadableStream({
				pull(controller) {
					if (index === bytes.length) controller.close();
					else controller.enqueue(bytes.slice(index, ++index));
				},
			}),
		);
		expect(await observer.response(upstream).text()).toBe(payload);
		expect(rows.at(-1)).toMatchObject({
			event: "completed",
			cached_tokens: null,
			cache_counters_known: false,
			transport: "sse",
		});
		expect(rows.some((row) => row.gap_reason === "missing_content_type")).toBe(
			true,
		);
	});

	test("records cancellation, malformed/truncated responses and stream failures without rewriting bytes", async () => {
		const { start, rows } = harness();
		const canceled = await start("cancel", true);
		await canceled
			.response(new Response(new ReadableStream({})))
			.body?.cancel("PRIVATE-CANCEL");
		const signal = new AbortController();
		await start("signal", false, body, signal.signal);
		signal.abort();
		const timeout = await start("timeout");
		timeout.error(new DOMException("PRIVATE-TIMEOUT", "AbortError"));
		for (const [id, data] of [
			["malformed", "event: response.completed\ndata: {broken}\n\n"],
			["truncated", "event: response.completed\ndata: {}"],
		]) {
			const observer = await start(id, true);
			expect(
				await observer
					.response(
						new Response(data, {
							headers: { "content-type": "text/event-stream" },
						}),
					)
					.text(),
			).toBe(data);
		}
		const broken = await start("broken", true);
		await expect(
			broken
				.response(
					new Response(
						new ReadableStream({
							pull(controller) {
								controller.error(new Error("PRIVATE-BROKEN"));
							},
						}),
					),
				)
				.text(),
		).rejects.toThrow("PRIVATE-BROKEN");
		expect(
			rows.filter((row) => row.event !== "prepared").map((row) => row.event),
		).toEqual([
			"coverage_gap",
			"canceled",
			"canceled",
			"timeout",
			"coverage_gap",
			"truncated",
			"coverage_gap",
			"transport_error",
		]);
		expect(rows.some((row) => row.gap_reason === "invalid_json")).toBe(true);
		expect(JSON.stringify(rows)).not.toContain("PRIVATE-");
	});

	test("oversize observations are explicit while request and response remain usable", async () => {
		const { start, rows } = harness();
		const oversized = await start("oversize", true, {
			...body,
			input: Array(2049).fill({ role: "user", content: "x" }),
		});
		await oversized
			.response(
				new Response(JSON.stringify(terminal), {
					headers: { "content-type": "application/json" },
				}),
			)
			.text();
		expect(rows.some((row) => row.gap_reason === "item_limit")).toBe(true);
		expect(rows.at(-1)).toMatchObject({
			event: "completed",
			fingerprint_complete: false,
			cache_counters_known: true,
		});
		const parseLimited = await start("parse-limit", true);
		const bytes = `data: ${"x".repeat(8 * 1024 * 1024 + 1)}`;
		expect(
			await parseLimited
				.response(
					new Response(bytes, {
						headers: { "content-type": "text/event-stream" },
					}),
				)
				.text(),
		).toBe(bytes);
		expect(rows.at(-1)).toMatchObject({
			event: "coverage_gap",
			gap_reason: "native_parse_limit",
		});
	});
});
