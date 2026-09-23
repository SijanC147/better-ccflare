import { describe, expect, test } from "bun:test";
import { translateAnthropicStreamToChat } from "../stream-translator";
import type { ChatCompletionChunk, OpenAIErrorBody } from "../types";

const encoder = new TextEncoder();

function sse(events: Array<[string, unknown]>, eol = "\n"): string {
	return events
		.map(
			([name, data]) =>
				`event: ${name}${eol}data: ${JSON.stringify(data)}${eol}${eol}`,
		)
		.join("");
}

/** Stream the given bytes, split into chunks of `size` bytes (whole when 0). */
function upstreamFrom(text: string, size = 0): ReadableStream<Uint8Array> {
	const bytes = encoder.encode(text);
	const parts: Uint8Array[] = [];
	if (size <= 0) parts.push(bytes);
	else
		for (let i = 0; i < bytes.length; i += size)
			parts.push(bytes.slice(i, i + size));
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const p of parts) controller.enqueue(p);
			controller.close();
		},
	});
}

interface Parsed {
	raw: string;
	frames: string[];
	chunks: ChatCompletionChunk[];
	errors: OpenAIErrorBody[];
}

async function run(
	upstream: ReadableStream<Uint8Array>,
	includeUsage = false,
): Promise<Parsed> {
	const out = translateAnthropicStreamToChat(upstream, {
		id: "chatcmpl-1",
		created: 1_700_000_000,
		model: "gpt-4o",
		includeUsage,
	});
	const raw = await new Response(out).text();
	const frames = raw.split("\n\n").filter((f) => f !== "");
	const chunks: ChatCompletionChunk[] = [];
	const errors: Parsed["errors"] = [];
	for (const f of frames) {
		if (!f.startsWith("data: ") || f === "data: [DONE]") continue;
		const obj = JSON.parse(f.slice("data: ".length));
		if ("error" in obj) errors.push(obj);
		else chunks.push(obj);
	}
	return { raw, frames, chunks, errors };
}

const start = (usage: Record<string, number> = { input_tokens: 12 }) =>
	[
		"message_start",
		{
			type: "message_start",
			message: {
				id: "msg_1",
				type: "message",
				role: "assistant",
				model: "claude-x",
				content: [],
				stop_reason: null,
				usage: { output_tokens: 1, ...usage },
			},
		},
	] as [string, unknown];

const textStart = (index: number): [string, unknown] => [
	"content_block_start",
	{
		type: "content_block_start",
		index,
		content_block: { type: "text", text: "" },
	},
];
const textDelta = (index: number, text: string): [string, unknown] => [
	"content_block_delta",
	{ type: "content_block_delta", index, delta: { type: "text_delta", text } },
];
const blockStop = (index: number): [string, unknown] => [
	"content_block_stop",
	{ type: "content_block_stop", index },
];
const messageDelta = (
	stop_reason: string,
	output_tokens: number,
): [string, unknown] => [
	"message_delta",
	{
		type: "message_delta",
		delta: { stop_reason, stop_sequence: null },
		usage: { output_tokens },
	},
];
const messageStop: [string, unknown] = [
	"message_stop",
	{ type: "message_stop" },
];

const plainText = sse([
	start(),
	textStart(0),
	["ping", { type: "ping" }],
	textDelta(0, "Hello"),
	textDelta(0, ", world"),
	blockStop(0),
	messageDelta("end_turn", 7),
	messageStop,
]);

function contentOf(chunks: ChatCompletionChunk[]): string {
	return chunks.map((c) => c.choices[0]?.delta.content ?? "").join("");
}

