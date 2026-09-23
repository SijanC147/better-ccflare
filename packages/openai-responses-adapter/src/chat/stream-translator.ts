import {
	buildChatUsage,
	mapStopReason,
	toOpenAIError,
} from "./response-translator";
import type {
	ChatCompletionChunk,
	ChatFinishReason,
	OpenAIErrorBody,
	StreamTranslationContext,
} from "./types";

type Delta = ChatCompletionChunk["choices"][number]["delta"];

interface State {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	stopReason: string | null;
	nextToolIndex: number;
	/** Anthropic content-block index to OpenAI tool_calls index. */
	toolIndexByBlock: Map<number, number>;
	finished: boolean;
	/** Frames enqueued so far; `pull` loops until it rises or the stream ends. */
	emitted: number;
}

const encoder = new TextEncoder();

function frame(data: unknown): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

const DONE = encoder.encode("data: [DONE]\n\n");
const PING = encoder.encode(": ping\n\n");

/**
 * Translate an Anthropic Messages SSE stream into an OpenAI Chat Completions
 * SSE stream. Each output frame is `data: <json>\n\n`, terminated by
 * `data: [DONE]\n\n`. A stream that ends without `message_stop` produces an
 * error frame rather than an invented `finish_reason`.
 */
export function translateAnthropicStreamToChat(
	upstream: ReadableStream<Uint8Array>,
	ctx: StreamTranslationContext,
): ReadableStream<Uint8Array> {
	const reader = upstream.getReader();
	const decoder = new TextDecoder();
	const state: State = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		stopReason: null,
		nextToolIndex: 0,
		toolIndexByBlock: new Map(),
		finished: false,
		emitted: 0,
	};
	let buffer = "";

	const emit = (
		controller: ReadableStreamDefaultController<Uint8Array>,
		bytes: Uint8Array,
	): void => {
		state.emitted++;
		controller.enqueue(bytes);
	};

	const chunk = (
		delta: Delta,
		finishReason: ChatFinishReason | null = null,
	): Uint8Array => {
		const body: ChatCompletionChunk = {
			id: ctx.id,
			object: "chat.completion.chunk",
			created: ctx.created,
			model: ctx.model,
			choices: [
				{ index: 0, delta, finish_reason: finishReason, logprobs: null },
			],
		};
		if (ctx.includeUsage) body.usage = null;
		return frame(body);
	};

	const usage = () =>
		buildChatUsage({
			input_tokens: state.inputTokens,
			output_tokens: state.outputTokens,
			cache_read_input_tokens: state.cacheReadTokens,
			cache_creation_input_tokens: state.cacheCreationTokens,
		});

	const finishWithError = (
		controller: ReadableStreamDefaultController<Uint8Array>,
		error: OpenAIErrorBody,
	): void => {
		state.finished = true;
		emit(controller, frame(error));
		emit(controller, DONE);
		controller.close();
		reader.cancel().catch(() => {});
	};

	/** Returns true when the stream has been closed. */
	const handleEvent = (
		controller: ReadableStreamDefaultController<Uint8Array>,
		eventName: string | null,
		data: string,
	): boolean => {
		let event: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(data);
			if (typeof parsed !== "object" || parsed === null) return false;
			event = parsed as Record<string, unknown>;
		} catch {
			return false;
		}
		const type = typeof event.type === "string" ? event.type : eventName;

		switch (type) {
			case "message_start": {
				const message = event.message as
					| { usage?: Record<string, number | null | undefined> }
					| undefined;
				const u = message?.usage ?? {};
				state.inputTokens = u.input_tokens ?? 0;
				state.outputTokens = u.output_tokens ?? 0;
				state.cacheReadTokens = u.cache_read_input_tokens ?? 0;
				state.cacheCreationTokens = u.cache_creation_input_tokens ?? 0;
				emit(controller, chunk({ role: "assistant", content: "" }));
				return false;
			}
			case "content_block_start": {
				const block = event.content_block as
					| { type?: string; id?: string; name?: string }
					| undefined;
				if (block?.type !== "tool_use") return false;
				const toolIndex = state.nextToolIndex++;
				state.toolIndexByBlock.set(Number(event.index), toolIndex);
				emit(
					controller,
					chunk({
						tool_calls: [
							{
								index: toolIndex,
								id: block.id ?? "",
								type: "function",
								function: { name: block.name ?? "", arguments: "" },
							},
						],
					}),
				);
				return false;
			}
			case "content_block_delta": {
				const delta = event.delta as
					| {
							type?: string;
							text?: string;
							thinking?: string;
							partial_json?: string;
					  }
					| undefined;
				if (delta?.type === "text_delta" && typeof delta.text === "string") {
					emit(controller, chunk({ content: delta.text }));
				} else if (
					delta?.type === "thinking_delta" &&
					typeof delta.thinking === "string"
				) {
					emit(controller, chunk({ reasoning_content: delta.thinking }));
				} else if (
					delta?.type === "input_json_delta" &&
					typeof delta.partial_json === "string"
				) {
					const toolIndex = state.toolIndexByBlock.get(Number(event.index));
					if (toolIndex === undefined) return false;
					emit(
						controller,
						chunk({
							tool_calls: [
								{
									index: toolIndex,
									function: { arguments: delta.partial_json },
								},
							],
						}),
					);
				}
				// signature_delta and unknown deltas are ignored.
				return false;
			}
			case "message_delta": {
				const delta = event.delta as
					| { stop_reason?: string | null }
					| undefined;
				if (delta && "stop_reason" in delta) {
					state.stopReason = delta.stop_reason ?? null;
				}
				const u = event.usage as { output_tokens?: number } | undefined;
				if (typeof u?.output_tokens === "number") {
					state.outputTokens = u.output_tokens;
				}
				return false;
			}
			case "message_stop": {
				state.finished = true;
				// message_stop means the message completed, so it always carries a
				// finish_reason even when no message_delta supplied a stop_reason.
				emit(controller, chunk({}, mapStopReason(state.stopReason) ?? "stop"));
				if (ctx.includeUsage) {
					const final: ChatCompletionChunk = {
						id: ctx.id,
						object: "chat.completion.chunk",
						created: ctx.created,
						model: ctx.model,
						choices: [],
						usage: usage(),
					};
					emit(controller, frame(final));
				}
				emit(controller, DONE);
				controller.close();
				reader.cancel().catch(() => {});
				return true;
			}
			case "ping":
				emit(controller, PING);
				return false;
			case "error":
				finishWithError(controller, toOpenAIError(500, event));
				return true;
			default:
				return false;
		}
	};

	/** Parse one raw SSE event block. Returns true when the stream closed. */
	const handleBlock = (
		controller: ReadableStreamDefaultController<Uint8Array>,
		block: string,
	): boolean => {
		let eventName: string | null = null;
		const dataLines: string[] = [];
		for (const line of block.split("\n")) {
			if (line === "" || line.startsWith(":")) continue;
			const colon = line.indexOf(":");
			const field = colon === -1 ? line : line.slice(0, colon);
			let value = colon === -1 ? "" : line.slice(colon + 1);
			if (value.startsWith(" ")) value = value.slice(1);
			if (field === "data") dataLines.push(value);
			else if (field === "event") eventName = value;
		}
		if (dataLines.length === 0) return false;
		return handleEvent(controller, eventName, dataLines.join("\n"));
	};

	/** Drain every complete event in the buffer. Returns true when closed. */
	const drain = (
		controller: ReadableStreamDefaultController<Uint8Array>,
		final = false,
	): boolean => {
		// A trailing CR may be the first half of a CRLF split across chunks;
		// hold it back so it does not become a lone line break.
		const heldCr = !final && buffer.endsWith("\r");
		const body = heldCr ? buffer.slice(0, -1) : buffer;
		buffer = body.replace(/\r\n?/g, "\n") + (heldCr ? "\r" : "");
		let boundary = buffer.indexOf("\n\n");
		while (boundary !== -1) {
			const block = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			if (handleBlock(controller, block)) return true;
			boundary = buffer.indexOf("\n\n");
		}
		return false;
	};

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			// A pull that enqueues nothing is not re-invoked, so keep reading
			// until at least one frame is out or the stream has closed.
			const before = state.emitted;
			while (!state.finished && state.emitted === before) {
				let result: Awaited<ReturnType<typeof reader.read>>;
				try {
					result = await reader.read();
				} catch (err) {
					if (state.finished) return;
					finishWithError(
						controller,
						toOpenAIError(
							502,
							`Upstream stream failed: ${err instanceof Error ? err.message : String(err)}`,
						),
					);
					return;
				}
				if (state.finished) return;
				if (result.done) {
					buffer += decoder.decode();
					if (drain(controller, true)) return;
					// A final event with no trailing blank line still counts.
					if (buffer.trim() !== "" && handleBlock(controller, buffer)) return;
					finishWithError(
						controller,
						toOpenAIError(
							502,
							"Upstream stream ended early, before message_stop; the response is incomplete",
						),
					);
					return;
				}
				buffer += decoder.decode(result.value, { stream: true });
				if (drain(controller)) return;
			}
		},
		async cancel(reason) {
			state.finished = true;
			await reader.cancel(reason).catch(() => {});
		},
	});
}
