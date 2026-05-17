// Checked-in fallback for the embedded vacuum worker.
//
// The CLI build step (apps/cli/build-multi-arch.ts) overwrites this file
// with the bundled vacuum-worker code base64-encoded into
// EMBEDDED_VACUUM_WORKER_CODE so production binaries can spawn the vacuum
// worker from an inline blob.
//
// This default ships an empty string so that a clean checkout can import
// `@better-ccflare/database` (and therefore run `bun test` / `bun run
// server`) WITHOUT having run the CLI build first. When the constant is
// empty, database-operations.ts falls back to spawning the worker from
// `./vacuum-worker.ts` directly — fully functional, just without the
// inlined blob optimization.
//
// Do not commit a build-populated (non-empty) version of this file; if a
// build has overwritten it, restore with:
//   git checkout -- packages/database/src/inline-vacuum-worker.ts
export const EMBEDDED_VACUUM_WORKER_CODE = "";
