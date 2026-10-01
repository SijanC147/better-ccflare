/**
 * `bun test` preload: no test may open a connection to a host that is not this
 * machine. Loaded for every root `bun test` run by `bunfig.toml`.
 *
 * WHY. The project rule is that automated testing never reaches a real
 * upstream, and until this file it was enforced only by every test author
 * stubbing correctly. They did not. Measured 2026-10-01 at `69e4982f` with a
 * blocking, logging version of this preload over one full run (6030 tests,
 * 459 files), SB23-3493:
 *
 * - `openai-compat-oauth-refusal.test.ts`: 21 requests to `api.anthropic.com`
 *   per run with fake tokens. Its "hermetic" stub was `ctx.provider.buildUrl`,
 *   dead code for any provider name the registry knows (SB23-2536). That was
 *   the whole of SB23-2576; PR #259 fixed the file.
 * - `bun-leak-273-safety.test.ts`: 3 requests to `api.minimax.io`, asserting
 *   on whatever MiniMax's edge answered to a fake bearer.
 * - `pricing.test.ts`, `alerts.test.ts` and four provider suites: 18 requests
 *   to `nano-gpt.com` and `models.dev`, made by `estimateCostUSD` and friends
 *   in `packages/core/src/pricing.ts` whenever a test touched a cost.
 *
 * - `outbound-proxy.test.ts`: 2 requests to a `.invalid` host, which go to a
 *   loopback proxy and are allowed (below).
 *
 * That is 44 attempts in 9 files, and only 5 of them failed a test when
 * blocked. Production code catches a failed fetch and carries on (the proxy
 * fails the account, pricing falls back to bundled data), so a guard that only
 * rejected the fetch would be silent for 39 of them. Hence the two halves below: the fetch rejects the
 * way a real fetch does, AND a global `afterEach` fails the test that made
 * the attempt, whatever the code under test did with the rejection.
 *
 * WHAT IS GUARDED. `globalThis.fetch` (and `fetch.preconnect`), `WebSocket`,
 * `node:http` and `node:https` `request`/`get`, `node:net` and `node:tls`
 * `connect`/`createConnection`, `net.Socket.prototype.connect`, and
 * `Bun.connect`. Every one is patched on the shared object, so code that
 * captured the function at import time after this preload ran gets the
 * guarded one; a named `import { request } from "node:https"` in a test is
 * still refused, one layer down at `node:tls connect` (measured by the PR #260
 * review).
 *
 * Known gaps, named rather than handled, and used nowhere in the tree today:
 * - `Bun.fetch` is a second entry to the real fetch and cannot be wrapped: its
 *   property descriptor is `{ writable: false, configurable: false }` and
 *   assignment throws (measured on Bun 1.4.2).
 * - A redirect that a loopback server issues to an external host: Bun follows
 *   it inside the original fetch.
 * - happy-dom's own `XMLHttpRequest`, which
 *   `packages/dashboard-web/src/test/dom.ts` does not restore to Bun's.
 *
 * WHAT IS ALLOWED. `localhost` and `*.localhost`, `127.0.0.0/8`, `::1`, and
 * `0.0.0.0` / `::` (Bun.serve's default bind address). A fetch with a
 * loopback `proxy` option is allowed whatever its URL, because the process
 * connects only to the proxy (`outbound-proxy.test.ts` relies on that). A
 * fetch over a `unix` socket and any non-network scheme (`data:`, `blob:`,
 * `file:`) are allowed.
 *
 * TO FIX A FAILURE. Stub `globalThis.fetch` for the test and restore it in
 * `afterEach`, or serve the fake upstream with
 * `Bun.serve({ hostname: "127.0.0.1", port: 0, ... })` and point the code at
 * `http://127.0.0.1:${server.port}`. Never stub `ctx.provider` in a proxy
 * test: the registry wins for every real provider name (SB23-2536).
 *
 * THERE IS NO OPT-OUT, deliberately. An environment variable that switches the
 * guard off gets exported in a shell and forgotten, and then the suite reaches
 * the internet again with nothing to say so. No test needs one: the PostgreSQL
 * live harness is local. A deliberately live check belongs in a script run
 * with `bun run`, which this preload never loads.
 *
 * `CF_PRICING_OFFLINE` is set here for the same reason: without it every test
 * that touches a cost fetches live pricing, which this guard would then fail.
 * A test that exercises the pricing fetch path unsets it and stubs `fetch`.
 *
 * Scope: only a root `bun test` loads this file. Bun reads `bunfig.toml` from
 * the working directory alone, so `bun test` run from any subdirectory, such
 * as `packages/proxy` or `packages/dashboard-web`, is unguarded.
 */
