/**
 * Inbound OpenAI Chat Completions gateway (SB23-2720).
 *
 * A client that treats ccflare as a custom OpenAI-compatible provider sends
 * `POST /v1/chat/completions`. We translate it to an Anthropic Messages
 * request, run it through `handleProxy` as a synthetic `POST /v1/messages`
 * (so combos, failover and every provider in the pool apply unchanged), and
 * translate the Anthropic answer back. This is the same shape as the
 * Responses adapter in `../handler.ts`; `@better-ccflare/openai-formats` is
 * the OUTBOUND direction and is deliberately not used here.
 *
 * This file is the contract the translators and the handler are written
 * against. Change it only in agreement with every module that imports it.
 */

// ── OpenAI Chat Completions: inbound request ──────────────────────────────

export interface ChatTextPart {
	type: "text";
	text: string;
}

export interface ChatImagePart {
	type: "image_url";
	image_url: { url: string; detail?: "auto" | "low" | "high" };
}

/** Parts a client may send that we cannot represent. Refused, not dropped. */
export interface ChatUnsupportedPart {
	type: "input_audio" | "file" | (string & {});
	[key: string]: unknown;
}

export type ChatContentPart =
	| ChatTextPart
	| ChatImagePart
	| ChatUnsupportedPart;

export interface ChatToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export type ChatMessage =
	| {
			role: "system" | "developer";
			content: string | ChatTextPart[];
			name?: string;
	  }
	| {
			role: "user";
			content: string | ChatContentPart[];
			name?: string;
	  }
	| {
			role: "assistant";
			content?: string | ChatTextPart[] | null;
			tool_calls?: ChatToolCall[];
			/** Legacy single-call form. Treated as one tool_call. */
			function_call?: { name: string; arguments: string } | null;
			refusal?: string | null;
			name?: string;
	  }
	| {
			role: "tool";
			content: string | ChatTextPart[];
			tool_call_id: string;
	  }
	| {
			/** Legacy role. `name` is the function name, no call id exists. */
			role: "function";
			content: string | null;
			name: string;
	  };

export interface ChatFunctionTool {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
		strict?: boolean;
	};
}

export type ChatToolChoice =
	| "none"
	| "auto"
	| "required"
	| { type: "function"; function: { name: string } };

export interface ChatCompletionRequest {
	model: string;
	messages: ChatMessage[];
	stream?: boolean;
	stream_options?: { include_usage?: boolean } | null;
	max_tokens?: number | null;
	max_completion_tokens?: number | null;
	temperature?: number | null;
	top_p?: number | null;
	stop?: string | string[] | null;
	n?: number | null;
	tools?: ChatFunctionTool[];
	tool_choice?: ChatToolChoice;
	parallel_tool_calls?: boolean;
	user?: string;
	logprobs?: boolean | null;
	top_logprobs?: number | null;
	response_format?: { type: string; [key: string]: unknown };
	reasoning_effort?: string | null;
	/** Anything else is ignored rather than refused (seed, penalties, …). */
	[key: string]: unknown;
}

// ── Anthropic Messages: the synthetic upstream request ────────────────────

export type AnthropicTextBlock = { type: "text"; text: string };

export type AnthropicImageBlock = {
	type: "image";
	source:
		| { type: "base64"; media_type: string; data: string }
		| { type: "url"; url: string };
};

export type AnthropicToolUseBlock = {
	type: "tool_use";
	id: string;
	name: string;
	input: unknown;
};

export type AnthropicToolResultBlock = {
	type: "tool_result";
	tool_use_id: string;
	content: string | Array<AnthropicTextBlock | AnthropicImageBlock>;
	is_error?: boolean;
};

export type AnthropicRequestBlock =
	| AnthropicTextBlock
	| AnthropicImageBlock
	| AnthropicToolUseBlock
	| AnthropicToolResultBlock;

export interface AnthropicMessagesRequest {
	model: string;
	max_tokens: number;
	messages: Array<{
		role: "user" | "assistant";
		content: string | AnthropicRequestBlock[];
	}>;
	system?: string;
	temperature?: number;
	top_p?: number;
	stop_sequences?: string[];
	stream?: boolean;
	tools?: Array<{
		name: string;
		description?: string;
		input_schema: Record<string, unknown>;
	}>;
	tool_choice?:
		| { type: "auto"; disable_parallel_tool_use?: boolean }
		| { type: "any"; disable_parallel_tool_use?: boolean }
		| { type: "tool"; name: string; disable_parallel_tool_use?: boolean }
		| { type: "none" };
	metadata?: { user_id?: string };
}

