import { UPSTREAM_CONTENT_TYPE_HEADER } from "@better-ccflare/types";
import { drainBody } from "./handlers/discard-body-cancel";

/**
 * An upstream error page, rewrapped as a JSON error for a JSON API client
 * (SB23-3494).
 *
 * An upstream edge can answer a `/v1/*` request with a page meant for a
 * browser: Cloudflare's stock `400 Bad Request`, a 502, a 520 or a 524, all
 * `Content-Type: text/html`. Relayed verbatim, the Anthropic and OpenAI SDKs
 * report raw markup instead of an error object. Everything better-ccflare
 * generates itself on those paths is already JSON.
 *
 * `handleProxy` applies this once, to the response it is about to return, so
 * every decision that needs the raw upstream response has already been made
 * on it: the Codex Cloudflare cookie capture (at fetch time, in
 * `request-handler.ts`), the error classifiers, rate-limit parsing, the
 * in-place retry loops and failover (all inside `proxyWithAccount`), and the
 * analytics tee in `forwardToClient`, which records the raw status, headers
 * and body. Only the client sees the envelope.
 *
 * Wrapped: status 400 or above, a body, a `/v1` path, and a content type that
 * is absent or textual (`text/*` other than `text/event-stream`, or XML).
 * Untouched: anything below 400, a JSON body (`application/json` or `+json`),
 * an event stream, a binary type, and every path outside `/v1`.
 */

export { UPSTREAM_CONTENT_TYPE_HEADER };

/** Value of {@link UPSTREAM_CONTENT_TYPE_HEADER} when the upstream sent none. */
export const UPSTREAM_CONTENT_TYPE_NONE = "none";

/** Longest upstream text kept in the envelope's message, in characters. */
export const UPSTREAM_ERROR_TEXT_MAX_CHARS = 2048;

/**
 * Bytes read from the upstream body before the rest is drained unread. An
 * error page is a few kilobytes; this bounds memory if one is not.
 */
export const UPSTREAM_ERROR_READ_MAX_BYTES = 64 * 1024;

const ELLIPSIS = "...";

/** The media type alone, lowercased, or null when absent or blank. */
function mediaTypeOf(contentType: string | null): string | null {
	if (contentType === null) return null;
	const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	return mediaType === "" ? null : mediaType;
}

function isJsonMediaType(mediaType: string): boolean {
	return mediaType === "application/json" || mediaType.endsWith("+json");
}

/** The textual types an edge answers errors in. An event stream is not one. */
function isTextualMediaType(mediaType: string): boolean {
	if (mediaType === "text/event-stream") return false;
	return (
		mediaType.startsWith("text/") ||
		mediaType === "application/xml" ||
		mediaType.endsWith("+xml")
	);
}

/** True for `/v1` and anything under it, gateways included. */
export function isClientApiPath(pathname: string): boolean {
	return pathname === "/v1" || pathname.startsWith("/v1/");
}

/** Whether {@link wrapNonJsonUpstreamError} would rewrite this response. */
export function shouldWrapUpstreamError(
	response: Response,
	pathname: string,
): boolean {
	if (response.status < 400 || response.body === null) return false;
	if (!isClientApiPath(pathname)) return false;
	const mediaType = mediaTypeOf(response.headers.get("content-type"));
	if (mediaType === null) return true;
	if (isJsonMediaType(mediaType)) return false;
	return isTextualMediaType(mediaType);
}

const NAMED_ENTITIES: Record<string, string> = {
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

function decodeEntities(text: string): string {
	return (
		text
			.replace(/&#(\d+);/g, (match, digits: string) => {
				const code = Number(digits);
				return code <= 0x10ffff ? String.fromCodePoint(code) : match;
			})
			.replace(/&#x([0-9a-f]+);/gi, (match, hex: string) => {
				const code = Number.parseInt(hex, 16);
				return code <= 0x10ffff ? String.fromCodePoint(code) : match;
			})
			.replace(
				/&(lt|gt|quot|apos|nbsp);/gi,
				(_match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? "",
			)
			// Last, so `&amp;lt;` decodes to the text `&lt;` and not to `<`.
			.replace(/&amp;/gi, "&")
	);
}