import { afterAll, afterEach } from "bun:test";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { relative } from "node:path";
import tls from "node:tls";

// Unconditional, so a developer's exported CF_PRICING_OFFLINE=0 cannot turn
// live pricing fetches back on for the whole suite.
process.env.CF_PRICING_OFFLINE = "1";

const GUARD_FILE = import.meta.path;

const LOOPBACK_NAMES = new Set([
	"localhost",
	"127.0.0.1",
	"::1",
	"[::1]",
	"0.0.0.0",
	"::",
	"[::]",
]);

/** True for a hostname that resolves to this machine without DNS. */
export function isLoopbackHost(host: string): boolean {
	const h = host.trim().toLowerCase().replace(/\.$/, "");
	if (LOOPBACK_NAMES.has(h)) return true;
	if (h.endsWith(".localhost")) return true;
	if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
	// IPv4-mapped 127.0.0.0/8, as URL normalises it: [::ffff:7f00:1].
	return /^\[?::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]?$/.test(h);
}

const NETWORK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

interface FetchInitWithBunOptions extends RequestInit {
	proxy?: string;
	unix?: string;
}

/**
 * The URL a fetch would open a connection to when it is not loopback, or
 * `null` when it is allowed. Unparseable input is allowed through so the real
 * fetch rejects it with its own error.
 */
export function blockedFetchTarget(
	input: unknown,
	init?: FetchInitWithBunOptions,
): string | null {
	const raw =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.href
				: input instanceof Request
					? input.url
					: typeof input === "object" &&
							input !== null &&
							typeof (input as { url?: unknown }).url === "string"
						? // Bun's fetch also sends a bare object carrying `url`, which
							// is the shape of a Request from another realm or library.
							(input as { url: string }).url
						: String(input);
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (!NETWORK_SCHEMES.has(url.protocol)) return null;
	if (init?.unix) return null;
	if (init?.proxy) {
		let proxy: URL;
		try {
			proxy = new URL(init.proxy);
		} catch {
			return null;
		}
		return isLoopbackHost(proxy.hostname)
			? null
			: `${url.href} (via proxy ${proxy.href})`;
	}
	return isLoopbackHost(url.hostname) ? null : url.href;
}

/** Attempts not yet charged to a test; drained by the hooks below. */
const pending: string[] = [];

function callerLine(): string {
	const frames = (new Error().stack ?? "").split("\n").slice(1);
	const outside = frames.find(
		(line) => line.includes("/") && !line.includes(GUARD_FILE),
	);
	return outside ? outside.trim() : "(no caller frame)";
}

/**
 * Record a refused attempt and build the error the caller sees. `Bun.main`
 * names the test file `bun test` is running at the moment of the call
 * (measured on 1.4.2); a timer left behind by an earlier file is therefore
 * charged to whichever file is running when it fires, so the caller frame is
 * printed as well.
 */
function refuse(via: string, target: string): Error {
	const file = relative(process.cwd(), Bun.main) || Bun.main;
	const message =
		`network-guard: a test in ${file} tried to reach ${target} via ${via}, ` +
		`${callerLine()}. Tests may connect only to loopback (localhost, ` +
		"127.0.0.0/8, ::1). Stub globalThis.fetch, or serve the fake upstream " +
		'with Bun.serve({ hostname: "127.0.0.1", port: 0 }). See ' +
		"scripts/test-network-guard.ts.";
	pending.push(message);
	return new Error(message);
}

function drain(): void {
	if (pending.length === 0) return;
	throw new Error(pending.splice(0).join("\n"));
}

// A failed fetch is usually caught by the code under test, so the rejection
// alone is not enough to fail the test that caused it.
afterEach(drain);
// Catches an attempt made after the last test's afterEach, such as a timer.
afterAll(drain);

/**
 * Handle for the guard's own tests, `scripts/test-network-guard.test.ts`. It
 * is reached through a global rather than an import so that a test proving
 * the guard is installed cannot install it by importing it: without the
 * `bunfig.toml` preload this is undefined.
 */
export const GUARD_HANDLE = Symbol.for("better-ccflare.test-network-guard");

(globalThis as Record<symbol, unknown>)[GUARD_HANDLE] = {
	takeRefused: (): string[] => pending.splice(0),
	isLoopbackHost,
	blockedFetchTarget,
};

// fetch -----------------------------------------------------------------------

const realFetch = globalThis.fetch;

const guardedFetch = function fetch(
	input: Parameters<typeof realFetch>[0],
	init?: Parameters<typeof realFetch>[1],
): Promise<Response> {
	const target = blockedFetchTarget(input, init as FetchInitWithBunOptions);
	if (target) return Promise.reject(refuse("fetch", target));
	return realFetch(input, init);
};

