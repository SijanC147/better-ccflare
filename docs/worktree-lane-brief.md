# The worktree lane brief

Standing rules appended to every worktree peer's dispatch brief on this project. Each line
is a measurement rather than a preference: something went wrong, it was measured, and the
rule is what stops it recurring. Dates and PR numbers are kept so a reader can check them.

**This file is tracked on purpose.** `.claude/` is gitignored and `git worktree add`
populates only tracked files, so a brief written into the main checkout's `.claude/dispatch/`
**does not exist** at the path a lane's kickoff prompt names. That silently dispatched four
lanes with no brief on 2026-09-18, and a peer reported the exact cause hours before anyone
checked the filesystem. A lane can read this file from inside its own worktree.

The task-specific half of a brief still goes in `.claude/dispatch/<name>.md` and still has to
be **copied into the worktree and verified non-empty before spawning**.

## Standing rules, all of them load-bearing, several learned tonight

- **`main` is protected and is at `fe2ca2d9`.** Open a PR from your branch; BTCF-000 merges. Never push to `refs/heads/main`.
- **Never contact upstream.** No pushes, PRs, issues or comments to `tombii/better-ccflare` or any third party, whatever you find. Record it locally and stop.
- **Never `git add -A`, and never `git reset --soft refs/heads/main`.** This bit a lane **twice in twenty minutes** tonight. The reset moves a ref and leaves your working tree alone, so a stale copy of a file that moved on main is staged as a clean, conflict-free **revert of a merged PR**, with green CI and nothing to notice. One lane reverted `#142` that way under a `feat(logger)` title, then nearly reverted all of `#143`. **Name your paths on every `git add`**: a named path cannot stage a file you never edited. If you must squash, use `git reset --soft $(git merge-base refs/heads/main HEAD)`.
- **Name `origin/main`, never `refs/heads/main`, from inside a worktree.** `main` is checked out in the main checkout, so no worktree can fast-forward its own `refs/heads/main` and yours is stale from the moment you start. A lane measuring its diff against the stale ref read **39 logic lines across four files** where the truth against `origin/main` was **21 across three**. That applies to the reviewer-threshold command and to every merge simulation.
- **To check for that before reporting ready, use a merge simulation, not a diff.** `git diff main...HEAD` (three dots) is merge-base relative and structurally **blind** to this; two dots false-positives on every behind branch. Use:
  ```sh
  MT=$(git merge-tree --write-tree refs/heads/main HEAD)
  git diff --stat refs/heads/main "$MT"
  ```
