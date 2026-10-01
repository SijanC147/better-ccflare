/**
 * Shared `ProxyContext` fixture. Not a test file: `bun test` only collects
 * `*.test.ts`. Sibling of `public-surface.ts`, the other shared helper here.
 *
 * SB23-2446. Six test files each defined their own `makeProxyContext()` and
 * every one returned a strict subset of the eight fields `ProxyContext`
 * declares, then asserted the result to the whole type at the constructor
 * call. Four returned `runtime` and `refreshInFlight`; the rotation-race suite
 * returned those plus a one-method `dbOps`; the cache-keepalive suite returned
 * `runtime` alone. The `runtime` they all supplied was itself a two-of-four
 * literal, missing `retry` and `sessionDurationMs`.
 *
 * The assertion is what makes that dangerous rather than merely untidy. The
 * scheduler reads `proxyContext.dbOps` at six sites; the suites never reached
 * one because their mock query returns `[]`, so no probe is sent. Widen any of
 * them and the property is `undefined` while the type promises
 * `DatabaseOperations`, and the compiler has already been told not to look.
 *
 * ## What is real and what is a stub
 *
 * Real values, because a test can meaningfully read them:
 *
 * - `runtime`, a complete `RuntimeConfig`. Override any subset.
 * - `refreshInFlight`, a real `Map`, fresh per call so two contexts never
 *   share one.
 * - `dbOps`, whatever methods the caller supplies, and nothing else.
 * - `internalProbeSecret`, absent unless supplied, which is what the six
 *   suites had. It is the one optional field on the type.
 *
 * Throwing stubs, because a silent `undefined` is the defect this file exists
 * to remove:
 *
 * - `strategy`, `config`, `provider` and `asyncWriter` when the caller does not
 *   supply them, and any `dbOps` method the caller did not supply.
 *
 * ## Supplying `strategy`, `config`, `provider` or `asyncWriter` (SB23-2483)
 *
 * Nineteen more files, then sixty-four once the handler and server suites were
 * counted by shape, built the whole context inline because the fixture could
 * not take these four. Each accepts either of two things, and the two are told
 * apart by prototype rather than by anything the caller declares:
 *
 * - **A plain object literal** (prototype `Object.prototype` or `null`) is a
 *   partial mock. It is wrapped exactly like `dbOps`: the methods it names are
 *   served, live, so a later write to the caller's object is seen; every other
 *   property throws naming itself. `{ select: ... }` for `strategy` is the
 *   common case.
 * - **Anything else** is a real instance, for example `new AnthropicProvider()`
 *   or `getProvider("anthropic")`, and is returned unchanged. Wrapping one would
 *   hide its prototype methods behind the stub, since the stub serves only own
 *   properties.
 *
 * A plain object that happens to implement the whole interface is still
 * wrapped. That costs nothing and keeps one rule: a literal in a test is a
 * mock, and a mock answers only for what it names.
 *
 * ## Members production tests for presence
 *
 * Some members are optional in practice: production checks for them and takes
 * a default branch when they are missing. A literal that did not name one
 * answered `undefined` and took that branch; the stub throws instead. Measured
 * while migrating sixty-four files (SB23-2483):
 *
 * - `provider.isStreamingResponse` (`?.()`), `extractUsageInfo` and
 *   `prepareRequest` (`if (provider.x)`), `observeRequest` (proxy.ts picks
 *   the codex observer when it is absent), `observeUpstream` (`?.()`). These
 *   are optional on `Provider`, so absence is a real production state: name
 *   the member as `undefined` to keep that branch, never a function returning
 *   a guessed default.
 * - `config.getModelScopedCapacityRouting`, `getCombosEnabled`,
 *   `getForceAccountModel`, `getComboSessionFallback` (account-selector.ts,
 *   all `?.()`), `getStorePayloads` (response-handler.ts, `?.()`). These are
 *   REQUIRED methods on `Config`, so a production context never lacks them and
 *   an explicit `undefined` is the `Partial<T>` lie `exactOptionalPropertyTypes`
 *   exists to refuse (SB23-2456). Name each as a function returning exactly its
 *   read site's fallback: `() => true` for `getCombosEnabled`,
 *   `getStorePayloads` and `getComboSessionFallback` (`?? true`),
 *   `() => false` for `getForceAccountModel` (`?? false`), `() => "off"` for
 *   `getModelScopedCapacityRouting` (the read is `=== "exhausted"`). That is
 *   the branch `undefined` took, with no guessed value. SB23-3983 converted 104
 *   such members across 33 files.
 *
 * That is why the four fields and `dbOps` are typed `MockOf<T>` rather than
 * `Partial<T>`. `MockOf<T>` admits an explicit `undefined` only on a member
 * whose type already includes it (an optional member such as
 * `Provider.observeRequest`), because there an own key holding `undefined`
 * differs from leaving the member out: the stub serves the first and throws for
 * the second. On a required member it refuses `undefined`, as `Partial<T>` does
 * under the flag. A required `dbOps` member a test does not need is left out:
 * production reads `resolverManager`, `getAccount` and `updateRequestUsage`
 * without `?.`, so the stub's throw lands in the same `catch` an `undefined`'s
 * `TypeError` did.
 *
 * One exception: a member production tests with `in`, such as
 * `"parseRateLimitFromBody" in provider` (handlers/response-processor.ts),
 * must be OMITTED, not named as `undefined`. The `has` trap answers true for
 * a named member, so `in` takes the present branch and calls `undefined`.
 *
 * ## Spy on the object you passed, never on `ctx.<field>`
 *
 * `spyOn(ctx.config, "getX")` does not throw and does nothing: Bun's `spyOn`
 * writes past the `Proxy` traps, so later reads still return the original and
 * the spy records no calls. Reads are live, so spying on the object handed to
 * `makeProxyContext()` works. Measured on Bun 1.4.2 by the PR #294 reviewer.
 *
 * **Several of those reads sit inside a `catch` that logs and carries on**, so
 * a stub throw there changes the branch with every test still green and the
 * same `expect()` count. A test-name diff cannot see it. A preload that wraps
 * `Proxy` and prints every throw carrying this file's message, swallowed or
 * not, can; that is how `observeRequest` and `observeUpstream` were found.
 *
 * Reaching one throws naming the field and the property, so a test that grows
 * into a new code path gets told which field to supply instead of
 * `Cannot read properties of undefined`.
 *
 * ## What a throwing stub does not buy you
 *
 * **No `dbOps` read site in `auto-refresh-scheduler.ts` produces a `TypeError`
 * a test can see.** All six are inside a `try` that catches everything: 1018
 * and 1213 catch their own write, 1312 catches and returns early, 935 and 1132
 * hand `dbOps` to `flushPendingRotation`, which has its own catch, and 738 sits
 * inside the `try` that `sendDummyMessage` opens at :353 and does not close
 * until its catch at :804.
 *
 * That last catch calls `recordRefreshFailure`, so an absent `dbOps` at 738 is
 * counted as a refresh failure against the account and pushes it toward
 * `FAILURE_THRESHOLD`. A widened suite would watch an account drift toward a
 * pause, with no type error and no crash anywhere.
 *
 * So neither a `TypeError` from `undefined` nor this stub's named error reaches
 * a test as a throw. Both are swallowed and the method takes its failure
 * branch, which surfaces as a wrong result. The stub still wins, because the
 * swallowed message names the field in the log line instead of reading as a
 * database outage, but do not expect a reached stub to fail a test loudly.
 *
 * An earlier version of this comment said only site 738 was uncaught. That was
 * measured with a window starting at line 690, which found the `try` at 769,
 * below the site, and could not see the one opening above it. **A window around
 * a line cannot answer whether the line is enclosed**; that is a brace-balance
 * question over the whole enclosing scope:
 * `awk 'NR>=335 && NR<=738 {if (/try \{/) t++; if (/\} catch/) c++}' ` gives
 * `try=3 catch=2`, one unclosed.
 *
 * ## No assertion on the result
 *
 * `makeProxyContext()` returns `ProxyContext` with no `as`. The casts that
 * remain are one per stub, inside this file, where a `Proxy` is given the type
 * of the class it stands in for. That is the whole point of the change: the
 * assertion moved from "this two-field object is a whole context" at six call
 * sites to "this throwing placeholder stands in for a class no unit test
 * builds" at four declarations that say so.
 */
