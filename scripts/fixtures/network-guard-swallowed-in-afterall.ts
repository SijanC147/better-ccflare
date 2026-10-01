/**
 * Fixture for `scripts/test-network-guard.test.ts`, run by it in a child
 * `bun test` and never by the root suite: the name has no `.test.` in it.
 *
 * The attempt is made in a file-level afterAll, after the last test's
 * afterEach has run, so only the guard's own global afterAll can charge it.
 */
import { afterAll, expect, test } from "bun:test";

test("a test that passes", () => {
	expect(1).toBe(1);
});

afterAll(async () => {
	try {
		await fetch("https://api.anthropic.com/v1/models");
	} catch {
		// swallowed, as cleanup code usually does
	}
});
