import type { ChatCompletionRequest, ChatRequestError } from "../chat/types";
import {
	type CompletionRequest,
	DEFAULT_COMPLETION_MAX_TOKENS,
	type TranslateCompletionResult,
} from "./types";

function isSet(value: unknown): boolean {
	return value !== undefined && value !== null;
}

function refuse(
	param: string | null,
	code: string,
	message: string,
): TranslateCompletionResult {
	const error: ChatRequestError = {
		status: 400,
		message,
		type: "invalid_request_error",
		param,
		code,
	};
	return { ok: false, error };
}

/**
 * The legacy Completions body as a Chat Completions body: the prompt becomes
 * the single `user` turn. Everything the chat translator already validates
 * (model, max_tokens, temperature, top_p, stop, n, user, stream_options) is
 * passed through for it to validate, so the two paths cannot disagree. What
 * only exists on this API is decided here, and anything that cannot be
 * honoured whole is refused rather than partly honoured.
 */
export function translateCompletionRequestToChat(
	req: CompletionRequest,
): TranslateCompletionResult {
	const { prompt } = req;
	if (!isSet(prompt)) {
		return refuse(
			"prompt",
			"missing_required_parameter",
			"prompt is required.",
		);
	}
	if (Array.isArray(prompt)) {
		return refuse(
			"prompt",
			"unsupported_value",
			"prompt must be a single string. Arrays of strings and token arrays are not supported: each array element is a separate completion, and this endpoint returns one.",
		);
	}
	if (typeof prompt !== "string") {
		return refuse("prompt", "invalid_type", "prompt must be a string.");
	}
	// OpenAI completes an empty prompt from the start of a document; Anthropic
	// refuses an empty user turn, so there is nothing to send.
	if (prompt.trim() === "") {
		return refuse(
			"prompt",
			"invalid_value",
			"prompt must contain text other than whitespace.",
		);
	}
	if (typeof req.suffix === "string" && req.suffix !== "") {
		return refuse(
			"suffix",
			"unsupported_value",
			"suffix (insertion) is not supported.",
		);
	}
	if (isSet(req.best_of) && req.best_of !== 1) {
		return refuse(
			"best_of",
			"unsupported_value",
			"Only best_of = 1 is supported.",
		);
	}
	// An integer here, so 0 is a request for log probabilities too.
	if (isSet(req.logprobs)) {
		return refuse(
			"logprobs",
			"unsupported_value",
			"logprobs is not supported.",
		);
	}

	const chat: ChatCompletionRequest = {
		model: req.model,
		messages: [{ role: "user", content: prompt }],
		max_tokens: isSet(req.max_tokens)
			? req.max_tokens
			: DEFAULT_COMPLETION_MAX_TOKENS,
	};
	const passed: Record<string, unknown> = chat;
	for (const key of [
		"stream",
		"stream_options",
		"temperature",
		"top_p",
		"stop",
		"n",
		"user",
	] as const) {
		if (req[key] !== undefined) passed[key] = req[key];
	}
	return { ok: true, echo: req.echo === true ? prompt : null, chat };
}
