# better-ccflare

Load balancer proxy for Claude Code distributing requests across multiple account providers for optimal rate limit management.

## CRITICAL: Account & File Safety

**Testing Endpoint**: Always use non-Anthropic accounts (ollama, litellm, omniroute, etc.) for automated/scripted testing. Real Anthropic accounts get banned for automated usage. The `claude` account is reserved for real Claude Code usage only. Force-route testing via `x-better-ccflare-account-id` header.

**Protected Files**:
- `inline-worker.ts` is auto-generated — always exclude from all reads, edits, searches, and commits. Recovery: `git checkout -- packages/proxy/src/inline-worker.ts`
- Always modify only `./README.md` (root). Keep `apps/cli/README.md` untouched.

## Quick Start

**Build & run**: `bun run build && bun start` (port 8080)

**Quality checks** (run after code changes):
```bash
bun run lint && bun run typecheck && bun run format
```

**Git safety**:
- `git status` before any changes — track pre-existing uncommitted files
- Feature branches only (`git checkout -b feature/name`); never change main directly
- This repo has both a `main` branch and a `main` tag. **Always use `refs/heads/main`** (not bare `main`) for git log/diff/checkout/merge-base to avoid ambiguous-refspec errors
- Push branch: `git push origin refs/heads/main:refs/heads/main` (branch/tag collision workaround)
- Commit: `git add <specific-files>` only (preserves inline-worker.ts)

**Version** — Release system handles version bumps. Update `package.json`, `apps/cli/package.json`, and `packages/core/src/version.ts` only if explicitly instructed.

## ⚠️ Database Migrations — Port to PostgreSQL

Every migration added to `packages/database/src/migrations.ts` MUST also be ported to `packages/database/src/migrations-pg.ts`:
1. `ensureSchema()` in `migrations.ts` (SQLite CREATE TABLE)
2. `runMigrations()` in `migrations.ts` (SQLite ALTER TABLE for existing DBs)
3. `ensureSchemaPg()` in `migrations-pg.ts` (PG CREATE TABLE for new installs)
4. `columnsToAdd` array in `runMigrationsPg()` (PG ALTER TABLE for existing DBs)
5. Mirror any SQLite backfill as an `adapter.unsafe(UPDATE ...)` in `runMigrationsPg()`

New tables go in `ensureSchemaPg()` AND `runMigrationsPg()` (`CREATE TABLE IF NOT EXISTS`).

## Development Workflow

**New functionality** — Write tests first, then implement, then run tests.

**Multi-task sessions** — Spawn subagents for independent work (code changes, research, testing, exploration). Sequential execution wastes context.

**Implementation plans** — Use subagent-driven development, dispatch fresh subagents per task.

**External-contributor PRs** — Merge with `git merge --no-ff <branch>` (preserve contributor history), then add them to README Acknowledgements.

**Issue management** — Never close issues automatically; wait for reporter confirmation. Before implementing an issue, run `git log refs/heads/main --since='<issue-open-date>' --oneline --no-merges -- <paths>` and confirm it still applies given recent changes (rate-limit/health/proxy code changes often).

## Commands

**Server**:
- First run: `bun run build`
- Dev: `bun start --serve --port 8081` (test on 8081, not production 8082)
- Startup takes ~15s; wait before testing

**Account management**:
```bash
bun run cli --add-account <name> --mode <mode> --priority <n>
bun run cli --list
bun run cli --remove <name>
bun run cli --reauthenticate <name>
bun run cli --set-priority <name> <priority>
bun run cli --reset-stats
```

**Testing OpenRouter**: Use model `z-ai/glm-4.5-air:free`
```bash
curl -X POST http://localhost:8081/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{"model":"z-ai/glm-4.5-air:free","messages":[{"role":"user","content":"test"}],"max_tokens":10}'
```

## More Details

- **Releases & publishing**: See `.claude/docs/release.md`
- **CLI & account setup**: See `.claude/docs/cli-commands.md`
- **Database configuration**: See `.claude/docs/database.md`
- **GitNexus code intelligence**: See `.claude/docs/gitnexus.md`

## Commit Message Categories

Automated release system uses prefixes:
- Features: `feat:`, `add:`, `new:`
- Fixes: `fix:`, `bug:`, `resolve:`
- Security: `security:`, `vulnerabilit:`, `redact:`, `ReDoS:`
- Improvements: `improve:`, `enhance:`, `update:`, `refactor:`
