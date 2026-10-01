import { jest } from "bun:test";

/**
 * Runs `promise` to settlement on Bun's fake timers: let every microtask run,
 * and while it is still pending jump the clock to the next timer. The clock
 * moves only here, so `performance.now()` differences are exact, where on
 * real timers a loaded machine stretched them past the deadlines under test
 * (SB23-3567 for `CodexStreamLiveness`, SB23-3951 for the provider's stream
 * liveness tests, whose 200 ms raw-silence deadline fired at 206 ms under a
 * full suite).
 *
 * The flush is one `setImmediate`, not a fixed count of microtask turns. Bun's
 * fake timers leave `setImmediate` real (measured on 1.4.2: the fake timer
 * count does not move), and a macrotask runs only once the microtask queue is
 * empty, so the flush ends when nothing can progress without the clock. A
 * fixed count is a guess at how deep the chain is: 20 turns was enough for
 * one `reader.read()`, but `Response.text()` over a seven-frame stream was
 * still pending after 20, so this jumped to a 150 ms drain deadline and the
 * stream appeared to wait for it when it had closed at 0 ms.
 *
 * Call `jest.useFakeTimers()` before constructing the code under test: a
 * timer armed on the real clock is not one this can advance.
 */
export async function settle<T>(promise: Promise<T>): Promise<T> {
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
		await new Promise<void>((resolve) => setImmediate(resolve));
		if (failed) throw failure;
		if (settled) return value as T;
		jest.advanceTimersToNextTimer();
	}
	throw new Error("settle: the promise never settled");
}

/** Resolves when `signal` aborts, for use with `settle`. */
export function whenAborted(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}
