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

	// A stray `console.log(context)` or an `await` on a stub must not throw a
	// fixture error that has nothing to do with the test under way.
	it("answers undefined to the properties a runtime probes rather than throwing", () => {
		const { config } = makeProxyContext();
		expect(() => JSON.stringify(config)).not.toThrow();
		expect((config as unknown as { then?: unknown }).then).toBeUndefined();
		expect(Object.keys(config)).toEqual([]);
	});
});
