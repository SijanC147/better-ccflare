import { afterEach, describe, expect, test } from "bun:test";
import { logBus } from "./log-bus";
import {
	configureOpenObserve,
	flush,
	type OpenObserveSettings,
	openObserveBufferSizes,
	openObserveEnabled,
	openObserveShipsPayloads,
	shipRequestRecord,
} from "./openobserve";

const originalFetch = globalThis.fetch;

function settings(
	overrides: Partial<OpenObserveSettings> = {},
): OpenObserveSettings {
	return {
		baseUrl: "http://openobserve.invalid:5080",
		org: "default",
		user: "user@example.com",
		token: "token",
		logStream: "better_ccflare_logs",
		requestStream: "better_ccflare_requests",
		shipPayloads: true,
		logMinLevel: "INFO",
		...overrides,
	};
}

interface Capture {
	url: string;
	headers: Record<string, string>;
	body: unknown[];
}

function captureFetch(captures: Capture[], ok = true): void {
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		captures.push({
			url: String(url),
			headers: (init.headers ?? {}) as Record<string, string>,
			body: JSON.parse(String(init.body)),
		});
		return new Response(ok ? "{}" : "nope", { status: ok ? 200 : 500 });
	}) as unknown as typeof fetch;
}

afterEach(async () => {
	configureOpenObserve(null);
	await flush();
	globalThis.fetch = originalFetch;
});