describe("translateAnthropicStreamToChat", () => {
	test("plain text", async () => {
		const { raw, frames, chunks, errors } = await run(upstreamFrom(plainText));
		expect(errors).toEqual([]);
		expect(raw.endsWith("data: [DONE]\n\n")).toBe(true);
		expect(frames.filter((f) => f === "data: [DONE]")).toHaveLength(1);
		expect(frames).toContain(": ping");

		for (const c of chunks) {
			expect(c.id).toBe("chatcmpl-1");
			expect(c.object).toBe("chat.completion.chunk");
			expect(c.created).toBe(1_700_000_000);
			expect(c.model).toBe("gpt-4o");
			expect(c.choices[0]?.index).toBe(0);
			expect(c.choices[0]?.logprobs).toBeNull();
		}
		expect(chunks[0]?.choices[0]?.delta).toEqual({
			role: "assistant",
			content: "",
		});
		expect(contentOf(chunks)).toBe("Hello, world");

		const last = chunks[chunks.length - 1];
		expect(last?.choices[0]?.delta).toEqual({});
		expect(last?.choices[0]?.finish_reason).toBe("stop");
		// Only the final chunk carries a finish_reason.
		expect(
			chunks.slice(0, -1).every((c) => c.choices[0]?.finish_reason === null),
		).toBe(true);
	});

	test("every frame is exactly `data: <json>` or the ping comment", async () => {
		const { raw } = await run(upstreamFrom(plainText));
		for (const f of raw.split("\n\n").filter((x) => x !== "")) {
			expect(f.startsWith("data: ") || f === ": ping").toBe(true);
			expect(f).not.toContain("\n");
		}
	});

	test("7-byte chunks and CRLF line endings give the same frames", async () => {
		const whole = await run(upstreamFrom(plainText));
		const split = await run(upstreamFrom(plainText, 7));
		const crlf = await run(upstreamFrom(plainText.replace(/\n/g, "\r\n"), 7));
		expect(split.raw).toBe(whole.raw);
		expect(crlf.raw).toBe(whole.raw);
	});

	test("a multi-byte character split across chunks survives", async () => {
		const text = sse([
			start(),
			textStart(0),
			textDelta(0, "café \u{1F600} 中"),
			blockStop(0),
			messageDelta("end_turn", 3),
			messageStop,
		]);
		// Every chunk size from 1 to 5 bytes cuts at least one code point.
		for (const size of [1, 2, 3, 5]) {
			const { chunks, errors } = await run(upstreamFrom(text, size));
			expect(errors).toEqual([]);
			expect(contentOf(chunks)).toBe("café \u{1F600} 中");
		}
	});

	test("multiple data lines are joined with a newline; comments ignored", async () => {
		const payload = JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "joined" },
		});
		// Split the JSON across two data lines at a point where a newline is
		// legal JSON whitespace.
		const cut = payload.indexOf(",");
		const event = `: a comment\nevent: content_block_delta\ndata: ${payload.slice(0, cut)}\ndata: ${payload.slice(cut)}\n\n`;
		const text =
			sse([start(), textStart(0)]) +
			event +
			sse([blockStop(0), messageDelta("end_turn", 1), messageStop]);
		const { chunks, errors } = await run(upstreamFrom(text));
		expect(errors).toEqual([]);
		expect(contentOf(chunks)).toBe("joined");

		// CRLF delivered one byte at a time splits every CR from its LF. A CR
		// read as a line break on its own would end the event between the two
		// data lines and lose both halves.
		const crlf = await run(upstreamFrom(text.replace(/\n/g, "\r\n"), 1));
		expect(crlf.errors).toEqual([]);
		expect(contentOf(crlf.chunks)).toBe("joined");
	});

	test("thinking then text", async () => {
		const text = sse([
			start(),
			[
				"content_block_start",
				{
					type: "content_block_start",
					index: 0,
					content_block: { type: "thinking", thinking: "" },
				},
			],
			[
				"content_block_delta",
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "thinking_delta", thinking: "Let me " },
				},
			],
			[
				"content_block_delta",
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "thinking_delta", thinking: "think." },
				},
			],
			[
				"content_block_delta",
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "signature_delta", signature: "SIGNATURE" },
				},
			],
			blockStop(0),
			textStart(1),
			textDelta(1, "Answer"),
			blockStop(1),
			messageDelta("end_turn", 9),
			messageStop,
		]);
		const { raw, chunks, errors } = await run(upstreamFrom(text));
		expect(errors).toEqual([]);
		expect(
			chunks.map((c) => c.choices[0]?.delta.reasoning_content ?? "").join(""),
		).toBe("Let me think.");
		expect(contentOf(chunks)).toBe("Answer");
		expect(raw).not.toContain("SIGNATURE");
	});

	test("two parallel tool calls with interleaved argument fragments", async () => {
		const toolStart = (
			index: number,
			id: string,
			name: string,
		): [string, unknown] => [
			"content_block_start",
			{
				type: "content_block_start",
				index,
				content_block: { type: "tool_use", id, name, input: {} },
			},
		];
		const json = (index: number, partial_json: string): [string, unknown] => [
			"content_block_delta",
			{
				type: "content_block_delta",
				index,
				delta: { type: "input_json_delta", partial_json },
			},
		];
		const inputA = { city: "Valletta", days: 3 };
		const inputB = { query: "weather été", tags: ["a", "b"] };
		const a = JSON.stringify(inputA);
		const b = JSON.stringify(inputB);
		const text = sse([
			start(),
			textStart(0),
			textDelta(0, "Calling tools."),
			blockStop(0),
			toolStart(1, "toolu_A", "get_weather"),
			toolStart(2, "toolu_B", "search"),
			json(1, a.slice(0, 5)),
			json(2, b.slice(0, 9)),
			json(1, a.slice(5, 14)),
			json(2, b.slice(9)),
			json(1, a.slice(14)),
			blockStop(1),
			blockStop(2),
			messageDelta("tool_use", 40),
			messageStop,
		]);
		const { chunks, errors } = await run(upstreamFrom(text, 7));
		expect(errors).toEqual([]);

		const starts = chunks
			.flatMap((c) => c.choices[0]?.delta.tool_calls ?? [])
			.filter((t) => t.id !== undefined);
		expect(starts).toEqual([
			{
				index: 0,
				id: "toolu_A",
				type: "function",
				function: { name: "get_weather", arguments: "" },
			},
			{
				index: 1,
				id: "toolu_B",
				type: "function",
				function: { name: "search", arguments: "" },
			},
		]);

		const args = new Map<number, string>();
		for (const c of chunks) {
			for (const t of c.choices[0]?.delta.tool_calls ?? []) {
				args.set(
					t.index,
					(args.get(t.index) ?? "") + (t.function?.arguments ?? ""),
				);
			}
		}
		expect([...args.keys()].sort()).toEqual([0, 1]);
		expect(JSON.parse(args.get(0) ?? "")).toEqual(inputA);
		expect(JSON.parse(args.get(1) ?? "")).toEqual(inputB);

		const last = chunks[chunks.length - 1];
		expect(last?.choices[0]?.finish_reason).toBe("tool_calls");
	});

	test("include_usage on: usage null on earlier chunks, then a usage-only chunk", async () => {
		const text = sse([
			start({
				input_tokens: 100,
				cache_read_input_tokens: 1000,
				cache_creation_input_tokens: 200,
			}),
			textStart(0),
			textDelta(0, "hi"),
			blockStop(0),
			messageDelta("max_tokens", 50),
			messageStop,
		]);
		const { raw, chunks } = await run(upstreamFrom(text), true);
		const final = chunks[chunks.length - 1];
		expect(final?.choices).toEqual([]);
		expect(final?.usage).toEqual({
			prompt_tokens: 1300,
			completion_tokens: 50,
			total_tokens: 1350,
			prompt_tokens_details: { cached_tokens: 1000 },
		});
		const earlier = chunks.slice(0, -1);
		expect(earlier.length).toBeGreaterThan(1);
		for (const c of earlier) {
			expect("usage" in c).toBe(true);
			expect(c.usage).toBeNull();
		}
		expect(earlier[earlier.length - 1]?.choices[0]?.finish_reason).toBe(
			"length",
		);
		expect(raw.endsWith("data: [DONE]\n\n")).toBe(true);
	});

	test("include_usage off: no chunk has a usage key", async () => {
		const { raw, chunks } = await run(upstreamFrom(plainText), false);
		expect(chunks.length).toBeGreaterThan(0);
		for (const c of chunks) expect("usage" in c).toBe(false);
		expect(raw).not.toContain('"usage"');
	});

	test("an upstream error event becomes an OpenAI error frame, then [DONE]", async () => {
		const text = sse([
			start(),
			textStart(0),
			textDelta(0, "partial"),
			[
				"error",
				{
					type: "error",
					error: { type: "overloaded_error", message: "Overloaded" },
				},
			],
			// Anything after the error must not be translated.
			textDelta(0, "AFTER"),
			messageStop,
		]);
		const { raw, frames, chunks, errors } = await run(upstreamFrom(text));
		expect(errors).toEqual([
			{
				error: {
					message: "Overloaded",
					type: "overloaded_error",
					param: null,
					code: "overloaded_error",
				},
			},
		]);
		expect(frames[frames.length - 1]).toBe("data: [DONE]");
		expect(raw).not.toContain("AFTER");
		expect(chunks.every((c) => c.choices[0]?.finish_reason === null)).toBe(
			true,
		);
	});

	test("a stream that ends without message_stop gives an error, never a finish_reason", async () => {
		const text = sse([
			start(),
			textStart(0),
			textDelta(0, "cut off"),
			messageDelta("end_turn", 2),
		]);
		const { frames, chunks, errors } = await run(upstreamFrom(text, 7), true);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.error.message).toContain("ended early");
		expect(frames[frames.length - 1]).toBe("data: [DONE]");
		expect(
			chunks.every((c) => c.choices.every((ch) => ch.finish_reason === null)),
		).toBe(true);
		// No usage-only chunk either: that belongs to a completed stream.
		expect(chunks.every((c) => c.choices.length === 1)).toBe(true);
	});

	test("message_stop with no stop_reason from any message_delta finishes with stop", async () => {
		const text = sse([
			start(),
			textStart(0),
			textDelta(0, "done"),
			blockStop(0),
			messageStop,
		]);
		const { chunks, errors } = await run(upstreamFrom(text));
		expect(errors).toEqual([]);
		const last = chunks[chunks.length - 1];
		expect(last?.choices[0]?.delta).toEqual({});
		expect(last?.choices[0]?.finish_reason).toBe("stop");
	});

	test("a final event with no trailing blank line is still handled", async () => {
		const text = plainText.replace(/\n\n$/, "\n");
		const { chunks, errors } = await run(upstreamFrom(text));
		expect(errors).toEqual([]);
		expect(chunks[chunks.length - 1]?.choices[0]?.finish_reason).toBe("stop");
	});

	test("cancelling the output cancels the upstream", async () => {
		let cancelledWith: unknown = "not cancelled";
		let pulls = 0;
		const upstream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse([start(), textStart(0)])));
			},
			pull(controller) {
				pulls++;
				// Keep producing text deltas forever; never message_stop.
				controller.enqueue(encoder.encode(sse([textDelta(0, "x")])));
			},
			cancel(reason) {
				cancelledWith = reason;
			},
		});
		const out = translateAnthropicStreamToChat(upstream, {
			id: "chatcmpl-1",
			created: 1,
			model: "m",
			includeUsage: false,
		});
		const reader = out.getReader();
		const first = await reader.read();
		expect(first.done).toBe(false);
		await reader.read();
		await reader.cancel("client went away");
		expect(cancelledWith).toBe("client went away");
		expect(pulls).toBeGreaterThan(0);
	});
});
