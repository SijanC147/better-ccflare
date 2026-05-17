# Claude-Code Project Discovery + Worktree Hierarchy — Action Plan

**Date:** 2026-05-17
**Author:** orchestrator (post 4-agent parallel investigation)
**Status:** PLAN ONLY — no code changes proposed in this document
**Target branch when implementing:** `feature/projects-worktree-discovery`

---

## 1. Feature Summary

Add first-class **Project** entities to better-ccflare, sourced by scanning `~/.claude/projects/` on the host where the proxy runs. Users manage which discovered projects are enabled, define **worktree** detection (regex / glob / explicit dir), and optionally assign manual parent-of relationships. Incoming requests are attributed to the canonical parent project; worktree-origin requests carry an additional worktree label without losing the parent grouping.

---

## 2. Current State (from investigation)

### 2.1 Project attribution today is heuristic-only

The proxy already derives a `project` field per request from **four** signals (in priority order):

1. `X-CCFlare-Project` header — `packages/proxy/src/handlers/request-handler.ts:15`
2. `x-project` header alias — `packages/proxy/src/proxy.ts:75`
3. System-prompt workspace-path regex `/\/(?:Users|home)\/[^/]+\/(?:Desktop|projects|repos|src)\/([^/]+)\//` — `packages/proxy/src/proxy.ts:82-85`
4. First system-prompt Markdown H1 (unless prefixed with "claude") — `packages/proxy/src/proxy.ts:88-93`

The same logic is re-applied defensively inside `post-processor.worker.ts:167-202` against the `StartMessage`. Result is stored as freeform `TEXT` on `requests.project` in both SQLite (`migrations.ts:52`) and Postgres (`migrations-pg.ts:107`), indexed in SQLite only (`migrations.ts:753`).

**No cwd, no env, no body field is consulted.** Two practical consequences:

- Project names today are basenames or H1 strings, not canonical paths. They cannot reliably distinguish two repos named `api` in different parent dirs.
- The proxy has no knowledge of which Claude Code project a request came from beyond what it can scrape from the prompt body.

### 2.2 A `GET /api/projects` already exists

`packages/http-api/src/router.ts:407` — returns `string[]` of `SELECT DISTINCT project FROM requests WHERE project IS NOT NULL` (limit 50). Dashboard's filter UI binds to it (`hooks/queries.ts:143`, `AnalyticsFilters.tsx`, `RequestsTab.tsx`). There is **no** management UI, no enable/disable, no metadata.

### 2.3 `~/.claude/projects/` layout

- 93 entries on this host. Each is `<encoded-path>/` containing `<uuid>.jsonl` session transcripts + a `<uuid>/` artifacts dir + a `memory/` dir of `.md` files.
- Encoding: every `/` → `-`. Leading `/` → leading `-`. **Lossy**: directories with hyphens or underscores in their basename are indistinguishable after encoding (`stash-mcp-server` ↔ `stash_mcp_server`, `chll-bot-llm-telegram` ↔ `chll/bot/llm/telegram`).
- Ground-truth path lives in the JSONL: each session's **first message** (typically line index 1 or 2, after a `permission-mode` preamble at line 0) carries a `cwd` field with the true absolute path.
- Worktrees are already visible as `--` (double-hyphen) encoded segments: `.maestro/worktrees/…`, `.ralph/worktrees/…`, `.claude/worktrees/…`, `.omc/worktrees/…`.
- Freshness signal must be `max(mtime)` over `*.jsonl` files inside a project dir — the parent dir's own mtime does not bump on session append.
- File permissions: project dirs `rwxr-xr-x`, JSONL files `rw-------`. Server must run as the same OS user that owns `~/.claude/`.

### 2.4 Dashboard architecture

