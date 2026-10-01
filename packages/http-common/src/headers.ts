/**
 * Sanitizes proxy headers by removing hop-by-hop headers that should not be forwarded
 * after Bun has automatically decompressed the response body.
 *
 * Removes: content-encoding, content-length, transfer-encoding
 */
export function sanitizeProxyHeaders(original: Headers): Headers {
	const sanitized = new Headers(original);

	// Remove headers that are invalidated by automatic decompression
	sanitized.delete("content-encoding");
	sanitized.delete("content-length");
	sanitized.delete("transfer-encoding");

	return sanitized;
}

/**
 * The value a credential-bearing header is replaced with before a header set is
 * persisted or shipped. The key is kept so the read path still shows that the
 * header was sent (Bearer versus x-api-key, for instance); the value is not.
 */
export const REDACTED_HEADER_VALUE = "[redacted]";

const CREDENTIAL_HEADER_NAMES = new Set([
	"authorization",
	"proxy-authorization",
	"x-api-key",
	"api-key",
	"cookie",
	"set-cookie",
	// Cloudflare Access stamps a signed JWT on every request it forwards to the
	// origin, and a service-token client sends the id/secret pair.
	"cf-access-jwt-assertion",
	"cf-access-client-id",
	"cf-access-client-secret",
	"token",
	"secret",
	"key",
	"password",
]);

const CREDENTIAL_HEADER_SUFFIX = /-(token|secret|key|password)$/;

/** Prefix of this proxy's own control headers (routing, probes, local control). */
const CONTROL_HEADER_PREFIX = "x-better-ccflare-";

/**
 * Whether a request header carries a credential: `authorization`,
 * `proxy-authorization`, `x-api-key`, `cookie`, the Cloudflare Access headers,
 * or any name ending in `-token`, `-secret`, `-key` or `-password`.
 * Case-insensitive.
 */
export function isCredentialHeaderName(name: string): boolean {
	const lower = name.toLowerCase();
	return (
		CREDENTIAL_HEADER_NAMES.has(lower) || CREDENTIAL_HEADER_SUFFIX.test(lower)
	);
}

/**
 * Whether a request header's value must never be persisted: every credential
 * header, plus every `x-better-ccflare-*` control header. The control headers
 * include `x-better-ccflare-internal-probe-secret` and
 * `x-better-ccflare-local-control-secret`, and a prefix rule covers the next
 * one somebody adds without anyone having to remember this list.
 */
export function isStorageRedactedHeaderName(name: string): boolean {
	return (
		isCredentialHeaderName(name) ||
		name.toLowerCase().startsWith(CONTROL_HEADER_PREFIX)
	);
}

/**
 * Copy of a request header record with every value that
 * `isStorageRedactedHeaderName` names replaced by `REDACTED_HEADER_VALUE`.
 *
 * This is the last step before a request header set reaches the
 * `request_payloads` table or the OpenObserve exporter, and it runs there
 * rather than only at the producer because not every producer sanitises: the
 * refusal and pool-exhausted paths in `proxy.ts` build their `StartMessage`
 * from the raw `req.headers`.
 */
export function redactRequestHeadersForStorage(
	headers: Record<string, string> | null | undefined,
): Record<string, string> {
	const out: Record<string, string> = {};
	if (!headers) return out;
	for (const [key, value] of Object.entries(headers)) {
		out[key] = isStorageRedactedHeaderName(key) ? REDACTED_HEADER_VALUE : value;
	}
	return out;
}

/**
 * Removes hop-by-hop + compression negotiation headers from the ORIGINAL client
 * request, and redacts the value of every credential header, before the set is
 * handed to the usage collector for analytics.
 *
 * Removes: accept-encoding, content-encoding, transfer-encoding, content-length
 * Redacts (value becomes `REDACTED_HEADER_VALUE`): every name
 * `isCredentialHeaderName` accepts, which includes authorization, x-api-key,
 * cookie and x-better-ccflare-internal-probe-secret.
 *
 * `x-better-ccflare-*` control headers that are not credentials are kept
 * intact here because the collector reads some of them; they are redacted at
 * persistence by `redactRequestHeadersForStorage`.
 */
export function sanitizeRequestHeaders(original: Headers): Headers {
	const h = new Headers(original);
	h.delete("accept-encoding");
	h.delete("content-encoding");
	h.delete("content-length");
	h.delete("transfer-encoding");
	const credentialNames: string[] = [];
	for (const [name] of h.entries()) {
		if (isCredentialHeaderName(name)) credentialNames.push(name);
	}
	for (const name of credentialNames) h.set(name, REDACTED_HEADER_VALUE);
	return h;
}

const RESPONSE_SECRET_HEADERS = new Set([
	"set-cookie",
	"authorization",
	"proxy-authenticate",
	"www-authenticate",
]);

/**
 * Strip credential-bearing headers from an upstream RESPONSE before it is
 * persisted for analytics or shipped to an external observability backend.
 *
 * The counterpart of `sanitizeRequestHeaders`, which the response side has
 * lacked: an upstream `set-cookie` is a session credential, and shipping it off
 * the box is a wider exposure than keeping it in the local payload table.
 *
 * Removes: set-cookie, authorization, proxy-authenticate, www-authenticate
 */
export function sanitizeResponseHeaders(
	original: Record<string, string>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(original)) {
		if (RESPONSE_SECRET_HEADERS.has(key.toLowerCase())) continue;
		out[key] = value;
	}
	return out;
}

/**
 * Return a new Response with hop-by-hop / compression headers stripped.
 * Body & status are preserved.
 */
export function withSanitizedProxyHeaders(res: Response): Response {
	return new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers: sanitizeProxyHeaders(res.headers),
	});
}
