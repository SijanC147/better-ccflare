/**
 * Shared test helper. Not a test file: `bun test` only collects `*.test.ts`.
 *
 * Bun's `typeof fetch` carries `preconnect(url)`, an extension over the WHATWG
 * signature. A test double implements the call signature and nothing else, so
 * `globalThis.fetch = mock(async () => new Response("ok"))` is
 * `error TS2741: Property 'preconnect' is missing` — 95 of them in
 * `packages/proxy` before SB23-2344 gated these files.
 *
 * Assigning through this reference types the slot as the call signature alone,
 * which is the whole of what the code under test uses. The alternative is an
 * `as unknown as typeof fetch` at each of the 119 assignment sites, which
 * would put the same claim in 119 places and check none of them.
 *
 * The one assertion is here. It is sound in the direction that matters: the
 * real `typeof fetch` satisfies this narrower shape, so nothing a test assigns
 * through this reference can be something `fetch`'s own consumers could not
 * call. `unknown` is needed only because `typeof globalThis` declares many
 * other members this type does not.
 */
/**
 * The call signature alone. Exported for helpers that take a fetch double as a
 * parameter rather than assigning one: `fetchSlot` types an assignment target,
 * so it cannot reach a parameter position.
 */
export type FetchImpl = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export const fetchSlot = globalThis as unknown as {
	fetch: FetchImpl;
};
