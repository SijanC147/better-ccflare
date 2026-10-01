import { afterEach, describe, expect, jest, test } from "bun:test";
import { logBus } from "./log-bus";
import {
	configureOpenObserve,
	flush,
	type OpenObserveSettings,
	openObserveBufferSizes,
	openObserveEnabled,
	openObserveShipsPayloads,
	resetMetricsForTests,
	resetWarnThrottleForTests,
	shipMetricsSnapshot,
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
		metricsStream: "better_ccflare_exporter_metrics",
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

/**
 * Mock `fetch`, recording every call. `status` is what the endpoint answers,
 * or the string "throw" for a transport failure with no response at all —
 * the shape a DNS failure, a refused connection or the request timeout takes.
 */
function captureFetch(
	captures: Capture[],
	status: number | "throw" | boolean = 200,
): void {
	// `true`/`false` kept so the existing callers read unchanged.
	const resolved = status === true ? 200 : status === false ? 500 : status;
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		captures.push({
			url: String(url),
			headers: (init.headers ?? {}) as Record<string, string>,
			body: JSON.parse(String(init.body)),
		});
		if (resolved === "throw") {
			throw new TypeError("fetch failed");
		}
		return new Response(resolved === 200 ? "{}" : "nope", {
			status: resolved,
		});
	}) as unknown as typeof fetch;
}

/**
 * The exporter reports its failures on `console.warn`, which is the right
 * place for them and the wrong place for a test run. Returns what was warned
 * so the tests that care can assert on it.
 */
async function withSilencedWarnings(
	run: () => Promise<unknown> | unknown,
): Promise<string[]> {
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map(String).join(" "));
	};
	try {
		await run();
	} finally {
		console.warn = originalWarn;
	}
	return warnings;
}

const WARN_WINDOW_MS = 60_000;
const originalDateNow = Date.now;

/**
 * Backoff is measured against the wall clock, so the tests that exercise it
 * need to own the clock. Advancing it is how a test reaches the far side of a
 * retry window without sleeping for it.
 *
 * Each call starts a fresh hour ahead of the last, never at a fixed literal,
 * because `warnThrottled` and the backoff both keep module-level timestamps
 * that outlive a test. A clock that starts level with or behind them reads as
 * "warned moments ago" or "still inside the window", which silently suppresses
 * the very thing a test is asserting on. Only ever move this clock forward.
 */
let clockEpoch = 0;

function fakeClock(): { advance: (ms: number) => void } {
	clockEpoch++;
	let now = originalDateNow() + clockEpoch * 3_600_000;
	Date.now = () => now;
	// Push the throttle's own stamp forward with the clock. `lastWarnAt` is
	// module-level and outlives the test that set it, so a later test starting
	// a fresh epoch would otherwise see a `lastWarnAt` from the future, read
	// `now - lastWarnAt` as negative, and suppress every warning it asserts on.
	// That failure is silent and looks exactly like a passing test.
	resetWarnThrottleForTests(now);
	return {
		advance: (ms: number) => {
			now += ms;
		},
	};
}