/**
 * Upstream error text as a single readable line: script, style and comment
 * blocks dropped, tags stripped, entities decoded, whitespace collapsed, and
 * cut to {@link UPSTREAM_ERROR_TEXT_MAX_CHARS} characters.
 */
export function summarizeUpstreamErrorText(raw: string): string {
	const text = decodeEntities(
		raw
			.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
			.replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
			.replace(/<[^>]*>/g, " ")
			// A read cut off inside a tag leaves it unclosed.
			.replace(/<[^>]*$/, " "),
	)
		.replace(/\s+/g, " ")
		.trim();
	if (text.length <= UPSTREAM_ERROR_TEXT_MAX_CHARS) return text;
	return `${text.slice(0, UPSTREAM_ERROR_TEXT_MAX_CHARS - ELLIPSIS.length)}${ELLIPSIS}`;
}

/** The Anthropic error envelope for an upstream error page. */
export function buildUpstreamErrorEnvelope(
	status: number,
	contentType: string | null,
	rawText: string,
): { type: "error"; error: { type: "upstream_error"; message: string } } {
	const summary = summarizeUpstreamErrorText(rawText);
	const body = rawText.trim() === "" ? "an empty body" : "a non-JSON body";
	const described = `Upstream returned HTTP ${status} with ${body} (${
		mediaTypeOf(contentType) ?? "no content type"
	})`;
	return {
		type: "error",
		error: {
			type: "upstream_error",
			message: summary === "" ? described : `${described}: ${summary}`,
		},
	};
}

/**
 * Reads at most {@link UPSTREAM_ERROR_READ_MAX_BYTES} of the upstream body,
 * then emits the envelope. A read error keeps what arrived before it, so the
 * client still gets a parseable body. Past the cap the rest is drained in the
 * background rather than cancelled, because `reader.cancel()` does not release
 * a fetch body on Bun (see `discard-body-cancel.ts`).
 */
function envelopeBody(
	source: ReadableStream<Uint8Array>,
	status: number,
	contentType: string | null,
): ReadableStream<Uint8Array> {
	let started = false;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			started = true;
			const reader = source.getReader();
			const decoder = new TextDecoder();
			let text = "";
			let bytes = 0;
			let finished = false;
			try {
				while (bytes < UPSTREAM_ERROR_READ_MAX_BYTES) {
					const { done, value } = await reader.read();
					if (done) {
						finished = true;
						break;
					}
					const kept = value.subarray(0, UPSTREAM_ERROR_READ_MAX_BYTES - bytes);
					bytes += kept.byteLength;
					text += decoder.decode(kept, { stream: true });
				}
				text += decoder.decode();
			} catch {
				// Keep what arrived; an upstream reset still yields an envelope.
				finished = true;
			} finally {
				reader.releaseLock();
			}
			if (!finished) void drainBody(source).catch(() => {});
			const envelope = buildUpstreamErrorEnvelope(status, contentType, text);
			try {
				controller.enqueue(new TextEncoder().encode(JSON.stringify(envelope)));
				controller.close();
			} catch {
				// The client went away while the upstream body was being read.
			}
		},
		cancel() {
			if (!started && !source.locked) void drainBody(source).catch(() => {});
		},
	});
}

/**
 * Returns `response` unchanged unless {@link shouldWrapUpstreamError} says
 * otherwise; then a response with the same status and headers, a JSON body
 * holding the Anthropic error envelope, `Content-Type: application/json`, and
 * {@link UPSTREAM_CONTENT_TYPE_HEADER} naming what the upstream sent.
 */
export function wrapNonJsonUpstreamError(
	response: Response,
	pathname: string,
): Response {
	if (!shouldWrapUpstreamError(response, pathname) || response.body === null) {
		return response;
	}
	const contentType = response.headers.get("content-type");
	const headers = new Headers(response.headers);
	headers.delete("content-length");
	headers.delete("content-encoding");
	headers.set("content-type", "application/json");
	headers.set(
		UPSTREAM_CONTENT_TYPE_HEADER,
		contentType ?? UPSTREAM_CONTENT_TYPE_NONE,
	);
	return new Response(
		envelopeBody(response.body, response.status, contentType),
		{
			status: response.status,
			statusText: response.statusText,
			headers,
		},
	);
}
