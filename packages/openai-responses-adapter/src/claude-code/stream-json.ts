/**
 * Parser for `claude -p --output-format stream-json --verbose
 * --include-partial-messages` output: one JSON object per stdout line.
 *
 * ASSUMPTIONS (the CLI's wire format is not a published contract, and this
 * code has only been exercised against a fake):
 *   {"type":"system","subtype":"init","session_id":"…"}
 *   {"type":"stream_event","event":<Anthropic SSE event>}; text arrives as
 *     event.type "content_block_delta" with delta.type "text_delta"
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"…"}]}}
 *   {"type":"result","subtype":"success"|"error_…","is_error":bool,
 *     "result":"…","session_id":"…","usage":{input_tokens,output_tokens,
 *     cache_read_input_tokens,cache_creation_input_tokens}}
 * Anything else, and any field of the wrong type, is ignored rather than
 * treated as an error.
 */
export interface ClaudeCodeUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheCreation: number;
}

export type ClaudeStreamEvent =
	| { kind: "init"; sessionId: string | null }
	| { kind: "text-block-start" }
	| { kind: "partial-text"; text: string }
	| { kind: "assistant-text"; text: string }
	| {
			kind: "result";
			isError: boolean;
			text: string | null;
			sessionId: string | null;
			usage: ClaudeCodeUsage | null;
	  }
	| { kind: "ignored" };

function str(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function parseUsage(value: unknown): ClaudeCodeUsage | null {
	const usage = asRecord(value);
	if (!usage) return null;
	return {
		input: num(usage.input_tokens),
		output: num(usage.output_tokens),
		cacheRead: num(usage.cache_read_input_tokens),
		cacheCreation: num(usage.cache_creation_input_tokens),
	};
}

/** Returns null for a blank or non-JSON line. */
export function parseStreamJsonLine(line: string): ClaudeStreamEvent | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	const event = asRecord(parsed);
	if (!event) return null;

	switch (event.type) {
		case "system":
			return event.subtype === "init"
				? { kind: "init", sessionId: str(event.session_id) }
				: { kind: "ignored" };
		case "stream_event": {
			const inner = asRecord(event.event);
			if (!inner) return { kind: "ignored" };
			if (inner.type === "content_block_start") {
				return asRecord(inner.content_block)?.type === "text"
					? { kind: "text-block-start" }
					: { kind: "ignored" };
			}
			if (inner.type === "content_block_delta") {
				const delta = asRecord(inner.delta);
				const text = delta?.type === "text_delta" ? str(delta.text) : null;
				return text ? { kind: "partial-text", text } : { kind: "ignored" };
			}
			return { kind: "ignored" };
		}
		case "assistant": {
			const content = asRecord(event.message)?.content;
			if (!Array.isArray(content)) return { kind: "ignored" };
			const text = content
				.map((block) => {
					const b = asRecord(block);
					return b?.type === "text" ? (str(b.text) ?? "") : "";
				})
				.join("");
			return text ? { kind: "assistant-text", text } : { kind: "ignored" };
		}
		case "result":
			return {
				kind: "result",
				isError:
					event.is_error === true ||
					(typeof event.subtype === "string" &&
						event.subtype.startsWith("error")),
				text: typeof event.result === "string" ? event.result : null,
				sessionId: str(event.session_id),
				usage: parseUsage(event.usage),
			};
		default:
			return { kind: "ignored" };
	}
}
