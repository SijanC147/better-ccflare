import { describe, expect, it } from "bun:test";
import {
	buildUpstreamErrorEnvelope,
	summarizeUpstreamErrorText,
	UPSTREAM_CONTENT_TYPE_HEADER,
	UPSTREAM_ERROR_READ_MAX_BYTES,
	UPSTREAM_ERROR_TEXT_MAX_CHARS,
	wrapNonJsonUpstreamError,
} from "../upstream-error-envelope";

/**
 * The pure half of SB23-3494. The relay half, driven through `handleProxy`
 * against a loopback upstream, is apps/server/src/upstream-error-envelope.test.ts.
 */

const CLOUDFLARE_400 = `<html>
<head><title>400 Bad Request</title><style>body{color:red}</style></head>
<body>
<center><h1>400 Bad Request</h1></center>
<hr><center>cloudflare</center>
<script>window.x = "<b>not text</b>";</script>
</body>
</html>`;

function respond(
	body: BodyInit | null,
	status: number,
	contentType?: string,
): Response {
	const response = new Response(body, { status });
	// A string body makes the runtime add text/plain; remove it so each case
	// states its own content type, including none at all.
	response.headers.delete("content-type");
	if (contentType !== undefined) {
		response.headers.set("content-type", contentType);
	}
	return response;
}

describe("wrapNonJsonUpstreamError leaves these responses as the same object", () => {
	const cases: Array<[string, () => Response, string]> = [
		[
			"a JSON 400",
			() => respond('{"type":"error"}', 400, "application/json"),
			"/v1/messages",
		],
		[
			"a problem+json 422",
			() => respond('{"title":"x"}', 422, "application/problem+json"),
			"/v1/messages",
		],
		[
			"an SSE 200",
			() => respond("event: ping\n\n", 200, "text/event-stream"),
			"/v1/messages",
		],
		[
			"an SSE 429",
			() => respond("event: error\n\n", 429, "text/event-stream"),
			"/v1/messages",
		],
		[
			"an HTML 200",
			() => respond("<html>ok</html>", 200, "text/html"),
			"/v1/messages",
		],
		[
			"a binary 502",
			() => respond("\u0000\u0001", 502, "application/octet-stream"),
			"/v1/messages",
		],
		[
			"an HTML 400 outside /v1",
			() => respond(CLOUDFLARE_400, 400, "text/html"),
			"/messages/batches",
		],
		[
			"an HTML 400 on a path that only starts with v1",
			() => respond(CLOUDFLARE_400, 400, "text/html"),
			"/v1beta/messages",
		],
		["a bodiless 502", () => respond(null, 502), "/v1/messages"],
	];
	for (const [name, make, path] of cases) {
		it(name, () => {
			const response = make();
			expect(wrapNonJsonUpstreamError(response, path)).toBe(response);
		});
	}
});

