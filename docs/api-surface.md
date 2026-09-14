# The HTTP API surface

An audit of what this fork actually serves, measured against upstream's
[`docs/api-http.md`](https://github.com/tombii/better-ccflare/blob/main/docs/api-http.md).

Measured 2026-09-13 at `ac8e09e3` for SB23-1220.

## Where the truth lives

`packages/http-api/src/router.ts` is the authority. Nothing else is.

Routes reach it two ways:

- **Static routes** registered as `this.handlers.set("<METHOD>:<path>", ...)`.
  There are 110 of them.
- **Dynamic routes** matched by path prefix inside `handleRequest`, which take
  a parameter (`/api/accounts/:accountId/pause`, `/api/combos/:comboId/slots/:slotId`).
  There are 42.

One route belongs to neither group: `POST /api/logs/stream/token` is handled
inline in `handleRequest` at router.ts:740, because minting a stream token
needs the authenticated caller's identity and the handlers map is keyed only by
method and path, so it has no way to pass that through.

That is 153 routes. `packages/dashboard-web/src/lib/api-catalog.ts` lists all
of them and drives the API playground.

The catalog cannot quietly fall behind the router:
`packages/dashboard-web/src/lib/__tests__/api-catalog.test.ts` re-reads
router.ts, extracts every static registration, and fails when one is missing
from the catalog. It caught `GET /api/token-health/reauth-needed` on its first
run, which a hand inventory had missed because the registration spans two
lines.

## What upstream documents

The upstream document describes 40 endpoints. All 35 of its `/health` and
`/api/*` endpoints exist in this fork, unchanged in method and path.

The other five are the proxy path, not the API:

| Endpoint | Where it is served |
| --- | --- |
| `POST /v1/messages` | `apps/server/src/server.ts` |
| `GET /v1/models` | `apps/server/src/server.ts` |
| `POST /v1/responses` | `apps/server/src/server.ts` |
| `POST /v1/responses/compact` | `apps/server/src/server.ts` |
| `POST /v1/complete` | `apps/server/src/server.ts` |

These are the endpoints Claude Code and Codex actually call. They never reach
the API router, so they are outside this audit and outside the playground,
which is a dashboard tool for the management API. The playground would also be
the wrong place to fire them: they consume real account quota.

## What upstream does not document

118 of the fork's 153 routes appear nowhere in the upstream document. The
large additions, by area:

| Area | Routes | What it is |
| --- | --- | --- |
| Config | 40 | Retention, request storage, keep-alive, cache TTL, usage throttling, Postgres, model-capacity routing, combo session fallback, GitHub token, upstream maintainer, OpenObserve |
| Accounts | 30 | Sixteen provider-specific add routes, plus per-account rename, billing type, auto-refresh, custom endpoint, model mappings, request transformer, model fallbacks, auto-pause-on-overage, peak-hours pause |
| Combos | 11 | Combos and their slots, plus model-family assignment |
| Insights | 9 | Cache, anomaly and context insights, alerts and the alert stream |
| Projects | 11 | Project attribution and worktree discovery, both fork features |
| API keys | 7 | Key generation, roles, enable and disable |
| OAuth | 10 | Qwen and Codex device flows, Anthropic re-authentication |
| Debug | 3 | Heap statistics, RSS, heap snapshot |
| Maintenance | 4 | Restart, self-update, cleanup, upstream sync dispatch |

The upstream document is not wrong so much as old: it predates project
attribution, worktree discovery, agent workspaces, the combos subsystem, the
insights subsystem, the API-key layer, the upstream-maintainer configuration
and the OpenObserve exporter added in v3.12.0.

This fork has no equivalent document of its own. The playground is the
answer to that: a list that cannot go stale because a test compares it to the
router on every run.

## Routes whose names mislead

Three worth stating plainly, because each has cost time before.

- **`GET /health` is a liveness check of the proxy process, nothing more.** It
  does not report account health, and it is the only statically auth-exempt
  path besides `GET /api/version/check` and the `GET /api/sessions/:id/account`
  status-line read.
- **`/api/health` and `/api/version` do not exist.** Neither is registered in
  the router. Code looking for a status probe wants `/api/version/status`; see
  the comment at `packages/dashboard-web/src/components/version-status.tsx:91`,
  which records why the other two were rejected: they proxy to real accounts
  and return 503 when everything is fine.
- **`GET /api/debug/snapshot` writes a heap dump.** The response is large
  enough that the playground reports its size and content type rather than
  rendering it.

## What the OpenObserve request stream holds

The exporter ships one record per request to the configured request stream, and
that record is the `summary` object `UsageCollector._handleEndInternal` builds
(`packages/proxy/src/usage-collector.ts:1020-1074`), spread wholesale into
`shipRequestRecord`. `shipRequestRecord` takes a loose `Record<string, unknown>`
(`packages/logger/src/openobserve.ts:313-316`), adds `_timestamp`, and enqueues,
so it is field-agnostic: a field added to the summary reaches the stream with no
exporter change, and one deleted from it disappears just as silently.

Ten of those fields carry token usage and cost: `model`, `promptTokens`,
`completionTokens`, `totalTokens`, `inputTokens`, `cacheReadInputTokens`,
`cacheCreationInputTokens`, `outputTokens`, `costUsd`, `tokensPerSecond`.
`packages/logger/src/openobserve.test.ts` pins all ten.

Four things about this stream mislead people writing queries against it. Each
has a real failure mode, not a caveat.

**The shipped names are camelCase; the database columns are snake_case.** The
stream receives `inputTokens` and `costUsd`; the `requests` table has
`input_tokens` and `cost_usd` (`packages/database/src/migrations.ts:147-155`). A
query written from the schema matches nothing and reads as a broken exporter.
OpenObserve also lowercases field names on ingest, so confirm what the stream
stores rather than trusting what the code sends.

**An absent token field is omitted, not zeroed.** Every token field is optional
on `RequestResponse` (`packages/types/src/request.ts:200-210`) and
`JSON.stringify` drops `undefined` (`openobserve.ts:120`), so a request with no
parsed usage, an error or a non-message endpoint, ships with no token keys at
all. This is deliberate. A zero reads as "no tokens were used"; a missing key
reads as "this was not measured". Aggregates must treat missing as missing, and
an `avg()` over a stream half of whose records lack the field is not the average
anyone intends.

**There are two timestamps and they mean different things.** `_timestamp`
(`openobserve.ts:315`) is `Date.now()` at ship time, so approximately request
*end*. The `timestamp` field (`usage-collector.ts:1022`) is request *start*, as
an ISO string. OpenObserve indexes `_timestamp`, so a dashboard should use
`_timestamp` unless it specifically wants arrival time; the two differ by the
request duration, which for a long stream is not small.

**There is no retry, so the stream is lossy and is never a billing record.** A
batch that fails to post is dropped rather than requeued
(`openobserve.ts:206-210`, `:239-246`), and the buffers are bounded at 1000
records and 16 MB with evictions counted and warned about. Under pressure or an
outage, records are gone. Use the `requests` table for anything that must
reconcile. Retry is tracked as SB23-1760.

## Gaps worth filling

Filed as Linear issues rather than implemented here, since SB23-1220 was
scoped to the audit and the playground:

- **SB23-1782** (estimate 2) — no route lists the API surface. Every consumer,
  the playground included, has to hard-code the inventory. A
  `GET /api/meta/routes` would make the server self-describing.
- **SB23-1783** (estimate 3) — nothing updates an account's provider settings
  after creation. Rotating a credential means deleting the account and adding
  it again, which discards its id and its statistics.
- **SB23-1784** (estimate 1) — no route returns a single request by id, though
  `GET /api/requests/payload/:requestId` takes one. Callers fetch a page and
  filter client-side.
