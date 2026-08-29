# Rollback

How to put better-ccflare back on a previous release, and what a rollback does **not** undo.

Companion to `docs/release.md`, which covers cutting a release. Read this one before you
need it — not while a bad release is running.

**Sources.** The Hextap rulings below came from the Hextap Initiative coordinator thread on
2026-08-29, via `/ask-hextap-coordinator`. Everything marked *verified locally* was checked
directly on this machine the same day; everything else is the coordinator's ruling, recorded
as advice. Where the two are separated below, that separation is deliberate — do not collapse
it, because a future toolkit version can change the ruling without changing what was measured.

## The one-line version

`hextap rollback` is **package-only**. It moves which binary is installed. It does not touch
the database, and better-ccflare's schema migrations are one-way. So a rollback is only safe
after a fresh verified data backup **and** an explicit decision that the older binary can run
against the current schema.

## Use the Hextap command, not a hand-rolled one

Hextap `v0.6.0` ships a first-class `hextap rollback`. The obvious manual sequence — check out
an old `Formula/better-ccflare.rb` in the tap, `brew reinstall`, put it back — is the *mechanism*
Hextap uses internally, but doing it by hand skips its stale-plan, ownership, concurrency,
restoration and cleanliness checks. Don't.

There is **no** versioned-Formula or pin-based rollback. Pinning does not install an old
version, and Hextap refuses a rollback when the selected Formula is pinned. `homebrew-only` is
release-*publication* recovery — a different thing entirely, covered in `docs/release.md`.

*Verified locally 2026-08-29:* installed toolkit is `brew-hextap 0.6.0 (commit 9d1f6ef1ca365f83b118473d5bfcda416e7bf77c)`.
Note this is the **local CLI** version and is independent of the workflow pin (`v0.4.2` /
`613f0d37…`) in `.github/workflows/hextap-release.yml`. Do not "reconcile" them; they are
different things.

## Local mode — roll back this machine only

Leaves the canonical tap advertising the current version and restores it byte-for-byte. Only
the installed keg goes backwards. A later `brew update && brew upgrade` returns it. That
divergence is intentional and is not corrupt state.

```sh
brew services stop better-ccflare

# Project-owned safety step — see "The database is the real risk" below.
# Take and VERIFY a fresh backup here. Hextap will not do this for you.

# 1. Plan (read-only). Prints the confirmation string you need for step 2.
brew hextap rollback formula better-ccflare \
  --to-commit <tap-commit> \
  --mode local \
  --json

# 2. Execute. Copy --confirm from the plan you just ran, not from this file.
brew hextap rollback formula better-ccflare \
  --to-commit <tap-commit> \
  --mode local \
  --execute \
  --confirm 'ROLLBACK local formula sean/hextap/better-ccflare <tap-commit>' \
  --json

brew list --versions better-ccflare
better-ccflare --version
git -C "$(brew --repo sean/hextap)" status --short --branch

# Only after the schema/binary decision and a foreground health check:
brew services start better-ccflare
brew services list
```

**Always copy `--confirm` from the immediately preceding fresh plan.** A stale confirmation is
rejected by design — that is the point of it.

**Hextap refuses to run while the service is up, and will not stop it for you.**
*Verified locally 2026-08-29* — planning against the running service produced exactly:

```text
error: rollback formula: refusing rollback while better-ccflare has an active Homebrew service (started); Hextap will not stop it
```

Stopping the service is yours to do, deliberately, which is why it is step one above.

### Rolling back to 3.8.2 specifically

*Verified locally 2026-08-29.* The tap commit is `230b140745519aa73b7bfb04ac1e136e1864ee70`
("Update better-ccflare to 3.8.2"). The v3.8.2 release is immutable and its assets are still
published, so the reinstall has something to download.

## Remote mode — roll back every consumer

Opens a PR against the protected tap. It does **not** merge — tap CI and review still apply.

```sh
brew hextap rollback formula better-ccflare --to-version 3.8.2 --mode remote --json
```

The plan resolves a deterministic branch (`codex/hextap-rollback-formula-better-ccflare-to-<version>`)
touching `Formula/better-ccflare.rb` and `packaging/better-ccflare.rb.tmpl`, and sets
`version_scheme: 1` so Homebrew treats the republished older version as *newer* than what it
replaces. Remote mode preserves the current install/service/caveat/test structure rather than
reverting the whole historical Formula.

After the PR merges, each consumer converges with `brew update && brew upgrade`.

## What a rollback does NOT undo

Neither mode touches any of this:

- The immutable `v3.9.0` / `v3.9.0-rc.1` tags, their releases, assets, attestations, provenance
- Source repository history
- Caches and downloaded Formula metadata on **other** machines
- `~/.config/better-ccflare/.env`, the SQLite database, application data, or logs
- **Schema migrations, and rows deleted by them**
- Service lifecycle — Hextap neither stops nor starts it

There is no separate Hextap database or daemon registry to reconcile. The only registry is the
git-tracked `Projects/better-ccflare.json`, and neither rollback mode changes it.

### The `homebrew-only` recovery window stays open

Rolling the Formula back does **not** close the newer tag's `homebrew-only` window: local mode
restores the tap unchanged, remote mode touches only the Formula and template, and
`Projects/better-ccflare.json` is untouched — so the tag manifest and the live registration stay
equal at `328f95a7…`. Forward-republication of the immutable assets remains possible.

That holds *provided registration does not evolve*. If it does, recovery fails closed with
`tap/source manifest mismatch` before any Formula mutation. This is not hypothetical — see the
`claude-rc-proxy v0.1.0` incident below.

## Failure classification