- **Test on 8081.** The Homebrew service on 8080 is production. Never test against the live database: copy it first.
- **Automated request traffic uses non-Anthropic accounts only.** The `claude` account is reserved for Sean's real usage.
- **`bunx biome check --write <your files>`, scoped.** Never `bun run lint`: it is `--write --unsafe`, mutates the whole tree, and can exit 0 having rewritten code.
- **`bun install` first.** Revert `bun.lock` if it moves; never stage it.
- **Branch before your first edit.** You are already on your branch.
- **Commit before mutation-testing**, and **never point a mutation harness at a path with uncommitted work in it**: `git checkout -- <path>` ate a lane's reviewer fix tonight, and only `git commit` saying "nothing to commit" revealed it.
- **A mutation that did not apply looks exactly like one that survived.** The tell is `git checkout` printing `Updated 0 paths from the index` instead of `Updated 1 path`. Assert your anchor matched **before** writing, not after. The wrong conclusion from a false survivor is that your test is weak, so you strengthen a test that was already fine.
- **`grep -rl` has no word boundary, so a consumer count is wrong by default.** A lane measured 5 consumer files for a type and re-measured 2 with `-w`, because the pattern matched a longer identifier containing it. Its conclusion survived, **which is exactly when a wrong count goes unexamined**. Use `grep -rlw`, or a pattern anchored on the syntax you mean.
- **Two equal error counts prove nothing until the instrument is verified.** A lane measured zero typecheck errors before and after widening a type, then planted a deliberate error in the same interface to prove the program actually read the file. Without that, an equal count can hide a swapped error, and a gate that never reads the file reports zero forever.
- **An assertion that accepts several status codes hides everything upstream of it.** `if (res.status === 200) {...} else expect(data.error).toBeDefined()` accepted a 404 and a 400 as passes, which is why a seeding line calling a method that does not exist stayed invisible: the account was never inserted, the handler returned 404 from a pre-check, and the test passed. Assert the exact status and one message string that appears on no other path.
- **Mutate the contents of a rule, not only its mechanism.** A lane wrote five mutations against an allowlist filter and every one killed; four more, written by its reviewer, survived. The five proved the filter runs; the survivors proved nothing tested **which fields it names**. Dropping `pg_` from the list survived because `pg_password` was caught by a separate suffix rule, so `pg_enabled`, `pg_host`, `pg_port`, `pg_user` and `pg_ssl_mode` were covered by nothing, and a docstring spent a paragraph justifying that family. The author would have said it was thoroughly mutation-tested, and so would the orchestrator.
- **A validation helper shared between a write endpoint and a preview endpoint must not assume both want the same failure mode.** A lane first wrote a `/test` guard unscoped, which was correct for one pattern kind and quietly wrong for the other two: it would have converted a compile failure from a **per-sample-path diagnostic** into a 400, deleting the affordance the dashboard renders. It caught that by grepping the consuming package before running anything, and **no test in the repo would have caught it**, because that package has none for the previewer. The writer wants refusal; the previewer wants a per-item diagnostic.
- **Assert the whole message with `toBe`, not a pair of `toContain` and `not.toContain`.** A test pinned the log level and the file mode and never read the text, so it passed while the message contradicted the mode the same test body had just asserted. The obvious repair, one substring that is true only in that branch plus a denial of the neighbour's sentence, is **an allowlist of what must be present with no statement about what must be absent**: a mutation that ADDED a sentence survived 193 pass, every `toContain` matching and both `not.toContain` passing, while the message now told the operator the code had lstatted an entry and read its owner in the one branch that lstats nothing. A blocklist of two strings cannot catch a sentence nobody thought to list.
- **A boolean cannot hold three outcomes.** A try/catch around a guarded call has three results, and a boolean initialised optimistically folds the throw into the success arm. One lane's security ERROR then told the operator the file had been brought to 0600 and would not repeat, both false, while its own test two lines below asserted the mode was still 0666. Use a three-state union wherever a log level is chosen from an attempted fix.
- **A mutation ledger states the platform it was measured on**, the way a suite line states its head. Three mutants in one PR die only to a darwin-only fixture, so on Linux CI they survive; anyone re-measuring there gets a different answer and reads the difference as a regression.
- **A suite line is valid only when pass + skip + fail sums to the reported total.** Write suite output to a file and grep the file; never pipe a suite through `tail`. Pass test files as separate arguments, never a space-joined variable.
- **Your failure count carries a load term.** `main` measured **4 fail** tonight under sixteen concurrent sessions: the two documented macOS-only `AgentRegistry - injected workspace persistence` cases **plus** two `CLI Integration Tests > Performance` wall-clock assertions at 1045ms and 1117ms against a 1000ms bound (`SB23-2266`). So 2 and 4 are both honest at the same head. **Name your failures, never report a count**, and when a count differs, suspect the instrument before the code.
- **Bound every long command with `timeout -k 10 <n>`.** Never `pkill -f "bun test"`: it is machine-wide.
- **Never `git stash pop` or `git stash drop` in this repo.** The stash stack is shared across every worktree and the main checkout, so `stash@{0}` in your lane is whatever was stashed last by anyone. Two entries there today are Sean's, from 2026-04-26 and 2026-05-17, holding `_archive/` documents and `.serena/project.yml`. If you need a stash, name it (`git stash push -m`) and pop it by its message, never by index.
- **Read the clock before you cut anything, and write the reading next to the decision.** `date -u +%FT%TZ`. A lane cut three files at what it believed was 41 minutes elapsed against a 36 minute ceiling; the real figure was 7m44s and it had 26 minutes left. Its own close-out then said "inside it" while its scribe wrote "ran slightly past it" into Linear. A ceiling line that asks for a start time and never asks for a mid-task read lets a lane cut scope on a felt number, and this is the second time that rule has fired here and the first time it actually cost work.
- **`gh pr checks` can print `pending` for a job that has already finished**, because it points at a stale run id, most often the pre-merge run after an `update-branch`. Read `repos/<owner>/<repo>/commits/<sha>/check-runs` for the exact sha instead. A stale `pending` there is not evidence the job is running.
- **Treat an idle sub-agent as possibly still holding its output.** Three times now a scribe or reviewer has finished, cleaned up its worktree and gone idle **without ever calling `SendMessage`**, leaving its findings or a filed issue id unsent. Read the state yourself, by listing the project's recent issues or reading the PR, rather than waiting for a report that has already been written and never transmitted.
- **Read the state, never the report.** Verify a push with `git ls-remote`, CI with `gh pr view --json headRefOid` against the head you mean, and say the time you read it: a green reading is true when taken and can be stale a minute later.
- **One full `bun test` at your final head**, plus `bun run build:dashboard` if you touch `packages/dashboard-web`. Note that BTCF-000 runs `gh pr update-branch` before merging, which moves the head, so **CI's run at the merged head is the gate and your line is evidence about your work**. That is not a reason to skip it.
- **Any new route goes into `packages/types/src/api-catalog.ts` in the same commit.** Only the full suite runs the drift guard. `/v1/*` and `/messages/*` are proxy passthroughs and belong in **no** catalog entry; that was measured tonight.
- **An `accounts` column costs TEN places, not five.** `ensureSchema`, `runMigrations`, `ensureSchemaPg`, `columnsToAdd`, any backfill mirrored, **both** rebuild column lists in `migrations.ts`, and three read-side SELECT lists (`AccountRepository.findAll`, `findById`, the accounts list handler). A rebuild list **drops** the column and destroys data; a read-side list merely never reads it, so the data survives and the app behaves as though the operator never set a value.
- **CI runs in UTC.** Any test whose result depends on the local zone is blind in CI and blind to anyone east of Greenwich. If you touch date arithmetic, remove the zone-dependent call rather than testing around it.
- **No em dashes** in any prose you write.

