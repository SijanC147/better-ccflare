// Checked-in fallback for the embedded post-processor worker.
//
// The CLI build step (apps/cli/build-multi-arch.ts) overwrites this file
// with the bundled post-processor.worker code base64-encoded into
// EMBEDDED_WORKER_CODE so production binaries can spawn the usage
// post-processor worker from an inline blob.
//
// This default ships an empty string so that a clean checkout can import
// `@better-ccflare/proxy` (and therefore run `bun test`, `bun run start`,
// or `bun start`) WITHOUT having run the CLI build first. When the
// constant is empty, usage-worker-controller.ts falls back to spawning
// the worker from `./post-processor.worker.ts` directly — fully
// functional, just without the inlined-blob optimization.
//
// Do not commit a build-populated (non-empty) version of this file; if a
// build has overwritten it, restore with:
//   git checkout -- packages/proxy/src/inline-worker.ts
export const EMBEDDED_WORKER_CODE = "";