- React Router v6, routes registered as a `useMemo` array in `packages/dashboard-web/src/App.tsx:65-132`.
- Sidebar nav items live in `components/navigation.tsx:77-99` (similar `useMemo`). `FolderOpen` icon from `lucide-react` already imported.
- API client: singleton `api` in `src/api.ts`; React Query v5 patterns documented in `hooks/queries.ts`. Mutations invalidate via `queryClient.invalidateQueries({ queryKey: queryKeys.X() })`.
- Auth: `x-api-key` header normally; `?api_key=` query param for SSE/EventSource.
- shadcn/ui primitives available: `dialog`, `dropdown-menu`, `switch`, `input`, `label`, `card`, `badge`, etc. **No tree component** — must hand-roll a recursive list.
- Dashboard is bundled into the server binary via `build.ts` → `embed.ts` → `dist/embedded.ts`. **Frontend changes require rebuilding the dashboard package before the server picks them up.**
- Reference patterns:
  - List + toggle: `components/accounts/AccountListItem.tsx:151-203`
  - Modal/form: `components/combos/ComboDialog.tsx:63-149`
  - Filter chips: `RequestsTab.tsx:979-1113`
  - Group-by-project memo: `RequestsTab.tsx:436-461`

### 2.5 DB migration conventions

The 5-step dual-source pattern in `CLAUDE.md` is enforced. Reference column-add pair: `combo_name` in `migrations.ts:53,779-781` ↔ `migrations-pg.ts:109,367-370`. Reference table-add pair: `combos`/`combo_slots`/`combo_family_assignments` in `migrations.ts:183-215` ↔ `migrations-pg.ts:219-245,449-494`. Indexes co-located with `CREATE TABLE`. FKs declared in both engines; SQLite needs `PRAGMA foreign_keys = ON` (already set in `database-operations.ts:145`).

Repository pattern: extend `BaseRepository<T>`, returned via thin `DatabaseOperations` delegation methods. Types co-located in `packages/types/src/<domain>.ts` with `XxxRow` + `Xxx` + `toXxx(row)` triplet.

---

## 3. Proposed Architecture

### 3.1 Data model

**New table `projects`** — canonical entities, both discovered and manually added.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | stable id = `sha1(canonical_path)[0:16]` so it survives rename of dashboard label |
| `canonical_path` | TEXT UNIQUE NOT NULL | absolute, symlink-resolved, lowercased on darwin (case-insensitive FS) |
| `display_name` | TEXT NOT NULL | user-editable; default = basename of canonical_path |
| `enabled` | INTEGER (0/1) | default 1 for newly discovered |
| `source` | TEXT NOT NULL | `'discovered'` \| `'manual'` |
| `parent_project_id` | TEXT NULL | FK → `projects.id` `ON DELETE SET NULL` — manual worktree relationship |
| `last_session_at` | INTEGER NULL | max mtime of project's JSONLs, ms epoch |
| `session_count` | INTEGER NOT NULL DEFAULT 0 | denormalised, refreshed on discovery |
| `discovered_at` | INTEGER NOT NULL | ms epoch |
| `metadata` | TEXT NULL | JSON blob, reserved for future (e.g. git remote) |

Index: `idx_projects_parent` on `parent_project_id`, `idx_projects_enabled` on `enabled`.

**New table `worktree_rules`** — pattern-based worktree detection.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | uuid |
| `kind` | TEXT NOT NULL | `'glob'` \| `'regex'` \| `'directory'` |
| `pattern` | TEXT NOT NULL | raw user input |
| `parent_project_id` | TEXT NULL | FK → `projects.id` `ON DELETE SET NULL` — if NULL, parent is inferred as longest-prefix enabled project |
| `priority` | INTEGER NOT NULL DEFAULT 0 | higher = checked first |
| `enabled` | INTEGER (0/1) NOT NULL DEFAULT 1 |
| `created_at` | INTEGER NOT NULL |

Index: `idx_worktree_rules_priority_enabled` on `(priority DESC, enabled)`.

**`requests` table additions** — preserve existing `project` for display-name backward compat; add canonical id + worktree subpath.

