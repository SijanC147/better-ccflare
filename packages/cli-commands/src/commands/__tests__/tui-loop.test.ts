import { describe, expect, it } from "bun:test";
import type { AccountResponse } from "@better-ccflare/types";
import { parseTuiArgs, runTui, type TuiDeps } from "../tui";
import {
	ENTER_SCREEN,
	formatClock,
	LEAVE_SCREEN,
	type LoopIO,
	type LoopSignal,
	type OverviewFetchResult,
	runOverviewLoop,
} from "../tui-overview";

function acct(name: string, utilization: number): AccountResponse {
	return {
		name,
		provider: "zai",
		paused: false,
		requiresReauth: false,
		rateLimitStatus: "OK",
		rateLimitReset: null,
		usageUtilization: utilization,
		usageWindow: "tokens_limit",
		usageData: null,
		usageRateLimitedUntil: null,
		isPrimary: false,
	} as unknown as AccountResponse;
}

/** A terminal, a keyboard, a signal table and a timer queue, all by hand. */
function fakeIO(columns = 80) {
	const writes: string[] = [];
	const errors: string[] = [];
	const listeners = new Map<LoopSignal, Set<() => void>>();
	let keyListener: ((chunk: string) => void) | null = null;
	const rawModes: boolean[] = [];
	let timers: Array<{ id: number; cb: () => void; ms: number }> = [];
	let nextId = 1;
	let now = Date.parse("2026-10-01T08:00:00Z");
	const io: LoopIO = {
		stdout: {
			columns,
			rows: 40,
			write(text: string, callback?: () => void) {
				writes.push(text);
				callback?.();
				return true;
			},
		},
		stderr: { write: (t: string) => errors.push(t) },
		stdin: {
			isTTY: true,
			setRawMode: (mode: boolean) => rawModes.push(mode),
			on: (_e: "data", l: (chunk: Buffer | string) => void) => {
				keyListener = l as (chunk: string) => void;
			},
			removeListener: () => {
				keyListener = null;
			},
			resume: () => {},
			pause: () => {},
		},
		onSignal(signal, handler) {
			const set = listeners.get(signal) ?? new Set();
			set.add(handler);
			listeners.set(signal, set);
			return () => set.delete(handler);
		},
		setTimer(cb, ms) {
			const id = nextId++;
			timers.push({ id, cb, ms });
			return id;
		},
		clearTimer(handle) {
			timers = timers.filter((t) => t.id !== handle);
		},
		now: () => now,
	};
	return {
		io,
		writes,
		errors,
		rawModes,
		key: (k: string) => keyListener?.(k),
		hasKeyListener: () => keyListener !== null,
		signal: (s: LoopSignal) => {
			for (const h of [...(listeners.get(s) ?? [])]) h();
		},
		listenerCount: () =>
			[...listeners.values()].reduce((n, set) => n + set.size, 0),
		timers: () => timers,
		/** Run the interval timer (the longest pending one). */
		async fireInterval(ms = 5000) {
			now += ms;
			const t = timers.find((x) => x.ms === ms);
			if (!t) throw new Error("no interval timer pending");
			timers = timers.filter((x) => x !== t);
			t.cb();
			// let the async tick settle
			for (let i = 0; i < 5; i++) await Promise.resolve();
		},
	};
}

function start(
	f: ReturnType<typeof fakeIO>,
	results: OverviewFetchResult[] = [],
) {
	return runOverviewLoop({
		baseUrl: "http://127.0.0.1:65532",
		intervalMs: 5000,
		color: false,
		initial: [acct("alpha", 10)],
		fetchOnce: async () =>
			results.shift() ?? { ok: true, accounts: [acct("alpha", 10)] },
		quitHint: "q or Ctrl-C to quit",
		io: f.io,
	});
}

