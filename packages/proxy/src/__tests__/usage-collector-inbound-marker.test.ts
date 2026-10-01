/**
 * SB23-2727. The inbound marker flows from a `StartMessage`'s raw header map
 * through the real `UsageCollector` onto both the live summary and the stored
 * `requests` row, while the payload copy of the same headers is redacted.
 *
 * The redaction trap is the reason this drives the real collector: #258 turns
 * every `x-better-ccflare-*` value into "[redacted]" on its way to storage, so
 * a marker read after that point would record "[redacted]" as its format. The
 * extraction must run on the raw map at start.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AsyncDbWriter,
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import {
	INBOUND_FORMAT_HEADER,
	INBOUND_GATEWAY_HEADER,
	type RequestResponse,
} from "@better-ccflare/types";
import {
	extractInboundMarkerFromParts,
	extractInboundMarkerFromRequest,
} from "../inbound-marker";
import { UsageCollector } from "../usage-collector";
import type { EndMessage, StartMessage } from "../worker-messages";

describe("extractInboundMarker", () => {
	test("reads a known format and a valid gateway name", () => {
		expect(
			extractInboundMarkerFromRequest(
				new Headers({
					[INBOUND_FORMAT_HEADER]: "openai-chat",
					[INBOUND_GATEWAY_HEADER]: "work",
				}),
			),
		).toEqual({ format: "openai-chat", gateway: "work" });
	});

	test("records no gateway for the plain endpoints", () => {
		expect(
			extractInboundMarkerFromParts({
				[INBOUND_FORMAT_HEADER]: "openai-responses",
			}),
		).toEqual({ format: "openai-responses", gateway: null });
	});

	test("an unknown format records nothing, gateway included", () => {
		expect(
			extractInboundMarkerFromParts({
				[INBOUND_FORMAT_HEADER]: "[redacted]",
				[INBOUND_GATEWAY_HEADER]: "work",
			}),
		).toEqual({ format: null, gateway: null });
	});

	test("an invalid gateway name records the format only", () => {
		expect(
			extractInboundMarkerFromParts({
				[INBOUND_FORMAT_HEADER]: "openai-chat",
				[INBOUND_GATEWAY_HEADER]: "Not A Name",
			}),
		).toEqual({ format: "openai-chat", gateway: null });
	});

	test("header names are matched case-insensitively", () => {
		expect(
			extractInboundMarkerFromParts({
				"X-Better-CCFlare-Inbound-Format": "openai-chat",
				"X-Better-CCFlare-Inbound-Gateway": "work",
			}),
		).toEqual({ format: "openai-chat", gateway: "work" });
	});
});

describe("UsageCollector - inbound marker", () => {
	const dir = mkdtempSync(join(tmpdir(), "inbound-marker-"));
	const dbPath = join(dir, "test.db");
	let dbOps: DatabaseOperations;
	let asyncWriter: AsyncDbWriter;
	let collector: UsageCollector;
	const summaries = new Map<string, RequestResponse>();

	beforeAll(() => {
		DatabaseFactory.initialize(dbPath);
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

	// The `trash` spawn is the whole cost of this hook: 12 copies of this file
	// at load average 138 measured it at 2750 to 3390 ms, against under 130 ms
	// for dispose, drain and reset together, and in a loaded full suite the
	// hook passed Bun's 5000 ms default (SB23-3905), which Bun reports as an
	// extra "(unnamed)" failure. So the hook carries its own limit. `trash` is
	// macOS-only, and on the Linux CI runner the old `.nothrow()` swallowed its
	// absence and left the directory behind on every run.
	afterAll(async () => {
		collector.dispose();
		await collector.drain();
		DatabaseFactory.reset();
		const trashed =
			Bun.which("trash") && Bun.spawnSync(["trash", dir]).exitCode === 0;
		if (!trashed) rmSync(dir, { recursive: true, force: true });
	}, 30_000);

	function makeStart(
		requestId: string,
		requestHeaders: Record<string, string>,
	): StartMessage {
		return {
			type: "start",
			messageId: `msg-${requestId}`,
			requestId,
			accountId: null,
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now(),
			requestHeaders,
			requestBody: null,
			project: null,
			responseStatus: 200,
			responseHeaders: {},
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
			projectId: null,
			worktreePath: null,
			originalModel: null,
			appliedModel: null,
		};
	}

	async function run(
		requestId: string,
		requestHeaders: Record<string, string>,
	): Promise<RequestResponse> {
		collector.handleStart(makeStart(requestId, requestHeaders));
		const end: EndMessage = { type: "end", requestId, success: true };
		await collector.handleEnd(end);
		const summary = summaries.get(requestId);
		if (!summary) throw new Error(`no summary for ${requestId}`);
		return summary;
	}

	/** The save is queued on the async writer, so poll for the row. */
	async function storedRow(requestId: string) {
		for (let attempt = 0; attempt < 100; attempt++) {
			const row = await dbOps.getAdapter().get<{
				path: string;
				inbound_format: string | null;
				inbound_gateway: string | null;
			}>(
				"SELECT path, inbound_format, inbound_gateway FROM requests WHERE id = ?",
				[requestId],
			);
			if (row) return row;
			await Bun.sleep(20);
		}
		throw new Error(`no stored row for ${requestId}`);
	}

	test("a gateway chat request is labelled on the summary and the stored row, not [redacted]", async () => {
		const summary = await run("inbound-chat", {
			[INBOUND_FORMAT_HEADER]: "openai-chat",
			[INBOUND_GATEWAY_HEADER]: "work",
		});
		expect(summary.inboundFormat).toBe("openai-chat");
		expect(summary.inboundGateway).toBe("work");

		const row = await storedRow("inbound-chat");
		expect(row).toEqual({
			path: "/v1/messages",
			inbound_format: "openai-chat",
			inbound_gateway: "work",
		});
	});

	test("a plain Responses request is labelled with no gateway", async () => {
		const summary = await run("inbound-responses", {
			[INBOUND_FORMAT_HEADER]: "openai-responses",
		});
		expect(summary.inboundFormat).toBe("openai-responses");
		expect(summary.inboundGateway).toBeUndefined();
		expect(await storedRow("inbound-responses")).toEqual({
			path: "/v1/messages",
			inbound_format: "openai-responses",
			inbound_gateway: null,
		});
	});

	test("Claude Code traffic carries no marker", async () => {
		const summary = await run("inbound-none", {
			"user-agent": "claude-cli/2.1.300",
		});
		expect(summary.inboundFormat).toBeUndefined();
		expect(summary.inboundGateway).toBeUndefined();
		expect(await storedRow("inbound-none")).toEqual({
			path: "/v1/messages",
			inbound_format: null,
			inbound_gateway: null,
		});
	});
});
