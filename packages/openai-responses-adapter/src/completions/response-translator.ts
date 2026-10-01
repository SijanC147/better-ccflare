import type { ChatCompletion, ChatFinishReason } from "../chat/types";
import type { CompletionFinishReason, TextCompletion } from "./types";

/** `tool_calls` cannot occur without tools, and this API has none. */
export function toCompletionFinishReason(
	reason: ChatFinishReason | null | undefined,
): CompletionFinishReason | null {
	if (reason === null || reason === undefined) return null;
	return reason === "tool_calls" ? "stop" : reason;
}

/**
 * A Chat Completions answer from the chat core as a legacy completion:
 * `choices[].text` in place of `choices[].message`. Reasoning text and tool
 * calls have no place in this shape and are dropped. With `echo`, the prompt
 * leads the text, as OpenAI's own `echo` does.
 */
export function chatCompletionToTextCompletion(
	completion: ChatCompletion,
	echo: string | null,
): TextCompletion {
	const choice = completion.choices[0];
	return {
		id: completion.id,
		object: "text_completion",
		created: completion.created,
		model: completion.model,
		choices: [
			{
				text: (echo ?? "") + (choice?.message.content ?? ""),
				index: 0,
				logprobs: null,
				finish_reason:
					toCompletionFinishReason(choice?.finish_reason) ?? "stop",
			},
		],
		usage: completion.usage,
	};
}
