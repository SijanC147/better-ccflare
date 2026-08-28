# MERGELOG

Chronological record of upstream synchronizations into the **SijanC147/better-ccflare**
fork from **tombii/better-ccflare**. Maintained by the `/sync-upstream` slash command.
Newest entries first. Do not hand-edit the `last-sync-sha` marker — `/sync-upstream`
owns it for idempotency.

<!-- last-sync-sha: 4d27cb226f383a39e12aea530e83d2f9896999ce -->

## Sync History

| Date | Upstream Branch | SHA Range | Commits | Conflicts | Strategy | Verification | PR |
|------|-----------------|-----------|---------|-----------|----------|--------------|----|
| 2026-08-27 | main | `412e6326..4d27cb22` | 624 | 37 files / 72 hunks | merge --no-ff | pass (3967 tests, 11 inherited-upstream fail) | [#41](https://github.com/SijanC147/better-ccflare/pull/41) |
| 2026-07-03 | main | `ab677460..412e6326` | 206 | 23 files | merge --no-ff | pass (1960 tests, 0 fail) | [#33](https://github.com/SijanC147/better-ccflare/pull/33) |
| 2026-05-19 | main | `5cdabaa8..ab677460` | 125 | 15 files | merge --no-ff | pass (1582 tests, 0 fail) | [#32](https://github.com/SijanC147/better-ccflare/pull/32) |
| 2026-05-17 | main | `3c08c994..5cdabaa8` | 195 | 4 git + 4 semantic | merge --no-ff | pass (1291 tests, 0 fail) | [#27](https://github.com/SijanC147/better-ccflare/pull/27) |

---

<!-- New sync entries are appended below this line, newest first. -->

## 2026-08-27 — upstream `412e6326..4d27cb22` (624 commits)

**PR:** [#41](https://github.com/SijanC147/better-ccflare/pull/41) · **Strategy:** `merge --no-ff`
**Scale:** 494 files auto-merged clean · 37 conflicted files / 72 hunks · +84,403 / −3,262
**Tests:** 1,983 → 3,967 (upstream contributed ~2,000)

### Verification

| Gate | Result |
|---|---|
| `bun install --frozen-lockfile` | pass |
| `bun run typecheck` | 0 errors |
| `bunx biome check .` | 26 errors — **down from 29**, rule categories a strict subset of pre-merge |
| `bun test` | 3,900 pass / 11 fail — all 11 inherited (see below) |
| `bun run build:dashboard` | pass |
| `scripts/test-hextap-build.ts` | adapter determinism + identity pass |
| `brew hextap validate --project .` | VALIDATED, toolkit `v0.4.2@613f0d37` |
| Manifest byte-equality | `328f95a7…` both copies |
| Hextap inviolables | untouched (empty diff) |

### The 11 remaining failures are upstream's, not ours

Two distinct causes, both in upstream files byte-identical to `4d27cb22`:

**9 from destroyed global fetch.** `packages/proxy/src/__tests__/cache-keepalive-scheduler.test.ts`
does this in `afterEach`:

```ts
// Restore fetch to the real implementation.
// @ts-expect-error — resetting to undefined lets bun restore native fetch.
globalThis.fetch = undefined;
```

The comment is wrong: assigning `undefined` does not restore Bun's native fetch, it destroys it
for the rest of the process. Every later file calling global fetch dies with
`TypeError: fetch is not a function` — hence the sub-millisecond failures in
`request-handler-client-abort.test.ts` (6) and `bun-leak-273-safety.test.ts` (3). This is not
`mock.module` pollution and `mock.restore()` would not help. Minimal repro:

```sh
bun test packages/proxy/src/__tests__/cache-keepalive-scheduler.test.ts \
         packages/proxy/src/handlers/__tests__/request-handler-client-abort.test.ts
```

**2 from a macOS-only path assertion.** `packages/agents/src/__tests__/discovery-workspace-isolation.test.ts`
fails *standalone*, not from pollution: it expects `/private/var/folders/…` where the registry
stores `/var/folders/…`. `fs.realpathSync` resolves the macOS symlink; the assertion does not.
Would pass on Linux CI. (`discovery.test.ts` is clean — 15/15 everywhere.)

Verified inherited by running upstream's own suite standalone at `4d27cb22`: **182 fail /
2,507 pass**, including every one of these clusters. Upstream's entire `CLI Integration Tests`
and `AutoRefreshScheduler` suites are also red on their own main and green here.

### Defects found that produced NO merge conflict

The conflict list was not where the risk was. Five defects auto-merged cleanly:

1. **`signpath-release.yml` — second `v*` release publisher.** Upstream added a workflow with
   a `v*` tag trigger, `contents: write`, and `gh release upload`, which would write a ninth
   asset into the release Hextap publishes as immutable with an exact eight-file manifest.
   **`scripts/hextap-contract.test.ts` passed on it** — the assertion was a substring match for
   the double-quoted `- "v*"`, and upstream wrote `- 'v*'` with a trailing comment. Disabled via
   the fork's `.yml.disabled` convention. Contract test hardened with an exact active-workflow
   filename allowlist (unevadeable by quoting) plus a quote-agnostic regex; mutation-tested
   both ways. Toolkit-side fix tracked as SB23-680.
2. **`?api_key=` fallback survived upstream's #379 removal.** Upstream replaced the durable key
   in a query string with a short-lived single-use stream token; the fork's `extract-api-key.ts`
   kept the fallback, with a comment acknowledging the key "may appear in server access logs".
   Adopted upstream's version and extended the token flow to the fork's own
   `/api/requests/stream` (see below).
3. **`PathValidator` logged full TLS paths at info**, undoing the fork's own
   `fix(security): redact missing TLS paths`. Resolved path demoted to debug; description stays
   at info so upstream's dev ergonomics survive.
4. **`http-api/handlers/requests.ts` did not compile** — fork and upstream each independently
   added a `project` field, duplicating both the type member and the object key. The two
   assignments had *different* semantics (`request.project` vs `request.project || undefined`);
   kept the null-preserving form, since `RequestResponse.project` is typed `?: string | null`.
5. **`http-api/handlers/combos.ts` did not compile** — a stale `_comboId` reference survived
   where the parameter is `comboId`.

### Cross-cluster integration point

`dbOps.saveRequest()`'s positional parameters were reordered so upstream's form a contiguous
prefix and the fork's `projectId`/`worktreePath` are appended last. Eight call sites pass
upstream's params positionally with `undefined // comboName` style comments; interleaving the
fork's ahead would have shifted every binding **with no type error**, since several share a type.
Verified signature and the single fork call site match.

### Two attribution features now coexist

Upstream independently built project attribution in this window
(`packages/proxy/src/project-attribution.ts`), colliding with the fork's test file of the same
name. They are complementary, not duplicates:

| | Fork | Upstream |
|---|---|---|
| Input | filesystem path | headers / system prompt / workspace path |
| Output | registered project **id** + worktree | sanitised project **name** |

Both suites kept; the fork's renamed to `project-resolver-attribution.test.ts`. **Open design
question:** whether these should stay independent or converge.

### Deliberate changes beyond mechanical resolution

Three, each because leaving it would have shipped something broken or unsafe:

- Removed the `?api_key=` fallback and migrated `/api/requests/stream` to the stream-token flow
  (`useRequestStream.connect()` is now async; the unmount-before-token-resolves race is handled
  so a connection cannot be orphaned). **Authorised explicitly.**
- Demoted `PathValidator`'s resolved-path log to debug.
- Hardened the Hextap contract test with the active-workflow allowlist, on the coordinator's
  recommendation to do it in this PR rather than wait for a toolkit release.

### Follow-ups

- **SB23-680** (High) — Hextap toolkit: YAML-semantic tag-trigger exclusivity, reusable-workflow
  preflight, full-SHA action/runtime audit.
- **SB23-314** (Medium, re-scoped) — `bun test` exit code is non-deterministic: six runs on one
  commit, identical counts, five exit 0 and one exit 1. A required check can fail with zero test
  failures.
- Upstream's 182-failure baseline is inherited test debt; worth deciding whether to carry or fix.
- `signpath-release.yml.disabled` may reappear as an active file on a future sync — the new
  allowlist assertion is what catches that.

---

## 2026-07-03 — upstream/main sync

- **Upstream**: https://github.com/tombii/better-ccflare branch `main`
- **SHA range**: `ab677460330802078167f1ca4b5c0e84f545420b..412e63266475dd5b8ec485a8d8f5778586172bfd`
- **Commits integrated**: 206 across 8 parallel analysis buckets
- **Local-only commits preserved**: 72 (fork-specific work, none dropped)
- **Strategy**: merge --no-ff
- **Verification**: build ✅ · typecheck ✅ (0 errors) · biome ✅ (27 errors — all pre-existing fork-file debt SB23-313; net −1 vs baseline 28, zero new) · tests ✅ (1960 pass, 0 fail; non-zero exit only from pre-existing SB23-314 teardown unhandled rejections)

### Central architectural change

Adopted upstream's **worker → main-thread `UsageCollector`** migration wholesale
(fixes a real Bun memory leak, oven-sh/bun#5709 — structured-clone `postMessage`
buffers never reclaimed, ~0.85 MB RSS growth/request). Public proxy API renamed
`getUsageWorker*`/`sendWorkerConfigUpdate` → `initProxy`/`drainUsageCollector`/
`getUsageCollectorHealth`. Deleted `post-processor.worker.ts` +
`usage-worker-controller.ts`; retired the auto-generated `inline-worker.ts` +
`embedded-tiktoken-wasm.ts` embedding (apps/cli `build-multi-arch.ts` simplified to match).

**Re-injected fork features into the new collector** (`usage-collector.ts`), which
upstream's rewrite dropped:
- dual `x-ccflare-project` / `X-CCFlare-Project` case-insensitive header (upstream's
  `extractProjectFromRequest` only read `x-project`)
- `headersOnly` storage mode — threaded `getHeadersOnly` server → proxy → collector,
  consulted in `_handleEndInternal`; the live per-request getter replaces the old
  worker config-push, so config hot-reload still works
- `project_id` / `worktree_path` attribution persisted via `saveRequest`
  (ResolverManager resolution flows on `StartMessage`)

### Notable features brought in

- **openai-responses-adapter** (new package): Codex CLI `/v1/responses` → Anthropic
  Messages translation; wired into apps/server with WebSocket-upgrade 503 + decompression
- **xAI/Grok** OAuth provider (`packages/providers/xai`, CLI `--mode xai`, types/
  constants); the fork's qwen-only proactive refresh was generalized into upstream's
  `checkAndRefreshOpenAICompatibleOAuthTokens` (`provider IN ('qwen','xai')`)
- **Insights + Alerts** subsystem (dashboard `/insights` tab, http-api handlers +
  services, `alerts` table, SSE stream, nav badge)
- **Analytics** URL-state persistence + shared `buildRequestFilters`; the fork's
  **projects filter** preserved by extending the shared builder + URL-state (de)serialization
- **SessionAffinity** load-balancer strategy + new required `peek()` on the strategy
  interface; **Anthropic 529/overloaded** cooldown + **out_of_credits** per-request
  failover; Codex count_tokens/role-mapping/input-sanitization; Sonnet 5 / Opus 4.8 /
  Fable 5 model support
- **Accounts** `isPrimary` (via `strategy.peek()`) replacing lastUsed semantics;
  `consecutive_rate_limits` + `pause_reason` columns (SQLite + PG parity intact)

### Security — recurring Codex-P1 guard held

Upstream did **not** reintroduce blanket auth exemptions in this range; kept the fork's
`auth-service.ts` hardening (only `/health` + `/api/version/check` statically exempt;
GET oauth status exempt; token-mutating oauth gated to admin keys). Adopted only
upstream's safe `prefixLast8` scrypt short-circuit (runs *after* the exemption check, so
it cannot widen what is unauthenticated). Restored the graceful HTTP-drain shutdown block
(`SHUTDOWN_WATCHDOG_MS`, `isShuttingDown` guard, `serverInstance.stop()`) that upstream
commit `cc7be6ae` **accidentally deleted** as an unrelated side effect; sequenced
HTTP-drain → collector-drain.

### Conflicts (23) — rule applied

| File | Rule | Rationale |
|------|------|-----------|
| `CLAUDE.md` | keep-ours | fork-owned (caveman-compressed) config |
| `package.json`, `apps/cli/package.json` | keep-ours version | fork versions independently (`3.8.0`) |
| `apps/cli/build-multi-arch.ts` | take-upstream | drops retired tiktoken + post-processor embed |
| `apps/cli/src/main.ts` | union | fork qwen/openrouter/ollama-cloud + upstream xai modes |
| `packages/config/src/index.ts` | union | fork PG-config methods + upstream alert-config methods |
| `packages/proxy/src/proxy.ts` | take-upstream + re-inject | UsageCollector API + dual-header + headersOnly plumbing |
| `packages/proxy/src/response-handler.ts` | take-upstream | new teeStream pipeline (256KB cap native upstream); project attribution auto-merged |
| `packages/proxy/src/post-processor.worker.ts` | delete | superseded by `usage-collector.ts` |
| `packages/proxy/src/handlers/account-selector.ts` | merge | upstream `applyExclusions` + fork combo-stamp guard (Codex P2) |
| `packages/proxy/src/auto-refresh-scheduler.ts` | merge | fork guarded `sendDummyMessage` + upstream openai-compat refresh; qwen subsumed |
| `apps/server/src/server.ts` | take-upstream + replay | UsageCollector/responses routing + fork PG-bridge/DiscoveryScheduler/auth-order + restored shutdown drain |
| `packages/http-api/src/router.ts` | union | fork projects/worktree routes + upstream insights/alerts routes |
| `packages/http-api/src/handlers/analytics.ts` | take-upstream | shared `buildRequestFilters` (+projects added into it) |
| `packages/http-api/src/handlers/__tests__/health-runtime.test.ts` | take-upstream | identical fields, reordered |
| `packages/database/src/database-operations.ts` | union imports | ResolverManager + BunSqlAdapter/PG_CLIENT_QUERY_TIMEOUT_MS |
| `packages/dashboard-web/src/api.ts`, `hooks/queries.ts` | union | fork PG/projects methods + upstream alerts methods |
| `.../accounts/AccountList.tsx` | take-upstream + replay | `isPrimary` sort (was `mostRecentAccountId`) + fork toggles |
| `.../accounts/AccountListItem.tsx` | merge | keep `compact` + `isPrimary`, drop `isActive` |
| `.../components/navigation.tsx` | union | fork Projects nav + upstream Insights nav (both imports) |
| `.../components/AnalyticsTab.tsx` | take-upstream + preserve | `useAnalyticsUrlState` + fork projects filter |
| `bun.lock` | regenerate | `bun install` (adds `openai-responses-adapter` workspace) |

Follow-up commit `46bfe56f` fixed 3 analytics-url-state tests (guarded the optional
`projects` filter; updated upstream fixtures for the fork's projects dimension).

### Preserved local-only fork commits (72)

Fork history since the merge-base is retained unchanged — projects/worktree discovery
(#30), UI+backend batch (#29), Codex-P1 auth hardening (#28), the 2026-05-17 and
2026-05-19 upstream syncs (#27, #32), dashboard customizations (color chips, collapsible
sidebar, per-project grouping, 24h toggle), PostgreSQL backend, and the CLAUDE.md/Linear
docs work.

### Follow-ups

- `.github/workflows/**` kept-ours (fork CI intentionally minimal). Optional: cherry-pick
  upstream's `actions/checkout@v5` / `setup-bun@v2` bumps into the fork's active `release.yml`.
- `packages/proxy/src/inline-worker.ts` (auto-generated) is now orphaned in the tree — no
  longer built or imported after the collector migration; harmless. Its CLAUDE.md
  protected-file note is now historical.
- Pre-existing tech debt unchanged: SB23-313 (biome), SB23-314 (test teardown unhandled rejections).

## 2026-05-19 — upstream/main sync

- **Upstream**: https://github.com/tombii/better-ccflare branch `main`
- **SHA range**: `5cdabaa80a8986ce543f7ba9415d2bdceff83a55..ab677460330802078167f1ca4b5c0e84f545420b`
- **Commits integrated**: 125 across 14 workspace buckets (8 parallel analysis subagents)
- **Local-only commits preserved**: 66 (fork-specific work, none dropped)
- **Strategy**: `git merge --no-ff` onto safety branch `sync/upstream-20260519-192835`
- **Verification**: build PASS · typecheck PASS · biome check 28 errors (pre-merge main had **69** — sync net **−41**, zero new; pre-existing fork debt) · `bun test` **1582 pass / 0 fail** / 9 pre-existing teardown errors (identical to pre-merge baseline)

### Conflicts resolved (15 files)

| File | Rule | Rationale |
|------|------|-----------|
| `package.json` | keep-ours version | Fork versions independently; kept `3.8.0`, dropped upstream `3.5.12` |
| `apps/cli/package.json` | keep-ours version | Same — kept `3.8.0` |
| `.gitignore` | union | Kept fork `_archive*`; added upstream's 3 `inline-*-worker.ts` ignores |
| `CLAUDE.md` | docs, fork-wins | Kept fork's curated layout; dropped upstream d4rken-ack churn, GitNexus mega-block, duplicate PR/merge guidance (fork already covers) |
| `__tests__/api-auth.test.ts` | tests union (security-adjusted) | Kept fork Codex-P1 token-mutation test + added upstream `/api/version/check` tests; **dropped upstream "static assets exempt" test** — asserts the blanket non-/api exemption fork removed for Codex P1 (contradicts fork's authoritative test) |
| `packages/http-api/src/services/auth-service.ts` | fork-security-wins | **Rejected upstream's blanket `/api/oauth` + non-/api static exemptions** (reintroduce Codex P1 token-mutation vuln); adopted only read-only `/api/version/check` |
| `packages/http-api/src/handlers/oauth.ts` | keep-ours + upstream comment | Kept fork's `await dbOps.createOAuthSession` (async sweep); took upstream's clearer priority comment |
| `packages/database/src/migrations.ts` | never-delete-fork + take-upstream | Preserved fork project/worktree migrations + indexes; took upstream `VACUUM INTO` backup, `pruneOldBackups`, `willMutate`, `oauth_sessions.priority` |
| `apps/server/src/server.ts` | replay-fork-diff | Took upstream graceful HTTP-drain shutdown + `bootstrapAutoVacuum` + lowered mem thresholds; replayed fork PG-config bridge, DiscoveryScheduler, two-arg `sendWorkerConfigUpdate`, dashboard-before-API auth ordering |
| `packages/proxy/src/post-processor.worker.ts` | take-upstream + replay-fork | Took upstream's preflight `canAcceptPayload` serialization (no double-enqueue); preserved fork `meta.project`, headers-only null-body, body cap, `x-ccflare-project` dual header |
| `packages/dashboard-web/src/components/RequestsTab.tsx` | replay-fork-diff | Took upstream two-zone row + lazy `bodiesOmitted`; re-injected fork color chips, project/worktree chips, cache-hit %, 24h `formatTime`, project filters, grouped render |
| `packages/dashboard-web/src/api.ts` | union | Reconstructed clean union: fork project/worktree methods + upstream `getStorageInfo`/`triggerIntegrityCheck` |
| `packages/dashboard-web/src/hooks/queries.ts` | take-upstream + keep-fork | Dropped `useCompactDb` (compact removed end-to-end); kept fork Postgres-config + adminRestart hooks |
| `packages/dashboard-web/src/components/navigation.tsx` | replay-fork-diff | Kept fork collapsible-sidebar structure; ported upstream `updateError` state + reset + setter + display block |
| `packages/dashboard-web/src/components/accounts/AccountListItem.tsx` | keep-fork + take-upstream-fix | Kept fork `compact` dense-layout; adopted upstream's spurious-`key` removal |

### Post-merge gate fixes (2, caught by `bun test`, 1 remediation loop)

| File | Issue | Fix |
|------|-------|-----|
| `packages/http-api/src/handlers/__tests__/health-runtime.test.ts` | fork test exact-`toEqual` against old `getHealth()` shape; upstream split-queue rework expanded it | widened expected object to upstream's metadata/payload-queue fields |
| `__tests__/api-auth.test.ts` | unioned upstream "static assets exempt" test asserts behavior fork's Codex-P1 model rejects | removed it (documented why); fork's contradicting test is authoritative |

### Notable features brought in (by bucket)

- **database**: periodic background integrity probes (replace startup `integrity_check`); `VACUUM INTO` migration backup + bounded pruning; `auto_vacuum=INCREMENTAL` bootstrap + off-thread incremental-vacuum worker; AsyncDbWriter split metadata/payload queues + retention/byte caps; `oauth_sessions.priority` column; `mmapSize=0` honored
- **http-api**: `POST /api/storage/integrity/check` + integrity status fields on health/storage; recent-errors enrichment (`getRecentErrorGroups`, `?errorsSinceHours`); compact endpoint removed end-to-end; `/api/version/check` auth exemption; OAuth priority threading
- **proxy**: integrity-scheduler (quick 6h / full 24h, env-configurable); payload backpressure preflight; configurable worker startup timeout (60s default); logger noise reduction
- **dashboard-web**: Recent Errors panel + provider-aware suggestions; pool/quota tiles + burn-rate projection; StorageIntegrity card + background-probe polling; lazy payload hydration; AccountListItem reorg
- **apps/server**: graceful HTTP-drain shutdown (dedup guard + 30s watchdog); `bootstrapAutoVacuum`; halved memory thresholds; forced-GC removed
- **logger**: `Error`/`.cause` serialization; `LOG_LEVEL=DEBUG` env honored
- **core**: `CLAUDE_CLI_VERSION` → `2.1.143` (fork build-time injection preserved); SIGINT/SIGTERM defer-exit to server shutdown
- **providers**: `CODEX_VERSION` → `0.131.0`; openai-formats lint fixes
- **cli-commands**: `compactDatabase` writer-lock probe

### Security

- **Rejected** upstream's blanket `if (path.startsWith("/api/oauth")) return true;` static auth exemption and the non-/api fallthrough exemption in `auth-service.ts` — these reintroduce the Codex P1 vulnerability (unauthenticated callers overwriting stored account tokens when dashboard auth is configured) that fork PR #28 fixed.
- **Adopted** only the read-only `/api/version/check` exemption (public npm version data, no secrets, no mutation) — does not weaken token-mutating-endpoint gating.

### Follow-ups

- 28 pre-existing biome errors remain on fork main (e.g. `ProjectsTab.tsx` `children` prop, fork PR #30 code) — unrelated to this sync (sync reduced total 69→28); track separately.
- 9 pre-existing `bun test` teardown "Empty error object" unhandled rejections (OAuth/account test files) — present identically on pre-merge main; track separately.
- No upstream `.github/workflows/**` changes were in scope this cycle; fork CI customizations untouched.

## 2026-05-17 — upstream/main sync

- **Upstream**: https://github.com/tombii/better-ccflare branch `main`
- **SHA range**: `3c08c9944920aed06385c2a1b4b4fdfff45c64a5..5cdabaa80a8986ce543f7ba9415d2bdceff83a55`
- **Commits integrated**: 195 across 19 workspace buckets
- **Local-only commits preserved**: 56 (fork-specific work, none dropped)
- **Strategy**: `git merge --no-ff` onto safety branch `sync/upstream-20260517-040514`
- **Verification**: typecheck PASS · biome check PASS (229 pre-existing warnings, non-blocking) · `bun test` 1291 pass / 0 fail / **7 upstream teardown errors** · build PASS

### Conflicts resolved (4 git-level)

| File | Rule | Rationale |
|------|------|-----------|
| `package.json` | keep-ours version | Fork versions independently; kept `3.6.0`, dropped upstream `3.5.7` |
| `apps/cli/package.json` | keep-ours version | Same — kept `3.6.0` |
| `CLAUDE.md` | merge-docs, fork-structure-wins | Kept fork's slim progressive-disclosure layout; adopted upstream's net-new rules (refspec `refs/heads/main`, PG-migration parity, external-PR protocol, issue-staleness); dropped upstream GitNexus mega-block (fork moved it to `.claude/docs/gitnexus.md`) |
| `packages/proxy/src/post-processor.worker.ts` | replay-fork-diff | Took upstream's SSE/stream-parsing rewrite; replayed fork's `x-ccflare-project` extraction + `planProviders` anthropic removal |

### Post-merge semantic fixes (4, caught by typecheck gate, 2 remediation loops)

| File | Issue | Fix |
|------|-------|-----|
| `packages/proxy/src/worker-messages.ts` | duplicate `project` field (fork + upstream both added to `StartMessage`) | removed fork's commented duplicate, kept upstream-positioned field |
| `packages/proxy/src/response-handler.ts` | triple duplicate `project` (interface + destructure + object literal) | de-duplicated, kept request-details-grouped occurrence |
| `packages/proxy/src/handlers/proxy-operations.ts` | duplicate `project:` in two `forwardToClient` object literals | removed post-`agentUsed` duplicate at both call sites |
| `packages/database/src/inline-vacuum-worker.ts` | missing auto-generated module (upstream vacuum-worker feature) | created placeholder (gitignored, regenerated by `bun run build`) |

### Notable features brought in (by bucket)

- **proxy**: `RequestBodyContext` hot-path abstraction; cooldown/rate-limit overhaul (`extractCooldownUntil`, configurable no-reset cooldown, audit rows); pool-exhaustion 503; usage-throttling handler; stateful-decoder SSE robustness; integrity scheduler
- **providers**: Ollama + Ollama-Cloud providers; major Codex expansion (reasoning effort, count_tokens, SSE fixes); usage-fetcher dedup/rate-limit tracking; Minimax `M2` → `M2.7`
- **http-api**: `/health` 3-state rewrite + 503 + `?detail=1`; `/api/storage`, usage-throttling routes, Ollama account routes, peak-hours-pause; `extract-api-key` refactor
- **database**: combos tables; integrity + `--doctor` support; vacuum moved to worker thread; async `SQLITE_BUSY` retry; rate-limit audit columns; `saveRequestMeta` unified into `saveRequest`
- **dashboard-web**: Ollama provider UI; usage-throttling card; plugin agents; lazy payload hydration; rate-limit progress improvements (fork's chips/sidebar/grouping untouched by upstream — zero conflict)
- **core**: `TtlCache`, `throttle-utils`, `claude-opus-4-7` model, `CLAUDE_CLI_VERSION` → `2.1.138`
- **load-balancer**: `LeastUsedStrategy`, exhaustive SessionStrategy fallback, utilization tiebreaking
- **agents**: feature-gated plugin-agent discovery with path-validation hardening
- **config**: usage-throttling + health-detail config keys

### Follow-ups

1. **`.github/workflows/release.yml`** — upstream added breaking-change detection + thank-commit changelog filter. Fork keeps release workflows file-disabled (`.disabled` rename); release.yml content merged but adopt the breaking-change block + change hard-coded `tombii/better-ccflare` URL to `SijanC147/better-ccflare` only if/when the fork re-enables the dispatch workflows.
2. **7 SQLite teardown errors in `bun test`** — upstream's new `bun-sql-adapter.ts close()` runs `PRAGMA wal_checkpoint(TRUNCATE)`; during parallel test-DB teardown (`factory.ts reset`) this raises `SQLiteError: disk I/O error` *after* assertions (0 functional failures). Upstream-inherent harness-lifecycle fragility, not a merge defect. Investigate test DB lifecycle / consider skipping checkpoint on in-memory/temp DBs.
3. **Minimax behavior change** — upstream removed the forced `MiniMax-M2` model override; minimax accounts now pass the caller's model through and default to `MiniMax-M2.7`. Verify fork minimax accounts still behave as expected.
4. **`LATEST_OPUS_MODEL` → `OPUS_4_7`** — confirm `claude-opus-4-7` is available on the endpoints the fork routes to before relying on the alias in production.
5. **`BETTER_CCFLARE_DISCOVER_PLUGIN_AGENTS`** — new opt-in env flag; evaluate exposing it in the fork's Homebrew/launchd service templates.