afterEach(async () => {
	Date.now = originalDateNow;
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

	test("drops a batch the endpoint refuses rather than retaining it", async () => {
		const captures: Capture[] = [];
		captureFetch(captures, 401);
		configureOpenObserve(() => settings());

		shipRequestRecord({ id: "req-1" });
		await withSilencedWarnings(() => flush());
		expect(captures).toHaveLength(1);

		// A 401 is the caller's fault and will not become right by being sent
		// again. Nothing is left buffered.
		await withSilencedWarnings(() => flush());
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

/**
 * Retry, under the one constraint the exporter is built around: there is no
 * second retention path. A deferred batch goes back to the front of the same
 * bounded buffer it came from, and that buffer's own eviction bound is what
 * discards under pressure. Nothing new holds records anywhere.
 */
describe("openobserve retry", () => {
	test("keeps a batch the endpoint could not accept and re-sends it", async () => {
		const captures: Capture[] = [];
		captureFetch(captures, 503);
		configureOpenObserve(() => settings());
		const clock = fakeClock();

		shipRequestRecord({ id: "req-1" });
		await withSilencedWarnings(() => flush());

		expect(captures).toHaveLength(1);
		// The record is still held. Under the old behaviour it was gone.
		expect(openObserveBufferSizes().requests).toBe(1);

		captureFetch(captures, 200);
		clock.advance(60_000);
		await flush();

		expect(captures).toHaveLength(2);
		expect((captures[1].body as { id: string }[])[0].id).toBe("req-1");
		expect(openObserveBufferSizes().requests).toBe(0);
	});

	test("keeps a batch when the request never reached the endpoint", async () => {
		const captures: Capture[] = [];
		captureFetch(captures, "throw");
		configureOpenObserve(() => settings());
		const clock = fakeClock();

		shipRequestRecord({ id: "req-1" });
		await withSilencedWarnings(() => flush());
		expect(openObserveBufferSizes().requests).toBe(1);

		captureFetch(captures, 200);
		clock.advance(60_000);
		await flush();

		expect(captures).toHaveLength(2);
		expect((captures[1].body as { id: string }[])[0].id).toBe("req-1");
	});

	test("re-sends in the original order, oldest first", async () => {
		const captures: Capture[] = [];
		captureFetch(captures, 503);
		configureOpenObserve(() => settings());
		const clock = fakeClock();

		for (let i = 0; i < 250; i++) shipRequestRecord({ id: `req-${i}` });
		// One batch of 100 is attempted, fails, and goes back to the front.
		await withSilencedWarnings(() => flush());
		expect(captures).toHaveLength(1);
		expect(openObserveBufferSizes().requests).toBe(250);

		captureFetch(captures, 200);
		clock.advance(60_000);
		await flush();

		const shipped = captures
			.slice(1)
			.flatMap((c) => c.body as Array<{ id: string }>);
		expect(shipped).toHaveLength(250);
		expect(shipped[0].id).toBe("req-0");
		expect(shipped[249].id).toBe("req-249");
	});

	test("does not touch the endpoint again inside the backoff window", async () => {
		const captures: Capture[] = [];
		captureFetch(captures, 503);
		configureOpenObserve(() => settings());
		const clock = fakeClock();

		shipRequestRecord({ id: "req-1" });
		await withSilencedWarnings(() => flush());
		expect(captures).toHaveLength(1);

		// Second failure doubles the window, so the third flush is inside it.
		clock.advance(2_000);
		await withSilencedWarnings(() => flush());
		expect(captures).toHaveLength(2);

		clock.advance(1_000);
		await withSilencedWarnings(() => flush());
		expect(captures).toHaveLength(2);
		expect(openObserveBufferSizes().requests).toBe(1);
	});

	test("a success clears the backoff, so the next failure starts over", async () => {
		const captures: Capture[] = [];
		captureFetch(captures, 503);
		configureOpenObserve(() => settings());
		const clock = fakeClock();

		// Four failures would take the window well past the first step.
		for (let i = 0; i < 4; i++) {
			shipRequestRecord({ id: `req-${i}` });
			await withSilencedWarnings(() => flush());
			clock.advance(60_000);
		}
		expect(captures).toHaveLength(4);

		captureFetch(captures, 200);
		await flush();
		expect(captures).toHaveLength(5);
		expect(openObserveBufferSizes().requests).toBe(0);

		// Backoff is back at its first step: one tick's wait, not the escalated one.
		captureFetch(captures, 503);
		shipRequestRecord({ id: "after" });
		await withSilencedWarnings(() => flush());
		expect(captures).toHaveLength(6);

		captureFetch(captures, 200);
		clock.advance(2_000);
		await flush();
		expect(captures).toHaveLength(7);
	});

	/**
	 * The test that proves the design, and it has to be written carefully to
	 * mean anything.
	 *
	 * `takeBatch` removes a batch from the buffer before it is posted, so
	 * putting that same batch back can never by itself exceed the bound: it is
	 * returning borrowed room. A test that only fills to the bound and fails a
	 * batch therefore passes whether or not eviction runs after the re-queue,
	 * and proves nothing. Measured: deleting the `evictOverflow` call in
	 * `requeue` leaves such a test green.
	 *
	 * The ONLY window that can actually overflow is a record arriving while the
	 * post is in flight: `post` is awaited, and `logBus` delivers synchronously
	 * into that await, so the buffer can refill to the bound underneath a batch
	 * that is still on its way back. The mock below produces exactly that, by
	 * enqueuing inside the `fetch` handler.
	 *
	 * Do not simplify this back to "fill the buffer, fail a batch, check the
	 * size". It looks equivalent and is not: it is the version that was already
	 * measured green against the mutation. If this test ever stops needing the
	 * refill inside `fetch`, check that `takeBatch` still removes before the
	 * post before believing it.
	 */
	test("a batch deferred while new records arrive cannot exceed the bound", async () => {
		const captures: Capture[] = [];
		configureOpenObserve(() => settings());
		const clock = fakeClock();

		let refilled = false;
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			captures.push({
				url: String(url),
				headers: (init.headers ?? {}) as Record<string, string>,
				body: JSON.parse(String(init.body)),
			});
			if (!refilled) {
				refilled = true;
				// 100 records were taken for this batch. Refill that room while
				// the request is in flight, so the batch has nowhere to land.
				for (let i = 1000; i < 1100; i++) shipRequestRecord({ id: `req-${i}` });
			}
			return new Response("nope", { status: 503 });
		}) as unknown as typeof fetch;

		for (let i = 0; i < 1000; i++) shipRequestRecord({ id: `req-${i}` });
		expect(openObserveBufferSizes().requests).toBe(1000);

		await withSilencedWarnings(() => flush());

		// Still exactly at the bound, never above it.
		expect(openObserveBufferSizes().requests).toBe(1000);

		// And the 100 evicted are the oldest, which are the deferred ones: a
		// record already rejected once loses to a record not yet tried.
		captureFetch(captures, 200);
		clock.advance(60_000);
		await withSilencedWarnings(() => flush());
		const shipped = captures
			.slice(1)
			.flatMap((c) => c.body as Array<{ id: string }>);
		expect(shipped).toHaveLength(1000);
		expect(shipped[0].id).toBe("req-100");
		expect(shipped[999].id).toBe("req-1099");
	});

	test("eviction under retry still keeps the newest window, in order", async () => {
		const captures: Capture[] = [];
		captureFetch(captures, 503);
		configureOpenObserve(() => settings());
		const clock = fakeClock();

		for (let i = 0; i < 1000; i++) shipRequestRecord({ id: `req-${i}` });
		await withSilencedWarnings(() => flush());
		expect(openObserveBufferSizes().requests).toBe(1000);

		// Production keeps running while the endpoint is down. The held batch
		// gets no protection from being the one that was retried.
		for (let i = 1000; i < 1500; i++) shipRequestRecord({ id: `req-${i}` });
		expect(openObserveBufferSizes().requests).toBe(1000);

		captureFetch(captures, 200);
		clock.advance(60_000);
		await withSilencedWarnings(() => flush());
		const shipped = captures
			.slice(1)
			.flatMap((c) => c.body as Array<{ id: string }>);
		expect(shipped).toHaveLength(1000);
		expect(shipped[0].id).toBe("req-500");
		expect(shipped[999].id).toBe("req-1499");
	});

	test("a refused batch is dropped and does not set a backoff", async () => {
		const captures: Capture[] = [];
		captureFetch(captures, 400);
		configureOpenObserve(() => settings());
		const clock = fakeClock();

		shipRequestRecord({ id: "req-1" });
		const warnings = await withSilencedWarnings(() => flush());
		expect(openObserveBufferSizes().requests).toBe(0);
		expect(warnings.join(" ")).toContain("400");

		// No window was opened, so the very next tick posts the next record.
		shipRequestRecord({ id: "req-2" });
		clock.advance(1);
		await withSilencedWarnings(() => flush());
		expect(captures).toHaveLength(2);
		expect((captures[1].body as { id: string }[])[0].id).toBe("req-2");
	});

	test("the two streams back off independently", async () => {
		const captures: Capture[] = [];
		configureOpenObserve(() => settings());
		const clock = fakeClock();
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			captures.push({
				url: String(url),
				headers: (init.headers ?? {}) as Record<string, string>,
				body: JSON.parse(String(init.body)),
			});
			// Only the request stream is failing.
			const failing = String(url).includes("better_ccflare_requests");
			return new Response(failing ? "nope" : "{}", {
				status: failing ? 503 : 200,
			});
		}) as unknown as typeof fetch;

		logBus.emit("log", { ts: 1, level: "INFO", msg: "first" });
		shipRequestRecord({ id: "req-1" });
		await withSilencedWarnings(() => flush());
		expect(openObserveBufferSizes()).toEqual({ logs: 0, requests: 1 });

		// The log stream never failed, so it is not sitting behind the request
		// stream's window.
		clock.advance(1);
		logBus.emit("log", { ts: 2, level: "INFO", msg: "second" });
		await withSilencedWarnings(() => flush());

		const logPosts = captures.filter((c) =>
			c.url.includes("better_ccflare_logs"),
		);
		expect(logPosts).toHaveLength(2);
		expect(openObserveBufferSizes().requests).toBe(1);
	});

	test("the shutdown flush ignores a backoff window it would otherwise wait out", async () => {
		const captures: Capture[] = [];
		captureFetch(captures, 503);
		configureOpenObserve(() => settings());
		const clock = fakeClock();

		shipRequestRecord({ id: "req-1" });
		await withSilencedWarnings(() => flush());
		expect(captures).toHaveLength(1);

		// An ordinary flush inside the window does nothing.
		clock.advance(1);
		await withSilencedWarnings(() => flush());
		expect(captures).toHaveLength(1);

		// The shutdown flush gets its one last attempt: the alternative is
		// losing the records at exit, which is what it exists to prevent.
		captureFetch(captures, 200);
		await flush(true);
		expect(captures).toHaveLength(2);
		expect(openObserveBufferSizes().requests).toBe(0);
	});

	// Found in review. `flush()` returns early when `flushing` is set, and the
	// timer-driven pass can be parked in `post` for the full 10s timeout
	// against the endpoint that is failing — having already skipped every
	// stream in backoff. A forced flush that returned an instantly-resolved
	// promise there would let shutdown proceed and lose exactly the records
	// `force` exists to save. The window is widest in the retry case itself.
	test("a forced flush waits for a pass already in progress instead of returning", async () => {
		const captures: Capture[] = [];
		configureOpenObserve(() => settings());
		fakeClock();

		let releaseFirstPost: (() => void) | null = null;
		const firstPostStarted = new Promise<void>((startedResolve) => {
			globalThis.fetch = (async (url: string, init: RequestInit) => {
				captures.push({
					url: String(url),
					headers: (init.headers ?? {}) as Record<string, string>,
					body: JSON.parse(String(init.body)),
				});
				if (!releaseFirstPost) {
					await new Promise<void>((release) => {
						releaseFirstPost = release;
						startedResolve();
					});
					return new Response("nope", { status: 503 });
				}
				return new Response("{}", { status: 200 });
			}) as unknown as typeof fetch;
		});

		shipRequestRecord({ id: "req-1" });
		const slow = withSilencedWarnings(() => flush());
		await firstPostStarted;

		// The shutdown flush, issued while that pass is still parked.
		const forced = withSilencedWarnings(() => flush(true));
		(releaseFirstPost as unknown as () => void)();
		await slow;
		await forced;

		// Two posts: the one that failed, and the forced retry that succeeded.
		// Without the wait, `forced` resolves immediately and this is 1.
		expect(captures).toHaveLength(2);
		expect(openObserveBufferSizes().requests).toBe(0);
	});

	// Found in review. Both warnings share one 60s throttle window, and the
	// deferral is emitted first on every attempting tick, so the separate
	// buffer-pressure warning was always the suppressed one. Losing records is
	// not the half that may go unreported.
	test("the deferral warning carries the loss count", async () => {
		const captures: Capture[] = [];
		captureFetch(captures, 503);
		configureOpenObserve(() => settings());
		fakeClock();

		for (let i = 0; i < 1200; i++) shipRequestRecord({ id: `req-${i}` });
		const warnings = await withSilencedWarnings(() => flush());

		const deferral = warnings.find((w) => w.includes("deferring"));
		expect(deferral).toBeDefined();
		expect(deferral).toContain("200 older record(s) lost");
	});

	// Found in review. `fetch` throws a TypeError for a malformed URL and for a
	// network failure alike, so classifying every throw as retryable meant a
	// permanent config typo held un-shippable records forever, evicting real
	// ones behind them, while the warning promised another attempt in 60s.
	test("an unusable base URL drops rather than retrying forever", async () => {
		const captures: Capture[] = [];
		captureFetch(captures, 200);
		configureOpenObserve(() => settings({ baseUrl: "not a url" }));
		fakeClock();

		shipRequestRecord({ id: "req-1" });
		const warnings = await withSilencedWarnings(() => flush());

		// Never even attempted, and not retained.
		expect(captures).toHaveLength(0);
		expect(openObserveBufferSizes().requests).toBe(0);
		expect(warnings.join(" ")).toContain("unusable base URL");
	});

	// Found in review. Retry-to-front introduced head-of-line blocking that
	// dropping never had: a batch the endpoint keeps refusing with a 5xx goes
	// back to the front, is taken first by every later flush, and the `break`
	// stops the stream behind it. Before this commit the batch was dropped
	// after one attempt and the stream healed immediately; without a limit it
	// would ship nothing until 1000 newer records evicted the poison batch.
	test("gives up on a batch the endpoint keeps refusing, rather than stalling behind it", async () => {
		const captures: Capture[] = [];
		captureFetch(captures, 503);
		configureOpenObserve(() => settings());
		const clock = fakeClock();

		shipRequestRecord({ id: "poison" });
		// Six attempts is where the backoff reaches its cap.
		for (let i = 0; i < 6; i++) {
			await withSilencedWarnings(() => flush());
			clock.advance(60_000);
		}
		expect(captures).toHaveLength(6);
		// Dropped rather than held, so nothing is queued ahead of new records.
		expect(openObserveBufferSizes().requests).toBe(0);

		// The stream is usable again the moment the endpoint recovers, without
		// waiting for 1000 records to evict anything.
		captureFetch(captures, 200);
		shipRequestRecord({ id: "after" });
		await flush();
		expect(captures).toHaveLength(7);
		expect((captures[6].body as { id: string }[])[0].id).toBe("after");
	});

	// Found in review. The loss count was zeroed before the message carrying it
	// went through the throttle, so a suppressed message took the number with
	// it. At the 60s backoff cap the deferral lands right on the throttle
	// boundary, which is exactly when an operator most needs the figure.
	test("keeps the loss count until a warning actually carries it", async () => {
		const captures: Capture[] = [];
		captureFetch(captures, 503);
		configureOpenObserve(() => settings());
		const clock = fakeClock();

		// Overflow the buffer, then fail. The first deferral reports the losses.
		for (let i = 0; i < 1200; i++) shipRequestRecord({ id: `req-${i}` });
		const first = await withSilencedWarnings(() => flush());
		expect(first.find((w) => w.includes("deferring"))).toContain(
			"200 older record(s) lost",
		);

		// Now lose more inside the throttle window, where the message is
		// suppressed. The count must survive to the next emitted warning.
		for (let i = 1200; i < 1300; i++) shipRequestRecord({ id: `req-${i}` });
		clock.advance(4_000);
		await withSilencedWarnings(() => flush());

		clock.advance(WARN_WINDOW_MS + 60_000);
		const later = await withSilencedWarnings(() => flush());
		const deferral = later.find((w) => w.includes("deferring"));
		expect(deferral).toBeDefined();
		// 100 evicted by the new arrivals, plus the batch dropped at the
		// attempt limit. The number is non-zero either way; what matters is
		// that it was not thrown away by the suppressed message.
		expect(deferral).toMatch(/\d+ older record\(s\) lost/);
	});

	test("turning the exporter off clears the backoff too", async () => {
		const captures: Capture[] = [];
		captureFetch(captures, 503);
		configureOpenObserve(() => settings());
		const clock = fakeClock();

		shipRequestRecord({ id: "req-1" });
		await withSilencedWarnings(() => flush());
		expect(openObserveBufferSizes().requests).toBe(1);

		// Reconfiguring must not leave the new settings serving a window the old
		// ones opened.
		configureOpenObserve(null);
		configureOpenObserve(() => settings());
		captureFetch(captures, 200);
		clock.advance(1);
		shipRequestRecord({ id: "req-2" });
		await flush();

		expect(captures).toHaveLength(2);
		expect((captures[1].body as { id: string }[])[0].id).toBe("req-2");
	});
});

