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

/**
 * The path the client called, for the badge's tooltip. A Responses request may
 * have been `/responses/compact`; the marker does not say which, so the
 * tooltip names both.
 */
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
	if (format === "openai-responses") {
		const base = gateway ? `/v1/gateways/${gateway}` : "/v1";
		return `${base}/responses or ${base}/responses/compact`;
	}
	return gateway ? `/v1/gateways/${gateway}${rest}` : `/v1${rest}`;
}

/**
 * A request history timestamp on the 24-hour clock, whatever the viewer's
 * locale: `toLocaleTimeString()` with no options prints "4:10:37 AM" for an
 * en-US viewer. `hourCycle: "h23"` rather than `hour12: false`, which some
 * engines render as hour 24 at midnight.
 */
export function formatHistoryTime(timestamp: number | string): string {
	return new Date(timestamp).toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	});
}
