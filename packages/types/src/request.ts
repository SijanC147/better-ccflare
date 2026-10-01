/**
 * This module is deliberately import-free and is re-exported unchanged through
 * the package barrel. `@better-ccflare/types` has a documented runtime cycle
 * (`types/agent.ts` → core → `core/strategy.ts` → types, which evaluates
 * `Object.values(StrategyName)` at module scope), so evaluating the barrel
 * first crashes. Runtime consumers of the narrowing helpers below therefore
 * import them via the cycle-free `@better-ccflare/types/request` subpath
 * rather than the barrel.
 */

/**
 * What a request's `request_payloads` row carries, from the two switches that
 * decide it. `store_payloads` governs bodies; headers-only mode strips bodies
 * and keeps headers whether or not `store_payloads` is on.
 *
 * - `"full"`: headers, bodies and metadata (`store_payloads` on, headers-only off)
 * - `"headers"`: headers and metadata, no bodies (headers-only on)
 * - `"none"`: no row (both off)
 *
 * OpenObserve payload shipping is separate and not part of this value.
 */
export type PayloadPersistence = "full" | "headers" | "none";

export function resolvePayloadPersistence(
	storePayloads: boolean,
	headersOnly: boolean,
): PayloadPersistence {
	if (headersOnly) return "headers";
	return storePayloads ? "full" : "none";
}

export const PROJECT_ATTRIBUTION_SOURCES = [
	"header_project",
	"path_project",
	"heading_project",
	"none",
] as const;

export type ProjectAttributionSource =
	(typeof PROJECT_ATTRIBUTION_SOURCES)[number];

export const AGENT_ATTRIBUTION_SOURCES = [
	"header_agent",
	"session_header",
	"prompt_agent",
	"none",
] as const;

export type AgentAttributionSource = (typeof AGENT_ATTRIBUTION_SOURCES)[number];

/**
 * Narrow a raw `project_attribution_source` column value. Like every
 * provenance column this is TEXT with no database-side constraint, so a bare
 * `as` cast would hand consumers a value the type says cannot exist.
 * Unrecognized values become `undefined` — unlike the terminal state below,
 * this union already carries an explicit `"none"`, and the field is a
 * provenance label rather than the sole signal of an incomplete response.
 */
export function toProjectAttributionSource(
	value: unknown,
): ProjectAttributionSource | undefined {
	return typeof value === "string" &&
		(PROJECT_ATTRIBUTION_SOURCES as readonly string[]).includes(value)
		? (value as ProjectAttributionSource)
		: undefined;
}

/** Narrow a raw `agent_attribution_source` column value. See above. */
export function toAgentAttributionSource(
	value: unknown,
): AgentAttributionSource | undefined {
	return typeof value === "string" &&
		(AGENT_ATTRIBUTION_SOURCES as readonly string[]).includes(value)
		? (value as AgentAttributionSource)
		: undefined;
}

/**
 * Real outcome of an Anthropic-Messages-shaped SSE stream, as recorded in the
 * `stream_terminal_state` column. Distinct from `statusCode`, which only
 * reflects the upstream's opening handshake: a stream that dies mid-content or
 * is cancelled by the client still carries a 200. Absent for non-streaming
 * responses and for streams not wrapped by the terminal-recovery observer.
 *
 * The producer defines the same set as `AnthropicTerminalState` in
 * packages/proxy/src/anthropic-terminal-recovery.ts (which documents what each
 * state means); it cannot be imported here because types is the base package.
 */
export const STREAM_TERMINAL_STATES = [
	"complete",
	"recovered",
	"error",
	"truncated",
	"client_cancelled",
] as const;

export type StreamTerminalState = (typeof STREAM_TERMINAL_STATES)[number];

/**
 * What the API reports for a request: one of the known states, or `"unknown"`
 * when the column holds a value this build does not recognize.
 *
 * The distinction matters more here than for the provenance columns above.
 * `streamTerminalState` is the only field separating a stream that died
 * mid-content from a clean `statusCode: 200`, so collapsing an unrecognized
 * state into "nothing recorded" would make a NEW failure state — written by a
 * newer producer, or surviving a rollback — read as healthy. `"unknown"` says
 * "something terminated this stream and this build cannot name it", which is
 * the honest answer and still keeps consumers off a union member that does not
 * exist for them.
 */
