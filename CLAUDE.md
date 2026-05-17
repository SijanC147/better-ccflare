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
- Feature branches only (`git checkout -b feature/name`)
- Push branch: `git push origin refs/heads/main:refs/heads/main` (branch/tag name collision workaround)
- Commit: `git add <specific-files>` only (preserves inline-worker.ts)

**Version** — Release system handles version bumps. Update `package.json`, `apps/cli/package.json`, and `packages/core/src/version.ts` only if explicitly instructed.

## Development Workflow

**New functionality** — Write tests first, then implement, then run tests.

**Multi-task sessions** — Spawn subagents for independent work (code changes, research, testing, exploration). Sequential execution wastes context.

**Implementation plans** — Use subagent-driven development, dispatch fresh subagents per task.

**Issue management** — Wait for reporter confirmation before closing issues.

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