describe("openobserve exporter", () => {
	test("ships nothing and opens no connection when unconfigured", async () => {
		const captures: Capture[] = [];
		captureFetch(captures);
		configureOpenObserve(() => null);

		logBus.emit("log", { ts: 1, level: "INFO", msg: "hello" });
		shipRequestRecord({ id: "req-1" });
		await flush();

		expect(openObserveEnabled()).toBe(false);
		expect(openObserveShipsPayloads()).toBe(false);
		expect(openObserveBufferSizes()).toEqual({ logs: 0, requests: 0 });
		expect(captures).toHaveLength(0);
	});

	test("a base URL alone is not enough to ship payloads", () => {
		configureOpenObserve(() => settings({ shipPayloads: false }));
		expect(openObserveEnabled()).toBe(true);
		expect(openObserveShipsPayloads()).toBe(false);
	});

	test("posts log events to the log stream with basic auth", async () => {
		const captures: Capture[] = [];
		captureFetch(captures);
		configureOpenObserve(() => settings());

		logBus.emit("log", { ts: 1700000000000, level: "WARN", msg: "careful" });
		await flush();

		expect(captures).toHaveLength(1);
		expect(captures[0].url).toBe(
			"http://openobserve.invalid:5080/api/default/better_ccflare_logs/_json",
		);
		expect(captures[0].headers.Authorization).toBe(
			`Basic ${Buffer.from("user@example.com:token").toString("base64")}`,
		);
		expect(captures[0].body).toEqual([
			{
				_timestamp: 1700000000000,
				level: "WARN",
				msg: "careful",
				service: "better-ccflare",
			},
		]);
	});

	test("posts request records to the request stream", async () => {
		const captures: Capture[] = [];
		captureFetch(captures);
		configureOpenObserve(() => settings());

		shipRequestRecord({ id: "req-1", requestBody: '{"model":"x"}' });
		await flush();

		expect(captures).toHaveLength(1);
		expect(captures[0].url).toContain("/better_ccflare_requests/_json");
		const [record] = captures[0].body as Array<Record<string, unknown>>;
		expect(record.id).toBe("req-1");
		expect(record.requestBody).toBe('{"model":"x"}');
		expect(typeof record._timestamp).toBe("number");
	});

	test("ships every token and cost field the usage collector sets", async () => {
		const captures: Capture[] = [];
		captureFetch(captures);
		configureOpenObserve(() => settings());

		// The ten fields `UsageCollector._handleEndInternal` puts on its summary
		// (packages/proxy/src/usage-collector.ts:1031-1041). The exporter takes a
		// loose Record and never names them, so nothing else pins them: deleting
		// one from the summary literal would otherwise ship green.
		shipRequestRecord({
			id: "req-1",
			model: "claude-opus-5",
			promptTokens: 11,
			completionTokens: 22,
			totalTokens: 33,
			inputTokens: 11,
			cacheReadInputTokens: 44,
			cacheCreationInputTokens: 55,
			outputTokens: 22,
			costUsd: 0.0123,
			tokensPerSecond: 17.5,
		});
		await flush();

		expect(captures).toHaveLength(1);
		const [record] = captures[0].body as Array<Record<string, unknown>>;
		expect(record.model).toBe("claude-opus-5");
		expect(record.promptTokens).toBe(11);
		expect(record.completionTokens).toBe(22);
		expect(record.totalTokens).toBe(33);
		expect(record.inputTokens).toBe(11);
		expect(record.cacheReadInputTokens).toBe(44);
		expect(record.cacheCreationInputTokens).toBe(55);
		expect(record.outputTokens).toBe(22);
		expect(record.costUsd).toBe(0.0123);
		expect(record.tokensPerSecond).toBe(17.5);
	});

	test("omits token fields that were never measured rather than zeroing them", async () => {
		const captures: Capture[] = [];
		captureFetch(captures);
		configureOpenObserve(() => settings());

		// Every token field is optional on RequestResponse
		// (packages/types/src/request.ts:200-210) and JSON.stringify drops
		// undefined, so a request with no parsed usage — an error, a
		// non-message endpoint — ships with no token keys at all.
		//
		// Do not "fix" this into zeros. A zero reads as "no tokens were used";
		// a missing key reads as "this was not measured". avg() over a stream
		// padded with spurious zeros is not the average anyone intends.
		shipRequestRecord({
			id: "req-1",
			model: undefined,
			promptTokens: undefined,
			completionTokens: undefined,
			totalTokens: undefined,
			inputTokens: undefined,
			cacheReadInputTokens: undefined,
			cacheCreationInputTokens: undefined,
			outputTokens: undefined,
			costUsd: undefined,
			tokensPerSecond: undefined,
		});
		await flush();

		expect(captures).toHaveLength(1);
		const [record] = captures[0].body as Array<Record<string, unknown>>;
		for (const field of [
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
		]) {
			expect(Object.hasOwn(record, field)).toBe(false);
		}
		expect(record.id).toBe("req-1");
	});

	test("bounds the buffer and drops the oldest records under pressure", async () => {
		configureOpenObserve(() => settings());

		for (let i = 0; i < 1500; i++) {
			shipRequestRecord({ id: `req-${i}` });
		}

		expect(openObserveBufferSizes().requests).toBe(1000);

		const captures: Capture[] = [];
		captureFetch(captures);
		await flush();

		const shipped = captures.flatMap(
			(c) => c.body as Array<Record<string, unknown>>,
		);
		expect(shipped).toHaveLength(1000);
		// The oldest 500 were evicted, so the window starts at req-500.
		expect(shipped[0].id).toBe("req-500");
		expect(shipped[shipped.length - 1].id).toBe("req-1499");
	});

	test("drops a failed batch rather than retaining it for retry", async () => {
		const captures: Capture[] = [];
		captureFetch(captures, false);
		configureOpenObserve(() => settings());

		shipRequestRecord({ id: "req-1" });
		await flush();
		expect(captures).toHaveLength(1);

		// Nothing is left buffered: a retry queue would be a second retention path.
		await flush();
		expect(captures).toHaveLength(1);
		expect(openObserveBufferSizes().requests).toBe(0);
	});

	test("turning the exporter off discards what is buffered", async () => {
		configureOpenObserve(() => settings());
		shipRequestRecord({ id: "req-1" });
		expect(openObserveBufferSizes().requests).toBe(1);

		configureOpenObserve(null);
		expect(openObserveBufferSizes().requests).toBe(0);
	});
});

/**
 * The exporter's buffers drop the oldest under pressure, so a DEBUG burst does
 * not merely add noise: it evicts the ERROR records that were the reason for
 * shipping logs at all. These tests pin the filter that stops that, and the
 * fallback that stops a typo doing something worse.
 */
