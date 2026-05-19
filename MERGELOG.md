# MERGELOG

Chronological record of upstream synchronizations into the **SijanC147/better-ccflare**
fork from **tombii/better-ccflare**. Maintained by the `/sync-upstream` slash command.
Newest entries first. Do not hand-edit the `last-sync-sha` marker — `/sync-upstream`
owns it for idempotency.

<!-- last-sync-sha: ab677460330802078167f1ca4b5c0e84f545420b -->

## Sync History

| Date | Upstream Branch | SHA Range | Commits | Conflicts | Strategy | Verification | PR |
|------|-----------------|-----------|---------|-----------|----------|--------------|----|
| 2026-05-19 | main | `5cdabaa8..ab677460` | 125 | 15 files | merge --no-ff | pass (1582 tests, 0 fail) | [#32](https://github.com/SijanC147/better-ccflare/pull/32) |
| 2026-05-17 | main | `3c08c994..5cdabaa8` | 195 | 4 git + 4 semantic | merge --no-ff | pass (1291 tests, 0 fail) | [#27](https://github.com/SijanC147/better-ccflare/pull/27) |

---

<!-- New sync entries are appended below this line, newest first. -->

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