globalThis.fetch = Object.assign(guardedFetch, realFetch, {
	preconnect(url: string | URL, options?: unknown) {
		const target = blockedFetchTarget(url);
		if (target) throw refuse("fetch.preconnect", target);
		return (
			realFetch.preconnect as (u: string | URL, o?: unknown) => void
		).call(realFetch, url, options);
	},
}) as typeof fetch;

// WebSocket -------------------------------------------------------------------

const RealWebSocket = globalThis.WebSocket;

class GuardedWebSocket extends RealWebSocket {
	constructor(url: string | URL, protocols?: string | string[]) {
		const target = blockedFetchTarget(url);
		if (target) throw refuse("WebSocket", target);
		super(url, protocols);
	}
}

globalThis.WebSocket = GuardedWebSocket as typeof WebSocket;

// node:http, node:https -------------------------------------------------------

type AnyFn = (...args: unknown[]) => unknown;

interface RequestOptionsLike {
	hostname?: string | null;
	host?: string | null;
	socketPath?: string;
	protocol?: string | null;
}

/** Host a node `request`/`get` call would connect to, or null for a socket path. */
function nodeRequestHost(args: unknown[]): {
	host: string | null;
	label: string;
} {
	const first = args[0];
	if (typeof first === "string" || first instanceof URL) {
		try {
			const url = new URL(String(first));
			return { host: url.hostname, label: url.href };
		} catch {
			return { host: null, label: String(first) };
		}
	}
	const options = (first ?? {}) as RequestOptionsLike;
	if (options.socketPath) return { host: null, label: options.socketPath };
	// `host` may carry a port, except an unbracketed IPv6 literal such as `::1`.
	const host =
		options.hostname ??
		(options.host && (options.host.match(/:/g) ?? []).length > 1
			? options.host
			: options.host?.replace(/:\d+$/, ""));
	const resolved = host || "localhost";
	return { host: resolved, label: resolved };
}

for (const [name, mod] of [
	["node:http", http],
	["node:https", https],
] as const) {
	const target = mod as unknown as Record<"request" | "get", AnyFn>;
	for (const fn of ["request", "get"] as const) {
		const original = target[fn];
		target[fn] = function (this: unknown, ...args: unknown[]) {
			const { host, label } = nodeRequestHost(args);
			if (host !== null && !isLoopbackHost(host)) {
				throw refuse(`${name} ${fn}`, label);
			}
			return original.apply(this, args);
		};
	}
}

// node:net, node:tls ----------------------------------------------------------

interface ConnectOptionsLike {
	host?: string;
	path?: string;
	port?: number;
}

/** Host a node `connect` call would reach, or null for an IPC path. */
function nodeConnectHost(args: unknown[]): string | null {
	const [first, second] = args;
	// node's own net.connect hands Socket#connect its normalised [options, cb].
	if (Array.isArray(first)) return nodeConnectHost(first);
	if (typeof first === "object" && first !== null) {
		const options = first as ConnectOptionsLike;
		if (options.path) return null;
		return options.host || "localhost";
	}
	if (typeof first === "string" && !/^\d+$/.test(first)) return null;
	return typeof second === "string" ? second : "localhost";
}

for (const [name, mod] of [
	["node:net", net],
	["node:tls", tls],
] as const) {
	const target = mod as unknown as Record<string, AnyFn | undefined>;
	for (const fn of ["connect", "createConnection"]) {
		const original = target[fn];
		if (!original) continue;
		target[fn] = function (this: unknown, ...args: unknown[]) {
			const host = nodeConnectHost(args);
			if (host !== null && !isLoopbackHost(host)) {
				throw refuse(`${name} ${fn}`, host);
			}
			return original.apply(this, args);
		};
	}
}

// A socket built with `new net.Socket()` connects through its prototype, which
// the module-level patch above does not reach.
const socketPrototype = net.Socket.prototype as unknown as { connect: AnyFn };
const realSocketConnect = socketPrototype.connect;
socketPrototype.connect = function (this: unknown, ...args: unknown[]) {
	const host = nodeConnectHost(args);
	if (host !== null && !isLoopbackHost(host)) {
		throw refuse("node:net Socket#connect", host);
	}
	return realSocketConnect.apply(this, args);
};

// Bun.connect -----------------------------------------------------------------

const realConnect = Bun.connect;
const bunScope = Bun as unknown as { connect: AnyFn };
bunScope.connect = function (this: unknown, ...args: unknown[]) {
	const options = (args[0] ?? {}) as { hostname?: string; unix?: string };
	if (!options.unix && options.hostname && !isLoopbackHost(options.hostname)) {
		throw refuse("Bun.connect", options.hostname);
	}
	return (realConnect as unknown as AnyFn).apply(Bun, args);
};