export type ReportedStreamTerminalState = StreamTerminalState | "unknown";

/**
 * Narrow a raw `stream_terminal_state` column value. The column is TEXT and
 * the database enforces nothing, so a bare `as` cast would let a value from a
 * newer producer build — or a hand-edited row — reach consumers while the type
 * claims exhaustiveness.
 *
 * Absent (`null`/`undefined`/empty) stays `undefined` — no stream was observed.
 * A non-empty value outside the known set becomes `"unknown"` rather than
 * `undefined`, so version skew cannot make a failed stream look clean.
 */
export function toStreamTerminalState(
	value: unknown,
): ReportedStreamTerminalState | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	return (STREAM_TERMINAL_STATES as readonly string[]).includes(value)
		? (value as StreamTerminalState)
		: "unknown";
}

// Database row type
export interface RequestRow {
	id: string;
	timestamp: number;
	method: string;
	path: string;
	account_used: string | null;
	status_code: number | null;
	success: boolean | number;
	error_message: string | null;
	response_time_ms: number | null;
	failover_attempts: number;
	model: string | null;
	prompt_tokens: number | null;
	completion_tokens: number | null;
	total_tokens: number | null;
	cost_usd: number | null;
	input_tokens: number | null;
	cache_read_input_tokens: number | null;
	cache_creation_input_tokens: number | null;
	output_tokens: number | null;
	agent_used: string | null;
	output_tokens_per_second: number | null;
	project: string | null;
	project_id: string | null;
	worktree_path: string | null;
	api_key_id: string | null;
	api_key_name: string | null;
	billing_type: string | null;
	combo_name: string | null;
	original_model: string | null;
	applied_model: string | null;
	project_attribution_source: string | null;
	agent_attribution_source: string | null;
	client_session_id: string | null;
	stream_terminal_state: string | null;
	gateway_hint_request_class: string | null;
	gateway_hint_agent_type: string | null;
	gateway_hint_prev_tool_durations: string | null;
	gateway_hint_compaction: string | null;
	gateway_hint_context_compacted: string | null;
	inbound_format: string | null;
	inbound_gateway: string | null;
}

// Domain model
export interface Request {
	id: string;
	timestamp: number;
	method: string;
	path: string;
	accountUsed: string | null;
	statusCode: number | null;
	success: boolean;
	errorMessage: string | null;
	responseTimeMs: number | null;
	failoverAttempts: number;
	model?: string | undefined;
	promptTokens?: number | undefined;
	completionTokens?: number | undefined;
	totalTokens?: number | undefined;
	costUsd?: number | undefined;
	inputTokens?: number | undefined;
	cacheReadInputTokens?: number | undefined;
	cacheCreationInputTokens?: number | undefined;
	outputTokens?: number | undefined;
	agentUsed?: string | undefined;
	tokensPerSecond?: number | undefined;
	project?: string | null | undefined;
	projectId?: string | null | undefined;
	worktreePath?: string | null | undefined;
	apiKeyId?: string | undefined;
	apiKeyName?: string | undefined;
	billingType?: string | undefined;
	comboName?: string | undefined;
	originalModel?: string | undefined;
	appliedModel?: string | undefined;
	projectAttributionSource?: ProjectAttributionSource | undefined;
	agentAttributionSource?: AgentAttributionSource | undefined;
	clientSessionId?: string | undefined;
	streamTerminalState?: ReportedStreamTerminalState | undefined;
	/**
	 * Claude Code's opt-in "gateway hint" request headers (CLI >= 2.1.273,
	 * `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`). Pure observability metadata —
	 * absent for every client that doesn't send them, which is the normal
	 * case. See packages/proxy/src/gateway-hint-headers.ts for the producer.
	 */
	gatewayHintRequestClass?: string | undefined;
	gatewayHintAgentType?: string | undefined;
	gatewayHintPrevToolDurations?: string | undefined;
	gatewayHintCompaction?: string | undefined;
	gatewayHintContextCompacted?: string | undefined;
	/**
	 * The OpenAI-shaped API a translated request arrived on (`openai-chat` or
	 * `openai-responses`) and the named gateway it came through. Both absent
	 * for native Anthropic traffic, whose row path is the real one. See
	 * packages/proxy/src/inbound-marker.ts for the producer (SB23-2727).
	 */
	inboundFormat?: string | undefined;
	inboundGateway?: string | undefined;
}

