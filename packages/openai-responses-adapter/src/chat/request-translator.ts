import {
	type AnthropicImageBlock,
	type AnthropicMessagesRequest,
	type AnthropicRequestBlock,
	type AnthropicTextBlock,
	type AnthropicToolUseBlock,
	type ChatCompletionRequest,
	DEFAULT_MAX_TOKENS,
	type TranslateRequestResult,
} from "./types";

type AnthropicMessage = AnthropicMessagesRequest["messages"][number];
type AnthropicTool = NonNullable<AnthropicMessagesRequest["tools"]>[number];
type AnthropicToolChoice = NonNullable<AnthropicMessagesRequest["tool_choice"]>;

const JSON_INSTRUCTION =
	"Respond with a single valid JSON object and nothing else.";

/**
 * Thrown by the helpers below and turned into `{ ok: false }` by
 * `translateChatRequestToAnthropic`. Anything else that throws is a bug and
 * propagates.
 */
class Refusal extends Error {
	readonly param: string | null;
	readonly code: string;

	constructor(param: string | null, code: string, message: string) {
		super(message);
		this.param = param;
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSet(value: unknown): boolean {
	return value !== undefined && value !== null;
}

function describeType(part: unknown): string {
	return isRecord(part) && typeof part.type === "string"
		? part.type
		: typeof part;
}

function unsupportedPart(param: string, part: unknown): Refusal {
	return new Refusal(
		param,
		"unsupported_content_type",
		`Content part type '${describeType(part)}' at ${param} is not supported.`,
	);
}

/** The non-empty texts of a `string | text-part[]` content, one per part. */
function textSegments(content: unknown, param: string): string[] {
	if (!isSet(content)) return [];
	if (typeof content === "string") return content === "" ? [] : [content];
	if (!Array.isArray(content)) {
		throw new Refusal(
			param,
			"invalid_type",
			`${param} must be a string or an array of content parts.`,
		);
	}
	const segments: string[] = [];
	content.forEach((part, j) => {
		if (
			!isRecord(part) ||
			part.type !== "text" ||
			typeof part.text !== "string"
		) {
			throw unsupportedPart(`${param}[${j}]`, part);
		}
		if (part.text !== "") segments.push(part.text);
	});
	return segments;
}

function imageBlock(part: Record<string, unknown>, param: string) {
	const imageUrl = part.image_url;
	// Older OpenAI-compatible clients send the URL as a bare string.
	const url =
		typeof imageUrl === "string"
			? imageUrl
			: isRecord(imageUrl)
				? imageUrl.url
				: undefined;
	if (typeof url !== "string") {
		throw new Refusal(
			param,
			"invalid_image_url",
			`${param}.image_url.url must be a string.`,
		);
	}
	const trimmed = url.trim();
	if (trimmed.startsWith("data:")) {
		const match = /^data:([^;,]+);base64,(.+)$/.exec(trimmed);
		if (!match) {
			throw new Refusal(
				param,
				"invalid_image_url",
				`${param} is not a valid base64 data URL (expected data:<mime>;base64,<data>).`,
			);
		}
		const image: AnthropicImageBlock = {
			type: "image",
			source: { type: "base64", media_type: match[1], data: match[2] },
		};
		return image;
	}
	if (/^https?:\/\//i.test(trimmed)) {
		const image: AnthropicImageBlock = {
			type: "image",
			source: { type: "url", url: trimmed },
		};
		return image;
	}
	throw new Refusal(
		param,
		"invalid_image_url",
		`${param} must be an http(s) URL or a base64 data URL.`,
	);
}

function userContent(
	content: unknown,
	param: string,
): string | Array<AnthropicTextBlock | AnthropicImageBlock> {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) {
		throw new Refusal(
			param,
			"invalid_type",
			`${param} must be a string or an array of content parts.`,
		);
	}
	return content.map((part, j) => {
		const at = `${param}[${j}]`;
		if (
			isRecord(part) &&
			part.type === "text" &&
			typeof part.text === "string"
		) {
			const text: AnthropicTextBlock = { type: "text", text: part.text };
			return text;
		}
		if (isRecord(part) && part.type === "image_url")
			return imageBlock(part, at);
		throw unsupportedPart(at, part);
	});
}

/**
 * Anthropic's `tool_use.input` must be an object. `JSON.parse` succeeds on
 * `"null"`, `"[1]"` and `"3"`, so a successful parse is not enough.
 */
function parseToolArguments(
	args: unknown,
	param: string,
): Record<string, unknown> {
	if (typeof args !== "string") {
		throw new Refusal(param, "invalid_type", `${param} must be a JSON string.`);
	}
	if (args.trim() === "") return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(args);
	} catch {
		throw new Refusal(param, "invalid_value", `${param} is not valid JSON.`);
	}
	if (!isRecord(parsed)) {
		throw new Refusal(
			param,
			"invalid_value",
			`${param} must encode a JSON object.`,
		);
	}
	return parsed;
}

