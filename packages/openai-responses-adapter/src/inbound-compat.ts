/**
 * Inbound shapes an OpenAI client may legally send that Anthropic's Messages
 * API refuses as they stand. Shared by the Chat Completions and Responses
 * translators (SB23-2727 items 3 and 4).
 */

export interface Base64DataUrl {
	mediaType: string;
	data: string;
}

/**
 * Parses `data:<mime>[;<key>=<value>]*;base64,<payload>`.
 *
 * RFC 2397 allows parameters between the media type and `;base64`, such as
 * `data:image/png;charset=binary;base64,...`, and MIME base64 encoders (Python
 * `base64.encodebytes`, Java's MIME encoder) wrap the payload every 76
 * characters. Anthropic takes neither: `media_type` must be the bare type and
 * `data` plain base64. So the parameters are dropped, the media type is
 * lowercased (media types are case-insensitive, Anthropic's enum is not), and
 * whitespace is removed from the payload. Null when the URL is not a base64
 * data URL at all.
 */
export function parseBase64DataUrl(url: string): Base64DataUrl | null {
	const match = /^data:([^;,]+)((?:;[^;,]*)*?);base64,([\s\S]*)$/i.exec(url);
	if (!match) return null;
	const mediaType = match[1].trim().toLowerCase();
	const params = match[2];
	if (params !== "") {
		for (const param of params.slice(1).split(";")) {
			if (!/^[^=\s]+=[^=]*$/.test(param.trim())) return null;
		}
	}
	const data = match[3].replace(/\s+/g, "");
	if (mediaType === "" || data === "") return null;
	return { mediaType, data };
}

/** The structural slice of a `tool_use` block both translators emit. */
interface ToolUseLike {
	type: "tool_use";
	id: string;
	name: string;
	input: unknown;
}

/** The structural slice of a `tool_result` block both translators emit. */
interface ToolResultLike<Part> {
	type: "tool_result";
	tool_use_id: string;
	content: string | Part[];
	is_error?: boolean;
}

type TextLike = { type: "text"; text: string };

/**
 * Anthropic answers 400 `Requests must define tools when including 'tool_use'
 * or 'tool_result' blocks.` when the history carries either block and the
 * request defines no `tools`. OpenAI accepts that history, and a client may
 * drop `tools` mid-conversation, for instance to ask for a plain summary of
 * what the tools did. So when a request has no tools, each block is rewritten
 * as text that keeps the call, its arguments and its result. A dummy tool
 * would also satisfy the check but leaves the model something to call.
 *
 * Content that is neither block passes through unchanged, including images
 * inside a tool result, which a user turn may carry. Text never comes out
 * empty, because Anthropic refuses an empty text block.
 */
export function flattenToolHistory<
	Block extends { type: string },
	Message extends { role: string; content: string | Block[] },
>(messages: Message[]): Message[] {
	return messages.map((message) => {
		if (typeof message.content === "string") return message;
		if (
			!message.content.some(
				(block) => block.type === "tool_use" || block.type === "tool_result",
			)
		) {
			return message;
		}
		const content = message.content.flatMap((block) => {
			if (block.type === "tool_use") {
				const call = block as unknown as ToolUseLike;
				return [
					textBlock(
						`[Tool call ${call.name} (id ${call.id}) with arguments ${JSON.stringify(call.input ?? {})}]`,
					) as unknown as Block,
				];
			}
			if (block.type === "tool_result") {
				const result = block as unknown as ToolResultLike<Block>;
				const label = `[Tool result for call ${result.tool_use_id}${result.is_error ? ", reported as an error" : ""}]`;
				if (typeof result.content === "string") {
					return [
						textBlock(
							result.content === ""
								? `${label} (empty)`
								: `${label}\n${result.content}`,
						) as unknown as Block,
					];
				}
				const parts = result.content.filter(
					(part) =>
						part.type !== "text" ||
						(part as unknown as TextLike).text.trim() !== "",
				);
				return [
					textBlock(parts.length === 0 ? `${label} (empty)` : label),
					...parts,
				] as unknown as Block[];
			}
			return [block];
		});
		return { ...message, content };
	});
}

function textBlock(text: string): TextLike {
	return { type: "text", text };
}
