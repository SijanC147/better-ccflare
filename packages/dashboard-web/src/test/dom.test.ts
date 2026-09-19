/**
 * Tests for the test helper itself.
 *
 * Every case here was written against a mutation an independent reviewer
 * landed on `dom.ts` at head c1eddc2a and found surviving. Without them the
 * restore loop that makes the whole renderer safe can be deleted with
 * `bun test packages/dashboard-web/` still green, and the only thing that
 * notices is a full-suite run failing in a package the diff never touched.
 */
import { expect, test } from "bun:test";
import { byText } from "./dom";

test("registration left Bun's stream family in place", () => {
	// Reviewer mutation M11 replaced the restore loop with `void native;`.
	// The full suite went from 2 fail to 6 fail, the four extra being
	// `processResponse - SSE` in packages/providers, and every test in THIS
	// package stayed green. So the package that owns the hazard had no
	// detector for it and the failure surfaced two packages away.
	//
	// This is the exact operation that broke: a Bun ReadableStream piped
	// through a TransformStream. If the restore loop goes, this throws
	// `TypeError: The transform's 'readable' property must be a ReadableStream`.
	const body = new Response(new ReadableStream()).body;
	expect(body).not.toBeNull();
	const piped = (body as ReadableStream).pipeThrough(new TransformStream());
	expect(piped).toBeInstanceOf(ReadableStream);
});

test("the restored globals are present and Response round-trips a stream", () => {
	// Measured, and weaker than it looks: under the M11 mutation that deletes
	// the restore loop entirely, this test PASSES. Only the pipeThrough case
	// above catches that. It is kept as a cheap presence check, not as a
	// second detector, and this comment exists so nobody counts it as one.
	// `document` existing proves registration ran, so it is not vacuous.
	expect(typeof globalThis.document).not.toBe("undefined");
	for (const name of ["Response", "Request", "Headers", "Blob"]) {
		expect(typeof (globalThis as Record<string, unknown>)[name]).toBe(
			"function",
		);
	}
	// Bun's Response accepts a ReadableStream body and exposes it as one.
	// happy-dom's does not round-trip it this way.
	expect(new Response(new ReadableStream()).body).toBeInstanceOf(
		ReadableStream,
	);
});

test("byText matches exactly, not by prefix", () => {
	// Reviewer mutations M4 (drop the `.trim()`) and M5 (`startsWith` for
	// `===`) both survived all 13 tests. The docstring says "exactly" and
	// nothing held it there, so `byText(host, "button", "Acknowledge")` would
	// have silently matched both "Acknowledge group" and "Acknowledge all".
	const host = document.createElement("div");
	host.innerHTML =
		"<button>Acknowledge</button><button>Acknowledge group</button>" +
		"<button>  Acknowledge all  </button>";

	// Kills M5: a prefix match would return two here.
	expect(byText(host, "button", "Acknowledge").length).toBe(1);
	expect(byText(host, "button", "Acknowledge group").length).toBe(1);

	// Kills M4: the third button's text is padded, so without the trim it
	// matches nothing.
	expect(byText(host, "button", "Acknowledge all").length).toBe(1);

	expect(byText(host, "button", "Acknowledge grou").length).toBe(0);
});

test("happyDOM's async API is poisoned rather than silently wrong", () => {
	// `dom.ts` restores Bun's timers, which hides them from happy-dom's task
	// manager, so `waitUntilComplete()` would return with work outstanding:
	// measured at 1ms against a 300ms timer. A comment is a check and checks
	// get missed, so `dom.ts` replaces the method with a thrower.
	//
	// This test exists because the poison is itself a claim. The reviewer that
	// proposed it flagged as unproven whether `globalThis.happyDOM` is
	// writable or an accessor, and an accessor would discard the assignment
	// silently, which is the same failure class the poison prevents. Asserting
	// the throw is how that stops being unproven.
	const hd = (globalThis as Record<string, unknown>).happyDOM as
		| Record<string, unknown>
		| undefined;
	expect(hd).toBeDefined();
	for (const name of ["waitUntilComplete", "whenAsyncComplete"]) {
		expect(() => (hd?.[name] as () => void)()).toThrow(/Use React's act/);
	}
});
