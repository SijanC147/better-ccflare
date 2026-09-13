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
package. This fork does not publish to npm: it releases as `v*` tags on
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
| Open sync PR | open PR whose head branch starts with `upstream-sync/` **and** lives on the fork itself |

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
pass, a `403`/`429` carrying `x-ratelimit-remaining: 0` suppresses all requests
until the reported reset, and a refresh in which every call failed backs off for
60 seconds. That last brake is what bounds a DNS failure, timeout or 5xx, none of
which set a rate-limit header, and it applies to `?refresh=1` as well: `force`
skips the freshness TTL, not the failure brake.

The sync-PR match requires the head branch to live on the fork itself, not only
to carry the `upstream-sync/` prefix. This repository is public and accepts pull
requests from anyone, so a prefix test alone would let an outsider open
`upstream-sync/anything` from their own fork and have the dashboard present it as
the maintainer's sync PR. Only an account with push access can put a branch on
the fork.

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
3. The running executable must be **this formula's** Homebrew-installed binary,
   else `409`. The formula name is part of every path test on purpose: a
   prefix-only check (`/Cellar/`, `/opt/homebrew/`) also matches a
   Homebrew-installed Bun running the server from a source checkout, where
   `process.execPath` is `/opt/homebrew/Cellar/bun/<version>/bin/bun`. That would
   let the gate pass in development, upgrade an unrelated Cellar copy and exit a
   process with no supervisor behind it.
4. The command is `Bun.spawn([<brew>, "upgrade", "better-ccflare"])`. Every
   element is a compile-time constant or a path from a fixed list, no request
   field reaches argv, and there is no shell, so there is nothing for a quoting
   bug to escape. The formula name is kept byte-identical to `.hextap.json`
   `formula.name`.

