/**
 * Extract API key from request headers, with a fallback to the `?api_key=`
 * query parameter for SSE endpoints (EventSource cannot send custom
 * headers, so dashboard streams append the key as a query param).
 * Supports x-api-key (Vercel AI SDK / Opencode) and Authorization: Bearer.
 */
export function extractApiKey(req: Request): string | null {
	const apiKey = req.headers.get("x-api-key");
	if (apiKey) return apiKey;

	const authHeader = req.headers.get("authorization");
	if (authHeader) {
		const parts = authHeader.trim().split(/\s+/);
		if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
			return parts[1];
		}
	}

	// SSE fallback — EventSource has no header API. The dashboard appends
	// the stored API key as `?api_key=` on stream endpoints. Trade-off:
	// the key may appear in server access logs.
	try {
		const fromQuery = new URL(req.url).searchParams.get("api_key");
		if (fromQuery) return fromQuery;
	} catch {
		// Malformed URL — fall through to null.
	}
	return null;
}