## If you spawn a sub-agent

"Read only" is an instruction to the model, not a property of its tools. Three sub-agents have now written through a fixture whose path resolved wrong; **tonight's reached the live production config**. The cause each time was a path that silently defaulted, not an agent that disobeyed. So:

- `mktemp -d` for every fixture, asserted non-empty and not the live worktree, before anything runs in it.
- `git -C "$FIXTURE" ...` on every git call. Never `cd "$FIXTURE" && git ...`.
- A harness that edits and restores a file pins the path and verifies `git -C <live repo> diff --stat` is empty when it finishes.
- Never construct a config or client with no path argument in a fixture: in this repo that falls through to `resolveConfigPath()` and writes to the operator's real config.

## Your own scribe and your own reviewer

You run both; the orchestrator runs neither.

- **Scribe.** Spawn a background sub-agent that keeps Linear current from your PR and commit state: worklog comments at real checkpoints, status moves, issue bodies accurate. You write no Linear prose yourself.
- **Reviewer.** Measure your diff by non-test non-comment added lines:
  `git diff refs/heads/main...HEAD -- ':!*test*' | grep -E '^\+' | grep -vE '^\+\+\+|^\+\s*(\*|//|/\*)' | grep -vE '^\+\s*$' | wc -l`
  Above roughly 60, spawn one independent reviewer in its own worktree (security-reviewer for credential, file-mode or protocol code), fix what it finds, **run it once**. `#57` spent fourteen rounds and six of its seven defects were written during the review. **The reviewer must state the head its verdict covers**, and if you push after it starts, tell it the delta rather than re-running it.
- **Every defect worth finding tonight was found by a mechanism, never by care.** The full suite found what a focused suite structurally could not reach; mutation found three surviving branches including one a fix had just created; two reviewers independently found a type lie neither author had seen. Budget for the mechanism, not for attentiveness.

## Report to BTCF-000

Head sha, the one full-suite line with its sum and its failures **named**, the reviewer verdict **with the head it covers**, the mutation results, and anything you cut. Say explicitly if you push after reporting ready. If you finish early, say so and stop; do not pick up new scope. If blocked, message BTCF-000 rather than waiting.

**Fully autonomous: Sean is away and nobody will answer a question.** Make the best judgement available, write the reasoning into the Linear issue, and keep working.
