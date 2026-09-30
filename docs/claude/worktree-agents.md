# Worktree agents in better-ccflare

The project spec that `worktree-peers`' `spawn-worktree-agent.sh` implements for this
repository. Read with `docs/worktree-lane-brief.md`, which carries the standing lane rules.

## Create

`spawn-worktree-agent.sh <short-name>` from the main checkout, with the main checkout on
`main` and fast-forwarded to `origin/main` first (the new branch starts from its HEAD). The
worktree lands in `~/Code/better-ccflare-worktrees/<short-name>`.

Then, inside the worktree, **`bun install --frozen-lockfile`**. Nothing is symlinked: a
fresh worktree has no `node_modules`, and `bun run typecheck` fails with a `bun-types`
error until it does (`mem:fresh-worktree-needs-bun-install`). The Bun store is
content-addressed, so the install is cheap and shares nothing mutable.

## Shared, isolated, omitted

| Resource | Where | Rule |
| -- | -- | -- |
| `node_modules/` | per checkout | installed per worktree, never symlinked |
| `packages/dashboard-web/dist/` | per checkout, gitignored | built per worktree when needed |
| Runtime config and database | `~/.config/better-ccflare/` (outside the checkout) | **never touched by a lane.** A server or test run from a worktree sets its own `XDG_CONFIG_HOME` under `mktemp -d` |
| The live service | Homebrew, port 8080 | never started, stopped, restarted or signalled by a lane; test servers use a free port that is not 8080 |
| `.claude/` | gitignored | per worktree; the dispatch brief is copied in by the spawner and must be verified non-empty |
| `.mcp.json` | gitignored, holds credentials | never copied (SB23-688) |

No stateful resource lives inside the checkout, so a worktree cannot corrupt the main
checkout's state by sharing it. The danger runs the other way: a test that constructs a
`Config` or `DatabaseOperations` without a path resolves to the live `~/.config` tree
(`SB23-2277`). Isolate `XDG_CONFIG_HOME` for anything that boots the server.

## Refs

This repository has both a `main` branch and a `main` tag. From inside a worktree name
`origin/main`; never bare `main` and never `refs/heads/main`, which is stale in every
linked worktree because only the main checkout can fast-forward it.

## Teardown

After the PR merges: `git -C <main> worktree remove <path>`, delete the local and remote
branch separately (never `gh pr merge --delete-branch`, which removes the worktree under a
live peer), `worktree-registry.sh unregister`, close the tab.