import type { Config, RuntimeConfig } from "@better-ccflare/config";
import type {
	AsyncDbWriter,
	DatabaseOperations,
} from "@better-ccflare/database";
import type { Provider } from "@better-ccflare/providers";
import type { LoadBalancingStrategy } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers/proxy-types";

/**
 * A partial mock of `T`. A member whose type already includes `undefined` may
 * be named as `undefined`; a required member may not. See "Members production
 * tests for presence" above: an own key holding `undefined` is served as
 * `undefined`, while a key that is not named throws.
 */
export type MockOf<T> = {
	[K in keyof T]?: undefined extends T[K] ? T[K] | undefined : T[K];
};

/**
 * Property names a runtime probes on an arbitrary object without the code
 * under test asking for them: `await` looks for `then`, `JSON.stringify` looks
 * for `toJSON`, and printing a value looks for `inspect` or `constructor`.
 * Answering `undefined` to those keeps a stray `console.log` or a rejected
 * promise from throwing a fixture error that has nothing to do with the test.
 * Symbols are waved through for the same reason.
 */
const RUNTIME_PROBE_KEYS = new Set([
	"then",
	"toJSON",
	"inspect",
	"constructor",
	"asymmetricMatch",
	"$$typeof",
]);

/**
 * A stand-in for a `ProxyContext` field that no unit test in this directory
 * constructs. Every property read that is not a runtime probe throws, naming
 * the field, the property, and how to supply it.
 *
 * `known` serves the entries a caller did supply, so a partially-specified
 * `dbOps` answers for its own methods and throws for the rest.
 */
