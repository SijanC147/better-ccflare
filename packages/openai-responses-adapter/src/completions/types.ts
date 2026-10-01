/**
 * Inbound OpenAI legacy Completions (SB23-1970).
 *
 * `POST /v1/completions` takes a raw `prompt` and answers `choices[].text`.
 * Anthropic has no text-completions endpoint, so the prompt becomes the one
 * `user` turn of a Chat Completions request, which runs through the chat core
 * (`../chat/handler.ts`) and is reshaped on the way out. **The wrapping is
 * lossy**: a chat-tuned model given a prompt as a user turn answers it as a
 * message rather than continuing the text, so identical input does not give
 * what a true completion model would.
 */

import type {
	ChatCompletionRequest,
	ChatFinishReason,
	ChatRequestError,
	ChatUsage,
} from "../chat/types";

/** The legacy request. Every other key is ignored, as on the chat path. */
export interface CompletionRequest {
	model: string;
	/** A string here; the API also allows arrays, which are refused. */
	prompt: unknown;
	suffix?: string | null;
	max_tokens?: number | null | undefined;
	temperature?: number | null;
	top_p?: number | null;
	n?: number | null;
	stream?: boolean | null;
	stream_options?: { include_usage?: boolean } | null;
	/** An integer on this API, unlike chat's boolean. */
	logprobs?: number | null;
	echo?: boolean | null;
	stop?: string | string[] | null;
	best_of?: number | null;
	user?: string;
	[key: string]: unknown;
}

/**
 * Applied when the client sends no `max_tokens`: the legacy API's own
 * default (`CreateCompletionRequest.max_tokens`, `default: 16`, in
 * openai/openai-openapi), not the chat path's `DEFAULT_MAX_TOKENS`. A client relying on the
 * default gets the short completion OpenAI would have given it.
 */
export const DEFAULT_COMPLETION_MAX_TOKENS = 16;

/** The legacy API has no tool calls, so `tool_calls` never reaches a client. */
export type CompletionFinishReason = Exclude<ChatFinishReason, "tool_calls">;

export interface CompletionChoice {
	/** `text`, not chat's `message`: the whole difference between the APIs. */
	text: string;
	index: 0;
	logprobs: null;
	finish_reason: CompletionFinishReason | null;
}

export interface TextCompletion {
	id: string;
	object: "text_completion";
	created: number;
	model: string;
	choices: CompletionChoice[];
	/** Absent on stream chunks unless `include_usage` asked for it. */
	usage?: ChatUsage | null;
}

/** What the request translator hands the handler. */
export type TranslateCompletionResult =
	| {
			ok: true;
			/** The prompt, prepended to the answer when `echo` is set. */
			echo: string | null;
			chat: ChatCompletionRequest;
	  }
	| { ok: false; error: ChatRequestError };
