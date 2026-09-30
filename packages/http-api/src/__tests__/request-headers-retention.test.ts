/**
 * SB23-2572: headers-only request storage must persist the header set, and the
 * header set must be readable through `GET /api/requests/detail`.
 *
 * Before the fix, `request_storage_headers_only: true` with `store_payloads:
 * false` wrote no `request_payloads` row at all: the collector gated the write
 * on store_payloads alone, and computed headers-only as
 * `storePayloads && headersOnly`. `GET /api/config/request-storage` reported
 * `headersOnly: true` throughout.
 *
 * These tests drive a real UsageCollector against a real SQLite database and
 * read back through the real detail handler, so they cover the write gate, the
 * redaction step and the read-side projection together. A test that stops at
 * `getRequestPayload` would pass a projection defect; one that stubs the
 * database would pass a write-gate defect.
 */
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AsyncDbWriter,
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import { REDACTED_HEADER_VALUE } from "@better-ccflare/http-common";
import {
	configureOpenObserve,
	flushOpenObserve,
	type OpenObserveSettings,
} from "@better-ccflare/logger";
// The collector class is not on the proxy barrel; the test needs the real one,
// not initProxy's singleton, to drive both storage switches per test.
import { UsageCollector } from "../../../proxy/src/usage-collector";
import type {
	EndMessage,
	StartMessage,
} from "../../../proxy/src/worker-messages";
import { createRequestStorageHandlers } from "../handlers/config-request-storage";
import { createRequestsDetailHandler } from "../handlers/requests";

const RAW_AUTHORIZATION = "Bearer sk-ant-oat01-must-not-be-stored";
const RAW_API_KEY = "sk-ant-api03-must-not-be-stored";
const RAW_PROBE_SECRET = "probe-secret-must-not-be-stored";
const USER_AGENT = "claude-cli/2.1.0 (external, cli)";
const REQUEST_BODY_TEXT = '{"model":"claude-opus-5","messages":[]}';
const RESPONSE_BODY_TEXT = '{"type":"message","content":[]}';

const OO_BASE_URL = "http://openobserve.invalid:5080";
const OO_REQUEST_STREAM = "better_ccflare_requests";

type DetailRow = {
	id: string;
	request: { headers?: Record<string, string>; body?: string | null };
	response: { headers?: Record<string, string>; body?: string | null };
	meta: Record<string, unknown>;
};

