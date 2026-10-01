import type { ChatCompletionChunk } from "../chat/types";
import { toCompletionFinishReason } from "./response-translator";
import type { TextCompletion } from "./types";

const encoder = new TextEncoder();

function frame(payload: unknown): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function isChatChunk(value: unknown): value is ChatCompletionChunk {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { object?: unknown }).object === "chat.completion.chunk"
	);
}

/**
 * Reshapes the chat core's own SSE output into legacy completion chunks
 * (SB23-1970). It never reads the Anthropic stream: the chat translator
 * already did that once, and a second parser would drift from it.
 *
 * Per frame of the chat stream:
 * - a chunk with a choice becomes `{object: "text_completion", choices:
 *   [{text, index, logprobs, finish_reason}]}`; a chunk with no text and no
 *   finish reason (the role chunk, reasoning or tool-call deltas) is dropped,
 *   since this shape has nowhere to put it;
 * - the usage-only chunk keeps `choices: []` and its `usage`;
 * - anything else (an error frame, `[DONE]`, a `: ping` comment) passes
 *   through byte for byte.
 *
 * With `echo`, the prompt is sent as the first chunk, ahead of the first
 * chunk the chat stream produces.
 */
export function chatStreamToCompletionStream(
	chatStream: ReadableStream<Uint8Array>,
	echo: string | null,
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	let buffer = "";
	let echoPending = echo !== null && echo !== "";

	const translateFrame = (
		raw: string,
		controller: TransformStreamDefaultController<Uint8Array>,
	): void => {
		const dataLines = raw
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart());
		const data = dataLines.join("\n");
		let parsed: unknown;
		try {
			parsed = dataLines.length > 0 ? JSON.parse(data) : undefined;
		} catch {
			parsed = undefined;
		}
		if (!isChatChunk(parsed)) {
			controller.enqueue(encoder.encode(`${raw}\n\n`));
			return;
		}
		const base: Omit<TextCompletion, "choices"> = {
			id: parsed.id,
			object: "text_completion",
			created: parsed.created,
			model: parsed.model,
		};
		const usage =
			parsed.usage === undefined ? {} : { usage: parsed.usage ?? null };
		if (echoPending) {
			echoPending = false;
			controller.enqueue(
				frame({
					...base,
					choices: [
						{ text: echo, index: 0, logprobs: null, finish_reason: null },
					],
					...(parsed.usage === undefined ? {} : { usage: null }),
				}),
			);
		}
		const choice = parsed.choices[0];
		if (!choice) {
			controller.enqueue(frame({ ...base, choices: [], ...usage }));
			return;
		}
		const text =
			typeof choice.delta.content === "string" ? choice.delta.content : "";
		const finishReason = toCompletionFinishReason(choice.finish_reason);
		if (text === "" && finishReason === null) return;
		controller.enqueue(
			frame({
				...base,
				choices: [
					{ text, index: 0, logprobs: null, finish_reason: finishReason },
				],
				...usage,
			}),
		);
	};

	const drain = (
		controller: TransformStreamDefaultController<Uint8Array>,
	): void => {
		let end = buffer.indexOf("\n\n");
		while (end !== -1) {
			const raw = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			if (raw !== "") translateFrame(raw, controller);
			end = buffer.indexOf("\n\n");
		}
	};

	return chatStream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffer += decoder.decode(chunk, { stream: true });
				drain(controller);
			},
			flush(controller) {
				buffer += decoder.decode();
				drain(controller);
				if (buffer.trim() !== "") translateFrame(buffer, controller);
				buffer = "";
			},
		}),
	);
}
