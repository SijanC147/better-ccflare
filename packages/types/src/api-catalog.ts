/**
 * The inventory of every HTTP route this fork serves. Two consumers: the
 * dashboard's API playground, and `GET /api/meta/routes`, which serves this
 * array verbatim.
 *
 * It lives in `@better-ccflare/types` rather than in the dashboard because
 * the server has to import it and does not depend on `dashboard-web`. It is
 * hand-authored on purpose: generating it from the router would lose the
 * `description`, `category` and parameter metadata the playground needs.
 *
 * The authority is `packages/http-api/src/router.ts`, not this file and not
 * any document. Static routes are registered there as
 * `this.handlers.set("<METHOD>:<path>", ...)`; dynamic routes are matched by
 * prefix in `handleRequest` and appear here with `:param` placeholders.
 *
 * `packages/dashboard-web/src/lib/__tests__/api-catalog.test.ts` re-reads
 * router.ts and fails if a static route exists there but not here, so this
 * list cannot quietly fall behind the router. The dynamic half is guarded
 * more weakly; see that file.
 */

export type ApiCategory =
	| "Accounts"
	| "Agents"
	| "API keys"
	| "Combos"
	| "Config"
	| "Debug"
	| "Insights"
	| "Logs"
	| "Maintenance"
	| "Meta"
	| "Models"
	| "OAuth"
	| "Projects"
	| "Requests"
	| "Stats"
	| "System";

export interface ApiRoute {
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	/** Path template. `:name` marks a path parameter the caller must fill. */
	path: string;
	category: ApiCategory;
	/** One line on what the route does. */
	summary: string;
	/**
	 * Server-Sent Events. The playground reads these incrementally and never
	 * waits for the response to finish.
	 */
	stream?: boolean;
	/**
	 * Irreversible, or disruptive enough that a mis-click costs real work.
	 * The playground makes the caller type CONFIRM before it fires.
	 */
	dangerous?: boolean;
	/**
	 * Shown above the body editor where the expected shape is not obvious
	 * from the path.
	 */
	bodyHint?: string;
	/** Query parameters the handler reads, for the query builder. */
	query?: string[];
	/**
	 * Shown as a warning on the route itself. Used for the routes whose name
	 * misdescribes them.
	 */
	note?: string;
}

/** A path parameter placeholder, e.g. `:id` in `/api/projects/:id`. */
export function pathParams(path: string): string[] {
	return path
		.split("/")
		.filter((segment) => segment.startsWith(":"))
		.map((segment) => segment.slice(1));
}

/** Substitute `:param` placeholders with caller-supplied values. */
export function fillPath(path: string, values: Record<string, string>): string {
	return path
		.split("/")
		.map((segment) =>
			segment.startsWith(":")
				? encodeURIComponent(values[segment.slice(1)] ?? "")
				: segment,
		)
		.join("/");
}

/** Every route is mutating unless it is a GET. */
export function isMutating(route: ApiRoute): boolean {
	return route.method !== "GET";
}