const METRICS_STREAM = "better_ccflare_exporter_metrics";

type MetricsRecord = Record<string, unknown> & {
	stream_kind: "logs" | "requests";
};

/** Every metrics post captured, in order. */
function metricsPosts(captures: Capture[]): MetricsRecord[][] {
	return captures
		.filter((c) => c.url.includes(METRICS_STREAM))
		.map((c) => c.body as MetricsRecord[]);
}

function kind(
	snapshot: MetricsRecord[],
	streamKind: "logs" | "requests",
): MetricsRecord {
	const record = snapshot.find((r) => r.stream_kind === streamKind);
	if (!record) throw new Error(`no ${streamKind} record in the snapshot`);
	return record;
}

/** Every record accepted is shipped, dropped for a named reason, or held. */
function balances(record: MetricsRecord): boolean {
	const n = (key: string) => record[key] as number;
	return (
		n("enqueued_records") ===
		n("shipped_records") +
			n("evicted_records") +
			n("failed_records") +
			n("exhausted_records") +
			n("discarded_records") +
			n("buffered_records") +
			n("in_flight_records")
	);
}

/**
 * SB23-1760: the exporter's own counters, shipped to a third stream over the
 * same bulk endpoint. The constraint is the same one retry was held to: no
 * second retention path. A snapshot is built when it is sent and posted once;
 * the counters are cumulative, so the next snapshot carries whatever a lost
 * one would have.
 */
