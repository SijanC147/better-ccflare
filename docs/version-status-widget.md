# Version and upstream status widget

The bottom of the dashboard sidebar reports two separate things:

1. **This fork's release.** The running version against the latest published
   release of `SijanC147/better-ccflare`.
2. **The upstream gap.** Upstream's latest release against the upstream release
   this fork has merged, plus how many upstream commits are not in the fork yet.

Below both cards, one footer line carries the fork release, the short sha of the
newest upstream commit merged in, and the upstream release tag that commit
belongs to. Every version string and commit reference is a link: a fork version
goes to its release notes on `SijanC147/better-ccflare`, an upstream tag to its
notes on `tombii/better-ccflare`, and a sha to that commit on the repository it
belongs to.

## Why the old card was wrong

`GET /api/version/check` used to read
`https://registry.npmjs.org/better-ccflare/latest`. That is **upstream's** npm
package. This fork does not publish to npm: it releases as annotated `v*` tags on
GitHub plus a private Homebrew tap, and `package.json` deliberately lags the
release (`docs/release.md`). The card therefore compared the fork's `3.9.0`
against upstream's npm line and produced a verdict about two unrelated release
streams. The route and its response shape are unchanged; only the source moved to
the fork's own `releases/latest`.

## Where the data comes from

Every GitHub read happens on the server. The dashboard never calls GitHub
directly: that would leak a token into the browser and spend the viewer's own
unauthenticated rate limit.

| Value | Source |
| --- | --- |
| Fork's latest release | `repos/SijanC147/better-ccflare/releases/latest` |
| Merged upstream sha | `last-sync-sha` marker in `MERGELOG.md`, inlined at build time |
| Commits behind upstream | `repos/tombii/better-ccflare/compare/<merged-sha>...main` → `ahead_by` |
| Merged upstream tag | newest upstream release the merged sha is at or ahead of |
| Open sync PR | open PR on the fork whose head branch starts with `upstream-sync/` |

### The merged-upstream sha in a compiled binary

`packages/http-api/src/services/fork-identity.ts` reads `MERGELOG.md` through a
Bun text import (`with { type: "text" }`) and parses the marker at module load.
Bun inlines text imports into the bundle, so the value survives
`bun build --compile` and is present in a Homebrew binary that has no repository
on disk. It is a property of the source tree at the tagged commit, exactly like
the version and commit defines, so it belongs in the build rather than in runtime
config or an API call. Unlike a third `--define` it needs no change to
`apps/cli/build-standalone.ts`, and so does not touch the Hextap define contract
that `.github/upstream-maintainer.yml` and `scripts/test-hextap-build.ts` gate.

### Cost and failure behaviour

A full refresh is four GitHub calls, and the merged-tag resolution adds one
release-list page plus at most ten compares once per process. A successful
snapshot is served for 15 minutes, concurrent refreshes collapse into one network
pass, and a `403`/`429` carrying `x-ratelimit-remaining: 0` suppresses all
requests until the reported reset.

`GET /api/version/status` always answers `200`. Each section degrades on its own:
a failing call nulls its own half and leaves the rest, and a total failure serves
the previous snapshot marked `stale`. When there is nothing to serve the response
still carries the local version, commit and merged sha, and `remote.error`
explains why the remote half is missing. The widget can never block or break the
sidebar because GitHub is unreachable.

`BETTER_CCFLARE_GITHUB_TOKEN`, if set, is sent as a bearer token purely to raise
the rate limit. It is never returned by an endpoint and never logged. All five
reads are public data, so the token is optional.

## The two capabilities that execute something

Both are **disabled by default** and both are switched on through the server's
environment only — never through `RuntimeConfig`. The dashboard can POST config
values, so a config flag would let an authenticated dashboard user switch on
command execution at runtime; an environment variable requires access to the
process. When a capability is off its endpoint answers `404`, as if it did not
exist, and the dashboard renders no button for it.

### Self-update: `BETTER_CCFLARE_ENABLE_SELF_UPDATE=1`

