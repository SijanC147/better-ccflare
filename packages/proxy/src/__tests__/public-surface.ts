/**
 * Shared test helper. Not a test file: `bun test` only collects `*.test.ts`.
 *
 * Several auto-refresh tests reach into `AutoRefreshScheduler`'s private
 * members and spell the shape they expect as
 * `AutoRefreshScheduler & { consecutiveFailures: Map<string, number>; ... }`.
 *
 * That intersection is `never`. When a member is private on one constituent
 * and public on another, TypeScript cannot reconcile the two declarations and
 * reduces the whole intersection, so every property access on the result is
 * `error TS2339: Property 'x' does not exist on type 'never'` — 90 of them in
 * `packages/proxy` before SB23-2344 gated these files. The tests were passing
 * because JavaScript has no private members at runtime; nothing typechecked
 * them.
 *
 * `PublicSurface<T>` maps over `keyof T`, which lists only a class's public
 * members, so the private declarations are dropped rather than conflicted
 * with. Intersecting the result with the members a test wants to reach then
 * produces a plain object type.
 *
 * The value still has to be asserted through `unknown`: the constructed
 * instance really does declare those members private, and TypeScript refuses a
 * direct assertion between a type with a private member and one that declares
 * the same name public. That is the language enforcing the encapsulation the
 * test is deliberately bypassing, not a defect in either type.
 */
export type PublicSurface<T> = { [K in keyof T]: T[K] };
