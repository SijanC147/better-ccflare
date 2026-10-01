import { describe, expect, it, jest } from "bun:test";
import {
	CODEX_STREAM_HEARTBEAT_INTERVAL_MS,
	CODEX_STREAM_RAW_SILENCE_TIMEOUT_MS,
	CodexStreamLiveness,
	type CodexStreamReader,
} from "./stream-liveness";

function makeSilentReader() {
	let controller: ReadableStreamDefaultController<Uint8Array>;
	let cancelReason: unknown;
	const stream = new ReadableStream<Uint8Array>({
		start(value) {
			controller = value;
		},
		cancel(reason) {
			cancelReason = reason;
		},
	});
	return {
		reader: stream.getReader(),
		push(bytes: number[] = [1]) {
			controller.enqueue(Uint8Array.from(bytes));
		},
		getCancelReason: () => cancelReason,
	};
}

/**
 * Runs `promise` to settlement on fake timers: flush microtasks, and while it
 * is still pending jump the clock to the next timer. `next()` awaits a
 * microtask before it arms its timer, so the flush comes first. The clock moves
 * only here, so `performance.now()` differences are exact, where on real
 * timers a loaded machine stretched them past the deadlines under test
 * (SB23-3567).
 */
async function settle<T>(promise: Promise<T>): Promise<T> {
	let settled = false;
	let value: T | undefined;
	let failure: unknown;
	let failed = false;
	promise.then(
		(result) => {
			settled = true;
			value = result;
		},
		(error: unknown) => {
			failed = true;
			failure = error;
		},
	);
	for (let step = 0; step < 1_000; step++) {
		for (let turn = 0; turn < 20; turn++) await Promise.resolve();
		if (failed) throw failure;
		if (settled) return value as T;
		jest.advanceTimersToNextTimer();
	}
	throw new Error("settle: the promise never settled");
}