export const API_ROUTES: ApiRoute[] = [
	// ---------------------------------------------------------------- System
	{
		method: "GET",
		path: "/health",
		category: "System",
		summary: "Liveness of the proxy process itself.",
		note: "Not a check of account health. The only statically auth-exempt route.",
	},
	{
		method: "GET",
		path: "/api/system/info",
		category: "System",
		summary: "Host, runtime and build information.",
	},
	{
		method: "GET",
		path: "/api/version/check",
		category: "System",
		summary: "Latest published version. Auth-exempt, read-only.",
	},
	{
		method: "GET",
		path: "/api/version/status",
		category: "System",
		summary: "This build against upstream and the fork's own releases.",
		query: ["refresh"],
	},
	{
		method: "GET",
		path: "/api/storage",
		category: "System",
		summary: "Database and WAL size, plus the last integrity check.",
	},
	{
		method: "GET",
		path: "/api/service-status",
		category: "System",
		summary:
			"Claude service status, filtered to the components this proxy forwards to. Always 200.",
		query: ["refresh"],
	},
	{
		method: "POST",
		path: "/api/storage/integrity/check",
		category: "System",
		summary: "Run an integrity check over the database.",
		bodyHint: '{ "kind": "quick" | "full" }',
	},
	{
		method: "GET",
		path: "/api/aws/profiles",
		category: "System",
		summary: "AWS profiles available for Bedrock accounts.",
	},
	{
		method: "GET",
		path: "/api/workspaces",
		category: "System",
		summary: "Agent workspaces discovered on disk.",
	},

	// ----------------------------------------------------------------- Stats
	{
		method: "GET",
		path: "/api/stats",
		category: "Stats",
		summary: "Aggregate request statistics with per-account rows.",
		query: ["errorsSinceHours"],
	},
	{
		method: "POST",
		path: "/api/stats/reset",
		category: "Stats",
		summary: "Clear all accumulated statistics.",
		dangerous: true,
	},
	{
		method: "GET",
		path: "/api/analytics",
		category: "Stats",
		summary: "Time-bucketed analytics series.",
		query: ["range", "bucket", "model", "accountId", "projectId"],
	},
	{
		method: "GET",
		path: "/api/usage-history",
		category: "Stats",
		summary: "Token and cost usage over time.",
		query: ["range", "accountId"],
	},
	{
		method: "GET",
		path: "/api/routing/observations",
		category: "Stats",
		summary: "What the load balancer observed when routing.",
	},

	// -------------------------------------------------------------- Accounts
	{
		method: "GET",
		path: "/api/accounts",
		category: "Accounts",
		summary: "Every configured account with its live state.",
	},
	{
		method: "POST",
		path: "/api/accounts",
		category: "Accounts",
		summary: "Add an account (generic entry point).",
		bodyHint: "Provider-specific. See the per-provider routes below.",
	},
	{
		method: "POST",
		path: "/api/accounts/zai",
		category: "Accounts",
		summary: "Add a Z.ai account.",
	},
	{
		method: "POST",
		path: "/api/accounts/minimax",
		category: "Accounts",
		summary: "Add a MiniMax account.",
	},
	{
		method: "POST",
		path: "/api/accounts/deepseek",
		category: "Accounts",
		summary: "Add a DeepSeek account.",
	},
	{
		method: "POST",
		path: "/api/accounts/vertex-ai",
		category: "Accounts",
		summary: "Add a Google Vertex AI account.",
	},
	{
		method: "POST",
		path: "/api/accounts/bedrock",
		category: "Accounts",
		summary: "Add an AWS Bedrock account.",
	},
	{
		method: "POST",
		path: "/api/accounts/alibaba-coding-plan",
		category: "Accounts",
		summary: "Add an Alibaba coding-plan account.",
	},
	{
		method: "POST",
		path: "/api/accounts/kilo",
		category: "Accounts",
		summary: "Add a Kilo account.",
	},
	{
		method: "POST",
		path: "/api/accounts/openrouter",
		category: "Accounts",
		summary: "Add an OpenRouter account.",
	},
	{
		method: "POST",
		path: "/api/accounts/nanogpt",
		category: "Accounts",
		summary: "Add a NanoGPT account.",
	},
	{
		method: "POST",
		path: "/api/accounts/anthropic-compatible",
		category: "Accounts",
		summary: "Add an Anthropic-compatible endpoint.",
	},
	{
		method: "POST",
		path: "/api/accounts/ollama",
		category: "Accounts",
		summary: "Add a local Ollama account.",
	},
	{
		method: "POST",
		path: "/api/accounts/ollama-cloud",
		category: "Accounts",
		summary: "Add an Ollama Cloud account.",
	},
	{
		method: "POST",
		path: "/api/accounts/openai-compatible",
		category: "Accounts",
		summary: "Add an OpenAI-compatible endpoint.",
	},
	{
		method: "POST",
		path: "/api/accounts/meta",
		category: "Accounts",
		summary: "Add a Meta account.",
	},
	{
		method: "PATCH",
		path: "/api/accounts/:accountId",
		category: "Accounts",
		summary: "Update an account's provider settings.",
	},
	{
		method: "DELETE",
		path: "/api/accounts/:accountId",
		category: "Accounts",
		summary: "Remove an account and its stored credentials.",
		dangerous: true,
	},
	{
		method: "POST",
		path: "/api/accounts/:accountId/pause",
		category: "Accounts",
		summary: "Stop routing new requests to this account.",
	},
	{
		method: "POST",
		path: "/api/accounts/:accountId/resume",
		category: "Accounts",
		summary: "Resume routing to a paused account.",
	},
	{
		method: "POST",
		path: "/api/accounts/:accountId/reload",
		category: "Accounts",
		summary: "Reload the account's stored configuration.",
	},
	{
		method: "POST",
		path: "/api/accounts/:accountId/refresh-usage",
		category: "Accounts",
		summary: "Force a usage poll and token refresh.",
	},
	{
		method: "POST",
		path: "/api/accounts/:accountId/force-reset-rate-limit",
		category: "Accounts",
		summary: "Clear a recorded rate limit before it expires.",
	},
	{
		method: "POST",
		path: "/api/accounts/:accountId/rename",
		category: "Accounts",
		summary: "Rename an account.",
		bodyHint: '{ "name": "new-name" }',
	},
	{
		method: "POST",
		path: "/api/accounts/:accountId/priority",
		category: "Accounts",
		summary: "Set the account's routing priority.",
		bodyHint: '{ "priority": 0 }',
	},
	{
		method: "POST",
		path: "/api/accounts/:accountId/auto-fallback",
		category: "Accounts",
		summary: "Toggle automatic fallback for this account.",
	},
	{
		method: "POST",
		path: "/api/accounts/:accountId/auto-pause-on-overage",
		category: "Accounts",
		summary: "Toggle auto-pause when the account goes over quota.",
	},
	{
		method: "POST",
		path: "/api/accounts/:accountId/peak-hours-pause",
		category: "Accounts",
		summary: "Toggle peak-hours pausing. Z.ai accounts only.",
	},
	{
		method: "POST",
		path: "/api/accounts/:accountId/billing-type",
		category: "Accounts",
		summary: "Set the account's billing type.",
	},
	{
		method: "POST",
		path: "/api/accounts/:accountId/auto-refresh",
		category: "Accounts",
		summary: "Toggle automatic token refresh.",
	},
	{
		method: "POST",
		path: "/api/accounts/:accountId/custom-endpoint",
		category: "Accounts",
		summary: "Point the account at a custom base URL.",
	},
	{
		method: "POST",
		path: "/api/accounts/:accountId/model-mappings",
		category: "Accounts",
		summary: "Replace the account's model mappings.",
	},
	{
		method: "POST",
		path: "/api/accounts/:accountId/request-transformer",
		category: "Accounts",
		summary: "Set the account's request transformer.",
	},
	{
		method: "POST",
		path: "/api/accounts/:accountId/model-fallbacks",
		category: "Accounts",
		summary: "Replace the account's model fallbacks.",
	},
	{
		method: "GET",
		path: "/api/token-health",
		category: "Accounts",
		summary: "OAuth token expiry across all accounts.",
	},
	{
		method: "GET",
		path: "/api/token-health/reauth-needed",
		category: "Accounts",
		summary: "Accounts whose tokens need re-authentication.",
	},
	{
		method: "GET",
		path: "/api/token-health/account/:accountName",
		category: "Accounts",
		summary: "OAuth token health for one account, by name.",
	},
	{
		method: "GET",
		path: "/api/sessions/:sessionId/account",
		category: "Accounts",
		summary: "Which account served a session. Auth-exempt, GET only.",
	},

	// ----------------------------------------------------------------- OAuth
	{
		method: "POST",
		path: "/api/oauth/init",
		category: "OAuth",
		summary: "Begin an OAuth flow and get the authorize URL.",
	},
	{
		method: "POST",
		path: "/api/oauth/callback",
		category: "OAuth",
		summary: "Exchange an OAuth code for stored tokens.",
	},
	{
		method: "POST",
		path: "/api/oauth/qwen/init",
		category: "OAuth",
		summary: "Begin the Qwen device flow.",
	},
	{
		method: "POST",
		path: "/api/oauth/qwen/reauth",
		category: "OAuth",
		summary: "Re-authenticate an existing Qwen account.",
	},
	{
		method: "GET",
		path: "/api/oauth/qwen/status/:sessionId",
		category: "OAuth",
		summary: "Poll a Qwen device-flow session. Auth-exempt, read-only.",
	},
	{
		method: "POST",
		path: "/api/oauth/codex/init",
		category: "OAuth",
		summary: "Begin the Codex device flow.",
	},
	{
		method: "POST",
		path: "/api/oauth/codex/reauth",
		category: "OAuth",
		summary: "Re-authenticate an existing Codex account.",
	},
	{
		method: "GET",
		path: "/api/oauth/codex/status/:sessionId",
		category: "OAuth",
		summary: "Poll a Codex device-flow session. Auth-exempt, read-only.",
	},
	{
		method: "POST",
		path: "/api/oauth/anthropic/reauth/init",
		category: "OAuth",
		summary: "Begin Anthropic re-authentication.",
	},
	{
		method: "POST",
		path: "/api/oauth/anthropic/reauth/callback",
		category: "OAuth",
		summary: "Complete Anthropic re-authentication.",
	},

	// -------------------------------------------------------------- Requests
	{
		method: "GET",
		path: "/api/requests",
		category: "Requests",
		summary: "Recent requests, newest first.",
		query: ["limit", "offset", "accountId", "projectId", "model", "status"],
	},
	{
		method: "GET",
		path: "/api/requests/detail",
		category: "Requests",
		summary: "Requests with their full metadata.",
		query: ["limit", "offset"],
	},
	{
		method: "GET",
		path: "/api/requests/payload/:requestId",
		category: "Requests",
		summary: "Stored request and response payload for one request.",
	},
	{
		method: "GET",
		path: "/api/requests/stream",
		category: "Requests",
		summary: "Live request events.",
		stream: true,
	},

	// ------------------------------------------------------------------ Logs
	{
		method: "GET",
		path: "/api/logs/history",
		category: "Logs",
		summary: "Buffered recent log lines.",
	},
	{
		method: "GET",
		path: "/api/logs/stream",
		category: "Logs",
		summary: "Live application logs.",
		stream: true,
	},
	{
		method: "POST",
		path: "/api/logs/stream/token",
		category: "Logs",
		summary:
			"Mint a short-lived stream token. Handled inline in handleRequest, not via the handlers map.",
	},

	// ---------------------------------------------------------------- Config
	{
		method: "GET",
		path: "/api/config",
		category: "Config",
		summary: "The whole runtime configuration.",
	},
	{
		method: "GET",
		path: "/api/strategies",
		category: "Config",
		summary: "Load-balancing strategies available.",
	},
	{
		method: "GET",
		path: "/api/config/strategy",
		category: "Config",
		summary: "The active load-balancing strategy.",
	},
	{
		method: "POST",
		path: "/api/config/strategy",
		category: "Config",
		summary: "Set the load-balancing strategy.",
		bodyHint: '{ "strategy": "session" }',
	},
	{
		method: "GET",
		path: "/api/config/model",
		category: "Config",
		summary: "The default model.",
	},
	{
		method: "POST",
		path: "/api/config/model",
		category: "Config",
		summary: "Set the default model.",
	},
	{
		method: "GET",
		path: "/api/config/retention",
		category: "Config",
		summary: "How long request rows are kept.",
	},
	{
		method: "POST",
		path: "/api/config/retention",
		category: "Config",
		summary: "Set the retention window.",
	},
	{
		method: "GET",
		path: "/api/config/request-storage",
		category: "Config",
		summary: "Whether request and response payloads are stored.",
	},
	{
		method: "POST",
		path: "/api/config/request-storage",
		category: "Config",
		summary: "Turn payload storage on or off.",
	},
	{
		method: "GET",
		path: "/api/config/keepalive",
		category: "Config",
		summary: "Cache keep-alive settings.",
	},
	{
		method: "POST",
		path: "/api/config/keepalive",
		category: "Config",
		summary: "Change cache keep-alive settings.",
	},
	{
		method: "GET",
		path: "/api/config/cache-ttl",
		category: "Config",
		summary: "Prompt cache TTL.",
	},
	{
		method: "POST",
		path: "/api/config/cache-ttl",
		category: "Config",
		summary: "Set the prompt cache TTL.",
	},
	{
		method: "GET",
		path: "/api/config/usage-throttling",
		category: "Config",
		summary: "Usage throttling settings.",
	},
	{
		method: "POST",
		path: "/api/config/usage-throttling",
		category: "Config",
		summary: "Change usage throttling.",
	},
	{
		method: "GET",
		path: "/api/config/postgres",
		category: "Config",
		summary: "Postgres connection settings. The password is never returned.",
	},
	{
		method: "POST",
		path: "/api/config/postgres",
		category: "Config",
		summary: "Set Postgres connection settings.",
		bodyHint:
			"Carries pg_password. The playground never logs a request body — see the PR body.",
	},
	{
		method: "GET",
		path: "/api/config/provider-model-defaults",
		category: "Config",
		summary: "Per-provider default models.",
	},
	{
		method: "POST",
		path: "/api/config/provider-model-defaults",
		category: "Config",
		summary: "Set per-provider default models.",
	},
	{
		method: "GET",
		path: "/api/config/model-capacity-routing",
		category: "Config",
		summary: "Whether routing considers model capacity.",
	},
	{
		method: "POST",
		path: "/api/config/model-capacity-routing",
		category: "Config",
		summary: "Toggle model-capacity routing.",
	},
	{
		method: "GET",
		path: "/api/config/combos-enabled",
		category: "Config",
		summary: "Whether combos are enabled.",
	},
	{
		method: "POST",
		path: "/api/config/combos-enabled",
		category: "Config",
		summary: "Enable or disable combos.",
	},
	{
		method: "GET",
		path: "/api/config/combo-session-fallback",
		category: "Config",
		summary: "Combo session fallback behaviour.",
	},
	{
		method: "POST",
		path: "/api/config/combo-session-fallback",
		category: "Config",
		summary: "Set combo session fallback behaviour.",
	},
	{
		method: "GET",
		path: "/api/config/force-account-model",
		category: "Config",
		summary: "Whether an account's model overrides the request's.",
	},
	{
		method: "POST",
		path: "/api/config/force-account-model",
		category: "Config",
		summary: "Toggle account model forcing.",
	},
	{
		method: "GET",
		path: "/api/config/github-token",
		category: "Config",
		summary: "Whether a GitHub token is stored. The token is never returned.",
	},
	{
		method: "POST",
		path: "/api/config/github-token",
		category: "Config",
		summary: "Store a GitHub token.",
		bodyHint:
			"Carries a credential. The playground never logs a request body — see the PR body.",
	},
	{
		method: "GET",
		path: "/api/config/upstream-maintainer",
		category: "Config",
		summary: "The upstream maintainer App's configuration.",
	},
	{
		method: "GET",
		path: "/api/config/openobserve",
		category: "Config",
		summary: "OpenObserve settings. The token is never returned.",
	},
	{
		method: "POST",
		path: "/api/config/openobserve",
		category: "Config",
		summary: "Set OpenObserve settings.",
		bodyHint:
			"Carries openobserve_token. The playground never logs a request body — see the PR body.",
	},
	{
		method: "GET",
		path: "/api/config/retry",
		category: "Config",
		summary:
			"Upstream retry settings, the bounds the write enforces, and whether a restart is needed.",
	},
	{
		method: "POST",
		path: "/api/config/retry",
		category: "Config",
		summary:
			"Set retry_attempts, retry_delay_ms and retry_backoff. Out-of-range values are rejected.",
	},

	// ----------------------------------------------------------- Maintenance
	{
		method: "POST",
		path: "/api/admin/restart",
		category: "Maintenance",
		summary: "Restart the server process.",
		dangerous: true,
	},
	{
		method: "POST",
		path: "/api/admin/self-update",
		category: "Maintenance",
		summary: "Download and install a new version, then restart.",
		dangerous: true,
	},
	{
		method: "POST",
		path: "/api/maintenance/cleanup",
		category: "Maintenance",
		summary: "Delete rows past the retention window.",
		dangerous: true,
	},
	{
		method: "POST",
		path: "/api/upstream/sync-dispatch",
		category: "Maintenance",
		summary: "Trigger an upstream sync run on GitHub.",
		dangerous: true,
	},

	// -------------------------------------------------------------- Insights
	{
		method: "GET",
		path: "/api/insights/cache",
		category: "Insights",
		summary: "Prompt cache hit rates and savings.",
		query: ["range"],
	},
	{
		method: "GET",
		path: "/api/insights/anomalies",
		category: "Insights",
		summary: "Detected anomalies in traffic or cost.",
		query: ["range"],
	},
	{
		method: "GET",
		path: "/api/insights/context",
		category: "Insights",
		summary: "Context-window pressure across requests.",
		query: ["range"],
	},
	{
		method: "GET",
		path: "/api/insights/alerts",
		category: "Insights",
		summary: "Raised alerts and the unacknowledged count.",
		query: ["limit"],
	},
	{
		method: "POST",
		path: "/api/insights/alerts",
		category: "Insights",
		summary: "Update the alert configuration.",
	},
	{
		method: "GET",
		path: "/api/insights/alerts/config",
		category: "Insights",
		summary: "The current alert thresholds.",
	},
	{
		method: "POST",
		path: "/api/insights/alerts/acknowledge-all",
		category: "Insights",
		summary: "Acknowledge every outstanding alert.",
	},
	{
		method: "POST",
		path: "/api/insights/alerts/:alertId",
		category: "Insights",
		summary: "Acknowledge one alert by id.",
	},
	{
		method: "GET",
		path: "/api/insights/alerts/stream",
		category: "Insights",
		summary: "Live alert events.",
		stream: true,
	},

	// ---------------------------------------------------------------- Agents
	{
		method: "GET",
		path: "/api/agents",
		category: "Agents",
		summary: "Agents from every workspace, global and plugin source.",
	},
	{
		method: "PATCH",
		path: "/api/agents/:agentId",
		category: "Agents",
		summary: "Update one agent.",
	},
	{
		method: "POST",
		path: "/api/agents/:agentId/preference",
		category: "Agents",
		summary: "Pin a model preference for one agent.",
		bodyHint: '{ "model": "claude-opus-5" }',
	},
	{
		method: "DELETE",
		path: "/api/agents/:agentId/preference",
		category: "Agents",
		summary: "Revert the agent to its frontmatter default.",
	},
	{
		method: "POST",
		path: "/api/agents/bulk-preference",
		category: "Agents",
		summary: "Set a model preference across many agents at once.",
	},

	// -------------------------------------------------------------- API keys
	{
		method: "GET",
		path: "/api/api-keys",
		category: "API keys",
		summary: "Every API key, without its secret.",
	},
	{
		method: "POST",
		path: "/api/api-keys",
		category: "API keys",
		summary: "Generate a new API key. The secret is shown once.",
		bodyHint: '{ "name": "my-key", "role": "admin" | "api-only" }',
	},
	{
		method: "GET",
		path: "/api/api-keys/stats",
		category: "API keys",
		summary: "Per-key usage counters.",
	},
	{
		method: "PATCH",
		path: "/api/api-keys/:keyIdOrName/role",
		category: "API keys",
		summary: "Change a key's role. Requires an admin key.",
		bodyHint: '{ "role": "admin" | "api-only" }',
	},
	{
		method: "POST",
		path: "/api/api-keys/:keyIdOrName/disable",
		category: "API keys",
		summary: "Disable a key without deleting it.",
	},
	{
		method: "POST",
		path: "/api/api-keys/:keyIdOrName/enable",
		category: "API keys",
		summary: "Re-enable a disabled key.",
	},
	{
		method: "DELETE",
		path: "/api/api-keys/:keyIdOrName",
		category: "API keys",
		summary: "Delete a key permanently.",
		dangerous: true,
	},

	// -------------------------------------------------------------- Projects
	{
		method: "GET",
		path: "/api/projects",
		category: "Projects",
		summary: "Projects, optionally as a tree.",
		query: ["tree"],
	},
	{
		method: "POST",
		path: "/api/projects",
		category: "Projects",
		summary: "Create a project.",
	},
	{
		method: "POST",
		path: "/api/projects/discover",
		category: "Projects",
		summary: "Scan disk for projects and worktrees.",
	},
	{
		method: "GET",
		path: "/api/projects/:projectId",
		category: "Projects",
		summary: "One project.",
	},
	{
		method: "PATCH",
		path: "/api/projects/:projectId",
		category: "Projects",
		summary: "Update a project.",
	},
	{
		method: "DELETE",
		path: "/api/projects/:projectId",
		category: "Projects",
		summary: "Delete a project.",
		dangerous: true,
	},
	{
		method: "GET",
		path: "/api/worktree-rules",
		category: "Projects",
		summary: "Rules that map worktree paths to projects.",
	},
	{
		method: "POST",
		path: "/api/worktree-rules",
		category: "Projects",
		summary: "Create a worktree rule.",
	},
	{
		method: "POST",
		path: "/api/worktree-rules/test",
		category: "Projects",
		summary: "Test a rule against a path without saving it.",
		bodyHint: '{ "pattern": "...", "path": "/Users/..." }',
	},
	{
		method: "PATCH",
		path: "/api/worktree-rules/:ruleId",
		category: "Projects",
		summary: "Update a worktree rule.",
	},
	{
		method: "DELETE",
		path: "/api/worktree-rules/:ruleId",
		category: "Projects",
		summary: "Delete a worktree rule.",
	},

	// ---------------------------------------------------------------- Combos
	{
		method: "GET",
		path: "/api/combos",
		category: "Combos",
		summary: "Every combo with its slots.",
	},
	{
		method: "POST",
		path: "/api/combos",
		category: "Combos",
		summary: "Create a combo.",
	},
	{
		method: "GET",
		path: "/api/combos/:comboId",
		category: "Combos",
		summary: "One combo.",
	},
	{
		method: "PUT",
		path: "/api/combos/:comboId",
		category: "Combos",
		summary: "Replace a combo.",
	},
	{
		method: "DELETE",
		path: "/api/combos/:comboId",
		category: "Combos",
		summary: "Delete a combo.",
		dangerous: true,
	},
	{
		method: "POST",
		path: "/api/combos/:comboId/slots",
		category: "Combos",
		summary: "Add a slot to a combo.",
	},
	{
		method: "PUT",
		path: "/api/combos/:comboId/slots/reorder",
		category: "Combos",
		summary: "Reorder a combo's slots.",
	},
	{
		method: "PUT",
		path: "/api/combos/:comboId/slots/:slotId",
		category: "Combos",
		summary: "Update one slot.",
	},
	{
		method: "DELETE",
		path: "/api/combos/:comboId/slots/:slotId",
		category: "Combos",
		summary: "Remove one slot.",
	},
	{
		method: "GET",
		path: "/api/families",
		category: "Combos",
		summary: "Model families and their combo assignments.",
	},
	{
		method: "PUT",
		path: "/api/families/:family",
		category: "Combos",
		summary: "Assign a combo to a model family.",
	},

	// ---------------------------------------------------------------- Models
	{
		method: "GET",
		path: "/api/models",
		category: "Models",
		summary: "The model catalog.",
		query: ["provider", "refresh"],
	},
	{
		method: "POST",
		path: "/api/models/refresh",
		category: "Models",
		summary: "Re-fetch the catalog from every provider.",
	},
	{
		method: "POST",
		path: "/api/models/preview",
		category: "Models",
		summary: "Preview how a model string resolves, without routing.",
	},

	// ------------------------------------------------------------------ Meta
	{
		method: "GET",
		path: "/api/meta/routes",
		category: "Meta",
		summary: "This catalog, served by the server itself.",
		note: "Dynamic routes are returned with their `:param` placeholders intact, exactly as they appear here.",
	},

	// ----------------------------------------------------------------- Debug
	{
		method: "GET",
		path: "/api/debug/heap",
		category: "Debug",
		summary: "V8 heap statistics.",
	},
	{
		method: "GET",
		path: "/api/debug/rss",
		category: "Debug",
		summary: "Resident set size of the process.",
	},
	{
		method: "GET",
		path: "/api/debug/snapshot",
		category: "Debug",
		summary: "Write a heap snapshot.",
		note: "The response can be very large. The playground shows headers and a size instead of the body.",
	},
];

export const API_CATEGORIES: ApiCategory[] = [
	"System",
	"Stats",
	"Accounts",
	"OAuth",
	"Requests",
	"Logs",
	"Config",
	"Maintenance",
	"Insights",
	"Agents",
	"API keys",
	"Projects",
	"Combos",
	"Models",
	"Meta",
	"Debug",
];
