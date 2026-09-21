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
 * - `runtime` — a complete `RuntimeConfig`. Override any subset.
 * - `refreshInFlight` — a real `Map`, fresh per call so two contexts never
 *   share one.
 * - `dbOps` — whatever methods the caller supplies, and nothing else.
 * - `internalProbeSecret` — absent unless supplied, which is what the six
 *   suites had. It is the one optional field on the type.
 *
 * Throwing stubs, because no test in this directory constructs one and a
 * silent `undefined` is the defect this file exists to remove:
 *
 * - `strategy`, `config`, `provider`, `asyncWriter`, and any `dbOps` method
 *   the caller did not supply.
 *
 * Reaching one throws naming the field and the property, so a test that grows
 * into a new code path gets told which field to supply instead of
 * `Cannot read properties of undefined`.
 *
 * ## What a throwing stub does not buy you
 *
 * Five of the six `dbOps` read sites in `auto-refresh-scheduler.ts` sit inside
 * a `try` that catches everything: 1018 and 1213 catch their own write, 1312
 * catches and returns early, and 935 and 1132 hand `dbOps` to
 * `flushPendingRotation`, which has its own catch. So at those sites neither a
 * `TypeError` from `undefined` nor this stub's named error reaches the test as
 * a throw. Both are swallowed and the method takes its failure branch, which
 * surfaces as a wrong result rather than an error. The stub still wins, because
 * the swallowed message names the field in the log line instead of reading as a
 * database outage, but do not expect a reached stub to fail a test loudly. Only
 * site 738, `recordUsageSnapshot`, is outside a catch.
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
): T {
	return new Proxy({} as T, {
		get(_target, property) {
			if (typeof property === "symbol") return undefined;
			if (Object.hasOwn(known, property)) return known[property];
			if (RUNTIME_PROBE_KEYS.has(property)) return undefined;
			throw new Error(
				`ProxyContext.${field}.${property} was read by a test that did not supply it. ` +
					`makeProxyContext() stubs ${field} because no test in packages/proxy/src/__tests__ builds a real one. ` +
					`Pass { ${field}: { ${property}: ... } } to makeProxyContext(), or build the real object if the test needs one.`,
			);
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
	dbOps?: Partial<DatabaseOperations>;
	/** Defaults to a fresh empty `Map`, never shared between two contexts. */
	refreshInFlight?: Map<string, Promise<string>>;
	/** Absent by default, matching the six helpers this fixture replaces. */
	internalProbeSecret?: string;
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
		),
		strategy: throwingStub<LoadBalancingStrategy>("strategy"),
		config: throwingStub<Config>("config"),
		provider: throwingStub<Provider>("provider"),
		asyncWriter: throwingStub<AsyncDbWriter>("asyncWriter"),
	};
	if (overrides.internalProbeSecret !== undefined) {
		context.internalProbeSecret = overrides.internalProbeSecret;
	}
	return context;
}