| Column | Type | Notes |
|---|---|---|
| `project_id` | TEXT NULL | FK target is loose (don't FK across the high-write requests table) |
| `worktree_path` | TEXT NULL | absolute path of the worktree subdir when applicable, otherwise NULL |

Indexes: `idx_requests_project_id` on `project_id`.

Backfill: on first migration, attempt to map each existing distinct `requests.project` to a discovered project via display-name or basename match. Unmapped rows keep `project_id = NULL` (treated as "Unattributed").

**Postgres parity** — every above DDL mirrored in `migrations-pg.ts` per the 5-step checklist. Timestamps as `BIGINT`. Booleans as `INTEGER 0/1` (matching existing convention; PG schema already uses INTEGER for boolean-ish columns elsewhere).

### 3.2 Discovery service

New package `packages/claude-code-discovery` (or module inside `packages/core`).

**Public API:**

```ts
interface DiscoveredProject {
  encodedName: string;        // e.g. "-Users-foo-Code-bar"
  canonicalPath: string;      // from JSONL cwd; falls back to naive decode if no JSONL
  ambiguous: boolean;         // true when no JSONL existed to disambiguate
  sessionCount: number;
  lastSessionAt: number | null;
  detectedAsWorktree: boolean; // true when canonical_path matches default worktree heuristics
}

class ClaudeCodeDiscovery {
  async scan(opts?: { force?: boolean }): Promise<DiscoveredProject[]>;
  async resolveCwd(encodedName: string): Promise<string | null>;
  startWatcher(onChange: () => void): () => void;  // returns unsubscribe
  stopWatcher(): void;
}
```

**Implementation rules:**

- Resolve home dir via `os.homedir()` (env var `CLAUDE_PROJECTS_DIR` override for tests).
- For each entry under `~/.claude/projects/`: skip non-dirs, skip `ssh-*`, skip the literal `-/` (filesystem-root sentinel).
- Disambiguation: open the **first** `*.jsonl` (smallest mtime to bias older session that's more likely to have completed), stream line-by-line until a JSON object yields `.cwd`. Abort after 10 lines or 64 KiB to bound work.
- Fallback when no JSONL exists: naive decode (`-` → `/`) and mark `ambiguous: true` so UI can warn the user.
- Cache results in-memory keyed by `encodedName + dir-mtime`. Re-stat dir to invalidate.
- Watcher v1: poll every 60 s. Watcher v2: `fs.watch(projectsDir, { recursive: false })` for new dirs + `fs.watch` on each JSONL for append events. Defer to v2 milestone.

**Worktree heuristic** (used to seed default `detectedAsWorktree`, **not** to override user rules):
A path matches the built-in heuristic if any segment equals `.worktrees`, `worktrees`, or if any segment begins with `.` and contains a child segment `worktrees`. This catches `.maestro/worktrees`, `.ralph/worktrees`, `.claude/worktrees`, `.omc/worktrees`.

### 3.3 Path resolver (request-time matching)

A single in-memory immutable snapshot rebuilt whenever projects or rules change.

**Snapshot shape:**

```ts
type ResolverSnapshot = {
  // longest-prefix-first ordered list of enabled non-worktree projects
  prefixIndex: Array<{ canonicalPath: string; projectId: string }>;
  // compiled rules ordered by priority DESC
  rules: Array<{
    matcher: (path: string) => boolean;
    parentProjectId: string | null;
  }>;
};
```

**Resolution algorithm** (given a candidate path-or-string):

1. Normalize: `path.resolve` → lowercase on darwin → strip trailing slash.
2. For each enabled `worktree_rule` in priority order:
   - if matcher hits → result = `{ parent: rule.parentProjectId ?? longestPrefix(prefixIndex, normalized), worktreePath: normalized }`
   - return on first match.
3. For each `prefixIndex` entry in length-DESC order:
   - if `normalized === entry.canonicalPath` OR `normalized.startsWith(entry.canonicalPath + "/")` → `{ parent: entry.projectId, worktreePath: null }`
   - return on first match.
4. No match → `{ parent: null, worktreePath: null }`.

Rule matchers:
- `kind === 'directory'`: prefix equality (same canonicalize step)
- `kind === 'glob'`: `picomatch` (already a transitive dep of biome) or a hand-rolled adapter; compile once at snapshot build
- `kind === 'regex'`: `new RegExp(pattern)` at snapshot build; surface compilation errors to the rule's admin UI, mark rule `enabled = false` on failure

Snapshot rebuild trigger: any write to `projects` or `worktree_rules`. Hot path reads only the snapshot ref — no locking required (atomic ref swap).

### 3.4 Request ingress integration

We have **no cwd field** in incoming Anthropic API requests. Two complementary attribution paths:

**Path A — existing heuristic improved** (no client changes needed):

The proxy already extracts a project string from headers + system prompt regex (§2.1). After it produces that string today, also:

1. Try to interpret it as a path (it usually is the H1 line, sometimes a path).
2. Run the resolver on it.
3. If a project / worktree-rule hit lands, replace heuristic display name with the project's canonical `display_name`, and stamp `project_id` + optional `worktree_path` on the request row.

This is the v1 attribution path. It buys exact project_id for any user who runs Claude Code from a discovered project.

**Path B — explicit cwd header** (optional, v1.1):

Document a new optional header `X-CCFlare-CWD` (or extend `X-CCFlare-Project` to accept absolute paths). When present, the proxy bypasses the heuristic and feeds the header straight into the resolver. Users can populate it with a Claude Code wrapper script or environment-aware shell function. Add a 1-paragraph snippet to `README.md` showing a `~/.claude/hooks/preToolUse.sh` example.

**Path C — session-to-project map** (deferred to v1.2):

Optional background service that tails the active `~/.claude/projects/*/<uuid>.jsonl` and maintains `sessionId → projectId` in-memory. When Claude Code requests carry the session id (currently it does not, but the team may add it later), the proxy can attribute exactly without a header. Keep this on the roadmap.

**Write-path changes** required (codify in implementation phase):

- `packages/proxy/src/response-handler.ts:156` — extend `StartMessage` with `projectId: string | null` and `worktreePath: string | null`.
- `packages/proxy/src/worker-messages.ts` — add the two fields to the `StartMessage` interface.
- `packages/proxy/src/post-processor.worker.ts:519,771` — run the resolver after the existing project-string extraction; pass the two new fields into `dbOps.saveRequest(...)`.
- `packages/database/src/repositories/request.repository.ts` — extend signature; backwards-compatible defaults.

### 3.5 HTTP API surface

Add handlers in `packages/http-api/src/handlers/projects.ts` (new file) wired into `router.ts` following the combo-handler factory pattern.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/projects` | Replaces the existing distinct-values endpoint. Returns full `Project[]` with discovery freshness, enabled state, parent_id, last_session_at, session_count. Backwards-compat: if `?legacy=1`, return `string[]` of display names. |
| `POST` | `/api/projects/discover` | Triggers a fresh scan. Returns count of `{ added, updated, removed }`. |
| `PATCH` | `/api/projects/:id` | Update `display_name`, `enabled`, `parent_project_id`. |
| `DELETE` | `/api/projects/:id` | Only allowed for `source='manual'`. Discovered projects get `enabled=0` instead of delete. |
| `GET` | `/api/projects/:id/requests` | Convenience: requests filtered by `project_id` (with worktree breakdown). |
| `GET` | `/api/worktree-rules` | List rules ordered by priority. |
| `POST` | `/api/worktree-rules` | Create. Validate regex compiles. |
| `PATCH` | `/api/worktree-rules/:id` | Update. Recompile on `pattern` change. |
| `DELETE` | `/api/worktree-rules/:id` | Delete. |
| `POST` | `/api/worktree-rules/test` | Body: `{ pattern, kind, samplePaths[] }` → returns which sample paths the rule matches. Used by the UI's "test rule" affordance. |

All handlers use `errorResponse` + `BadRequest`/`NotFound` from `@better-ccflare/errors`. Mutations trigger a `requestEvents.emit("event", { type: "projects.changed" })` so SSE-connected dashboards refetch.

### 3.6 Dashboard UI

**New route**: `/projects` registered in `App.tsx:65-132` (insert after `/accounts`). Sidebar entry added to `navigation.tsx:77-99` with `FolderOpen` icon.

**`ProjectsTab.tsx` layout** (single page, three sections):

1. **Header toolbar**: "Discover" button (calls `POST /api/projects/discover`), "Add manual project" button, search input.
2. **Tree list**: parent projects rendered as cards, with their child worktrees nested inside. Each row has:
   - Enabled switch (matches `AccountListItem` toggle pattern)
   - Display-name field (inline edit)
   - Last-activity timestamp + session count
   - Action menu: "Mark as worktree of…", "Set parent…", "Remove" (manual only)
   - Ambiguity warning badge when `ambiguous: true`
3. **Worktree rules card**: list + add/edit/delete buttons. Modal form with `kind` select, `pattern` input, optional `parent` dropdown, "Test against sample paths" affordance.

**Tree component**: hand-rolled recursive `<ProjectRow>` that renders children indented when expanded. Two levels only (parent → worktrees) so no need for a general tree lib. ~80 LOC.

**Filter integration in `RequestsTab.tsx`**:

- Project filter (lines 1401-1470) keeps its dropdown of names but now also stores the resolved `project_id` server-side. UI label remains display-name.
- Group-by-project (lines 436-461): rollup key becomes `project_id ?? worktree_path ?? raw_project_string`. Worktree-origin requests group under their parent project's id automatically.
- New per-row badge: when `request.worktree_path` is set, render a secondary `Badge` with `worktreeBasename(worktree_path)` styled distinct from the project badge (e.g. amber outline). Tooltip shows full path.

**State**: local `useState` per tab, mutations invalidate `queryKeys.projects()` + `queryKeys.worktreeRules()` + `queryKeys.requests()` (for stamped attribution to repopulate).

**Build**: a single `bun run build` in `packages/dashboard-web` regenerates `dist/embedded.ts`. CI should fail if `dist/embedded.ts` is out of sync with `src/` (separate concern, not addressed here).

### 3.7 Open questions to confirm before implementation

1. **Migration of historical `requests.project`** — is it worth running a one-time backfill that attempts to map old freeform strings to new project_ids? Cost: scans the whole `requests` table; benefit: existing filters keep working under the new schema. Recommendation: yes, but gate behind a runtime flag (`BETTER_CCFLARE_BACKFILL_PROJECT_IDS=1`).
2. **Case sensitivity** — darwin filesystems default to case-insensitive but case-preserving. Confirm we want to lowercase before comparison; on Linux servers (production), this is wrong. Decision: detect via `fs.statSync` on `/Users` vs `/home` (heuristic) **or** read a config flag. Default to `caseSensitive: process.platform !== 'darwin'`.
3. **Symlink resolution** — should canonical_path resolve symlinks? Yes for matching but keep raw input for display. Use `fs.realpathSync` with a try/catch (don't fail on broken links).
4. **Cross-user / remote setups** — if better-ccflare is deployed on a remote host (e.g. tailscale, docker), the host's `~/.claude/projects/` does NOT match the client's working tree. Document this explicitly in the feature docs and treat it as out-of-scope for v1. Path C (session map) may help when this becomes a priority.
5. **Path A still relies on heuristics** — until cwd is available in requests, attribution remains best-effort. Be clear in the UI: show "Auto-attributed via heuristic" vs "Attributed via header" badges so users understand the confidence.
6. **`/api/projects` legacy callers** — analytics, requests filter, AnalyticsTab — currently expect `string[]`. Use the `?legacy=1` flag to keep them working, plan migration to typed response in v1.1.
7. **Worktree pattern compilation errors** — should a regex that throws disable the whole resolver, or just that single rule? Recommendation: disable just the rule, mark it as `compileError`, surface in UI.

---

## 4. Implementation Plan

Sequenced into phases. Phases marked **‖** can be parallelised across agents.

### Phase 0 — Decisions (sequential, ~30 min)

- Resolve the 7 open questions in §3.7.
- Approve the schema in §3.1.
- Approve the resolver semantics in §3.3.
- Approve URL surface in §3.5.

### Phase 1 — Schema + types (sequential, ~1 h)

1. `packages/types/src/project.ts` — `ProjectRow`, `Project`, `toProject(row)`. Also `WorktreeRuleRow`, `WorktreeRule`, `toWorktreeRule`.
2. `packages/types/src/request.ts` — extend `Request`, `RequestResponse`, `RequestRow` with `project_id?: string | null`, `worktree_path?: string | null`. Update `toRequest`, `toRequestResponse`.
3. `packages/database/src/migrations.ts` — `ensureSchema()` + `runMigrations()` new tables + ALTER TABLE for `requests`. Include indexes. Add new column names to `willModifySchema` guard.
4. `packages/database/src/migrations-pg.ts` — mirror in `ensureSchemaPg()` AND add `columnsToAdd` entries AND a `CREATE TABLE IF NOT EXISTS` block in `runMigrationsPg()`.
5. Add a smoke test `__tests__/projects-schema.test.ts` that boots an in-memory SQLite DB through `runMigrations` and asserts the new tables exist with the right columns.

### Phase 2 — Discovery service ‖ Repositories ‖ Resolver (parallel agents)

**Agent P2.A — Discovery package**
- New `packages/claude-code-discovery/` (mirror existing package shape).
- Implement `ClaudeCodeDiscovery` with `scan()` + `resolveCwd()`.
- Bun-native streaming JSONL parser bounded at 10 lines / 64 KiB.
- Unit tests with a temp dir fixture exercising encoded names, hyphens, missing JSONL, ambiguous decode.

**Agent P2.B — Repositories + DatabaseOperations wiring**
- `packages/database/src/repositories/project.repository.ts` — extends `BaseRepository<Project>`. CRUD + `findByCanonicalPath`, `findByParent`, `upsertFromDiscovery`.
- `packages/database/src/repositories/worktree-rule.repository.ts` — CRUD + `listOrderedByPriority`.
- `packages/database/src/database-operations.ts` — instantiate + public delegation methods.
- Unit tests in `repositories/__tests__/project.test.ts`, `worktree-rule.test.ts`.

**Agent P2.C — Path resolver**
- New module `packages/core/src/project-resolver.ts` or co-located in proxy package. Pure function; no DB import. Receives a `ResolverSnapshot` + a path string, returns `{ projectId, worktreePath }`.
- `ResolverManager` class owns snapshot lifecycle: rebuild on demand, subscribe via events.
- Unit tests covering: longest prefix, multiple competing prefixes, regex rule wins over prefix, regex with capture, glob with `**`, disabled rules ignored, unknown path returns nulls.

### Phase 3 — Wiring into proxy + HTTP API ‖ Discovery scheduler (parallel agents)

**Agent P3.A — Proxy integration**
- Extend `StartMessage` with `projectId`, `worktreePath`.
- In `response-handler.ts`, after building `project`, run `resolver.resolve(project)` and stamp the two new fields.
- In `post-processor.worker.ts`, write the two fields to the DB via the request repository's extended signature.
- In `request-handler.ts:15` area, also read optional `X-CCFlare-CWD` header — pass through proxy + into resolver before heuristics.
- Tests: extend `packages/proxy/src/__tests__/` with cases for resolver hits + misses.

**Agent P3.B — HTTP API handlers**
- `packages/http-api/src/handlers/projects.ts` — full CRUD + discover + per-project requests endpoint.
- `packages/http-api/src/handlers/worktree-rules.ts` — full CRUD + test endpoint.
- Register all in `router.ts`. Maintain `?legacy=1` for `GET /api/projects`.
- Tests: handler-level unit tests with mocked `dbOps`.

**Agent P3.C — Discovery scheduler**
- `packages/proxy/src/discovery-scheduler.ts` (or in apps/server bootstrap) — periodic 60s scan, debounced manual trigger, upsert via `ProjectRepository.upsertFromDiscovery`.
- Emit `requestEvents.emit("event", { type: "projects.changed" })` on changes.
- On startup, run one immediate scan, then start the schedule.

### Phase 4 — Dashboard UI ‖ Docs (parallel agents)

**Agent P4.A — ProjectsTab + nav**
- `packages/dashboard-web/src/components/ProjectsTab.tsx` — tree list + worktree rules card.
- Reusable `<ProjectRow>` + `<WorktreeBadge>` + `<WorktreeRuleEditorDialog>` components.
- Wire into `App.tsx` routes and `navigation.tsx` items.
- React Query hooks: `useProjectsAll`, `useProjectsDiscover`, `useUpdateProject`, `useWorktreeRules`, etc. — add to `hooks/queries.ts`. New `queryKeys.projects()` (extend, since key already exists), `queryKeys.worktreeRules()`.

**Agent P4.B — Filter + grouping integration**
- Update `RequestsTab.tsx` rollup key to use `project_id`.
- Add `<WorktreeBadge>` to request rows beside the project badge.
- Update `AnalyticsTab.tsx` to query the new shape; fall back to `?legacy=1` only if needed for the v1 cut.

**Agent P4.C — Docs**
- New `.claude/docs/projects.md` covering: how discovery works, what worktree rules do, the `X-CCFlare-CWD` opt-in header, troubleshooting ambiguous decodes.
- Top-level `README.md` — single paragraph + link.

### Phase 5 — Integration, perf, ship (sequential, ~1 day)

- Full test sweep: `bun test`, `bun run typecheck`, `bun run lint`.
- Dashboard build: `bun run build` in `packages/dashboard-web`, verify `dist/embedded.ts` is regenerated.
- Run the server against a real `~/.claude/projects/` on this host; sanity-check that the 93 entries appear.
- Bench: 1k path-resolutions/sec target; the resolver is O(rules + log(projects)) per call so this is trivial.
- Commit with conventional-commit `feat:` prefix.
- PR description references this plan doc.
- Codex review iteration loop (same-PR fix policy still applies).

---

## 5. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Path-ambiguous decodes silently mis-attribute requests | Medium | Medium | Read JSONL `cwd` field; mark `ambiguous: true` in UI |
| Heuristic-only attribution (no cwd in requests) keeps confidence low | High | Medium | Ship `X-CCFlare-CWD` opt-in header; document in README; surface confidence badge in UI |
| Remote/docker deployments have a mismatched `~/.claude/` | Medium | Low | Doc out-of-scope for v1; add config flag `CLAUDE_PROJECTS_DIR` for tests + non-standard installs |
| Dashboard `dist/embedded.ts` drift breaks server | Low | High | CI check separately (out of this PR's scope but call it out) |
| Regex worktree rules can be catastrophic backtracking | Low | High | Wrap rule compile + match in a 5 ms timeout; mark slow rules; reject patterns with `(.*)+` style suffixes at validation time |
| Resolver snapshot rebuild thrash under bursty rule edits | Low | Low | Debounce snapshot rebuilds at 250 ms |
| Migration backfill of `project_id` blocks a large requests table | Medium | Medium | Gate behind env flag; chunk in 1k-row batches; run inside a single read-only transaction with `LIMIT/OFFSET` |
| FK on `requests.project_id` slows inserts | Low | Medium | Do NOT add a hard FK on `requests.project_id`; just a regular index. Document the looseness. |
| Worktree rule with no parent + no inferred parent leaves orphan attribution | Low | Low | Render under "Ungrouped worktrees" group; flag in UI for user fix-up |

---

## 6. Out of scope for v1

- File-system watcher integration (poll-only for v1; watcher in v1.2).
- Multi-host / remote deployments (Path C session-map service in v1.2).
- Per-project quotas / cost budgets (orthogonal feature; future).
- Project-scoped API keys (could be a v2 follow-on).
- Hierarchical projects beyond one level (parent → worktrees only; no grandparents).
- Auto-detection of git repos vs random dirs (any path is a project candidate).

---

## 7. Acceptance criteria (v1)

1. On startup, `~/.claude/projects/` is scanned; discovered projects appear in `/api/projects` and the new `/projects` UI tab.
2. The user can enable/disable, rename, set parent, and manually mark a project as a worktree.
3. The user can create, edit, delete, and test worktree rules of all three kinds.
4. A new request whose path matches an enabled project is stamped with `project_id` and (if applicable) `worktree_path` in the DB.
5. The requests log shows the project badge based on canonical name; worktree-origin requests carry a second badge.
6. Filter and group-by-project in the requests UI honour the parent hierarchy.
7. `?legacy=1` keeps the old `string[]` shape of `/api/projects` working for any external consumer.
8. `bun test`, `bun run typecheck`, `bun run lint` all pass.
9. SQLite and Postgres both upgrade cleanly on fresh installs and on existing DBs.
10. README + `.claude/docs/projects.md` document the feature.

---

## 8. Estimated effort

| Phase | Agents | Wall-clock |
|---|---|---|
| 0 — Decisions | 1 (human) | 30 min |
| 1 — Schema + types | 1 | 1 h |
| 2 — Discovery / Repos / Resolver | 3 parallel | 2 h |
| 3 — Proxy wiring / HTTP / Scheduler | 3 parallel | 2 h |
| 4 — Dashboard / Filters / Docs | 3 parallel | 3 h |
| 5 — Integration + ship | 1 | 1 d (incl Codex review loop) |

Total: ~1.5 working days with parallelism; ~3.5 days serial.

---

## 9. Citations

- Current proxy attribution: `packages/proxy/src/proxy.ts:71-97,223,280`
- Worker re-extraction: `packages/proxy/src/post-processor.worker.ts:167-202,519,771-813`
- `X-CCFlare-Project` ingress: `packages/proxy/src/handlers/request-handler.ts:15`
- `requests.project` SQLite: `packages/database/src/migrations.ts:52,747-755`
- `requests.project` PG: `packages/database/src/migrations-pg.ts:107,344-345`
- Existing `GET /api/projects`: `packages/http-api/src/router.ts:407-413`
- Existing distinct-projects query: `packages/database/src/repositories/stats.repository.ts:236-247`
- Project filter UI: `packages/dashboard-web/src/components/RequestsTab.tsx:1401-1470,436-461,688-694`
- Analytics filter binding: `packages/dashboard-web/src/components/analytics/AnalyticsFilters.tsx:182-209`
- Group-by-project commit: `e43a116` (only touched `RequestsTab.tsx`)
- Combo handler factory template: `packages/http-api/src/handlers/combos.ts:13-43`
- Combo repository template: `packages/database/src/repositories/combo.repository.ts:20-33`
- Dialog template: `packages/dashboard-web/src/components/combos/ComboDialog.tsx:63-149`
- Routes: `packages/dashboard-web/src/App.tsx:65-132`
- Nav items: `packages/dashboard-web/src/components/navigation.tsx:77-99`
- Embedded dashboard build: `packages/dashboard-web/build.ts` + `embed.ts`
- Migration 5-step rule: `CLAUDE.md` (project root)
- Migration column-add pair example: `migrations.ts:53,779-781` + `migrations-pg.ts:109,367-370`
- Migration table-add example: `migrations.ts:183-215` + `migrations-pg.ts:219-245,449-494`
