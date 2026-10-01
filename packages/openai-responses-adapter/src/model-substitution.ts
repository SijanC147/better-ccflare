/**
 * Tells an OpenAI client which model answered when it is not the one it asked
 * for (SB23-2781).
 *
 * A gateway request for `claude-opus-5-5` that every Claude account refuses
 * can fail over to Codex and be answered by `gpt-5.6-sol`. The body's `model`
 * already says so (REPORT_UPSTREAM_MODEL_HEADER); this adds
 * `MODEL_SUBSTITUTED_HEADER: <requested> -> <answered>` so a client can see the
 * substitution without parsing the body, and before the first chunk of a
 * stream. The substitution itself is not refused: the family fallback that
 * produces it is a feature.
 */
import { MODEL_SUBSTITUTED_HEADER } from "@better-ccflare/types";

/**
 * A dated snapshot or `-latest` alias names the same model: Anthropic answers
 * a request for `claude-sonnet-4-5` as `claude-sonnet-4-5-20250929`, OpenAI
 * dates its snapshots `gpt-5.5-2026-09-01`, and neither is a substitution.
 */
const SAME_MODEL_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2}|latest)$/;

function baseModel(model: string): string {
	return model.replace(SAME_MODEL_SUFFIX, "");
}

/**
 * The header value, or null when the answering model is the one asked for.
 *
 * `requested` is the client's own name for the model. `routed` is the id the
 * gateway sent upstream after its model set mapped that name (the same as
 * `requested` without a model set); an answer from it is the operator's
 * configuration, not a substitution. An answer that names no model is not
 * evidence of one either.
 */
export function modelSubstitution(
	requested: string | null | undefined,
	routed: string | null | undefined,
	answered: unknown,
): string | null {
	if (typeof answered !== "string" || answered.length === 0) return null;
	if (typeof requested !== "string" || requested.length === 0) return null;
	const answeredBase = baseModel(answered);
	for (const asked of [requested, routed]) {
		if (typeof asked === "string" && baseModel(asked) === answeredBase) {
			return null;
		}
	}
	return `${requested} -> ${answered}`;
}

/** The substitution as response headers: empty when there is none. */
export function substitutionHeaders(
	substitution: string | null,
): Record<string, string> {
	return substitution ? { [MODEL_SUBSTITUTED_HEADER]: substitution } : {};
}

/**
 * What a peek reads out of one SSE event: a model to stop on, null to stop
 * without one, or undefined to keep reading.
 */
export type SseModelPick = (
	event: Record<string, unknown>,
) => string | null | undefined;

/** Anthropic Messages: `message_start` is the first event and names the model. */
export const anthropicMessageStartModel: SseModelPick = (event) => {
	if (event.type !== "message_start") return undefined;
	const message = event.message as { model?: unknown } | undefined;
	return typeof message?.model === "string" && message.model.length > 0
		? message.model
		: null;
};

/** OpenAI Responses: `response.created` is the first event and names the model. */
export const responsesCreatedModel: SseModelPick = (event) => {
	if (event.type !== "response.created") return undefined;
	const response = event.response as { model?: unknown } | undefined;
	return typeof response?.model === "string" && response.model.length > 0
		? response.model
		: null;
};

/** Enough for any first event; past it the stream goes out without a header. */
const PEEK_MAX_BYTES = 64 * 1024;

/**
 * Reads an SSE body until `pick` names the answering model, so the response
 * headers can carry it, and returns a body that replays every byte read.
 * Bounded: it stops at `maxBytes` or at the end of the stream and reports no
 * model, so a stream whose first event is late or absent is never held back
 * by more than that.
 */
export async function peekSseModel(
	body: ReadableStream<Uint8Array>,
	pick: SseModelPick,
	maxBytes = PEEK_MAX_BYTES,
): Promise<{ model: string | null; body: ReadableStream<Uint8Array> }> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const buffered: Uint8Array[] = [];
	let text = "";
	let bytes = 0;
	let model: string | null = null;
	let done = false;
	let failure: unknown = null;

	try {
		scan: while (bytes < maxBytes) {
			const read = await reader.read();
			if (read.done) {
				done = true;
				break;
			}
			buffered.push(read.value);
			bytes += read.value.byteLength;
			text += decoder.decode(read.value, { stream: true });
			// Only complete lines are parsed; the tail waits for the next chunk.
			const lines = text.split("\n");
			text = lines.pop() ?? "";
			for (const line of lines) {
				const data = line.startsWith("data:") ? line.slice(5).trim() : null;
				if (!data || data === "[DONE]") continue;
				let event: unknown;
				try {
					event = JSON.parse(data);
				} catch {
					continue;
				}
				if (event === null || typeof event !== "object") continue;
				const picked = pick(event as Record<string, unknown>);
				if (picked === undefined) continue;
				model = picked;
				break scan;
			}
		}
	} catch (err) {
		// Replayed to the reader of the returned body, after the bytes read.
		failure = err;
	}

	let index = 0;
	const replay = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (index < buffered.length) {
				controller.enqueue(buffered[index++]);
				return;
			}
			if (failure !== null) {
				controller.error(failure);
				return;
			}
			if (done) {
				controller.close();
				return;
			}
			try {
				const read = await reader.read();
				if (read.done) controller.close();
				else controller.enqueue(read.value);
			} catch (err) {
				controller.error(err);
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
	return { model, body: replay };
}