describe("runOverviewLoop", () => {
	it("takes the alternate screen and restores everything on q", async () => {
		const f = fakeIO();
		const done = start(f);
		expect(f.writes[0]).toBe(ENTER_SCREEN);
		expect(f.writes.join("")).toContain("alpha");
		expect(f.rawModes).toEqual([true]);
		f.key("q");
		expect(await done).toBe(0);
		expect(f.writes[f.writes.length - 1]).toBe(LEAVE_SCREEN);
		expect(f.rawModes).toEqual([true, false]);
		expect(f.hasKeyListener()).toBe(false);
		expect(f.listenerCount()).toBe(0);
		expect(f.timers()).toEqual([]);
	});

	it("exits on the Ctrl-C byte, which raw mode delivers instead of SIGINT", async () => {
		const f = fakeIO();
		const done = start(f);
		f.key("\x03");
		expect(await done).toBe(0);
		expect(f.writes[f.writes.length - 1]).toBe(LEAVE_SCREEN);
	});

	for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
		it(`exits cleanly on ${signal}, the only way out of a panel`, async () => {
			const f = fakeIO();
			const done = start(f);
			f.signal(signal);
			expect(await done).toBe(0);
			expect(f.writes[f.writes.length - 1]).toBe(LEAVE_SCREEN);
			expect(f.listenerCount()).toBe(0);
		});
	}

	it("repaints with fresh data on every interval", async () => {
		const f = fakeIO();
		const done = start(f, [{ ok: true, accounts: [acct("beta", 77)] }]);
		await f.fireInterval();
		expect(f.writes[f.writes.length - 1]).toContain("beta");
		expect(f.writes[f.writes.length - 1]).toContain("77%");
		f.key("q");
		await done;
	});

	it("keeps the last table on a transient failure and says so", async () => {
		const f = fakeIO();
		const done = start(f, [
			{
				ok: false,
				kind: "unreachable",
				message: "server not running on http://127.0.0.1:65532",
			},
		]);
		await f.fireInterval();
		const frame = f.writes[f.writes.length - 1];
		expect(frame).toContain("alpha");
		// The clock is the viewer's local time, so the expected value is built
		// the same way: a literal would pass in one zone and fail in UTC CI.
		expect(frame).toContain(
			`! server not running on http://127.0.0.1:65532; showing data from ${formatClock(new Date(Date.parse("2026-10-01T08:00:00Z")))}`,
		);
		expect(f.timers().some((t) => t.ms === 5000)).toBe(true);
		f.key("q");
		expect(await done).toBe(0);
	});

	it("exits 1 after restoring the screen when the key stops working", async () => {
		const f = fakeIO();
		const done = start(f, [
			{ ok: false, kind: "unauthorized", message: "API key required" },
		]);
		await f.fireInterval();
		expect(await done).toBe(1);
		expect(f.writes[f.writes.length - 1]).toBe(LEAVE_SCREEN);
		expect(f.errors).toEqual(["❌ API key required\n"]);
	});

	it("restores the terminal and exits 1 when a fetch throws", async () => {
		const f = fakeIO();
		const done = runOverviewLoop({
			baseUrl: "http://127.0.0.1:65532",
			intervalMs: 5000,
			color: false,
			initial: [acct("alpha", 10)],
			fetchOnce: async () => {
				throw new Error("boom");
			},
			quitHint: "q",
			io: f.io,
		});
		await f.fireInterval();
		expect(await done).toBe(1);
		expect(f.rawModes).toEqual([true, false]);
		expect(f.writes[f.writes.length - 1]).toBe(LEAVE_SCREEN);
		expect(f.errors).toEqual(["❌ boom\n"]);
		expect(f.listenerCount()).toBe(0);
	});

	it("restores the terminal when the first paint throws", async () => {
		const f = fakeIO();
		const done = runOverviewLoop({
			baseUrl: "http://127.0.0.1:65532",
			intervalMs: 5000,
			color: false,
			// Not a shape fetchOverview lets through; stands in for any render throw.
			initial: [{} as AccountResponse],
			fetchOnce: async () => ({ ok: true, accounts: [] }),
			quitHint: "q",
			io: f.io,
		});
		expect(await done).toBe(1);
		expect(f.rawModes).toEqual([true, false]);
		expect(f.writes[f.writes.length - 1]).toBe(LEAVE_SCREEN);
		expect(f.timers()).toEqual([]);
	});

	it("restores the terminal when a SIGWINCH repaint throws", async () => {
		const f = fakeIO();
		const done = start(f);
		f.io.now = () => {
			throw new Error("clock gone");
		};
		f.signal("SIGWINCH");
		expect(await done).toBe(1);
		expect(f.rawModes).toEqual([true, false]);
		expect(f.writes[f.writes.length - 1]).toBe(LEAVE_SCREEN);
		expect(f.errors).toEqual(["❌ clock gone\n"]);
	});

	it("arms no timer when stopped while a fetch is in flight", async () => {
		const f = fakeIO();
		let release: (r: OverviewFetchResult) => void = () => {};
		const done = runOverviewLoop({
			baseUrl: "http://127.0.0.1:65532",
			intervalMs: 5000,
			color: false,
			initial: [acct("alpha", 10)],
			fetchOnce: () =>
				new Promise<OverviewFetchResult>((resolve) => {
					release = resolve;
				}),
			quitHint: "q",
			io: f.io,
		});
		await f.fireInterval();
		f.signal("SIGTERM");
		expect(await done).toBe(0);
		release({ ok: true, accounts: [acct("late", 1)] });
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(f.timers()).toEqual([]);
		expect(f.writes[f.writes.length - 1]).toBe(LEAVE_SCREEN);
	});

	it("re-measures the width on SIGWINCH", async () => {
		const f = fakeIO(80);
		const done = start(f);
		f.io.stdout.columns = 30;
		f.signal("SIGWINCH");
		const frame = f.writes[f.writes.length - 1];
		for (const line of frame.split("\n")) {
			const visible = line.replace(
				new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g"),
				"",
			);
			expect(visible.length).toBeLessThanOrEqual(30);
		}
		f.key("q");
		await done;
	});
});