describe("openobserve metrics", () => {
	test("posts one record per record stream to the metrics stream, with the counts so far", async () => {
		resetMetricsForTests();
		const captures: Capture[] = [];
		captureFetch(captures);
		configureOpenObserve(() => settings());

		logBus.emit("log", { ts: 1, level: "INFO", msg: "one" });
		logBus.emit("log", { ts: 2, level: "ERROR", msg: "two" });
		logBus.emit("log", { ts: 3, level: "DEBUG", msg: "below the floor" });
		shipRequestRecord({ id: "req-1" });
		shipRequestRecord({ id: "req-2" });
		shipRequestRecord({ id: "req-3" });
		await flush();
		await shipMetricsSnapshot();

		const metricsCaptures = captures.filter((c) =>
			c.url.includes(METRICS_STREAM),
		);
		expect(metricsCaptures).toHaveLength(1);
		expect(metricsCaptures[0].url).toBe(
			`http://openobserve.invalid:5080/api/default/${METRICS_STREAM}/_json`,
		);
		const [snapshot] = metricsPosts(captures);
		expect(snapshot).toHaveLength(2);

		const logs = kind(snapshot, "logs");
		expect(logs.stream).toBe("better_ccflare_logs");
		expect(logs.enqueued_records).toBe(2);
		expect(logs.shipped_records).toBe(2);
		expect(logs.shipped_batches).toBe(1);
		expect(logs.filtered_records).toBe(1);
		expect(logs.buffered_records).toBe(0);

		const requests = kind(snapshot, "requests");
		expect(requests.stream).toBe("better_ccflare_requests");
		expect(requests.enqueued_records).toBe(3);
		expect(requests.shipped_records).toBe(3);
		expect(requests.shipped_batches).toBe(1);
		expect(requests.filtered_records).toBe(0);

		expect(balances(logs)).toBe(true);
		expect(balances(requests)).toBe(true);
	});

	test("carries counts and stream names only, never the endpoint or the credentials", async () => {
		resetMetricsForTests();
		const captures: Capture[] = [];
		captureFetch(captures);
		configureOpenObserve(() =>
			settings({ token: "metrics-secret-token", user: "metrics-user" }),
		);

		shipRequestRecord({ id: "req-1", accountName: "should-not-leak" });
		await flush();
		await shipMetricsSnapshot();

		const [snapshot] = metricsPosts(captures);
		for (const record of snapshot) {
			expect(Object.keys(record).sort()).toEqual(
				[
					"_timestamp",
					"service",
					"run_id",
					"run_started_at",
					"uptime_ms",
					"stream_kind",
					"stream",
					"enqueued_records",
					"shipped_records",
					"shipped_batches",
					"deferred_records",
					"evicted_records",
					"rejected_records",
					"failed_records",
					"exhausted_records",
					"discarded_records",
					"filtered_records",
					"buffered_records",
					"buffered_bytes",
					"in_flight_records",
					"consecutive_failures",
					"snapshot_failures",
				].sort(),
			);
		}
		const wire = JSON.stringify(snapshot);
		expect(wire).not.toContain("metrics-secret-token");
		expect(wire).not.toContain("metrics-user");
		expect(wire).not.toContain("openobserve.invalid");
		expect(wire).not.toContain("should-not-leak");
	});

	test("a failed snapshot is counted and gone: never buffered, never retried", async () => {
		resetMetricsForTests();
		const captures: Capture[] = [];
		captureFetch(captures);
		configureOpenObserve(() => settings());
		// Owns the clock so the metrics warning window starts open: an earlier
		// test's clock can leave its stamp in the future, which suppresses the
		// warning asserted on below.
		fakeClock();

		shipRequestRecord({ id: "req-1" });
		await flush();

		captureFetch(captures, 503);
		const warnings = await withSilencedWarnings(() => shipMetricsSnapshot());
		expect(metricsPosts(captures)).toHaveLength(1);
		expect(warnings.some((w) => w.includes("metrics snapshot"))).toBe(true);

		// Nothing was put anywhere: the record buffers are untouched and a flush
		// has nothing of the snapshot's to send.
		expect(openObserveBufferSizes()).toEqual({ logs: 0, requests: 0 });
		await flush();
		expect(metricsPosts(captures)).toHaveLength(1);

		// The next snapshot carries the totals the lost one would have, plus the
		// fact that one was lost.
		captureFetch(captures, 200);
		shipRequestRecord({ id: "req-2" });
		await flush();
		await shipMetricsSnapshot();

		const snapshots = metricsPosts(captures);
		expect(snapshots).toHaveLength(2);
		const requests = kind(snapshots[1], "requests");
		expect(requests.shipped_records).toBe(2);
		expect(requests.snapshot_failures).toBe(1);

		// And a delivered snapshot clears it.
		await shipMetricsSnapshot();
		expect(kind(metricsPosts(captures)[2], "requests").snapshot_failures).toBe(
			0,
		);
	});

	test("counts outlive the loss warning that zeroes the reporting debt", async () => {
		resetMetricsForTests();
		const captures: Capture[] = [];
		captureFetch(captures);
		configureOpenObserve(() => settings());
		fakeClock();

		// Five over the 1000-record bound: the oldest five are evicted on enqueue.
		for (let i = 0; i < 1005; i++) shipRequestRecord({ id: `req-${i}` });
		const warnings = await withSilencedWarnings(() => flush());
		expect(
			warnings.some((w) =>
				w.includes("dropped 5 record(s) for stream better_ccflare_requests"),
			),
		).toBe(true);

		await shipMetricsSnapshot();
		await shipMetricsSnapshot();
		const snapshots = metricsPosts(captures);
		for (const snapshot of snapshots) {
			const requests = kind(snapshot, "requests");
			expect(requests.evicted_records).toBe(5);
			expect(requests.enqueued_records).toBe(1005);
			expect(requests.shipped_records).toBe(1000);
			expect(balances(requests)).toBe(true);
		}
	});

	test("every accepted record is accounted for across deferral, exhaustion, failure and discard", async () => {
		resetMetricsForTests();
		const captures: Capture[] = [];
		configureOpenObserve(() => settings());
		const clock = fakeClock();

		// Three records fail six times: five deferrals each, then dropped.
		captureFetch(captures, 503);
		for (let i = 0; i < 3; i++) shipRequestRecord({ id: `retry-${i}` });
		await withSilencedWarnings(async () => {
			for (let attempt = 0; attempt < 6; attempt++) {
				await flush();
				clock.advance(61_000);
			}
		});

		// Two refused outright by a non-retryable status.
		captureFetch(captures, 400);
		for (let i = 0; i < 2; i++) shipRequestRecord({ id: `bad-${i}` });
		await withSilencedWarnings(() => flush());

		// Four shipped.
		captureFetch(captures, 200);
		for (let i = 0; i < 4; i++) shipRequestRecord({ id: `ok-${i}` });
		await flush();

		// One still buffered when the exporter is turned off and on again.
		shipRequestRecord({ id: "discarded" });
		configureOpenObserve(null);
		configureOpenObserve(() => settings());
		// And one rejected at enqueue, which never enters the identity.
		shipRequestRecord({ id: "unserializable", n: 1n });

		await shipMetricsSnapshot();
		const requests = kind(metricsPosts(captures)[0], "requests");
		expect(requests.deferred_records).toBe(15);
		expect(requests.exhausted_records).toBe(3);
		expect(requests.failed_records).toBe(2);
		expect(requests.shipped_records).toBe(4);
		expect(requests.discarded_records).toBe(1);
		expect(requests.rejected_records).toBe(1);
		expect(requests.enqueued_records).toBe(10);
		expect(requests.buffered_records).toBe(0);
		expect(balances(requests)).toBe(true);
	});

	test("an empty metrics stream sends no snapshot", async () => {
		resetMetricsForTests();
		const captures: Capture[] = [];
		captureFetch(captures);
		configureOpenObserve(() => settings({ metricsStream: "" }));

		shipRequestRecord({ id: "req-1" });
		await flush();
		await shipMetricsSnapshot();

		expect(metricsPosts(captures)).toHaveLength(0);
		expect(captures).toHaveLength(1);
	});

	test("one run id per process, and uptime measured from the run's start", async () => {
		resetMetricsForTests();
		const captures: Capture[] = [];
		captureFetch(captures);
		configureOpenObserve(() => settings());
		const clock = fakeClock();

		await shipMetricsSnapshot();
		clock.advance(90_000);
		await shipMetricsSnapshot();

		const [first, second] = metricsPosts(captures).map((s) => kind(s, "logs"));
		expect(typeof first.run_id).toBe("string");
		expect(second.run_id).toBe(first.run_id);
		expect(second.run_started_at).toBe(first.run_started_at);
		expect((second._timestamp as number) - (first._timestamp as number)).toBe(
			90_000,
		);
		expect(second.uptime_ms).toBe(
			(second._timestamp as number) - (second.run_started_at as number),
		);
	});

	test("snapshots run on their own interval, with nothing buffered, and stop when turned off", async () => {
		resetMetricsForTests();
		const captures: Capture[] = [];
		captureFetch(captures);
		jest.useFakeTimers();
		try {
			// Configured inside the fake clock so the interval is created on it.
			configureOpenObserve(() => settings());
			expect(openObserveBufferSizes()).toEqual({ logs: 0, requests: 0 });

			jest.advanceTimersByTime(60_000);
			expect(metricsPosts(captures)).toHaveLength(1);
			jest.advanceTimersByTime(60_000);
			expect(metricsPosts(captures)).toHaveLength(2);

			configureOpenObserve(null);
			jest.advanceTimersByTime(180_000);
			expect(metricsPosts(captures)).toHaveLength(2);
		} finally {
			jest.useRealTimers();
		}
	});
});

describe("openobserve attempt-limit drop", () => {
	// PR #144 left this counted twice: once in the attempt-limit warning and
	// again later as "under buffer pressure", which it was not.
	test("a drop reported by its own warning is not reported again as buffer pressure", async () => {
		resetMetricsForTests();
		const captures: Capture[] = [];
		captureFetch(captures, 503);
		configureOpenObserve(() => settings());
		const clock = fakeClock();

		shipRequestRecord({ id: "req-1" });
		const warnings = await withSilencedWarnings(async () => {
			for (let attempt = 0; attempt < 6; attempt++) {
				await flush();
				clock.advance(61_000);
			}
			shipRequestRecord({ id: "req-2" });
			captureFetch(captures, 200);
			await flush();
			clock.advance(61_000);
			await flush();
		});

		expect(warnings.some((w) => w.includes("after 6 attempts"))).toBe(true);
		expect(warnings.some((w) => w.includes("under buffer pressure"))).toBe(
			false,
		);
	});
});