`POST /api/admin/self-update` runs the Homebrew upgrade and hands control back to
the supervisor. Four independent gates, all fail-closed:

1. `BETTER_CCFLARE_ENABLE_SELF_UPDATE=1` in the server environment, else `404`.
2. Dashboard authentication must actually be enabled (at least one active API
   key), else `403`. Without it an unauthenticated caller on the listening port
   could trigger a package upgrade and a restart. Because the router authorizes
   `/api/*` before dispatch and only an `admin`-role key may reach non-proxy
   paths, an API-only key cannot call it either.
3. The running executable must live inside a Homebrew prefix, else `409`. A
   binary outside the Cellar was not installed by Homebrew, so `brew upgrade`
   would replace a different copy than the one serving the request.
4. The command is `Bun.spawn(["brew", "upgrade", "better-ccflare"])`. Every
   element is a compile-time constant, no request field reaches argv, and there
   is no shell, so there is nothing for a quoting bug to escape. The formula name
   is kept byte-identical to `.hextap.json` `formula.name`.

On success the process exits with code **75**, not 0. The Homebrew service this
fork ships installs a launchd plist with `KeepAlive { SuccessfulExit: false }`,
which relaunches the binary only on a non-zero exit — `process.exit(0)`, as
`/api/admin/restart` uses, would leave the service stopped. Self-update is gated
on a Homebrew installation, so that launchd posture is the one that applies
whenever this code can run.

The dashboard then polls `/api/version/status` until the reported version changes
and reloads. It deliberately does not poll `/api/health` or `/api/version`: both
proxy to real accounts and answer `503` even when the server is fine.

**To enable:** add the variable to the service environment and restart, for
example under `~/Library/LaunchAgents/sh.brew.better-ccflare.plist`:

```xml
<key>EnvironmentVariables</key>
<dict>
  <key>BETTER_CCFLARE_ENABLE_SELF_UPDATE</key>
  <string>1</string>
</dict>
```

then `brew services restart better-ccflare`. With it off, or on a non-Homebrew
install, the card shows the manual command `brew upgrade better-ccflare` with a
copy button instead.

### Dispatching the upstream maintainer: `BETTER_CCFLARE_UPSTREAM_MAINTAINER_TOKEN`

`POST /api/upstream/sync-dispatch` sends a `repository_dispatch` to
`SijanC147/upstream-maintainer`:

```json
{ "event_type": "sync-upstream", "client_payload": { "target": "SijanC147/better-ccflare" } }
```

The body is a constant. The token comes from the server environment only, is
never part of any response body, and is never logged — a rejected dispatch
reports the HTTP status and nothing else, because a failure body can echo request
detail. Presence of the token is the opt-in: without it the endpoint answers
`404`. It must hold `Contents: write` on the controller repository. Dashboard
authentication must be enabled here too, since this spends the controller's
token, and one dispatch per five minutes is enforced in-process so a stuck button
cannot hammer the controller.

**To enable:** put the token in the service environment the same way as above
(on this machine secrets live in `~/.config/zsh/zsh-secrets`, which is already
sourced for every shell — reference the variable, never print it).

When a sync PR is already open, the upstream card replaces itself with the PR
number, its title and a link straight to it, and offers no dispatch button.

## Rendered states

| Condition | Fork card | Upstream card |
| --- | --- | --- |
| Everything current | "Up to date", `v3.9.0` | "In sync with upstream", merged tag |
| Fork release is newer | "Update available", `v3.9.0 → v3.9.1`, then either an "Install update" button or the manual command | unchanged |
| Fork behind upstream | unchanged | "N commits behind upstream", merged tag and latest tag, plus "Request upstream sync" when enabled |
| Sync PR open | unchanged | "Sync PR #52" with its title and a link to it |
| GitHub unreachable | "Release check unavailable" with the local version and a Retry | "Upstream check unavailable" with the merged sha |
| Status endpoint down | "Version check unavailable" with the compile-time version | not rendered |