| Failure | State | Response |
|---|---|---|
| Dirty or wrong-branch tap, wrong origin, active service, ambiguous selector, stale confirmation, changed HEAD, Formula/Homebrew mismatch | Fails **before** mutation | Fix the named precondition, take a fresh plan |
| Reinstall fails/times out, with `restored=true` and `tap_clean=true` | Tap already restored | Diagnose Homebrew, re-plan, retry |
| Concurrent tap drift | Preserved and reported | Inspect by hand — do **not** reset or blind-retry |
| `rollback restoration failed; manual tap recovery is required` | **Manual** | Restore original Formula/index; prove HEAD, branch, bytes, cleanliness before retrying |
| Remote failure before branch push | Nothing remote changed | Resolve, re-plan |
| Branch pushed, PR creation failed | Branch exists; main and releases untouched | Open/reconcile the PR by hand — do not re-push the deterministic branch repeatedly |
| PR CI/review/merge failure | — | Work it through the protected PR; Hextap will not merge or bypass |
| Service or app health failure after rollback | Package rollback may already be complete | Treat as a **runtime/data incident**, not a reason to repeat the package rollback |

## The database is the real risk

**Hextap takes no position on application data.** No schema backup, no down-migration, no
binary/schema compatibility gate. That is entirely this project's problem.

better-ccflare's migrations are additive *except* where they are not. The `#340` account dedup
repoints dependent references onto a survivor row and then **deletes** the duplicates. Deleted
rows are not recoverable without a backup taken beforehand.

Do not rely on the app's own `.db.backup.<timestamp>` files. That path only fires for a specific
accounts-table rebuild — *verified 2026-08-29*: it did **not** fire for the 3.9.0-era migration,
and the newest such backup on this machine is from May.

Take the backup yourself, from a stopped service, and verify it:

```sh
brew services stop better-ccflare
sqlite3 ~/.config/better-ccflare/better-ccflare.db \
  "VACUUM INTO '$HOME/ccflare-pre-rollback-$(date +%s).db'"
sqlite3 "$HOME/ccflare-pre-rollback-<ts>.db" "PRAGMA integrity_check;"
```

`VACUUM INTO` rather than `cp` because the DB runs in WAL mode — a naive copy can miss committed
data sitting in the `-wal` file.

### Current state of this machine (2026-08-29)

*All verified locally.*

| | |
|---|---|
| Installed binary | `3.8.2 (commit fb95f734…)` |
| DB schema | already **3.9.0-era** |
| Evidence | `usage_snapshots` + `instance_heartbeats` tables exist; `accounts.requires_reauth` and the new `requests.*` columns exist; `idx_accounts_unique_name_provider_endpoint` exists, so `#340` dedup **completed** |

So the binary and schema are **already mismatched**, and have been running fine — which is
evidence of *some* backward compatibility but is **not a guarantee**. A binary rollback would
not move the schema back.

No accounts were lost to the dedup: the May backup held `CDX ICLD MOLT ORTR SB23 UOM`, the DB
now holds `CDX ICLD OTLK SB23 UOM`, and no duplicate name+provider+endpoint pair exists. MOLT
and ORTR were removed and OTLK added by ordinary operator action, not by the migration.

**The May backups are not rollback points.** They are schema-stale and carry a different account
roster. Restoring one would lose three months of data and re-run migrations.

## Prior incidents

No production failure of `hextap rollback` itself is on record — the command is new in `v0.6.0`.
Its validation, race, restoration, Formula/Cask, remote-branch and completion tests passed
before publication. Treat the table above as designed behaviour, not battle-tested behaviour.

Adjacent incidents that are on record and did happen:

- **SB23-312 / v3.8.0** — release failed because `bun.lock` drifted after an uncommitted
  workspace package while frozen-lockfile install was required. Fixed by regenerating and
  committing the lockfile. This is *why* exact runtime pins, frozen installs and clean-tree
  gates exist.
- **Published-Formula main-only failure** — PR CI green while post-merge Formula validation
  failed, because `setup-homebrew` removed an auxiliary checkout. Fixed by resolving the real
  tap after setup and verifying its HEAD.
- **Closed recovery window** — `claude-rc-proxy v0.1.0` became ineligible for `homebrew-only`
  after a caveat/registration evolution. Hextap did not rewrite history; it failed closed and
  required a future aligned stable release.
- **v3.9.0 procedural near-miss** — `v3.9.0-rc.1` was pushed despite two local `AgentRegistry`
  failures and local `validate --build` being blocked by Bun `1.4.0` against the required
  `1.3.14`. Hosted RC and native release evidence subsequently passed, and stable used the
  identical commit. Record this as **a gate violation caught by RC evidence, not as precedent
  for skipping local tag preconditions.**
- **Malformed `GIT_CONFIG_*` inherited in the environment** produced
  `missing config key GIT_CONFIG_KEY_0`. The safe fix is unsetting those per-process variables —
  never editing persistent git config.

## better-ccflare specifics

The private tap is explicitly supported: Hextap verifies the exact owned remote
`SijanC147/homebrew-hextap`, and remote mode uses authenticated `gh` to open — never merge — the
protected PR.

The 3.8.2 and 3.9.0 Formulae share the same service structure: runs `opt_bin/"better-ccflare"`,
keeps alive after crashes, sets `BETTER_CCFLARE_LOG_DIR`, and co-locates logs at
`$(brew --prefix)/var/log/better-ccflare/{launchd,app}.log`. Rollback does not truncate them, so
they span the rollback and are the first place to look afterwards.

## The rule

> Hextap rollback is package-only. A better-ccflare rollback may proceed only after a fresh,
> verified data backup **and** an explicit project-level decision that the target binary can run
> against the current schema — or after a separately tested project-owned data restoration or
> down-migration plan.
