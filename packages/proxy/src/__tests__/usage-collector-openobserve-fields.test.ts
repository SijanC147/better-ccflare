/**
 * Pins the token and cost fields on the `summary` literal the usage collector
 * builds (packages/proxy/src/usage-collector.ts), as opposed to the exporter
 * that carries them (packages/logger/src/openobserve.ts).
 *
 * SB23-1522's tests call `shipRequestRecord` with a hand-built record, so they
 * pin the exporter: given a record holding the fields, they survive into the
 * buffer. They do not pin the collector, which is where the fields are chosen.
 * Mutation testing on PR #94 measured the gap: deleting
 * `inputTokens: state.usage.inputTokens,` from the summary literal SURVIVED
 * the whole suite. SB23-1895 is that survivor, and these tests are its kill.
 *
 * Three properties the fixture has to hold, each one a way an earlier attempt
 * would have passed for the wrong reason:
 *
 * 1. It feeds SSE events and a response body. It never assigns `state.usage`.
 *    Token counts arrive on `message_start` and are then overwritten by
 *    `message_delta`, whose `output_tokens` is kept as the authoritative
 *    `providerFinalOutputTokens`. A harness that sets the fields directly pins
 *    its own scaffolding rather than the collector.
 * 2. It covers the non-streaming fallback. `extractUsageFromJson` runs only
 *    when no model was seen in the stream, which is the path an error response
 *    takes and the one most likely to ship a record with no token keys.
 * 3. It reads what actually reached the exporter, by letting the real
 *    `shipRequestRecord` buffer the record and then flushing it through a
 *    stubbed `fetch`. Nothing about the transport is simulated except the
 *    socket, so the `if (openObserveEnabled())` guard is exercised too.
 *
 * Absent is not zero: every token field is optional on `RequestResponse` and
 * `JSON.stringify` drops `undefined`, so a request with no parsed usage ships
 * with no token keys rather than with zeros. The last test pins that shape
 * deliberately; it is correct behaviour, not a defect to round up.
 *
 * No network and no credentials: the base URL is an unroutable `.invalid`
 * host and `fetch` is replaced for the duration of the file.
 */
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { existsSync, unlinkSync } from "node:fs";

