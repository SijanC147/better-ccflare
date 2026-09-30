import crypto from "node:crypto";
import type { ChatMessage } from "../chat/types";

export interface NormalizedMessage {
	role: "system" | "user" | "assistant";
	text: string;
}

export type NormalizeResult =
	| { ok: true; messages: NormalizedMessage[] }
	| { ok: false; message: string; param: string };

function contentText(
	content: unknown,
	index: number,
): { ok: true; text: string } | { ok: false; message: string } {
	if (content === null || content === undefined) return { ok: true, text: "" };
	if (typeof content === "string") return { ok: true, text: content };
	if (!Array.isArray(content)) {
		return {
			ok: false,
			message: `messages[${index}].content must be a string or an array of text parts.`,
		};
	}
	const texts: string[] = [];
	for (const part of content) {
		const type =
			typeof part === "object" && part !== null
				? (part as { type?: unknown }).type
				: undefined;
		if (
			type !== "text" ||
			typeof (part as { text?: unknown }).text !== "string"
		) {
			return {
				ok: false,
				message: `messages[${index}].content contains a "${String(type)}" part. Claude Code endpoints accept text parts only (no images or audio).`,
			};
		}
		texts.push((part as { text: string }).text);
	}
	return { ok: true, text: texts.join("") };
}

/**
 * Reduces an OpenAI message list to role + text. Tool and function turns are
 * refused: the CLI runs its own tools and a client cannot answer them.
 */
export function normalizeMessages(messages: unknown): NormalizeResult {
	if (!Array.isArray(messages) || messages.length === 0) {
		return {
			ok: false,
			message: "messages must be a non-empty array.",
			param: "messages",
		};
	}
	const out: NormalizedMessage[] = [];
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i] as ChatMessage | null;
		const role = message?.role;
		if (role === "tool" || role === "function") {
			return {
				ok: false,
				message: `messages[${i}] has role "${role}". Claude Code endpoints do not take tool results; the CLI runs its own tools.`,
				param: "messages",
			};
		}
		if (
			role !== "system" &&
			role !== "developer" &&
			role !== "user" &&
			role !== "assistant"
		) {
			return {
				ok: false,
				message: `messages[${i}] has an unsupported role.`,
				param: "messages",
			};
		}
		const text = contentText(message?.content, i);
		if (!text.ok) {
			return { ok: false, message: text.message, param: "messages" };
		}
		out.push({
			role: role === "developer" ? "system" : role,
			text: text.text,
		});
	}
	if (out[out.length - 1]?.role !== "user") {
		return {
			ok: false,
			message: "The last message must have the role user.",
			param: "messages",
		};
	}
	return { ok: true, messages: out };
}

/**
 * Identity of a conversation prefix. The endpoint name is part of it so one
 * endpoint never resumes a session that was created in another directory.
 */
export function conversationKey(
	endpointName: string,
	messages: readonly NormalizedMessage[],
): string {
	return crypto
		.createHash("sha256")
		.update(
			JSON.stringify([
				endpointName,
				messages.map((m) => [m.role, m.text.trim()]),
			]),
		)
		.digest("hex");
}

export function systemText(messages: readonly NormalizedMessage[]): string {
	return messages
		.filter((m) => m.role === "system")
		.map((m) => m.text)
		.filter((text) => text.length > 0)
		.join("\n\n");
}

/**
 * Prompt for a fresh session: earlier turns as "User:" / "Assistant:" blocks
 * and the final user message last. A lone user message goes through verbatim.
 */
export function flattenConversation(
	messages: readonly NormalizedMessage[],
): string {
	const turns = messages.filter((m) => m.role !== "system");
	if (turns.length === 1) return turns[0]?.text ?? "";
	return turns
		.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
		.join("\n\n");
}