function toolUseBlock(call: unknown, param: string): AnthropicToolUseBlock {
	if (!isRecord(call)) {
		throw new Refusal(param, "invalid_type", `${param} must be an object.`);
	}
	if (isSet(call.type) && call.type !== "function") {
		throw new Refusal(
			`${param}.type`,
			"unsupported_value",
			`Tool call type '${String(call.type)}' is not supported; only 'function' is.`,
		);
	}
	if (typeof call.id !== "string" || call.id === "") {
		throw new Refusal(
			`${param}.id`,
			"missing_required_parameter",
			`${param}.id is required.`,
		);
	}
	const fn = call.function;
	if (!isRecord(fn) || typeof fn.name !== "string" || fn.name === "") {
		throw new Refusal(
			`${param}.function.name`,
			"missing_required_parameter",
			`${param}.function.name is required.`,
		);
	}
	return {
		type: "tool_use",
		id: call.id,
		name: fn.name,
		input: parseToolArguments(fn.arguments, `${param}.function.arguments`),
	};
}

function toBlocks(
	content: AnthropicMessage["content"],
): AnthropicRequestBlock[] {
	return typeof content === "string"
		? [{ type: "text", text: content }]
		: content;
}

/**
 * Anthropic requires the `tool_result` blocks answering a `tool_use` to lead
 * the next user turn. OpenAI sends each result as its own `tool` message, so
 * adjacent same-role messages are folded into one.
 */
function mergeAdjacentSameRole(
	messages: AnthropicMessage[],
): AnthropicMessage[] {
	const merged: AnthropicMessage[] = [];
	for (const message of messages) {
		const last = merged[merged.length - 1];
		if (last !== undefined && last.role === message.role) {
			last.content = [...toBlocks(last.content), ...toBlocks(message.content)];
		} else {
			merged.push(message);
		}
	}
	return merged;
}

function translateMessages(messages: unknown[]): {
	system: string[];
	messages: AnthropicMessage[];
} {
	const system: string[] = [];
	const built: AnthropicMessage[] = [];
	// A legacy `function_call` has no id, so one is made up here and handed
	// to the `role: "function"` message that answers it.
	let pendingLegacyCall: { id: string; name: string } | null = null;

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		const at = `messages[${i}]`;
		if (!isRecord(message)) {
			throw new Refusal(at, "invalid_type", `${at} must be an object.`);
		}
		switch (message.role) {
			// Anthropic has no system role inside `messages`, so these are hoisted
			// out of their position into the top-level `system` string.
			case "system":
			case "developer":
				system.push(...textSegments(message.content, `${at}.content`));
				break;
			case "user":
				built.push({
					role: "user",
					content: userContent(message.content, `${at}.content`),
				});
				break;
			case "assistant": {
				const blocks: AnthropicRequestBlock[] = textSegments(
					message.content,
					`${at}.content`,
				).map((text) => ({ type: "text", text }));
				if (isSet(message.tool_calls)) {
					if (!Array.isArray(message.tool_calls)) {
						throw new Refusal(
							`${at}.tool_calls`,
							"invalid_type",
							`${at}.tool_calls must be an array.`,
						);
					}
					message.tool_calls.forEach((call, k) => {
						blocks.push(toolUseBlock(call, `${at}.tool_calls[${k}]`));
					});
				}
				if (isSet(message.function_call)) {
					const fc = message.function_call;
					if (!isRecord(fc) || typeof fc.name !== "string" || fc.name === "") {
						throw new Refusal(
							`${at}.function_call.name`,
							"missing_required_parameter",
							`${at}.function_call.name is required.`,
						);
					}
					const id = `call_legacy_${i}`;
					blocks.push({
						type: "tool_use",
						id,
						name: fc.name,
						input: parseToolArguments(
							fc.arguments,
							`${at}.function_call.arguments`,
						),
					});
					pendingLegacyCall = { id, name: fc.name };
				}
				if (blocks.length > 0)
					built.push({ role: "assistant", content: blocks });
				break;
			}
			case "tool": {
				if (
					typeof message.tool_call_id !== "string" ||
					message.tool_call_id === ""
				) {
					throw new Refusal(
						`${at}.tool_call_id`,
						"missing_required_parameter",
						`${at}.tool_call_id is required.`,
					);
				}
				built.push({
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: message.tool_call_id,
							content: textSegments(message.content, `${at}.content`).join(
								"\n\n",
							),
						},
					],
				});
				break;
			}
			case "function": {
				if (
					pendingLegacyCall === null ||
					pendingLegacyCall.name !== message.name
				) {
					throw new Refusal(
						at,
						"invalid_value",
						`${at} answers no preceding assistant function_call named '${String(message.name)}'.`,
					);
				}
				built.push({
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: pendingLegacyCall.id,
							content: textSegments(message.content, `${at}.content`).join(
								"\n\n",
							),
						},
					],
				});
				pendingLegacyCall = null;
				break;
			}
			default:
				throw new Refusal(
					`${at}.role`,
					"invalid_value",
					`Message role '${String(message.role)}' at ${at} is not supported.`,
				);
		}
	}

	return { system, messages: mergeAdjacentSameRole(built) };
}

