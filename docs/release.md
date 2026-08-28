# Releasing better-ccflare

Releases are produced by [Hextap](https://github.com/SijanC147/hextap-toolkit), a shared
release platform. This repository no longer contains its own release framework: the old
`.github/workflows/release.yml` was removed and replaced by a single thin caller,
`.github/workflows/hextap-release.yml`, pinned to an immutable toolkit commit.

Migrated in PRs [#36](https://github.com/SijanC147/better-ccflare/pull/36) and
[#37](https://github.com/SijanC147/better-ccflare/pull/37). First Hextap release: `v3.8.2`.

## The short version

A release is a **pushed annotated git tag on protected `main`**. Nothing else starts one.

```bash
git tag -a v3.8.3 -m "Release v3.8.3"
git push origin refs/tags/v3.8.3
```

There is no version file to bump, no npm step in the release path, and no commit-message
convention that triggers anything.

## Division of responsibility

| Layer | Owns |
|---|---|
| This repository | Release identity (`.hextap.json`), the build adapter, target declarations |
| Hextap toolkit | Build isolation, packaging, checksums, attestations, GitHub release, tap publication |
| `SijanC147/homebrew-hextap` | Every non-metadata byte of `Formula/better-ccflare.rb` |

A stable release may change exactly four values in the Formula: two Darwin URLs and two
SHA-256 checksums. Everything else in the Formula — the service block, caveats, logging
paths, tests — is tap-owned and cannot be changed from here.

## Version identity

**The git tag is the version.** Hextap normalizes `v3.8.3` to `3.8.3` and injects it, plus
the exact tagged source commit, as Bun compile-time defines. A release binary reports:

```
better-ccflare 3.8.2 (commit fb95f7340333b6d21ef7483e19dd8c25e3f57a98)
```

This format is enforced by the tap's service smoke test. The legacy `better-ccflare vX.Y.Z`
form is accepted only when validating the historical `3.8.1` binary.

Consequences worth internalizing:

- **Hextap does not edit `package.json` or `apps/cli/package.json`.** It reads the tag and
  injects it; nothing writes back. **Policy: bump them yourself, before tagging**, so the
  manifests always match the version about to be released. See *Cutting a release* below.
- `packages/core/src/version.ts` is **not** a version-bump target. It holds
  `CLAUDE_CLI_VERSION` (the Claude CLI user-agent string) and the compile-time define
  declarations. Do not put a release number there.
- Development builds deliberately carry a different identity: `bun run build` uses the
  package version and a forty-zero commit; running from source reports `commit development`.

## Protected main

`main` is governed by repository ruleset `hextap/main` (ID `21627513`):

- Pull requests only. No direct pushes, no force-pushes, no deletion.
- Review threads must be resolved.
- Two required status checks, both strict:
  - `Bun and release tooling`
  - `Hextap release contract`
- Zero bypass actors — admin override is not available and must not be sought.

Release tags are governed by `hextap/release-tags` (ID `21627514`): `v*` tags cannot be
moved or deleted. Immutable releases are enabled.

**A failed release is fixed forward with a new version, never by re-tagging.** `v3.8.2-rc.1`
exists as a tag with no release object, from a build that failed on Windows. It was
deliberately left in place. Do not clean it up.

## Development loop

```bash
git fetch origin main --tags
git switch main && git pull --ff-only origin main
git switch -c feat/your-change
```

Before opening a PR:

```bash
bun install --frozen-lockfile
bun run typecheck
bun test                              # includes scripts/hextap-contract.test.ts
bun run build:dashboard
bun run scripts/test-hextap-build.ts
/bin/bash -n scripts/hextap-build

brew hextap validate --project .
```

Add `brew hextap validate --project . --build` when the change can affect compiled output:
CLI or server code, dashboard, embedded workers, build identity, dependencies, the adapter,
or target declarations.

Then confirm a clean tree — CI enforces this and will fail on generated-file drift:

```bash
git diff --exit-code && git diff --cached --exit-code
test -z "$(git status --porcelain --untracked-files=no)"
```

Note that `bun run lint` and `bun run format` **modify files** (`biome check --write
--unsafe` and `biome format --write`). They are useful, but they are not a pass/fail gate.
The authoritative gate is `.github/workflows/ci.yml`.

## Validation ladder

| Command | Checks | Runs project code | Network |
|---|---|---|---|
| `brew hextap validate` | Manifest, caller, rulesets, `SETUP.md`, adapter location | No | No |
| `brew hextap validate --build` | The above, plus builds every declared target | Yes | Yes (Bun deps) |
| `brew hextap doctor` | The above, plus local `git`/`gh`/`bun` availability | No | No |
| `brew hextap doctor --online` | The above, plus live GitHub rulesets and tap parity | No | Yes |

Run `doctor --online` immediately before creating a release tag. No local command proves
hosted CI, all-platform native execution, release publication, or tap CI.

### `--build` dirties the working tree

`validate --build` and `scripts/test-hextap-build.ts` regenerate:

- `packages/dashboard-web/dist/**` — gitignored, harmless
- `packages/database/src/inline-vacuum-worker.ts` — **tracked**
- `packages/database/src/inline-incremental-vacuum-worker.ts` — **tracked**
- `packages/database/src/inline-integrity-check-worker.ts` — **tracked**

Prefer running these in an isolated worktree. If you run them in a working checkout, diff
those three paths afterward. If you did not change worker source and they still differ,
that is a signal — usually the wrong Bun version — not churn to commit away.

## Cutting a release

### Bump the manifests first

**Decided 2026-08-28: package versions are not independent of the release.** Before tagging
`vX.Y.Z`, set that exact version in both manifests, in its own PR merged ahead of the tag:

```
package.json           "version": "X.Y.Z"
apps/cli/package.json  "version": "X.Y.Z"
```

Nothing else carries a release version. `packages/core/src/version.ts` holds
`CLAUDE_CLI_VERSION` (the Claude CLI user-agent) and the compile-time define declarations —
**not** a version-bump target. `apps/cli/__tests__/cli.test.ts` derives its expectation from
`apps/cli/package.json` rather than hardcoding, so it follows the bump automatically.

Two things that look like they need updating and do not:

- **`bun.lock`** carries a stale `"version"` under the `apps/cli` workspace entry. `bun
  install` does not rewrite it on a version-only change, and `bun install --frozen-lockfile`
  passes regardless — the field is informational and bun resolves workspaces by path.
  Verified 2026-08-28. (The v3.8.0 release failure was a *missing workspace package*, which
  is a different problem and does require a regenerated committed lockfile.)
- **npm.** This fork does not publish there; `better-ccflare` on npm is upstream's package.
  `cd apps/cli && bun publish` is not part of any release path here.

Why bother, given Hextap injects the tag version into release binaries regardless: source-mode
`bun run cli --version` and everyday `bun run build` both report the manifest version, so a
stale manifest misleads developers even while released binaries stay correct.

### Cutting the tag

Verify you are on clean, current, protected `main` with both CI jobs green on the merge
commit, then run the full local gate plus:

```bash
brew hextap doctor --project . --online
git ls-remote --tags origin refs/tags/v3.8.3 'refs/tags/v3.8.3^{}'   # must be empty
git tag -a v3.8.3 -m "Release v3.8.3"
git push origin refs/tags/v3.8.3
```

A **prerelease** (`v3.8.3-rc.1`) builds all five targets, publishes an immutable prerelease,
and stops. Homebrew is skipped and the tap is untouched.

A **stable** release (`v3.8.3`) does the same, then updates the Formula's four metadata
values, pushes the tap, and waits for tap CI at that exact commit.

Every successful release publishes exactly eight files: five raw binaries, two Darwin
`.tar.gz` archives, and `SHA256SUMS`.

## Recovery

If the stable GitHub release succeeded but Homebrew publication failed:

```bash
gh workflow run hextap-release.yml \
  --repo SijanC147/better-ccflare \
  --ref main \
  -f tag=v3.8.2
```

Every manual dispatch maps to `homebrew-only`. It re-verifies the existing immutable
release, skips all build and publication jobs, and updates only Formula metadata — or
reports `formula unchanged` / `already-current`.

Recovery is **windowed**: it requires the tagged source manifest to still equal the live tap
registration. Changing the manifest can permanently close recovery for older tags. Never use
recovery to rebuild assets, replace a release, or move a tag. Never dispatch it for a
prerelease.

## The manifest is a boundary, not a config file

These three files must be **byte-identical**:

```
.hextap.json
.hextap/tap-registration.json
homebrew-hextap/Projects/better-ccflare.json
```

Current SHA-256: `328f95a73340ff0de3d5489a7fc40fb3f9c9c2f7e55e4603ab465f59e169f9fb`

No field is safe to edit unilaterally. A legitimate manifest change means: edit
`.hextap.json`, copy the exact bytes to `.hextap/tap-registration.json`, open a reviewed tap
PR updating the registry, update `scripts/hextap-contract.test.ts`, revalidate, and merge
source and tap in the correct order. Reformatting counts as a change.

Effectively fixed invariants: `schema: 2`, formula name and class, repository owner/name,
binary name, `runtime: "bun"`, the exact `bun install --frozen-lockfile` argv, both Darwin
targets, the paired-Linux rule, the Windows `.exe` rule, `macos_only: true`, and
`formula_profile == formula.name`.

The toolkit pin in `.github/workflows/hextap-release.yml` is equally load-bearing:

```
Hextap Toolkit v0.4.2
613f0d37a0c84cff20a8e277fc5e9c374f9cbc26
```

Never float it to `@main` or a tag. Upgrading requires a provenance-only PR. The reusable
workflow is still named `release-go.yml` in the toolkit for historical reasons despite
schema 2 supporting Bun — do not "correct" that reference.

## Homebrew

`brew services start better-ccflare` generates a per-user LaunchAgent that runs the binary
with no arguments; port 8080 comes from application defaults, not the Formula. Both launchd
streams and the app's own log land in `$(brew --prefix)/var/log/better-ccflare/`.

The macOS binaries are **not** Developer ID signed and **not** notarized. Hextap provides
GitHub build-provenance attestations, which are not Apple trust. Homebrew's download path
normally avoids Gatekeeper quarantine; a direct browser download usually does not, and needs
`xattr -d com.apple.quarantine <file>`.

The tap is private. It is operator infrastructure, not a public installation channel.

## Open questions

- **Signing and notarization.** Not implemented for macOS or Windows.
- **No CHANGELOG.** `docs/contributing.md` recommends one; the repository has none.

## Runtime boundary

Nothing in this document authorizes `brew upgrade better-ccflare`,
`brew services restart better-ccflare`, reinstalling the Formula, or touching live
configuration, database, certificates, or ports. A successful remote release does not mean
the local machine should be upgraded. That is a separate operation requiring explicit
approval.