// API response type
export interface RequestResponse {
	id: string;
	timestamp: string;
	method: string;
	path: string;
	accountUsed: string | null;
	statusCode: number | null;
	success: boolean;
	errorMessage: string | null;
	responseTimeMs: number | null;
	failoverAttempts: number;
	model?: string | undefined;
	promptTokens?: number | undefined;
	completionTokens?: number | undefined;
	totalTokens?: number | undefined;
	inputTokens?: number | undefined;
	cacheReadInputTokens?: number | undefined;
	cacheCreationInputTokens?: number | undefined;
	outputTokens?: number | undefined;
	costUsd?: number | undefined;
	agentUsed?: string | undefined;
	tokensPerSecond?: number | undefined;
	project?: string | null | undefined;
	projectId?: string | null | undefined;
	worktreePath?: string | null | undefined;
	apiKeyId?: string | undefined;
	apiKeyName?: string | undefined;
	billingType?: string | undefined;
	comboName?: string | undefined;
	originalModel?: string | undefined;
	appliedModel?: string | undefined;
	// Derived from statusCode === 429 server-side so the list view can render
	// the "Rate Limited" badge without lazy-loading the full payload.
	rateLimited?: boolean | undefined;
	projectAttributionSource?: ProjectAttributionSource | undefined;
	agentAttributionSource?: AgentAttributionSource | undefined;
	/**
	 * Client session id the request came from (body `metadata.user_id`).
	 * Lets a stored row be traced back to the session that produced it —
	 * without it, a session's own requests and those of its subagents are
	 * indistinguishable after the fact, since both share account and model.
	 */
	clientSessionId?: string | undefined;
	streamTerminalState?: ReportedStreamTerminalState | undefined;
	/** See the matching field on `Request` above. */
	gatewayHintRequestClass?: string | undefined;
	gatewayHintAgentType?: string | undefined;
	gatewayHintPrevToolDurations?: string | undefined;
	gatewayHintCompaction?: string | undefined;
	gatewayHintContextCompacted?: string | undefined;
	/** See the matching fields on `Request` above. */
	inboundFormat?: string | undefined;
	inboundGateway?: string | undefined;
}

// Detailed request with payload
export interface RequestPayload {
	id: string;
	request: {
		headers: Record<string, string>;
		body: string | null;
		truncated?: boolean;
	};
	response: {
		status: number;
		headers: Record<string, string>;
		body: string | null;
		truncated?: boolean;
	} | null;
	error?: string;
	meta: {
		accountId?: string;
		accountName?: string;
		retry?: number;
		timestamp: number;
		success?: boolean;
		accountsAttempted?: number;
		pending?: boolean;
		path?: string;
		method?: string;
		agentUsed?: string;
		agentAttributionSource?: AgentAttributionSource;
		project?: string | null;
		projectAttributionSource?: ProjectAttributionSource;
		projectId?: string | null;
		worktreePath?: string | null;
		requestBodyTruncated?: boolean;
		responseBodyTruncated?: boolean;
		limitApplied?: number;
		// True when the server (or client-side synthesis) returned this payload
		// without request/response bodies. Consumers that need bodies must
		// re-fetch via GET /api/requests/payload/:id.
		bodiesOmitted?: boolean;
		// True when a memory bound dropped captured body bytes while the request
		// was still active; the headers and metadata were kept and written.
		// Absent on a headers-only row, which never held a body.
		bodiesReleased?: boolean;
		// Mirror of RequestResponse.rateLimited so the list view can render
		// the "Rate Limited" badge from a summary-only payload (no body
		// hydration required).
		rateLimited?: boolean;
	};
}

