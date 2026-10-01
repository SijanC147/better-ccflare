// A side-effect import first: `../api` and react-dom must see the DOM at load.
// See the header of src/test/dom.ts for why the order is load-bearing.
import "../../test/dom";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { api, type RequestPayload, type RequestResponse } from "../../api";
import { queryKeys } from "../../lib/query-keys";
import { mount } from "../../test/dom";
import { cleanupRequestStream, useRequestStream } from "../useRequestStream";

/**
 * SB23-3995: the live Requests tab never showed the "Rate Limited" badge for a
 * request that completed over the stream. The start event carries status 0,
 * so the placeholder row reads `rateLimited: false`, and the summary handler
 * only refreshed the flag when the payload carried a `rateLimited` key, which
 * the stream summary never did. These tests drive the real hook with a fake
 * `EventSource` and read the row back out of the query cache.
 */

type Listener = (ev: { data: string }) => void;

/**
 * Just enough of `EventSource` for `useRequestStream`: the three readyState
 * statics it compares against, `addEventListener`, and `close`. Every instance
 * is recorded so a test can fail loudly when the hook never connected, rather
 * than dispatch into nothing and read an unchanged seeded row back.
 */
class FakeEventSource {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 2;
	static instances: FakeEventSource[] = [];

	readonly url: string;
	readyState = FakeEventSource.OPEN;
	private readonly listeners = new Map<string, Listener[]>();

	constructor(url: string) {
		this.url = url;
		FakeEventSource.instances.push(this);
	}

	addEventListener(type: string, listener: Listener): void {
		const list = this.listeners.get(type) ?? [];
		list.push(listener);
		this.listeners.set(type, list);
	}

	close(): void {
		this.readyState = FakeEventSource.CLOSED;
	}

	emit(data: unknown): void {
		const list = this.listeners.get("message") ?? [];
		if (list.length === 0)
			throw new Error("the hook registered no message listener");
		for (const listener of list) listener({ data: JSON.stringify(data) });
	}
}

type RequestsCache = {
	requests: RequestPayload[];
	detailsMap: Map<string, RequestResponse>;
};

const restores: Array<() => void> = [];

afterEach(() => {
	cleanupRequestStream();
	while (restores.length > 0) restores.pop()?.();
	FakeEventSource.instances = [];
});

function installFakeEventSource(): void {
	const scope = globalThis as unknown as { EventSource: unknown };
	const original = scope.EventSource;
	scope.EventSource = FakeEventSource;
	restores.push(() => {
		scope.EventSource = original;
	});
	// The hook mints a stream token first. Unstubbed, that is a relative
	// fetch, which Bun's restored `fetch` refuses with ERR_INVALID_URL.
	const streamUrl = spyOn(api, "streamUrl").mockImplementation(
		async (path: string) => path,
	);
	restores.push(() => streamUrl.mockRestore());
}

function Harness({ limit }: { limit: number }) {
	useRequestStream(limit);
	return null;
}

/**
 * Mount the hook with a seeded cache and return the live connection. Each
 * test passes its own `limit`: the connection pool is module state keyed on
 * it, and a pooled connection is reused without the new instance's listener.
 */
async function mountStream(limit: number) {
	installFakeEventSource();
	const queryClient = new QueryClient();
	// `setQueryData` leaves an undefined entry undefined, which would make
	// every assertion below read nothing and pass a "stays false" check.
	queryClient.setQueryData<RequestsCache>(queryKeys.requests(limit), {
		requests: [],
		detailsMap: new Map(),
	});
	const mounted = await mount(
		<QueryClientProvider client={queryClient}>
			<Harness limit={limit} />
		</QueryClientProvider>,
	);
	restores.push(() => {
		void mounted.unmount();
	});
	// connect() awaits the token before constructing the EventSource.
	for (
		let turn = 0;
		turn < 50 && FakeEventSource.instances.length === 0;
		turn++
	)
		await act(async () => {
			await Promise.resolve();
		});
	const es = FakeEventSource.instances[0];
	if (!es) throw new Error("useRequestStream never opened an EventSource");
	const row = (id: string): RequestPayload => {
		const cache = queryClient.getQueryData<RequestsCache>(
			queryKeys.requests(limit),
		);
		const found = cache?.requests.find((r) => r.id === id);
		if (!found) throw new Error(`no row in the requests cache for ${id}`);
		return found;
	};
	return { es, row };
}

function startEvent(id: string) {
	return {
		type: "start",
		id,
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		accountId: null,
		// The start event is emitted before the upstream answers, so its
		// status is always 0. That is why the placeholder cannot know.
		statusCode: 0,
		agentUsed: null,
	};
}

/**
 * The summary exactly as the collector emitted it before this fix: no
 * `rateLimited` key. A payload carrying `rateLimited: true` would pass on the
 * old code through its `!== undefined` branch, so it cannot be the case that
 * proves the bug.
 */
function summaryWithoutFlag(id: string, statusCode: number): RequestResponse {
	return {
		id,
		timestamp: new Date().toISOString(),
		method: "POST",
		path: "/v1/messages",
		accountUsed: null,
		statusCode,
		success: statusCode < 400,
		errorMessage: null,
		responseTimeMs: 12,
		failoverAttempts: 0,
	};
}

describe("useRequestStream: the Rate Limited flag from a stream summary", () => {
	test("a 429 summary without a rateLimited key marks the row rate limited", async () => {
		const { es, row } = await mountStream(901);

		await act(async () => es.emit(startEvent("req-429")));
		expect(row("req-429").meta.pending).toBe(true);
		expect(row("req-429").meta.rateLimited).toBe(false);

		await act(async () =>
			es.emit({ type: "summary", payload: summaryWithoutFlag("req-429", 429) }),
		);
		expect(row("req-429").meta.pending).toBe(false);
		expect(row("req-429").response?.status).toBe(429);
		expect(row("req-429").meta.rateLimited).toBe(true);
	});

	test("a 200 summary leaves the row not rate limited", async () => {
		const { es, row } = await mountStream(902);

		await act(async () => es.emit(startEvent("req-200")));
		await act(async () =>
			es.emit({ type: "summary", payload: summaryWithoutFlag("req-200", 200) }),
		);
		expect(row("req-200").meta.pending).toBe(false);
		expect(row("req-200").meta.rateLimited).toBe(false);
	});

	test("an explicit rateLimited key from the server wins over the status", async () => {
		// The server derives the flag from the same status today, so the two
		// cannot disagree in practice. Pinned so the fallback stays a fallback.
		const { es, row } = await mountStream(903);

		await act(async () => es.emit(startEvent("req-flag")));
		await act(async () =>
			es.emit({
				type: "summary",
				payload: { ...summaryWithoutFlag("req-flag", 200), rateLimited: true },
			}),
		);
		expect(row("req-flag").meta.rateLimited).toBe(true);
	});
});
