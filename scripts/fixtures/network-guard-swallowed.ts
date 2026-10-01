/**
 * Fixture for `scripts/test-network-guard.test.ts`, run by it in a child
 * `bun test` and never by the root suite: the name has no `.test.` in it.
 *
 * It does what the proxy, the pricing loader and the usage poller all do with
 * a failed fetch, which is to catch it and carry on. The guard must fail this
 * test anyway, through its global afterEach.
 */
import { expect, test } from "bun:test";

test("an attempt the code swallows", async () => {
	let caught = false;
	try {
		await fetch("https://api.anthropic.com/v1/messages", { method: "POST" });
	} catch {
		caught = true;
	}
	expect(caught).toBe(true);
});