// Type mappers
export function toRequest(row: RequestRow): Request {
	return {
		id: row.id,
		timestamp: Number(row.timestamp),
		method: row.method,
		path: row.path,
		accountUsed: row.account_used,
		statusCode: row.status_code != null ? Number(row.status_code) : null,
		success: !!row.success,
		errorMessage: row.error_message,
		responseTimeMs:
			row.response_time_ms != null ? Number(row.response_time_ms) : null,
		failoverAttempts: Number(row.failover_attempts) || 0,
		model: row.model || undefined,
		promptTokens:
			row.prompt_tokens != null ? Number(row.prompt_tokens) : undefined,
		completionTokens:
			row.completion_tokens != null ? Number(row.completion_tokens) : undefined,
		totalTokens:
			row.total_tokens != null ? Number(row.total_tokens) : undefined,
		costUsd: row.cost_usd != null ? Number(row.cost_usd) : undefined,
		inputTokens:
			row.input_tokens != null ? Number(row.input_tokens) : undefined,
		cacheReadInputTokens:
			row.cache_read_input_tokens != null
				? Number(row.cache_read_input_tokens)
				: undefined,
		cacheCreationInputTokens:
			row.cache_creation_input_tokens != null
				? Number(row.cache_creation_input_tokens)
				: undefined,
		outputTokens:
			row.output_tokens != null ? Number(row.output_tokens) : undefined,
		agentUsed: row.agent_used || undefined,
		tokensPerSecond:
			row.output_tokens_per_second != null
				? Number(row.output_tokens_per_second)
				: undefined,
		apiKeyId: row.api_key_id || undefined,
		apiKeyName: row.api_key_name || undefined,
		project: row.project,
		projectId: row.project_id ?? null,
		worktreePath: row.worktree_path ?? null,
		billingType: row.billing_type || undefined,
		comboName: row.combo_name || undefined,
		originalModel: row.original_model || undefined,
		appliedModel: row.applied_model || undefined,
		projectAttributionSource: toProjectAttributionSource(
			row.project_attribution_source,
		),
		agentAttributionSource: toAgentAttributionSource(
			row.agent_attribution_source,
		),
		clientSessionId: row.client_session_id || undefined,
		streamTerminalState: toStreamTerminalState(row.stream_terminal_state),
		gatewayHintRequestClass: row.gateway_hint_request_class || undefined,
		gatewayHintAgentType: row.gateway_hint_agent_type || undefined,
		gatewayHintPrevToolDurations:
			row.gateway_hint_prev_tool_durations || undefined,
		gatewayHintCompaction: row.gateway_hint_compaction || undefined,
		gatewayHintContextCompacted:
			row.gateway_hint_context_compacted || undefined,
		inboundFormat: row.inbound_format || undefined,
		inboundGateway: row.inbound_gateway || undefined,
	};
}

export function toRequestResponse(request: Request): RequestResponse {
	return {
		id: request.id,
		timestamp: new Date(request.timestamp).toISOString(),
		method: request.method,
		path: request.path,
		accountUsed: request.accountUsed,
		statusCode: request.statusCode,
		success: request.success,
		errorMessage: request.errorMessage,
		responseTimeMs: request.responseTimeMs,
		failoverAttempts: request.failoverAttempts,
		model: request.model,
		promptTokens: request.promptTokens,
		completionTokens: request.completionTokens,
		totalTokens: request.totalTokens,
		inputTokens: request.inputTokens,
		cacheReadInputTokens: request.cacheReadInputTokens,
		cacheCreationInputTokens: request.cacheCreationInputTokens,
		outputTokens: request.outputTokens,
		costUsd: request.costUsd,
		agentUsed: request.agentUsed,
		tokensPerSecond: request.tokensPerSecond,
		project: request.project,
		projectId: request.projectId ?? null,
		worktreePath: request.worktreePath ?? null,
		apiKeyId: request.apiKeyId,
		apiKeyName: request.apiKeyName,
		billingType: request.billingType,
		comboName: request.comboName,
		originalModel: request.originalModel,
		appliedModel: request.appliedModel,
		rateLimited: request.statusCode === 429,
		projectAttributionSource: request.projectAttributionSource,
		agentAttributionSource: request.agentAttributionSource,
		clientSessionId: request.clientSessionId,
		streamTerminalState: request.streamTerminalState,
		gatewayHintRequestClass: request.gatewayHintRequestClass,
		gatewayHintAgentType: request.gatewayHintAgentType,
		gatewayHintPrevToolDurations: request.gatewayHintPrevToolDurations,
		gatewayHintCompaction: request.gatewayHintCompaction,
		gatewayHintContextCompacted: request.gatewayHintContextCompacted,
		inboundFormat: request.inboundFormat,
		inboundGateway: request.inboundGateway,
	};
}

// Special account ID for requests without an account
export const NO_ACCOUNT_ID = "no_account";