describe("openobserve log minimum level", () => {
	test("drops an event below the configured level and ships one at it", async () => {
		const captures: Capture[] = [];
		captureFetch(captures);
		configureOpenObserve(() => settings({ logMinLevel: "INFO" }));

		logBus.emit("log", { ts: 1, level: "DEBUG", msg: "chatter" });
		logBus.emit("log", { ts: 2, level: "INFO", msg: "kept" });
		await flush();

		const msgs = captures.flatMap((c) =>
			(c.body as { msg: string }[]).map((r) => r.msg),
		);
		expect(msgs).toEqual(["kept"]);
	});

	test("ships every level above the configured one", async () => {
		const captures: Capture[] = [];
		captureFetch(captures);
		configureOpenObserve(() => settings({ logMinLevel: "WARN" }));

		logBus.emit("log", { ts: 1, level: "DEBUG", msg: "debug" });
		logBus.emit("log", { ts: 2, level: "INFO", msg: "info" });
		logBus.emit("log", { ts: 3, level: "WARN", msg: "warn" });
		logBus.emit("log", { ts: 4, level: "ERROR", msg: "error" });
		await flush();

		const msgs = captures.flatMap((c) =>
			(c.body as { msg: string }[]).map((r) => r.msg),
		);
		expect(msgs).toEqual(["warn", "error"]);
	});

	test("DEBUG ships everything, which is how the old behaviour is restored", async () => {
		const captures: Capture[] = [];
		captureFetch(captures);
		configureOpenObserve(() => settings({ logMinLevel: "DEBUG" }));

		logBus.emit("log", { ts: 1, level: "DEBUG", msg: "chatter" });
		await flush();

		const msgs = captures.flatMap((c) =>
			(c.body as { msg: string }[]).map((r) => r.msg),
		);
		expect(msgs).toEqual(["chatter"]);
	});

	// The silent-green case: a typo must not turn the log stream off, which
	// looks exactly like a working exporter with nothing to say.
	test("an unparseable level falls back to INFO rather than dropping everything", async () => {
		const captures: Capture[] = [];
		captureFetch(captures);
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		};
		try {
			configureOpenObserve(() => settings({ logMinLevel: "INFF" }));

			logBus.emit("log", { ts: 1, level: "DEBUG", msg: "below" });
			logBus.emit("log", { ts: 2, level: "INFO", msg: "at" });
			logBus.emit("log", { ts: 3, level: "ERROR", msg: "above" });
			await flush();
		} finally {
			console.warn = originalWarn;
		}

		const msgs = captures.flatMap((c) =>
			(c.body as { msg: string }[]).map((r) => r.msg),
		);
		expect(msgs).toEqual(["at", "above"]);
		// Warned once for the bad value, not once per event.
		expect(warnings.filter((w) => w.includes("INFF"))).toHaveLength(1);
	});

	test("an empty level means unset, which is the INFO default", async () => {
		const captures: Capture[] = [];
		captureFetch(captures);
		configureOpenObserve(() => settings({ logMinLevel: "" }));

		logBus.emit("log", { ts: 1, level: "DEBUG", msg: "below" });
		logBus.emit("log", { ts: 2, level: "INFO", msg: "at" });
		await flush();

		const msgs = captures.flatMap((c) =>
			(c.body as { msg: string }[]).map((r) => r.msg),
		);
		expect(msgs).toEqual(["at"]);
	});

	// server.ts installs `configureOpenObserve(() => config.getOpenObserveSettings())`
	// and currentSettings() calls it on every decision, so a level changed in the
	// dashboard takes effect with no restart. A test holding one settings object
	// would not exercise that, so this one drives the getter.
	test("a level change through the getter takes effect with no restart", async () => {
		const captures: Capture[] = [];
		captureFetch(captures);
		let level = "ERROR";
		configureOpenObserve(() => settings({ logMinLevel: level }));

		logBus.emit("log", { ts: 1, level: "INFO", msg: "before" });
		level = "DEBUG";
		logBus.emit("log", { ts: 2, level: "INFO", msg: "after" });
		await flush();

		const msgs = captures.flatMap((c) =>
			(c.body as { msg: string }[]).map((r) => r.msg),
		);
		expect(msgs).toEqual(["after"]);
	});

	// Request records carry no level and are the other half of the feature.
	// Filtering them would silently stop shipping request data.
	test("the minimum level does not filter the request stream", async () => {
		const captures: Capture[] = [];
		captureFetch(captures);
		configureOpenObserve(() => settings({ logMinLevel: "ERROR" }));

		shipRequestRecord({ id: "req-1" });
		await flush();

		const requestPosts = captures.filter((c) =>
			c.url.includes("better_ccflare_requests"),
		);
		expect(requestPosts).toHaveLength(1);
		expect((requestPosts[0].body as { id: string }[])[0].id).toBe("req-1");
	});
});
