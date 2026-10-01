import {
	type ChatCoreShape,
	readJsonObject,
	runChatCompletion,
} from "../chat/handler";
import type { ChatCompletion } from "../chat/types";
import type { OpenAIGatewayOptions } from "../gateway";
import type { HandleProxyFn } from "../types";
import { translateCompletionRequestToChat } from "./request-translator";
import { chatCompletionToTextCompletion } from "./response-translator";
import { chatStreamToCompletionStream } from "./stream-translator";
import type { CompletionRequest } from "./types";

const COMPLETIONS_SHAPE: ChatCoreShape = {
	format: "openai-completions",
	idPrefix: "cmpl-",
};

/** True for the default gateway's legacy route. */
export function isOpenAICompletionsRequest(
	method: string,
	pathname: string,
): boolean {
	return method === "POST" && pathname === "/v1/completions";
}

function copyHeaders(from: Response): Headers {
	const headers = new Headers(from.headers);
	headers.delete("content-length");
	return headers;
}

/**
 * Inbound OpenAI legacy Completions (SB23-1970). The prompt becomes the one
 * user turn of a Chat Completions request, the chat core runs it exactly as
 * it runs `/v1/chat/completions` (model set, translation, `handleProxy` as a
 * synthetic `POST /v1/messages`, so usage is recorded from the Anthropic
 * answer before any reshaping), and the chat answer is reshaped into
 * `choices[].text`. Errors are already in the OpenAI shape, which both APIs
 * share, and leave unchanged.
 */
export async function handleCompletionsRequest(
	req: Request,
	url: URL,
	handleProxy: HandleProxyFn,
	ctx: unknown,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
	options?: OpenAIGatewayOptions,
): Promise<Response> {
	const parsed = await readJsonObject(req);
	if (parsed instanceof Response) return parsed;
	const translated = translateCompletionRequestToChat(
		parsed as CompletionRequest,
	);
	if (!translated.ok) {
		const { status, message, type, param, code } = translated.error;
		return new Response(
			JSON.stringify({ error: { message, type, param, code } }),
			{ status, headers: { "content-type": "application/json" } },
		);
	}

	const chatResponse = await runChatCompletion(
		translated.chat,
		req,
		url,
		handleProxy,
		ctx,
		apiKeyId,
		apiKeyName,
		options,
		COMPLETIONS_SHAPE,
	);
	if (!chatResponse.ok) return chatResponse;

	const contentType = chatResponse.headers.get("content-type") ?? "";
	if (contentType.includes("text/event-stream") && chatResponse.body) {
		return new Response(
			chatStreamToCompletionStream(chatResponse.body, translated.echo),
			{ status: chatResponse.status, headers: copyHeaders(chatResponse) },
		);
	}
	const completion = (await chatResponse.json()) as ChatCompletion;
	return new Response(
		JSON.stringify(chatCompletionToTextCompletion(completion, translated.echo)),
		{ status: chatResponse.status, headers: copyHeaders(chatResponse) },
	);
}
