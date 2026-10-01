/**
 * The label for a request that arrived on an OpenAI-shaped API and was
 * translated into `/v1/messages` (SB23-2727). Its path column reads
 * `/v1/messages` like Claude Code traffic, so this is what tells them apart.
 * Null when the row carries no marker, so callers render nothing.
 */
export function inboundLabel(
	format?: string | null,
	gateway?: string | null,
): string | null {
	const api =
		format === "openai-chat"
			? "OpenAI chat"
			: format === "openai-responses"
				? "OpenAI responses"
				: null;
	if (api === null) return null;
	return gateway ? `${api} · ${gateway}` : api;
}

/** The path the client called, for the badge's tooltip. */
export function inboundPath(
	format?: string | null,
	gateway?: string | null,
): string | null {
	const rest =
		format === "openai-chat"
			? "/chat/completions"
			: format === "openai-responses"
				? "/responses"
				: null;
	if (rest === null) return null;
	return gateway ? `/v1/gateways/${gateway}${rest}` : `/v1${rest}`;
}
