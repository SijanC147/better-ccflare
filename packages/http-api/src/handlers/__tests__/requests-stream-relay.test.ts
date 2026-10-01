/**
 * The relay hop of SB23-3995: `createRequestsStreamHandler` serialises every
 * `requestEvents` event whole, so a summary's `rateLimited` reaches the
 * dashboard's `useRequestStream` exactly as the collector built it. A relay
 * that picked fields would drop the badge between the two tested ends.
 */
import { describe, expect, test } from "bun:test";
import { type RequestEvt, requestEvents } from "@better-ccflare/core";
import type { RequestResponse } from "@better-ccflare/types";
import { createRequestsStreamHandler } from "../requests-stream";

const summary: RequestResponse = {
	id: "relay-429",
	timestamp: "2026-10-01T17:00:00.000Z",
	method: "POST",
	path: "/v1/messages",
	accountUsed: "acct-1",
	statusCode: 429,
	success: false,
	errorMessage: null,
	responseTimeMs: 40,
	failoverAttempts: 0,
	rateLimited: true,
};

/** Reads SSE frames until one carries a `data:` line other than the handshake. */
async function readDataFrame(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<RequestEvt> {
	const decoder = new TextDecoder();
	let buffer = "";
	for (let reads = 0; reads < 10; reads++) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		// Chunks can coalesce or split, so cut on the blank line and leave the
		// last piece, which is either empty or a frame still arriving.
		const frames = buffer.split("\n\n");
		for (const frame of frames.slice(0, -1)) {
			if (frame.startsWith("event: connected")) continue;
			if (frame.startsWith("data: "))
				return JSON.parse(frame.slice("data: ".length)) as RequestEvt;
		}
	}
	throw new Error(
		`no data frame arrived; buffer was ${JSON.stringify(buffer)}`,
	);
}

describe("createRequestsStreamHandler relays a summary whole", () => {
	test("rateLimited and statusCode survive the SSE frame", async () => {
		const listenersBefore = requestEvents.listenerCount("event");
		const response = createRequestsStreamHandler()(
			new Request("http://127.0.0.1/api/requests/stream"),
		);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("stream response has no body");
		try {
			// `start` registers the listener synchronously, so the emit lands.
			expect(requestEvents.listenerCount("event")).toBe(listenersBefore + 1);
			requestEvents.emit("event", { type: "summary", payload: summary });

			const frame = await readDataFrame(reader);
			if (frame.type !== "summary")
				throw new Error(`expected a summary frame, got ${frame.type}`);
			expect(frame.payload).toEqual(summary);
			expect(frame.payload.rateLimited).toBe(true);
		} finally {
			// requestEvents is one emitter for the whole test process.
			await reader.cancel();
		}
		expect(requestEvents.listenerCount("event")).toBe(listenersBefore);
	});
});
