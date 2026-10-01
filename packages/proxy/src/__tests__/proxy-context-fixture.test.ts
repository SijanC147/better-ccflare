/**
 * Tests for the shared `ProxyContext` fixture (SB23-2446).
 *
 * The fixture exists so a test that grows into a new scheduler path is told
 * which field it failed to supply instead of getting
 * `Cannot read properties of undefined`. That property is the whole point of
 * the change and nothing else in this directory exercises it: the six suites
 * the fixture replaced all stay inside `runtime`, `refreshInFlight` and, in one
 * case, a supplied `dbOps` method. Without this file a mutation that turned
 * every throwing stub into a silent `undefined` would survive the entire
 * package, which is the defect the fixture was written to remove, reproduced
 * one layer down.
 */
import { describe, expect, it } from "bun:test";
import { makeProxyContext } from "./proxy-context-fixture";

describe("makeProxyContext", () => {
	it("supplies all seven required ProxyContext fields", () => {
		const context = makeProxyContext();
		for (const field of [
			"strategy",
			"dbOps",
			"runtime",
			"config",
			"provider",
			"refreshInFlight",
			"asyncWriter",
		] as const) {
			expect(context[field]).toBeDefined();
		}
	});

	it("supplies a complete RuntimeConfig, not the two-field literal it replaced", () => {
		const { runtime } = makeProxyContext();
		expect(runtime.clientId).toBe("test-client");
		expect(runtime.port).toBe(8080);
		expect(runtime.sessionDurationMs).toBe(5 * 60 * 60 * 1000);
		expect(runtime.retry).toEqual({ attempts: 3, delayMs: 1000, backoff: 2 });
	});

	it("merges a runtime override over the default without dropping the rest", () => {
		const { runtime } = makeProxyContext({ runtime: { port: 8443 } });
		expect(runtime.port).toBe(8443);
		expect(runtime.sessionDurationMs).toBe(5 * 60 * 60 * 1000);
	});

	it("gives each context its own refreshInFlight map", () => {
		const first = makeProxyContext();
		const second = makeProxyContext();
		first.refreshInFlight.set("acc-1", Promise.resolve("token"));
		expect(second.refreshInFlight.size).toBe(0);
	});

	it("omits internalProbeSecret unless asked, and supplies it when asked", () => {
		expect(makeProxyContext().internalProbeSecret).toBeUndefined();
		expect(
			makeProxyContext({ internalProbeSecret: "probe-secret" })
				.internalProbeSecret,
		).toBe("probe-secret");
	});

	// ── the throwing stubs ─────────────────────────────────────────────────────
	//
	// Each case asserts the whole behaviour rather than that "something threw":
	// the message has to name the field and the property, because a message that
	// only says "not supplied" sends the reader back to the same search the
	// fixture exists to end.

	it("throws naming the field and the property when an unsupplied field is read", () => {
		const context = makeProxyContext();
		expect(() => context.strategy.select([], {} as never)).toThrow(
			/ProxyContext\.strategy\.select was read by a test that did not supply it/,
		);
		expect(() => context.provider.canHandle("/v1/messages")).toThrow(
			/ProxyContext\.provider\.canHandle was read by a test that did not supply it/,
		);
		expect(() => context.asyncWriter.enqueue({} as never)).toThrow(
			/ProxyContext\.asyncWriter\.enqueue was read by a test that did not supply it/,
		);
	});

	it("throws for a dbOps method the caller did not supply", () => {
		const context = makeProxyContext({
			dbOps: { flagRequiresReauthIfTokenMatches: async () => true },
		});
		expect(() =>
			context.dbOps.recordUsageSnapshot("acc-1", {} as never, 0),
		).toThrow(
			/ProxyContext\.dbOps\.recordUsageSnapshot was read by a test that did not supply it/,
		);
	});

	it("serves a dbOps method the caller did supply", async () => {
		const context = makeProxyContext({
			dbOps: { flagRequiresReauthIfTokenMatches: async () => true },
		});
		expect(
			await context.dbOps.flagRequiresReauthIfTokenMatches("acc-1", "rt"),
		).toBe(true);
	});

	// ── strategy, config, provider, asyncWriter (SB23-2483) ───────────────────
	//
	// A plain object is a partial mock and a class instance is real. Both arms
	// are asserted for every field, because a mutation that dropped one field's
	// override would otherwise survive in any suite that never supplies it.

	it.each([
		"strategy",
		"config",
		"provider",
		"asyncWriter",
	] as const)("serves the methods a plain %s mock names and throws for the rest", (field) => {
		const named = () => "served";
		const context = makeProxyContext({ [field]: { named } });
		const stub = context[field] as unknown as Record<string, unknown>;
		expect(stub.named).toBe(named);
		expect(() => stub.unnamed).toThrow(
			new Error(
				`ProxyContext.${field}.unnamed was read by a test that did not supply it. ` +
					`The ${field} passed to makeProxyContext() is a partial mock that does not name unnamed. Add unnamed to it, or pass a real instance.`,
			),
		);
	});

	// The other plain-object arm: a mock built with no prototype at all.
	// Without this case, dropping `prototype === null` from isPlainObject
	// passes every test and such a mock goes through unwrapped (FM1 on PR
	// #294, measured on darwin).
	it.each([
		"strategy",
		"config",
		"provider",
		"asyncWriter",
	] as const)("wraps a null-prototype %s mock like any other plain object", (field) => {
		const named = () => "served";
		const mockObject: Record<string, unknown> = Object.create(null);
		mockObject.named = named;
		const context = makeProxyContext({ [field]: mockObject });
		expect(context[field]).not.toBe(mockObject as never);
		const stub = context[field] as unknown as Record<string, unknown>;
		expect(stub.named).toBe(named);
		expect(() => stub.unnamed).toThrow(
			new Error(
				`ProxyContext.${field}.unnamed was read by a test that did not supply it. ` +
					`The ${field} passed to makeProxyContext() is a partial mock that does not name unnamed. Add unnamed to it, or pass a real instance.`,
			),
		);
	});

	it.each([
		"strategy",
		"config",
		"provider",
		"asyncWriter",
	] as const)("returns a real %s instance by identity", (field) => {
		class Real {
			method() {
				return "prototype method";
			}
		}
		const real = new Real();
		const context = makeProxyContext({ [field]: real });
		expect(context[field]).toBe(real as never);
		// The case the passthrough exists for: a stub serves only own
		// properties, so wrapping an instance would hide this method.
		expect((context[field] as unknown as Real).method()).toBe(
			"prototype method",
		);
	});

	it("names the unsupplied field, not a partial mock, when the caller passed none", () => {
		expect(() => makeProxyContext().config.getStorePayloads()).toThrow(
			new Error(
				"ProxyContext.config.getStorePayloads was read by a test that did not supply it. " +
					"makeProxyContext() stubs config when the caller passes none. " +
					"Pass { config: { getStorePayloads: ... } } to makeProxyContext(), or a real instance if the test needs one.",
			),
		);
	});

	it("sees a write to the caller's mock after construction, and a write through the context", () => {
		const strategy: Record<string, unknown> = {};
		const context = makeProxyContext({ strategy });
		const select = () => [];
		strategy.select = select;
		expect(context.strategy.select).toBe(select);
		const replaced = () => [];
		(context.strategy as unknown as Record<string, unknown>).select = replaced;
		expect(strategy.select).toBe(replaced);
	});

	// A stray `console.log(context)` or an `await` on a stub must not throw a
	// fixture error that has nothing to do with the test under way.
	it("answers undefined to the properties a runtime probes rather than throwing", () => {
		const { config } = makeProxyContext();
		expect(() => JSON.stringify(config)).not.toThrow();
		expect((config as unknown as { then?: unknown }).then).toBeUndefined();
		expect(Object.keys(config)).toEqual([]);
	});
});