`<brew>` is an absolute path resolved from the known Homebrew prefixes
(`/opt/homebrew/bin/brew`, `/usr/local/bin/brew`,
`/home/linuxbrew/.linuxbrew/bin/brew`), not the bare name. A launchd user agent
inherits `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and the plist Homebrew generates
for this formula sets only `BETTER_CCFLARE_LOG_DIR`, so a bare `brew` argv fails
with "command not found" under exactly the service this capability is gated to.
Running the upgrade under that environment confirmed both halves: the bare name
is not found, the absolute path runs. When no brew executable is present the
handler answers `409` before spawning anything. The child also gets
`HOMEBREW_NO_AUTO_UPDATE=1`, so upgrading the formula does not drag in a
Homebrew self-update.

The child's environment is an allowlist (`PATH`, `HOME`, `LANG`, `TMPDIR`,
`HOMEBREW_NO_AUTO_UPDATE`), not an inherited copy of the server's. Homebrew runs
formula Ruby and `git`, and this process holds both GitHub tokens; inheriting the
environment would hand them over. For the same reason the command's output never
reaches the client: it goes to the server log with credential shapes redacted,
and the response carries only the exit code. This fork installs from a private
tap, so a failed fetch can echo a credentialed remote URL.

Only one upgrade runs at a time. Overlapping requests share the first one's
result rather than spawning a second `brew`.

`brew upgrade` does not restart services of its own accord (`upgrade.rb` has no
service handling; `brew services restart` is a separate user-invoked command), so
the upgrade is not interrupted by its own side effects.

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

### Dispatching the upstream maintainer: the controller token

`POST /api/upstream/sync-dispatch` sends a `repository_dispatch` to
`SijanC147/upstream-maintainer`:

```json
{ "event_type": "sync-upstream", "client_payload": { "target": "SijanC147/better-ccflare" } }
```

The body is a constant. **The token's presence is the feature's only switch.**
There is no separate enable flag: configure a token and the endpoint works and
the dashboard offers "Request upstream sync"; configure none and the endpoint
answers `404` and no button renders.

#### Setting it

The token is a configuration parameter, stored and read like every other secret
in `packages/config`: **environment first, then the persisted config file.**

```jsonc
// ~/.config/better-ccflare/better-ccflare.json
{
  "upstream_maintainer_token": "github_pat_..."
}
```

`BETTER_CCFLARE_UPSTREAM_MAINTAINER_TOKEN` in the server environment works too
and wins over the stored value — which is why
`GET /api/config/upstream-maintainer` also reports `tokenFromEnvironment`:
without it, editing the stored token while the variable is set would look like a
no-op.

The config file is read once when the server starts, so **restart the server
after editing it**. That is true of every value in the file, not just this one.

**There is no setter endpoint, and the config layer has no setter method.** The
operator writes the token; nothing reachable from the dashboard can install or
overwrite it. `GET /api/config/upstream-maintainer` is read-only and returns
booleans.

> **Where the token lives, and who can read it.** The config file is
> `~/.config/better-ccflare/better-ccflare.json` (or `$BETTER_CCFLARE_CONFIG_PATH`).
> It is written with default permissions, which on this machine means **`0644` in
> a `0755` directory — world-readable**. That is pre-existing behaviour and
> already applies to `pg_password` and `local_control_secret`, but a GitHub token
> is more portable than either, so it is worth stating plainly rather than
> assuming. Tightening it is a deliberate choice for the repository owner to make;
> nothing here changes the file's mode. An operator who would rather not put the
> token on disk at all can use the environment variable instead.

#### Why this is configuration and the self-update switch is not

The two capabilities are gated differently on purpose.

`BETTER_CCFLARE_ENABLE_SELF_UPDATE` authorizes **command execution** on the host,
so it must not be settable by anything that can reach the API — it lives in the
environment, where changing it needs access to the process, not an API key.

The maintainer token authorizes a **workflow dispatch on another repository**,
bounded by the controller's own protections (below). That is ordinary
configuration, so it lives with the other secrets in the config file. Neither one
is writable through an endpoint; the difference is that a token is something the
user supplies, while an execution switch is something the host grants.

#### What the token needs

A **fine-grained personal access token**, resource-scoped to
`SijanC147/upstream-maintainer` alone, with one permission: **`Contents: write`**.
That is the minimum GitHub's `POST /repos/{owner}/{repo}/dispatches` accepts. Do
not grant it anything else, and do not point it at this repository.

Two things bound what a leaked copy of it could do:

- The controller's own `main` is protected with required reviews, so the token can
  start a run but cannot change the code that runs.
- The controller refuses any target that is not in its `TARGETS` variable, so the
  token cannot aim a sync at an arbitrary repository.

#### How it is handled

The token is never returned by any endpoint, never appears in a response body,
never reaches the browser and is never logged. The dashboard learns one boolean,
`capabilities.dispatch`, and nothing else. A rejected dispatch reports the HTTP
status alone, because a failure body can echo request detail.

Endpoints checked for configuration echo, since a diagnostic route that dumped
config would defeat all of the above:

| Endpoint | Finding |
| --- | --- |
| `GET /api/config` | Copies named fields into an allowlisted `ConfigResponse` (`packages/types/src/stats.ts`), which has no token field; no spread |
| `GET /api/config/upstream-maintainer` | `tokenSet` and `tokenFromEnvironment` booleans only; read-only, no setter |
| `GET /api/config/postgres` | Same precedent: `passwordSet` boolean, never the password |
| The other twelve `GET /api/config/*` routes | Each returns its own named fields |
| `GET /api/system/info` | Package-manager and container detection only |
| `GET /api/health` | Named build fields and `config.getStrategy()` |
| `GET /api/version/status` | Local identity, GitHub URLs, capability booleans |
| `Config.getAllSettings()` | Now strips `upstream_maintainer_token`, `pg_password` and `local_control_secret` at the source |

`getAllSettings()` previously spread the whole config object, so although no
caller leaked anything today, the next one to hand it to a settings endpoint would
have shipped `pg_password` and `local_control_secret` with it. The three secrets
are excluded there now, and each has its own accessor for the code that needs it.

Dashboard authentication must be enabled for a dispatch, since it spends the
controller's token, and one dispatch per five minutes is enforced in-process so a
stuck button cannot hammer the controller.

When a sync PR is already open, the upstream card replaces itself with the PR
number, its title and a link straight to it, and offers no dispatch button.

## Rendered states

| Condition | Fork card | Upstream card |
| --- | --- | --- |
| Everything current | "Up to date", `v3.9.0` | "In sync with upstream", merged tag |
| Fork release is newer | "Update available", `v3.9.0 → v3.9.1`, then either an "Install update" button or the manual command | unchanged |
| Fork behind upstream, no token configured | unchanged | "N commits behind upstream", merged tag and latest tag, and **no button** |
| Fork behind upstream, token configured | unchanged | The same, plus a "Request upstream sync" button; after a click it reads "Sync requested" with "The maintainer opens a PR when it finishes." |
| Sync PR open (with or without a token) | unchanged | "Sync PR #52" with its title and a "Review pull request" link, and no dispatch button — the work is already queued |
| GitHub unreachable | "Release check unavailable" with the local version and a Retry | "Upstream check unavailable" with the merged sha |
| Status endpoint down | "Version check unavailable" with the compile-time version | not rendered |