function throwingStub<T extends object>(
	field: string,
	known: Record<string, unknown> = {},
	callerSupplied = false,
): T {
	return new Proxy({} as T, {
		get(_target, property) {
			if (typeof property === "symbol") return undefined;
			if (Object.hasOwn(known, property)) return known[property];
			if (RUNTIME_PROBE_KEYS.has(property)) return undefined;
			throw new Error(
				`ProxyContext.${field}.${property} was read by a test that did not supply it. ` +
					(callerSupplied
						? `The ${field} passed to makeProxyContext() is a partial mock that does not name ${property}. Add ${property} to it, or pass a real instance.`
						: `makeProxyContext() stubs ${field} when the caller passes none. ` +
							`Pass { ${field}: { ${property}: ... } } to makeProxyContext(), or a real instance if the test needs one.`),
			);
		},
		// A write through the context lands on the caller's object, which is
		// what a test that assigns a mock after construction expects: the inline
		// literals these contexts replace were that object.
		set(_target, property, value) {
			if (typeof property === "symbol") return false;
			known[property] = value;
			return true;
		},
		has(_target, property) {
			return typeof property === "string" && Object.hasOwn(known, property);
		},
		ownKeys() {
			return Object.keys(known);
		},
		getOwnPropertyDescriptor(_target, property) {
			if (typeof property === "string" && Object.hasOwn(known, property)) {
				return { configurable: true, enumerable: true, value: known[property] };
			}
			return undefined;
		},
	});
}

/**
 * True for an object literal, the shape a test writes when it mocks a field;
 * false for a class instance, which is a real implementation to pass through.
 */
function isPlainObject(value: object): boolean {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * The value for one of the four fields that are either a partial mock or a
 * real instance. See "Supplying `strategy`, ..." in the header.
 *
 * The single assertion here is the passthrough arm: `MockOf<T>` is the
 * declared type, and an instance that is not a plain object is taken to be the
 * whole `T` it was constructed as. That is the same claim every call site used
 * to make with `as never`, made once, behind a runtime check.
 */
function suppliedOrStub<T extends object>(
	field: string,
	supplied: MockOf<T> | undefined,
): T {
	if (supplied === undefined) return throwingStub<T>(field);
	if (isPlainObject(supplied)) {
		return throwingStub<T>(field, supplied as Record<string, unknown>, true);
	}
	return supplied as T;
}

/**
 * A complete `RuntimeConfig`. The values match the shipped defaults rather
 * than being arbitrary: five-hour session window, three retry attempts at a
 * 1000ms base with a backoff of 2.
 */
const DEFAULT_RUNTIME: RuntimeConfig = {
	clientId: "test-client",
	port: 8080,
	sessionDurationMs: 5 * 60 * 60 * 1000,
	retry: { attempts: 3, delayMs: 1000, backoff: 2 },
};

export interface ProxyContextOverrides {
	/** Merged over the complete default; pass only the fields the test reads. */
	runtime?: Partial<RuntimeConfig>;
	/**
	 * The `DatabaseOperations` methods this test expects to be called. Any
	 * other method throws naming itself.
	 */
	dbOps?: MockOf<DatabaseOperations>;
	/** Defaults to a fresh empty `Map`, never shared between two contexts. */
	refreshInFlight?: Map<string, Promise<string>>;
	/** Absent by default, matching the six helpers this fixture replaces. */
	internalProbeSecret?: string | undefined;
	/**
	 * A plain object is a partial mock: its methods are served and any other
	 * property throws. A class instance passes through unchanged.
	 */
	strategy?: MockOf<LoadBalancingStrategy>;
	/** As `strategy`. */
	config?: MockOf<Config>;
	/** As `strategy`. A real provider instance passes through. */
	provider?: MockOf<Provider>;
	/** As `strategy`. */
	asyncWriter?: MockOf<AsyncDbWriter>;
}

/**
 * Build a `ProxyContext` with all seven required fields present.
 *
 * Returns the real type. Call sites need no assertion, so a change to
 * `ProxyContext` fails here once rather than being silenced six times.
 */
export function makeProxyContext(
	overrides: ProxyContextOverrides = {},
): ProxyContext {
	const context: ProxyContext = {
		runtime: { ...DEFAULT_RUNTIME, ...overrides.runtime },
		refreshInFlight: overrides.refreshInFlight ?? new Map(),
		dbOps: throwingStub<DatabaseOperations>(
			"dbOps",
			(overrides.dbOps ?? {}) as Record<string, unknown>,
			overrides.dbOps !== undefined,
		),
		strategy: suppliedOrStub<LoadBalancingStrategy>(
			"strategy",
			overrides.strategy,
		),
		config: suppliedOrStub<Config>("config", overrides.config),
		provider: suppliedOrStub<Provider>("provider", overrides.provider),
		asyncWriter: suppliedOrStub<AsyncDbWriter>(
			"asyncWriter",
			overrides.asyncWriter,
		),
	};
	if (overrides.internalProbeSecret !== undefined) {
		context.internalProbeSecret = overrides.internalProbeSecret;
	}
	return context;
}