import {
	AsyncDbWriter,
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import {
	configureOpenObserve,
	flushOpenObserve,
	type OpenObserveSettings,
} from "@better-ccflare/logger";
import type { RequestResponse } from "@better-ccflare/types";
import { UsageCollector } from "../usage-collector";
import type { EndMessage, StartMessage } from "../worker-messages";

const TEST_DB_PATH = "/tmp/test-usage-collector-openobserve-fields.db";
const BASE_URL = "http://openobserve.invalid:5080";
const REQUEST_STREAM = "better_ccflare_requests";

/** The ten fields SB23-1522 exists to keep flowing. */
const TOKEN_AND_COST_FIELDS = [
	"model",
	"promptTokens",
	"completionTokens",
	"totalTokens",
	"inputTokens",
	"cacheReadInputTokens",
	"cacheCreationInputTokens",
	"outputTokens",
	"costUsd",
	"tokensPerSecond",
] as const;

const originalFetch = globalThis.fetch;

function settings(): OpenObserveSettings {
	return {
		baseUrl: BASE_URL,
		org: "default",
		user: "user@example.invalid",
		token: "not-a-real-token",
		logStream: "better_ccflare_logs",
		requestStream: REQUEST_STREAM,
		shipPayloads: false,
	};
}

/** Records posted to the request stream, in order. */
let shipped: Record<string, unknown>[] = [];

/**
 * Captures OpenObserve posts and fails every other request, which is what
 * keeps the pricing table's remote refresh off the network: it falls back to
 * the bundled table instead of reaching out.
 */
function installFetchStub(): void {
	globalThis.fetch = (async (
		url: string | URL | Request,
		init?: RequestInit,
	) => {
		const href = String(url instanceof Request ? url.url : url);
		if (href.startsWith(BASE_URL) && href.includes(REQUEST_STREAM)) {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>[];
			shipped.push(...body);
			return new Response("{}", { status: 200 });
		}
		if (href.startsWith(BASE_URL)) {
			return new Response("{}", { status: 200 });
		}
		return new Response("offline", { status: 503 });
	}) as unknown as typeof fetch;
}

describe("UsageCollector - token fields on the record shipped to OpenObserve", () => {
	let dbOps: DatabaseOperations;
	let asyncWriter: AsyncDbWriter;
	let collector: UsageCollector;
	const summaries = new Map<string, RequestResponse>();

	beforeAll(() => {
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch (error) {
			console.warn("Failed to clean up existing test database:", error);
		}
		installFetchStub();
		configureOpenObserve(() => settings());
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		asyncWriter = new AsyncDbWriter();
		collector = new UsageCollector(
			dbOps,
			asyncWriter,
			() => false,
			(summary) => {
				summaries.set(summary.id, summary);
			},
		);
	});

	afterAll(async () => {
		collector.dispose();
		await collector.drain();
		configureOpenObserve(null);
		await flushOpenObserve();
		globalThis.fetch = originalFetch;
		DatabaseFactory.reset();
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch (error) {
			console.warn("Failed to clean up test database:", error);
		}
	});

	beforeEach(() => {
		shipped = [];
	});

	function makeStart(requestId: string): StartMessage {
		return {
			type: "start",
			messageId: `msg-${requestId}`,
			requestId,
			accountId: `account-${requestId}`,
			method: "POST",
			path: "/v1/messages",
			// Two seconds in the past, so responseTime is non-zero and
			// tokensPerSecond is a real division rather than a divide-by-zero
			// branch that would pass whatever the collector computed.
			timestamp: Date.now() - 2_000,
			requestHeaders: {},
			requestBody: null,
			project: null,
			projectId: null,
			worktreePath: null,
			originalModel: null,
			appliedModel: null,
			responseStatus: 200,
			responseHeaders: {},
			isStream: true,
			providerName: "anthropic",
			accountBillingType: null,
			accountAutoPauseOnOverageEnabled: null,
			accountName: null,
			agentUsed: null,
			comboName: null,
			apiKeyId: null,
			apiKeyName: null,
			retryAttempt: 0,
			failoverAttempts: 0,
		};
	}

	function chunk(text: string): Uint8Array {
		return new TextEncoder().encode(text);
	}

	/**
	 * Runs one request to completion and returns the record that reached the
	 * exporter. Throws rather than returning undefined, so a request the
	 * collector silently skipped cannot read as an empty pass.
	 */
	async function shipOne(
		requestId: string,
		drive: () => void,
		end: Partial<EndMessage> = {},
	): Promise<Record<string, unknown>> {
		collector.handleStart(makeStart(requestId));
		drive();
		await collector.handleEnd({
			type: "end",
			requestId,
			success: true,
			...end,
		} as EndMessage);
		await flushOpenObserve();
		const record = shipped.find((entry) => entry.id === requestId);
		if (!record) {
			throw new Error(
				`No record reached shipRequestRecord for requestId=${requestId} (shipped ${shipped.length} record(s))`,
			);
		}
		return record;
	}

	test("a streaming request ships every token and cost field the collector computed", async () => {
		const requestId = "openobserve-stream";
		const record = await shipOne(requestId, () => {
			// message_start carries the opening counts. message_delta then
			// overwrites them, which is why the assertions below expect the
			// delta's numbers and not these.
			collector.handleChunk(
				requestId,
				chunk(
					'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-5-20250929","usage":{"input_tokens":11,"cache_read_input_tokens":3,"cache_creation_input_tokens":5,"output_tokens":0}}}\n\n',
				),
			);
			collector.handleChunk(
				requestId,
				chunk(
					'event: content_block_start\ndata: {"type":"content_block_start","index":0}\n\n',
				),
			);
			collector.handleChunk(
				requestId,
				chunk(
					'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":17,"cache_read_input_tokens":4,"output_tokens":29}}\n\n',
				),
			);
		});

		for (const field of TOKEN_AND_COST_FIELDS) {
			expect(record).toHaveProperty(field);
		}

		expect(record.model).toBe("claude-sonnet-4-5-20250929");
		// message_delta wins over message_start for input and cache-read.
		expect(record.inputTokens).toBe(17);
		expect(record.promptTokens).toBe(17);
		expect(record.cacheReadInputTokens).toBe(4);
		// cache_creation is absent from the delta, so message_start's value stands.
		expect(record.cacheCreationInputTokens).toBe(5);
		// The delta's output_tokens is the authoritative provider count.
		expect(record.outputTokens).toBe(29);
		expect(record.completionTokens).toBe(29);
		// 17 input + 29 output + 4 cache read + 5 cache creation.
		expect(record.totalTokens).toBe(55);
		expect(typeof record.tokensPerSecond).toBe("number");
		expect(record.tokensPerSecond as number).toBeGreaterThan(0);
		expect(typeof record.costUsd).toBe("number");
	});

	test("a non-streaming response ships the fields read from the JSON body", async () => {
		const requestId = "openobserve-non-stream";
		// No SSE chunks at all, so no model is seen in the stream and
		// extractUsageFromJson is the only path that can populate usage.
		const responseBody = Buffer.from(
			JSON.stringify({
				model: "claude-sonnet-4-5-20250929",
				usage: {
					input_tokens: 23,
					cache_read_input_tokens: 7,
					cache_creation_input_tokens: 2,
					output_tokens: 13,
				},
			}),
		).toString("base64");

		const record = await shipOne(
			requestId,
			() => {
				/* deliberately no chunks: this is the fallback path */
			},
			{ responseBody },
		);

		for (const field of TOKEN_AND_COST_FIELDS) {
			expect(record).toHaveProperty(field);
		}

		expect(record.model).toBe("claude-sonnet-4-5-20250929");
		expect(record.inputTokens).toBe(23);
		expect(record.promptTokens).toBe(23);
		expect(record.cacheReadInputTokens).toBe(7);
		expect(record.cacheCreationInputTokens).toBe(2);
		expect(record.outputTokens).toBe(13);
		expect(record.completionTokens).toBe(13);
		// 23 + 13 + 7 + 2.
		expect(record.totalTokens).toBe(45);
	});

	test("a request with no parsed usage ships with no token keys, not with zeros", async () => {
		const requestId = "openobserve-no-usage";
		// An error response with a body the collector cannot read usage out of.
		const responseBody = Buffer.from(
			JSON.stringify({ type: "error", error: { message: "overloaded" } }),
		).toString("base64");

		const record = await shipOne(
			requestId,
			() => {
				/* no chunks, and the body carries no usage object */
			},
			{ success: false, responseBody, error: "overloaded" },
		);

		// Absent, not zero. JSON.stringify drops undefined, so these keys never
		// reach the wire. Reading a missing key as 0 is exactly the averaging
		// mistake this shape exists to prevent.
		for (const field of TOKEN_AND_COST_FIELDS) {
			expect(record).not.toHaveProperty(field);
		}
		// The record itself still ships, carrying its identity and outcome.
		expect(record.id).toBe(requestId);
		expect(record.success).toBe(false);
		expect(record.statusCode).toBe(200);
	});
});
