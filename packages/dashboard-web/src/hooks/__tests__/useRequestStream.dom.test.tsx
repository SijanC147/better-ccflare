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
 * SB23-3995: where the live Requests row's "Rate Limited" flag comes from.
 *
 * The issue said the badge never showed on the live tab because the start
 * event carries status 0. That is not true of real traffic: response-handler.ts
 * emits the start event once the upstream has answered, with its status, so
 * the placeholder already read `rateLimited: true` for a 429. The one emitter
 * of status 0 is the auto-refresh probe, which never gets a summary. Measured
 * by this PR's reviewer: with a start event carrying 429, the pre-fix hook
 * already set the flag.
 *
 * What was true is that the flag rested on the start event alone, because the
 * stream summary carried no `rateLimited` and the hook kept the placeholder's
 * value when the key was absent. The summary now carries it, and the hook
 * derives it from the summary's status when it is absent. These tests drive
 * the real hook with a fake `EventSource` and read the row back out of the
 * query cache.
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

const unmounts: Array<() => Promise<void>> = [];

afterEach(async () => {
	// Unmount first and wait for it: the unmount runs inside React's `act`,
	// and a still-running one would overlap the next test's mount.
	while (unmounts.length > 0) await unmounts.pop()?.();
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
	unmounts.push(mounted.unmount);
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

/**
 * A start event as response-handler.ts emits it: after the upstream answered,
 * carrying its status. Pass 0 for a start event that carried none, which is
 * the case where only the summary can decide the flag.
 */
function startEvent(id: string, statusCode: number) {
	return {
		type: "start",
		id,
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		accountId: null,
		statusCode,
		agentUsed: null,
	};
}

/**
 * The summary as the collector emitted it before SB23-3995: no `rateLimited`
 * key. A payload carrying `rateLimited: true` passes on the old hook through
 * its `!== undefined` branch, so it cannot show what the hook does on its own.
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
	test("a 429 summary decides the flag when the start event carried no status", async () => {
		// Fails on the pre-fix hook (Expected: true, Received: false): with no
		// key in the summary it kept the placeholder's value.
		const { es, row } = await mountStream(901);

		await act(async () => es.emit(startEvent("req-429", 0)));
		expect(row("req-429").meta.pending).toBe(true);
		expect(row("req-429").meta.rateLimited).toBe(false);

		await act(async () =>
			es.emit({ type: "summary", payload: summaryWithoutFlag("req-429", 429) }),
		);
		expect(row("req-429").meta.pending).toBe(false);
		expect(row("req-429").response?.status).toBe(429);
		expect(row("req-429").meta.rateLimited).toBe(true);
	});

	test("a 429 start event, as the proxy emits it, then a 429 summary stays rate limited", async () => {
		const { es, row } = await mountStream(904);

		await act(async () => es.emit(startEvent("req-429-real", 429)));
		expect(row("req-429-real").meta.rateLimited).toBe(true);
		await act(async () =>
			es.emit({
				type: "summary",
				payload: {
					...summaryWithoutFlag("req-429-real", 429),
					rateLimited: true,
				},
			}),
		);
		expect(row("req-429-real").meta.pending).toBe(false);
		expect(row("req-429-real").meta.rateLimited).toBe(true);
	});

	test("a 200 summary leaves the row not rate limited", async () => {
		const { es, row } = await mountStream(902);

		await act(async () => es.emit(startEvent("req-200", 200)));
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

		await act(async () => es.emit(startEvent("req-flag", 200)));
		await act(async () =>
			es.emit({
				type: "summary",
				payload: { ...summaryWithoutFlag("req-flag", 200), rateLimited: true },
			}),
		);
		expect(row("req-flag").meta.rateLimited).toBe(true);
	});

	test("an explicit rateLimited: false from the server is kept on a 429", async () => {
		// The negative of the case above: only an absent key falls back to the
		// status. `||` in place of `??` would turn this row rate limited.
		const { es, row } = await mountStream(905);

		await act(async () => es.emit(startEvent("req-false", 0)));
		await act(async () =>
			es.emit({
				type: "summary",
				payload: {
					...summaryWithoutFlag("req-false", 429),
					rateLimited: false,
				},
			}),
		);
		expect(row("req-false").meta.pending).toBe(false);
		expect(row("req-false").meta.rateLimited).toBe(false);
	});
});