/**
 * Applied when the client sends neither `max_tokens` nor
 * `max_completion_tokens`. Anthropic requires the field; OpenAI does not.
 */
export const DEFAULT_MAX_TOKENS = 8192;

// ── Anthropic Messages: the upstream answer (non-streaming) ───────────────

export interface AnthropicMessageResponse {
	id: string;
	type: "message";
	role: "assistant";
	model: string;
	content: Array<
		| { type: "text"; text: string }
		| { type: "thinking"; thinking: string; signature?: string }
		| { type: "redacted_thinking"; data: string }
		| { type: "tool_use"; id: string; name: string; input: unknown }
		| { type: string; [key: string]: unknown }
	>;
	stop_reason: string | null;
	stop_sequence?: string | null;
	usage: {
		input_tokens: number;
		output_tokens: number;
		cache_read_input_tokens?: number | null;
		cache_creation_input_tokens?: number | null;
	};
}

// ── OpenAI Chat Completions: what the client receives ─────────────────────

export type ChatFinishReason =
	| "stop"
	| "length"
	| "tool_calls"
	| "content_filter";

export interface ChatUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	prompt_tokens_details?: { cached_tokens: number };
}

export interface ChatCompletion {
	id: string;
	object: "chat.completion";
	created: number;
	model: string;
	choices: Array<{
		index: 0;
		message: {
			role: "assistant";
			content: string | null;
			tool_calls?: ChatToolCall[];
			/** De facto extension (DeepSeek, OpenRouter) for thinking text. */
			reasoning_content?: string;
			refusal: null;
		};
		finish_reason: ChatFinishReason | null;
		logprobs: null;
	}>;
	usage: ChatUsage;
}

export interface ChatCompletionChunk {
	id: string;
	object: "chat.completion.chunk";
	created: number;
	model: string;
	choices: Array<{
		index: 0;
		delta: {
			role?: "assistant";
			content?: string | null;
			reasoning_content?: string;
			tool_calls?: Array<{
				index: number;
				id?: string;
				type?: "function";
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason: ChatFinishReason | null;
		logprobs: null;
	}>;
	/** Present, and null, on every chunk when include_usage is set, except the last. */
	usage?: ChatUsage | null;
}

// ── Errors, in the OpenAI shape ───────────────────────────────────────────

export interface OpenAIErrorBody {
	error: {
		message: string;
		type: string;
		param: string | null;
		code: string | null;
	};
}

/** A refusal decided before anything is sent upstream. */
export interface ChatRequestError {
	status: number;
	message: string;
	type: "invalid_request_error";
	param: string | null;
	code: string | null;
}

export type TranslateRequestResult =
	| { ok: true; body: AnthropicMessagesRequest }
	| { ok: false; error: ChatRequestError };

export interface ResponseTranslationContext {
	/** `chatcmpl-…`; one id for every chunk of one completion. */
	id: string;
	/** Unix seconds. */
	created: number;
	/**
	 * The model name the client asked for. Used only when the upstream message
	 * does not name the model that answered; a fallback can route to another
	 * model entirely (SB23-2781), and the client is told which one.
	 */
	model: string;
}

export interface StreamTranslationContext extends ResponseTranslationContext {
	/** `stream_options.include_usage`: emit a final usage-only chunk. */
	includeUsage: boolean;
}

// ── Module signatures (implemented in sibling files) ──────────────────────
//
// request-translator.ts
//   export function translateChatRequestToAnthropic(
//     req: ChatCompletionRequest,
//   ): TranslateRequestResult;
//
// response-translator.ts
//   export function mapStopReason(reason: string | null | undefined): ChatFinishReason | null;
//   export function translateAnthropicMessageToChat(
//     msg: AnthropicMessageResponse,
//     ctx: ResponseTranslationContext,
//   ): ChatCompletion;
//   export function toOpenAIError(status: number, body: unknown): OpenAIErrorBody;
//
// stream-translator.ts
//   export function translateAnthropicStreamToChat(
//     upstream: ReadableStream<Uint8Array>,
//     ctx: StreamTranslationContext,
//   ): ReadableStream<Uint8Array>;
//
// handler.ts
//   export async function handleChatCompletionsRequest(
//     req: Request, url: URL, handleProxy: HandleProxyFn, ctx: unknown,
//     apiKeyId?: string | null, apiKeyName?: string | null,
//   ): Promise<Response>;
