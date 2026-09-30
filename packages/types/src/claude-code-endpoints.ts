/**
 * Claude Code project endpoints: OpenAI-compatible endpoints answered by
 * running the host's own `claude` CLI (`claude -p`) inside a project
 * directory, instead of forwarding to an account in the pool.
 *
 * A client uses `http(s)://<host>/<name>/v1` as its base URL, exactly like a
 * named gateway's short form, and calls `POST /chat/completions` and
 * `GET /models` under it. better-ccflare does not choose credentials for the
 * child process: the CLI authenticates however the host has it configured.
 *
 * Endpoint names share the `/<name>/v1` namespace with `openai_gateways`, so a
 * name may not exist in both. The API handlers refuse a collision in either
 * direction.
 */
import {
	isValidOpenAIGatewayName,
	RESERVED_GATEWAY_ALIAS_NAMES,
} from "./openai-gateways";

export const CLAUDE_CODE_ENDPOINTS_CONFIG_KEY = "claude_code_endpoints";

/** Environment override for the CLI binary, used by tests and odd installs. */
export const CLAUDE_CODE_BIN_ENV = "BETTER_CCFLARE_CLAUDE_BIN";

/** Values accepted by `claude --permission-mode`. */
export const CLAUDE_CODE_PERMISSION_MODES = [
	"default",
	"acceptEdits",
	"plan",
	"bypassPermissions",
] as const;
export type ClaudeCodePermissionMode =
	(typeof CLAUDE_CODE_PERMISSION_MODES)[number];

/**
 * The model id `default` means "pass no --model": the CLI uses whatever the
 * host's Claude Code is configured to use.
 */
export const CLAUDE_CODE_DEFAULT_MODEL_ID = "default";

export const DEFAULT_CLAUDE_CODE_MODELS: readonly string[] = [
	CLAUDE_CODE_DEFAULT_MODEL_ID,
	"opus",
	"sonnet",
	"haiku",
];

export const DEFAULT_CLAUDE_CODE_PERMISSION_MODE: ClaudeCodePermissionMode =
	"bypassPermissions";
export const DEFAULT_CLAUDE_CODE_MAX_CONCURRENCY = 2;
export const DEFAULT_CLAUDE_CODE_TIMEOUT_MS = 10 * 60 * 1000;

export const MAX_CLAUDE_CODE_CONCURRENCY = 16;
export const MIN_CLAUDE_CODE_TIMEOUT_MS = 10_000;
export const MAX_CLAUDE_CODE_TIMEOUT_MS = 60 * 60 * 1000;
export const MAX_CLAUDE_CODE_EXTRA_ARGS = 32;
export const MAX_CLAUDE_CODE_MODELS = 32;

/** As stored under `claude_code_endpoints.<name>` in the config file. */
export interface ClaudeCodeEndpointConfig {
	/** Absolute path to an existing directory on the host. Required. */
	directory: string;
	description?: string;
	/** Model ids offered by `GET /models` and accepted by chat. */
	models?: string[];
	/** Passed as `--permission-mode`. */
	permission_mode?: ClaudeCodePermissionMode;
	/**
	 * Extra CLI arguments appended verbatim (e.g. `["--bare"]`,
	 * `["--allowedTools", "Read"]`). Never passed through a shell.
	 */
	extra_args?: string[];
	/** Concurrent `claude` processes for this endpoint; excess gets a 429. */
	max_concurrency?: number;
	/** Wall-clock limit per request; the process group is killed after it. */
	timeout_ms?: number;
}

/** Fully defaulted form used by the runner. */
export interface ResolvedClaudeCodeEndpoint {
	name: string;
	directory: string;
	description: string | null;
	models: string[];
	permission_mode: ClaudeCodePermissionMode;
	extra_args: string[];
	max_concurrency: number;
	timeout_ms: number;
}

export type ClaudeCodeEndpoints = Record<string, ClaudeCodeEndpointConfig>;

/** `GET /api/claude-code-endpoints` row. */
export interface ClaudeCodeEndpointListing extends ResolvedClaudeCodeEndpoint {
	/** Relative short base path, e.g. `/myproject/v1`. */
	base_path: string;
	/** Whether `directory` exists and is a directory right now. */
	directory_exists: boolean;
}

export type ClaudeCodeEndpointValidation =
	| { ok: true; value: ClaudeCodeEndpointConfig }
	| { ok: false; error: string };

/** Same name rules as gateways, and never a reserved first segment. */
export function isValidClaudeCodeEndpointName(name: unknown): name is string {
	return (
		isValidOpenAIGatewayName(name) && !RESERVED_GATEWAY_ALIAS_NAMES.has(name)
	);
}

export function resolveClaudeCodeEndpoint(
	name: string,
	config: ClaudeCodeEndpointConfig,
): ResolvedClaudeCodeEndpoint {
	return {
		name,
		directory: config.directory,
		description: config.description ?? null,
		models: config.models ?? [...DEFAULT_CLAUDE_CODE_MODELS],
		permission_mode:
			config.permission_mode ?? DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
		extra_args: config.extra_args ?? [],
		max_concurrency:
			config.max_concurrency ?? DEFAULT_CLAUDE_CODE_MAX_CONCURRENCY,
		timeout_ms: config.timeout_ms ?? DEFAULT_CLAUDE_CODE_TIMEOUT_MS,
	};
}

export function claudeCodeEndpointBasePath(name: string): string {
	return `/${name}/v1`;
}

/*
 * Implemented by lane A (config + API). Signatures are the contract; bodies
 * are filled in on that lane.
 *
 * validateClaudeCodeEndpointConfig(input: unknown): ClaudeCodeEndpointValidation
 *   Pure: shape and bounds only (directory must be an absolute path string;
 *   existence is checked by the API handler, not here, so config parsing at
 *   boot never touches the filesystem).
 *
 * parseClaudeCodeEndpoints(raw: unknown): { endpoints: ClaudeCodeEndpoints; errors: string[] }
 *   Mirrors parseOpenAIGateways: invalid entries are skipped with an error.
 */