describe("runTui live or once", () => {
	function deps(isTTY: boolean) {
		const f = fakeIO();
		const out: string[] = [];
		let liveStarted = 0;
		const d: TuiDeps = {
			env: {},
			stdout: {
				isTTY,
				columns: 80,
				write: (t: string, cb?: () => void) => {
					out.push(t);
					cb?.();
					return true;
				},
			},
			stderr: { write: () => true },
			now: () => Date.parse("2026-10-01T08:00:00Z"),
			fetch: async () => new Response("[]", { status: 200 }),
			loop: {
				stdin: f.io.stdin,
				onSignal: f.io.onSignal,
				setTimer: f.io.setTimer,
				clearTimer: f.io.clearTimer,
			},
			onLiveStart: () => {
				liveStarted++;
			},
		};
		return { d, out, f, liveStarted: () => liveStarted };
	}
	const options = (args: string[]) => {
		const r = parseTuiArgs(args);
		if (!r.ok) throw new Error(r.message);
		return r.options;
	};

	it("goes live on a terminal", async () => {
		const { d, out, f, liveStarted } = deps(true);
		const done = runTui(options([]), d);
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(liveStarted()).toBe(1);
		expect(out[0]).toBe(ENTER_SCREEN);
		f.key("q");
		expect(await done).toBe(0);
	});

	it("prints once with --once on a terminal, and when piped", async () => {
		for (const [isTTY, args] of [
			[true, ["--once"]],
			[false, []],
		] as const) {
			const { d, out, liveStarted } = deps(isTTY);
			expect(await runTui(options([...args]), d)).toBe(0);
			expect(liveStarted()).toBe(0);
			expect(out.join("").includes(ENTER_SCREEN)).toBe(false);
			expect(out.join("")).toContain("better-ccflare overview");
		}
	});
});