function positiveInteger(value: unknown, param: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Refusal(
			param,
			"invalid_value",
			`${param} must be a positive integer.`,
		);
	}
	return value;
}

function finiteNumber(value: unknown, param: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Refusal(param, "invalid_type", `${param} must be a number.`);
	}
	return value;
}

function resolveMaxTokens(req: ChatCompletionRequest): number {
	if (isSet(req.max_completion_tokens)) {
		return positiveInteger(req.max_completion_tokens, "max_completion_tokens");
	}
	if (isSet(req.max_tokens))
		return positiveInteger(req.max_tokens, "max_tokens");
	return DEFAULT_MAX_TOKENS;
}

function translateStop(stop: unknown): string[] | undefined {
	if (!isSet(stop)) return undefined;
	const list = typeof stop === "string" ? [stop] : stop;
	if (!Array.isArray(list)) {
		throw new Refusal(
			"stop",
			"invalid_type",
			"stop must be a string or an array of strings.",
		);
	}
	const kept: string[] = [];
	list.forEach((sequence, k) => {
		if (typeof sequence !== "string") {
			throw new Refusal(
				`stop[${k}]`,
				"invalid_type",
				`stop[${k}] must be a string.`,
			);
		}
		if (sequence !== "") kept.push(sequence);
	});
	return kept.length > 0 ? kept : undefined;
}

function translateTools(tools: unknown): AnthropicTool[] {
	if (!isSet(tools)) return [];
	if (!Array.isArray(tools)) {
		throw new Refusal("tools", "invalid_type", "tools must be an array.");
	}
	return tools.map((tool, i) => {
		const at = `tools[${i}]`;
		if (!isRecord(tool) || tool.type !== "function") {
			throw new Refusal(
				`${at}.type`,
				"unsupported_value",
				`Tool type '${describeType(tool)}' at ${at} is not supported; only 'function' is.`,
			);
		}
		const fn = tool.function;
		if (!isRecord(fn) || typeof fn.name !== "string" || fn.name === "") {
			throw new Refusal(
				`${at}.function.name`,
				"missing_required_parameter",
				`${at}.function.name is required.`,
			);
		}
		if (isSet(fn.parameters) && !isRecord(fn.parameters)) {
			throw new Refusal(
				`${at}.function.parameters`,
				"invalid_type",
				`${at}.function.parameters must be an object.`,
			);
		}
		// `strict` has no Anthropic equivalent and is dropped.
		const translated: AnthropicTool = {
			name: fn.name,
			input_schema: isRecord(fn.parameters)
				? fn.parameters
				: { type: "object", properties: {} },
		};
		if (typeof fn.description === "string")
			translated.description = fn.description;
		return translated;
	});
}

function translateToolChoice(
	choice: unknown,
	parallelToolCalls: unknown,
): AnthropicToolChoice | undefined {
	let mapped: AnthropicToolChoice | undefined;
	if (!isSet(choice)) {
		mapped = undefined;
	} else if (choice === "none") {
		mapped = { type: "none" };
	} else if (choice === "auto") {
		mapped = { type: "auto" };
	} else if (choice === "required") {
		mapped = { type: "any" };
	} else if (
		isRecord(choice) &&
		(choice.type === undefined || choice.type === "function") &&
		isRecord(choice.function) &&
		typeof choice.function.name === "string" &&
		choice.function.name !== ""
	) {
		mapped = { type: "tool", name: choice.function.name };
	} else {
		throw new Refusal(
			"tool_choice",
			"invalid_value",
			"tool_choice is not supported.",
		);
	}
	if (parallelToolCalls === false) {
		if (mapped === undefined)
			return { type: "auto", disable_parallel_tool_use: true };
		// `none` calls no tools, so there is nothing to serialise.
		if (mapped.type !== "none")
			return { ...mapped, disable_parallel_tool_use: true };
	}
	return mapped;
}