describe("headers-only request storage persists a readable header set (SB23-2572)", () => {
	const dir = mkdtempSync(join(tmpdir(), "sb23-2572-headers-"));
	const dbPath = join(dir, "headers.db");
	let dbOps: DatabaseOperations;
	let asyncWriter: AsyncDbWriter;
	let collector: UsageCollector;
	let storePayloads = false;
	let headersOnly = true;
	let shipped: Record<string, unknown>[] = [];
	const originalFetch = globalThis.fetch;

	beforeAll(() => {
		// Keeps the pricing refresh off the network and captures OpenObserve
		// posts for the one test that turns shipping on.
		globalThis.fetch = (async (
			url: string | URL | Request,
			init?: RequestInit,
		) => {
			const href = String(url instanceof Request ? url.url : url);
			if (href.startsWith(OO_BASE_URL) && href.includes(OO_REQUEST_STREAM)) {
				shipped.push(
					...(JSON.parse(String(init?.body)) as Record<string, unknown>[]),
				);
				return new Response("{}", { status: 200 });
			}
			if (href.startsWith(OO_BASE_URL)) return new Response("{}");
			return new Response("offline", { status: 503 });
		}) as unknown as typeof fetch;
		// initialize() only records the path, and getInstance() returns any
		// instance an earlier file in this process left behind, possibly on a
		// database that file has since unlinked.
		DatabaseFactory.reset();
		DatabaseFactory.initialize(dbPath);
		dbOps = DatabaseFactory.getInstance();
		asyncWriter = new AsyncDbWriter();
		collector = new UsageCollector(
			dbOps,
			asyncWriter,
			() => storePayloads,
			() => {},
			() => headersOnly,
		);
	});

	afterAll(async () => {
		collector.dispose();
		await collector.drain();
		configureOpenObserve(null);
		await flushOpenObserve();
		globalThis.fetch = originalFetch;
		DatabaseFactory.reset();
	});

	beforeEach(() => {
		storePayloads = false;
		headersOnly = true;
		shipped = [];
	});

	function makeStart(requestId: string): StartMessage {
		return {
			type: "start",
			messageId: `msg-${requestId}`,
			requestId,
			accountId: null,
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now(),
			// Raw, as the refusal and pool-exhausted paths in proxy.ts stage
			// them: nothing upstream of the collector has redacted these.
			requestHeaders: {
				authorization: RAW_AUTHORIZATION,
				"x-api-key": RAW_API_KEY,
				"x-better-ccflare-internal-probe-secret": RAW_PROBE_SECRET,
				"user-agent": USER_AGENT,
				"anthropic-version": "2023-06-01",
			},
			requestBody: Buffer.from(REQUEST_BODY_TEXT).toString("base64"),
			project: null,
			projectId: null,
			worktreePath: null,
			originalModel: null,
			appliedModel: null,
			responseStatus: 404,
			responseHeaders: { "content-type": "application/json" },
			isStream: false,
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

	async function runRequest(requestId: string): Promise<void> {
		collector.handleStart(makeStart(requestId));
		const end: EndMessage = {
			type: "end",
			requestId,
			success: false,
			responseBody: Buffer.from(RESPONSE_BODY_TEXT).toString("base64"),
		};
		await collector.handleEnd(end);
		await collector.drain();
	}

	type Internals = {
		requests: Map<
			string,
			{
				createdAt: number;
				retainedPayloadBytes: number;
				bodiesReleased: boolean;
				startMessage: StartMessage;
			}
		>;
		activePayloadBytes: number;
		pendingPayloadBytes: number;
		pendingPayloadCount: number;
		cleanupStaleRequests(): void;
		estimateCostWithDeadline: (...args: unknown[]) => Promise<number>;
	};
	const internals = (): Internals => collector as unknown as Internals;

	function withOpenObserveShipping(): void {
		configureOpenObserve(() => ({
			baseUrl: OO_BASE_URL,
			org: "default",
			user: "user@example.invalid",
			token: "not-a-real-token",
			logStream: "better_ccflare_logs",
			requestStream: OO_REQUEST_STREAM,
			shipPayloads: true,
			logMinLevel: "INFO",
		}));
	}

	/** The row as `GET /api/requests/detail` returns it, and its raw text. */
	async function readDetail(
		requestId: string,
	): Promise<{ row: DetailRow; text: string }> {
		const response = await createRequestsDetailHandler(dbOps)(1000);
		const text = await response.text();
		const rows = JSON.parse(text) as DetailRow[];
		const row = rows.find((r) => r.id === requestId);
		if (!row) throw new Error(`request ${requestId} missing from detail`);
		return { row, text };
	}

	test("store_payloads off + headers-only: the header set is readable through /api/requests/detail", async () => {
		const requestId = "sb23-2572-headers-only";
		await runRequest(requestId);

		const { row } = await readDetail(requestId);
		expect(row.request.headers?.["user-agent"]).toBe(USER_AGENT);
		expect(row.request.headers?.["anthropic-version"]).toBe("2023-06-01");
		expect(row.response.headers?.["content-type"]).toBe("application/json");
		expect(row.request.body).toBeNull();
		expect(row.response.body).toBeNull();
	});

	test("neither authorization nor x-api-key is stored, and the names show they were sent", async () => {
		const requestId = "sb23-2572-redaction";
		await runRequest(requestId);

		const { row, text } = await readDetail(requestId);
		expect(row.request.headers?.authorization).toBe(REDACTED_HEADER_VALUE);
		expect(row.request.headers?.["x-api-key"]).toBe(REDACTED_HEADER_VALUE);
		expect(
			row.request.headers?.["x-better-ccflare-internal-probe-secret"],
		).toBe(REDACTED_HEADER_VALUE);
		// Negative, over the whole response text and the stored row, so a value
		// that leaked into any other field is caught as well.
		const stored = JSON.stringify(await dbOps.getRequestPayload(requestId));
		for (const secret of [RAW_AUTHORIZATION, RAW_API_KEY, RAW_PROBE_SECRET]) {
			expect(text).not.toContain(secret);
			expect(stored).not.toContain(secret);
		}
	});

	test("store_payloads off + headers-only off: no row, and the detail row says so by its shape", async () => {
		headersOnly = false;
		const requestId = "sb23-2572-nothing";
		await runRequest(requestId);

		expect(await dbOps.getRequestPayload(requestId)).toBeNull();
		const { row } = await readDetail(requestId);
		expect(row.request).toEqual({});
	});

	test("store_payloads on + headers-only off: headers and bodies are both stored", async () => {
		storePayloads = true;
		headersOnly = false;
		const requestId = "sb23-2572-full";
		await runRequest(requestId);

		const { row, text } = await readDetail(requestId);
		expect(row.request.headers?.["user-agent"]).toBe(USER_AGENT);
		expect(
			Buffer.from(row.request.body ?? "", "base64").toString("utf-8"),
		).toBe(REQUEST_BODY_TEXT);
		expect(
			Buffer.from(row.response.body ?? "", "base64").toString("utf-8"),
		).toBe(RESPONSE_BODY_TEXT);
		expect(text).not.toContain(RAW_AUTHORIZATION);
	});

	test("store_payloads on + headers-only on: headers stored, bodies dropped", async () => {
		storePayloads = true;
		const requestId = "sb23-2572-both-on";
		await runRequest(requestId);

		const { row } = await readDetail(requestId);
		expect(row.request.headers?.["user-agent"]).toBe(USER_AGENT);
		expect(row.request.body).toBeNull();
		expect(row.response.body).toBeNull();
	});

	test("a stream still active past the payload retention bound keeps its headers", async () => {
		const requestId = "sb23-2572-long-stream";
		collector.handleStart({ ...makeStart(requestId), isStream: true });
		const state = internals().requests.get(requestId);
		if (!state) throw new Error("collector did not track the request");
		// Older than REQUEST_PAYLOAD_RETENTION_MS (2 min), younger than the
		// stream inactivity timeout, so only the payload bound fires.
		state.createdAt = Date.now() - 3 * 60 * 1000;
		internals().cleanupStaleRequests();
		await collector.handleEnd({ type: "end", requestId, success: true });
		await collector.drain();

		const { row } = await readDetail(requestId);
		expect(row.request.headers?.["user-agent"]).toBe(USER_AGENT);
		expect(row.request.headers?.authorization).toBe(REDACTED_HEADER_VALUE);
		// Headers-only never held a body, so the row must not claim one was
		// dropped.
		expect(row.meta.bodiesReleased).toBeUndefined();
	});

	test("headers-only without shipping holds no request body in memory", () => {
		const requestId = "sb23-2572-no-body-held";
		collector.handleStart(makeStart(requestId));
		const state = internals().requests.get(requestId);
		if (!state) throw new Error("collector did not track the request");
		expect(state.startMessage.requestBody).toBeNull();
		expect(state.retainedPayloadBytes).toBe(0);
		expect(internals().activePayloadBytes).toBe(0);
		internals().requests.delete(requestId);
	});

	test("a request refused by the start-side byte budget still writes its headers, flagged bodiesReleased", async () => {
		storePayloads = true;
		headersOnly = false;
		const requestId = "sb23-2572-start-budget";
		const nearCap = 100 * 1024 * 1024 - 1;
		internals().activePayloadBytes = nearCap;
		try {
			collector.handleStart(makeStart(requestId));
			const state = internals().requests.get(requestId);
			expect(state?.bodiesReleased).toBe(true);
			expect(state?.startMessage.requestHeaders["user-agent"]).toBe(USER_AGENT);
		} finally {
			internals().activePayloadBytes = 0;
		}
		await collector.handleEnd({ type: "end", requestId, success: true });
		await collector.drain();

		const { row } = await readDetail(requestId);
		expect(row.request.headers?.["user-agent"]).toBe(USER_AGENT);
		expect(row.request.body).toBeNull();
		expect(row.meta.bodiesReleased).toBe(true);
	});

	test("shipping bodies with nothing persisted returns every finalizer reservation", async () => {
		headersOnly = false;
		withOpenObserveShipping();
		try {
			await runRequest("sb23-2572-ship-only");
			await flushOpenObserve();
			expect(await dbOps.getRequestPayload("sb23-2572-ship-only")).toBeNull();
			expect(internals().pendingPayloadBytes).toBe(0);
			expect(internals().pendingPayloadCount).toBe(0);
		} finally {
			configureOpenObserve(null);
			await flushOpenObserve();
		}
	});

	test("a pricing failure after serialisation returns both reservations", async () => {
		withOpenObserveShipping();
		const original = internals().estimateCostWithDeadline;
		internals().estimateCostWithDeadline = async () => {
			throw new Error("pricing unavailable");
		};
		try {
			const requestId = "sb23-2572-pricing-throw";
			collector.handleStart(makeStart(requestId));
			const usageBody = Buffer.from(
				JSON.stringify({
					type: "message",
					model: "claude-opus-5",
					usage: { input_tokens: 3, output_tokens: 2 },
				}),
			).toString("base64");
			let threw = false;
			try {
				await collector.handleEnd({
					type: "end",
					requestId,
					success: true,
					responseBody: usageBody,
				});
			} catch {
				threw = true;
			}
			// The throw path is the one under test; a run that never reached it
			// would read 0 for the reason the test is not about.
			expect(threw).toBe(true);
			expect(internals().pendingPayloadBytes).toBe(0);
			expect(internals().pendingPayloadCount).toBe(0);
		} finally {
			internals().estimateCostWithDeadline = original;
			configureOpenObserve(null);
			await flushOpenObserve();
		}
	});

	test("with OpenObserve shipping bodies, the row stays headers-only and the shipped record keeps its bodies", async () => {
		const settings: OpenObserveSettings = {
			baseUrl: OO_BASE_URL,
			org: "default",
			user: "user@example.invalid",
			token: "not-a-real-token",
			logStream: "better_ccflare_logs",
			requestStream: OO_REQUEST_STREAM,
			shipPayloads: true,
			logMinLevel: "INFO",
		};
		configureOpenObserve(() => settings);
		try {
			const requestId = "sb23-2572-openobserve";
			await runRequest(requestId);
			await flushOpenObserve();

			const { row } = await readDetail(requestId);
			expect(row.request.headers?.["user-agent"]).toBe(USER_AGENT);
			expect(row.request.body).toBeNull();
			expect(row.response.body).toBeNull();

			const record = shipped.find((r) => r.id === requestId);
			if (!record) throw new Error("no OpenObserve record was shipped");
			expect(record.requestBody).toBe(REQUEST_BODY_TEXT);
			expect(record.responseBody).toBe(RESPONSE_BODY_TEXT);
			expect(String(record.requestHeaders)).toContain(USER_AGENT);
			expect(String(record.requestHeaders)).not.toContain(RAW_API_KEY);
		} finally {
			configureOpenObserve(null);
			await flushOpenObserve();
		}
	});

	test("GET /api/config/request-storage reports what is persisted, not only the switch", async () => {
		const read = async (store: boolean, only: boolean) => {
			const config = {
				getStorePayloads: () => store,
				getRequestStorageHeadersOnly: () => only,
			} as unknown as import("@better-ccflare/config").Config;
			return (await createRequestStorageHandlers(config)
				.getRequestStorage()
				.json()) as Record<string, unknown>;
		};
		expect(await read(false, true)).toEqual({
			headersOnly: true,
			storePayloads: false,
			persists: "headers",
		});
		expect(await read(false, false)).toEqual({
			headersOnly: false,
			storePayloads: false,
			persists: "none",
		});
		expect(await read(true, false)).toEqual({
			headersOnly: false,
			storePayloads: true,
			persists: "full",
		});
		expect(await read(true, true)).toEqual({
			headersOnly: true,
			storePayloads: true,
			persists: "headers",
		});
	});
});
