import { afterEach, describe, expect, test } from "bun:test";
import { logBus } from "./log-bus";
import {
	configureOpenObserve,
	flush,
	openObserveBufferSizes,
	openObserveEnabled,
	type OpenObserveSettings,
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