/**
 * Best-effort only: Anthropic has no JSON mode, so the constraint becomes a
 * system instruction and nothing validates the answer.
 */
function responseFormatInstruction(format: unknown): string | undefined {
	if (!isSet(format)) return undefined;
	if (!isRecord(format)) {
		throw new Refusal(
			"response_format",
			"invalid_type",
			"response_format must be an object.",
		);
	}
	switch (format.type) {
		case "text":
			return undefined;
		case "json_object":
			return JSON_INSTRUCTION;
		case "json_schema": {
			const schema = isRecord(format.json_schema)
				? format.json_schema.schema
				: undefined;
			if (schema === undefined) return JSON_INSTRUCTION;
			return `${JSON_INSTRUCTION}\nThe object must conform to this JSON Schema:\n${JSON.stringify(schema)}`;
		}
		default:
			throw new Refusal(
				"response_format.type",
				"unsupported_value",
				`response_format type '${String(format.type)}' is not supported.`,
			);
	}
}

function translate(req: ChatCompletionRequest): AnthropicMessagesRequest {
	if (!isRecord(req)) {
		throw new Refusal(
			null,
			"invalid_type",
			"The request body must be a JSON object.",
		);
	}
	if (typeof req.model !== "string" || req.model === "") {
		throw new Refusal(
			"model",
			"missing_required_parameter",
			"model is required.",
		);
	}
	if (!Array.isArray(req.messages)) {
		throw new Refusal(
			"messages",
			"missing_required_parameter",
			"messages must be an array.",
		);
	}
	if (isSet(req.n) && req.n !== 1) {
		throw new Refusal("n", "unsupported_value", "Only n = 1 is supported.");
	}
	if (req.logprobs === true) {
		throw new Refusal(
			"logprobs",
			"unsupported_value",
			"logprobs is not supported.",
		);
	}
	if (isSet(req.top_logprobs)) {
		throw new Refusal(
			"top_logprobs",
			"unsupported_value",
			"top_logprobs is not supported.",
		);
	}

	const translated = translateMessages(req.messages);
	if (translated.messages.length === 0) {
		throw new Refusal(
			"messages",
			"invalid_value",
			"messages must contain at least one user, assistant or tool message.",
		);
	}

	const body: AnthropicMessagesRequest = {
		model: req.model,
		max_tokens: resolveMaxTokens(req),
		messages: translated.messages,
	};

	const instruction = responseFormatInstruction(req.response_format);
	const system =
		instruction === undefined
			? translated.system
			: [...translated.system, instruction];
	if (system.length > 0) body.system = system.join("\n\n");

	// Current Claude models refuse `temperature` and `top_p` together, so when
	// both are set only `temperature` is sent. OpenAI allows 0 to 2; Anthropic
	// allows 0 to 1.
	if (isSet(req.temperature)) {
		body.temperature = Math.min(
			1,
			Math.max(0, finiteNumber(req.temperature, "temperature")),
		);
	} else if (isSet(req.top_p)) {
		body.top_p = finiteNumber(req.top_p, "top_p");
	}

	const stopSequences = translateStop(req.stop);
	if (stopSequences !== undefined) body.stop_sequences = stopSequences;

	if (req.stream === true) body.stream = true;

	const tools = translateTools(req.tools);
	if (tools.length > 0) {
		body.tools = tools;
		const toolChoice = translateToolChoice(
			req.tool_choice,
			req.parallel_tool_calls,
		);
		if (toolChoice !== undefined) body.tool_choice = toolChoice;
	}

	if (typeof req.user === "string" && req.user !== "") {
		body.metadata = { user_id: req.user };
	}

	// reasoning_effort, seed, penalties and any other key are ignored.
	return body;
}

export function translateChatRequestToAnthropic(
	req: ChatCompletionRequest,
): TranslateRequestResult {
	try {
		return { ok: true, body: translate(req) };
	} catch (error) {
		if (!(error instanceof Refusal)) throw error;
		return {
			ok: false,
			error: {
				status: 400,
				message: error.message,
				type: "invalid_request_error",
				param: error.param,
				code: error.code,
			},
		};
	}
}