describe("wrapNonJsonUpstreamError rewraps an upstream error page", () => {
	it("turns a Cloudflare HTML 400 into the Anthropic envelope", async () => {
		const upstream = respond(CLOUDFLARE_400, 400, "text/html; charset=UTF-8");
		upstream.headers.set("server", "cloudflare");
		upstream.headers.set("cf-ray", "abc123-LHR");
		upstream.headers.set("content-length", String(CLOUDFLARE_400.length));

		const wrapped = wrapNonJsonUpstreamError(upstream, "/v1/messages");

		expect(wrapped).not.toBe(upstream);
		expect(wrapped.status).toBe(400);
		expect(wrapped.headers.get("content-type")).toBe("application/json");
		expect(wrapped.headers.get(UPSTREAM_CONTENT_TYPE_HEADER)).toBe(
			"text/html; charset=UTF-8",
		);
		// The upstream's own headers survive; the length no longer describes
		// the body, so it goes.
		expect(wrapped.headers.get("server")).toBe("cloudflare");
		expect(wrapped.headers.get("cf-ray")).toBe("abc123-LHR");
		expect(wrapped.headers.get("content-length")).toBeNull();
		expect(await wrapped.json()).toEqual({
			type: "error",
			error: {
				type: "upstream_error",
				message:
					"Upstream returned HTTP 400 with a non-JSON body (text/html): 400 Bad Request 400 Bad Request cloudflare",
			},
		});
	});

	it("wraps a text/plain 502 and a 502 with no content type", async () => {
		const plain = wrapNonJsonUpstreamError(
			respond("upstream connect error", 502, "text/plain"),
			"/v1/gateways/gpt/v1/chat/completions",
		);
		expect(plain.status).toBe(502);
		expect(plain.headers.get(UPSTREAM_CONTENT_TYPE_HEADER)).toBe("text/plain");
		expect((await plain.json()).error.message).toBe(
			"Upstream returned HTTP 502 with a non-JSON body (text/plain): upstream connect error",
		);

		const untyped = wrapNonJsonUpstreamError(
			respond("bad gateway", 502),
			"/v1/messages",
		);
		expect(untyped.headers.get("content-type")).toBe("application/json");
		expect(untyped.headers.get(UPSTREAM_CONTENT_TYPE_HEADER)).toBe("none");
		expect((await untyped.json()).error.message).toBe(
			"Upstream returned HTTP 502 with a non-JSON body (no content type): bad gateway",
		);
	});

	it("says empty when the body is empty", async () => {
		const wrapped = wrapNonJsonUpstreamError(
			respond("", 524, "text/html"),
			"/v1/messages",
		);
		expect((await wrapped.json()).error.message).toBe(
			"Upstream returned HTTP 524 with an empty body (text/html)",
		);
	});

	it("reads at most the cap and still answers", async () => {
		const huge = `<p>${"x".repeat(UPSTREAM_ERROR_READ_MAX_BYTES * 2)}</p>`;
		const wrapped = wrapNonJsonUpstreamError(
			respond(huge, 503, "text/html"),
			"/v1/messages",
		);
		const message: string = (await wrapped.json()).error.message;
		expect(message.endsWith("...")).toBe(true);
	});

	it("answers with what arrived when the upstream body errors", async () => {
		const encoder = new TextEncoder();
		let sent = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (!sent) {
					sent = true;
					controller.enqueue(encoder.encode("<h1>Bad gateway</h1>"));
					return;
				}
				controller.error(new Error("connection reset"));
			},
		});
		const wrapped = wrapNonJsonUpstreamError(
			respond(body, 502, "text/html"),
			"/v1/messages",
		);
		expect((await wrapped.json()).error.message).toBe(
			"Upstream returned HTTP 502 with a non-JSON body (text/html): Bad gateway",
		);
	});
});

describe("summarizeUpstreamErrorText", () => {
	it("drops script and style blocks, comments and tags", () => {
		expect(summarizeUpstreamErrorText(CLOUDFLARE_400)).toBe(
			"400 Bad Request 400 Bad Request cloudflare",
		);
		expect(summarizeUpstreamErrorText("a<!-- hidden -->b")).toBe("a b");
	});

	it("decodes entities once", () => {
		expect(
			summarizeUpstreamErrorText(
				"&lt;b&gt; &amp;lt; &#65;&#x42; &quot;q&quot;",
			),
		).toBe('<b> &lt; AB "q"');
	});

	it("drops a tag the read cut off", () => {
		expect(summarizeUpstreamErrorText('Error 520<div class="det')).toBe(
			"Error 520",
		);
	});

	it("caps the text at the limit, ellipsis included", () => {
		const text = summarizeUpstreamErrorText("y".repeat(10_000));
		expect(text.length).toBe(UPSTREAM_ERROR_TEXT_MAX_CHARS);
		expect(text.endsWith("...")).toBe(true);
		expect(summarizeUpstreamErrorText("short")).toBe("short");
	});
});

describe("buildUpstreamErrorEnvelope", () => {
	it("names the status and the bare media type", () => {
		expect(
			buildUpstreamErrorEnvelope(
				429,
				"text/html; charset=utf-8",
				"<p>slow down</p>",
			),
		).toEqual({
			type: "error",
			error: {
				type: "upstream_error",
				message:
					"Upstream returned HTTP 429 with a non-JSON body (text/html): slow down",
			},
		});
	});
});
