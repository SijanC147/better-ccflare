import type {
	AnthropicMessageResponse,
	ChatCompletion,
	ChatFinishReason,
	ChatToolCall,
	ChatUsage,
	OpenAIErrorBody,
	ResponseTranslationContext,
} from "./types";

const STOP_REASONS: Record<string, ChatFinishReason> = {
	end_turn: "stop",
	stop_sequence: "stop",
	max_tokens: "length",
	model_context_window_exceeded: "length",
	tool_use: "tool_calls",
	refusal: "content_filter",
	pause_turn: "stop",
};

export function mapStopReason(
	reason: string | null | undefined,
): ChatFinishReason | null {
	if (reason === null || reason === undefined) return null;
	return STOP_REASONS[reason] ?? "stop";
}

/**
 * OpenAI's `prompt_tokens` includes cached tokens; Anthropic reports them
 * separately, so both cache counts are added back in.
 */
export function buildChatUsage(u: {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
}): ChatUsage {
	const cacheRead = u.cache_read_input_tokens ?? 0;
	const prompt =
		(u.input_tokens ?? 0) + cacheRead + (u.cache_creation_input_tokens ?? 0);
	const completion = u.output_tokens ?? 0;
	return {
		prompt_tokens: prompt,
		completion_tokens: completion,
		total_tokens: prompt + completion,
		prompt_tokens_details: { cached_tokens: cacheRead },
	};
}

export function translateAnthropicMessageToChat(
	msg: AnthropicMessageResponse,
	ctx: ResponseTranslationContext,
): ChatCompletion {
	let text = "";
	let hasText = false;
	let reasoning = "";
	let hasReasoning = false;
	const toolCalls: ChatToolCall[] = [];

	for (const block of msg.content ?? []) {
		if (block.type === "text" && typeof block.text === "string") {
			text += block.text;
			hasText = true;
		} else if (
			block.type === "thinking" &&
			typeof block.thinking === "string"
		) {
			reasoning += block.thinking;
			hasReasoning = true;
		} else if (block.type === "tool_use") {
			const tool = block as { id: string; name: string; input: unknown };
			toolCalls.push({
				id: tool.id,
				type: "function",
				function: {
					name: tool.name,
					arguments: JSON.stringify(tool.input ?? {}),
				},
			});
		}
		// redacted_thinking and unknown block types are dropped.
	}

	const message: ChatCompletion["choices"][number]["message"] = {
		role: "assistant",
		content: hasText ? text : toolCalls.length > 0 ? null : "",
		refusal: null,
	};
	if (toolCalls.length > 0) message.tool_calls = toolCalls;
	if (hasReasoning) message.reasoning_content = reasoning;

	return {
		id: ctx.id,
		object: "chat.completion",
		created: ctx.created,
		model: ctx.model,
		choices: [
			{
				index: 0,
				message,
				// A completed message always carries a finish_reason, even when
				// upstream reported no stop_reason.
				finish_reason: mapStopReason(msg.stop_reason) ?? "stop",
				logprobs: null,
			},
		],
		usage: buildChatUsage(msg.usage ?? {}),
	};
}

function defaultErrorType(status: number): string {
	switch (status) {
		case 400:
		case 413:
			return "invalid_request_error";
		case 401:
			return "authentication_error";
		case 403:
			return "permission_error";
		case 404:
			return "not_found_error";
		case 429:
			return "rate_limit_error";
		default:
			return status >= 500 ? "api_error" : "invalid_request_error";
	}
}

const MAX_TEXT_MESSAGE = 500;

function nonEmptyString(v: unknown): string | null {
	return typeof v === "string" && v.trim() !== "" ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Normalise any upstream error body into the OpenAI error shape. Accepts an
 * Anthropic error envelope, an OpenAI envelope, a bare string (an HTML page
 * from an intermediary, say), or anything else. Never returns an empty message.
 */
export function toOpenAIError(status: number, body: unknown): OpenAIErrorBody {
	const fallbackMessage = `Upstream returned HTTP ${status}`;
	let message: string | null = null;
	let type: string | null = null;
	let code: string | null = null;
	let param: string | null = null;

	if (typeof body === "string") {
		const collapsed = body.replace(/\s+/g, " ").trim();
		message = collapsed === "" ? null : collapsed.slice(0, MAX_TEXT_MESSAGE);
	} else if (isRecord(body) && isRecord(body.error)) {
		// Anthropic `{type:"error", error:{type, message}}` and OpenAI
		// `{error:{message, type, code, param}}` share the inner shape.
		const e = body.error;
		message = nonEmptyString(e.message);
		type = nonEmptyString(e.type);
		code =
			typeof e.code === "string" || typeof e.code === "number"
				? String(e.code)
				: null;
		param = nonEmptyString(e.param);
	} else if (isRecord(body)) {
		message = nonEmptyString(body.message);
		type = nonEmptyString(body.type);
	}

	return {
		error: {
			message: message ?? fallbackMessage,
			type: type ?? defaultErrorType(status),
			param,
			code: code ?? type ?? null,
		},
	};
}