async function advanceBy(ms: number): Promise<void> {
	for (let turn = 0; turn < 20; turn++) await Promise.resolve();
	jest.advanceTimersByTime(ms);
	for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

describe("CodexStreamLiveness", () => {
	it("keeps production deadlines inside the proxy liveness contract", () => {
		expect(CODEX_STREAM_HEARTBEAT_INTERVAL_MS).toBe(25_000);
		expect(CODEX_STREAM_RAW_SILENCE_TIMEOUT_MS).toBe(8 * 60_000);
		expect(CODEX_STREAM_HEARTBEAT_INTERVAL_MS).toBeLessThan(120_000);
	});

	it("emits periodic heartbeat deadlines until canonical output resets the clock", async () => {
		jest.useFakeTimers();
		try {
			const upstream = makeSilentReader();
			const liveness = new CodexStreamLiveness({
				heartbeatIntervalMs: 20,
				rawSilenceTimeoutMs: 250,
			});
			const createdAt = performance.now();

			const first = await settle(liveness.next(upstream.reader));
			expect(first.type).toBe("heartbeat_due");
			expect(performance.now() - createdAt).toBe(20);
			liveness.recordDownstreamWrite();

			// Without this write the next heartbeat would be due 8 ms later.
			await advanceBy(12);
			liveness.recordDownstreamWrite();
			const resetAt = performance.now();
			const second = await settle(liveness.next(upstream.reader));

			expect(second.type).toBe("heartbeat_due");
			expect(performance.now() - resetAt).toBe(20);

			liveness.stop();
			await upstream.reader.cancel("test complete");
		} finally {
			jest.useRealTimers();
		}
	});

	it("resets the hard raw-silence deadline only when actual upstream bytes arrive", async () => {
		jest.useFakeTimers();
		try {
			const upstream = makeSilentReader();
			const liveness = new CodexStreamLiveness({
				heartbeatIntervalMs: 15,
				rawSilenceTimeoutMs: 75,
			});
			const createdAt = performance.now();

			const first = await settle(liveness.next(upstream.reader));
			expect(first.type).toBe("heartbeat_due");
			liveness.recordDownstreamWrite();

			await advanceBy(25);
			upstream.push([1, 2, 3]);
			const bytes = await settle(liveness.next(upstream.reader));
			expect(bytes).toMatchObject({ type: "upstream" });
			if (bytes.type === "upstream") {
				expect(bytes.result.value?.byteLength).toBe(3);
			}
			const resetAt = performance.now();
			expect(resetAt - createdAt).toBe(40);

			// Heartbeats keep writing downstream, and none of them may move the
			// raw-silence deadline. The bound stops a deadline they did move
			// from looping forever on a clock that never runs out.
			let heartbeats = 0;
			let outcome = await settle(liveness.next(upstream.reader));
			while (outcome.type === "heartbeat_due" && heartbeats < 100) {
				heartbeats++;
				liveness.recordDownstreamWrite();
				outcome = await settle(liveness.next(upstream.reader));
			}

			expect(outcome.type).toBe("raw_silence_timeout");
			expect(heartbeats).toBeGreaterThan(0);
			// 75 ms after the bytes, not 75 ms after construction (35 ms from here).
			expect(performance.now() - resetAt).toBe(75);
			expect((await liveness.next(upstream.reader)).type).toBe("stopped");
			await upstream.reader.cancel("test complete");
		} finally {
			jest.useRealTimers();
		}
	});

	it("stops a pending deadline without leaving a heartbeat timer active", async () => {
		const upstream = makeSilentReader();
		const liveness = new CodexStreamLiveness({
			heartbeatIntervalMs: 20,
			rawSilenceTimeoutMs: 100,
		});
		const pending = liveness.next(upstream.reader);

		liveness.stop();

		expect((await pending).type).toBe("stopped");
		await upstream.reader.cancel("downstream cancelled");
		expect(upstream.getCancelReason()).toBe("downstream cancelled");
		await Bun.sleep(30);
		expect((await liveness.next(upstream.reader)).type).toBe("stopped");
	});

	it("keeps losing stop and capacity subscriptions bounded", async () => {
		const upstream = makeSilentReader();
		const liveness = new CodexStreamLiveness({
			heartbeatIntervalMs: 1,
			rawSilenceTimeoutMs: 1_000,
		});
		let activeCapacityWaiters = 0;
		let maxActiveCapacityWaiters = 0;
		let abortedCapacityWaiters = 0;
		const gate = {
			isReady: () => false,
			waitUntilReady(signal?: AbortSignal) {
				activeCapacityWaiters++;
				maxActiveCapacityWaiters = Math.max(
					maxActiveCapacityWaiters,
					activeCapacityWaiters,
				);
				return new Promise<void>((resolve) => {
					if (!signal) return;
					const onAbort = () => {
						signal.removeEventListener("abort", onAbort);
						activeCapacityWaiters--;
						abortedCapacityWaiters++;
						resolve();
					};
					signal.addEventListener("abort", onAbort, { once: true });
					if (signal.aborted) onAbort();
				});
			},
		};

		await Bun.sleep(2);
		for (let index = 0; index < 50; index++) {
			upstream.push([index]);
			expect((await liveness.next(upstream.reader, gate)).type).toBe(
				"upstream",
			);
		}

		const pending = liveness.next(upstream.reader, gate);
		await Bun.sleep(1);
		liveness.stop();

		expect((await pending).type).toBe("stopped");
		await upstream.reader.cancel("test complete");
		expect(activeCapacityWaiters).toBe(0);
		expect(maxActiveCapacityWaiters).toBe(1);
		expect(abortedCapacityWaiters).toBe(51);
	});

	it("waits for the retained read to settle before teardown can release its lock", async () => {
		// bun-types and lib.dom both declare `ReadableStreamDefaultReader`, so
		// `CodexStreamReader["read"]` is an overload pair and this `read` has
		// to satisfy both return types. Neither is assignable to the other:
		// on a done result lib.dom types `value` as `T | undefined` and bun
		// types it as `undefined`. Spelling the two cases out satisfies both,
		// where naming either library's alias satisfies only itself.
		// `ReturnType` picks only the last overload, so deriving the type
		// that way sees one of the pair and misses the other.
		type ReaderResult =
			| { done: false; value: Uint8Array }
			| { done: true; value: undefined };
		// `= null` would pin the flow type at `null`, because the assignment
		// happens inside the executor below (TS#9998).
		let settleRead: ((result: ReaderResult) => void) | undefined;
		const reader: CodexStreamReader = {
			read: () =>
				new Promise<ReaderResult>((resolve) => {
					settleRead = resolve;
				}),
		};
		const liveness = new CodexStreamLiveness({
			heartbeatIntervalMs: 100,
			rawSilenceTimeoutMs: 200,
		});
		const pending = liveness.next(reader);
		await Bun.sleep(1);
		liveness.stop();
		expect((await pending).type).toBe("stopped");

		let cleanupFinished = false;
		const cleanup = liveness.settlePendingReadForCleanup().then(() => {
			cleanupFinished = true;
		});
		await Bun.sleep(5);
		expect(cleanupFinished).toBeFalse();

		// Not `settleRead?.(...)`: a stub that never captured its resolver
		// would leave `cleanup` pending forever, so the case would die on the
		// per-test timeout instead of saying what was missing, and the
		// `toBeTrue` below would never run.
		if (!settleRead) throw new Error("reader.read() captured no resolver");
		settleRead({ done: true, value: undefined });
		await cleanup;
		expect(cleanupFinished).toBeTrue();
	});
});
