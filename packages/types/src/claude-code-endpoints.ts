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

const MAX_DIRECTORY_LENGTH = 4096;
const MAX_EXTRA_ARG_LENGTH = 1024;
const MAX_DESCRIPTION_LENGTH = 500;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;
/** POSIX absolute, or a Windows drive path. `node:path` stays out of this package: the dashboard bundles it. */
const ABSOLUTE_PATH_PATTERN = /^(\/|[A-Za-z]:[\\/])/;
const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
	"directory",
	"description",
	"models",
	"permission_mode",
	"extra_args",
	"max_concurrency",
	"timeout_ms",
]);

function refuse(error: string): ClaudeCodeEndpointValidation {
	return { ok: false, error };
}

/**
 * Validates one endpoint's configuration: shape and bounds only. Whether
 * `directory` exists is the API handler's question, so parsing the config at
 * boot never touches the filesystem. Unknown keys are refused rather than
 * dropped, so a typo such as `permission_modes` fails loudly instead of
 * silently producing an endpoint with the default (permissive) mode.
 */
export function validateClaudeCodeEndpointConfig(
	input: unknown,
): ClaudeCodeEndpointValidation {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		return refuse("endpoint config must be an object");
	}
	const record = input as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!ALLOWED_FIELDS.has(key)) {
			return refuse(`unknown endpoint field: ${key}`);
		}
	}

	const directory = record.directory;
	if (typeof directory !== "string" || directory.length === 0) {
		return refuse("directory is required and must be a string");
	}
	if (directory.length > MAX_DIRECTORY_LENGTH) {
		return refuse(`directory holds at most ${MAX_DIRECTORY_LENGTH} characters`);
	}
	if (directory.includes("\0")) {
		return refuse("directory must not contain a NUL character");
	}
	if (!ABSOLUTE_PATH_PATTERN.test(directory)) {
		return refuse(
			`directory must be an absolute path; got ${JSON.stringify(directory)}`,
		);
	}
	const value: ClaudeCodeEndpointConfig = { directory };

	if (record.description !== undefined) {
		if (typeof record.description !== "string") {
			return refuse("description must be a string");
		}
		if (record.description.length > MAX_DESCRIPTION_LENGTH) {
			return refuse(
				`description holds at most ${MAX_DESCRIPTION_LENGTH} characters`,
			);
		}
		value.description = record.description;
	}

	if (record.models !== undefined) {
		const raw = record.models;
		if (!Array.isArray(raw)) return refuse("models must be an array");
		if (raw.length === 0) {
			return refuse(
				"models must name at least one model; omit it to use the defaults",
			);
		}
		if (raw.length > MAX_CLAUDE_CODE_MODELS) {
			return refuse(`models holds at most ${MAX_CLAUDE_CODE_MODELS} entries`);
		}
		const seen = new Set<string>();
		for (const entry of raw) {
			if (typeof entry !== "string" || !MODEL_ID_PATTERN.test(entry)) {
				return refuse(
					`models entries must be model ids such as "sonnet"; got ${JSON.stringify(entry)}`,
				);
			}
			if (seen.has(entry)) {
				return refuse(`models entry ${entry} is listed twice`);
			}
			seen.add(entry);
		}
		value.models = [...seen];
	}

	if (record.permission_mode !== undefined) {
		const mode = record.permission_mode;
		if (
			typeof mode !== "string" ||
			!(CLAUDE_CODE_PERMISSION_MODES as readonly string[]).includes(mode)
		) {
			return refuse(
				`permission_mode must be one of ${CLAUDE_CODE_PERMISSION_MODES.join(", ")}; got ${JSON.stringify(mode)}`,
			);
		}
		value.permission_mode = mode as ClaudeCodePermissionMode;
	}

	if (record.extra_args !== undefined) {
		const raw = record.extra_args;
		if (!Array.isArray(raw)) return refuse("extra_args must be an array");
		if (raw.length > MAX_CLAUDE_CODE_EXTRA_ARGS) {
			return refuse(
				`extra_args holds at most ${MAX_CLAUDE_CODE_EXTRA_ARGS} entries`,
			);
		}
		for (const arg of raw) {
			if (typeof arg !== "string") {
				return refuse("extra_args entries must be strings");
			}
			if (arg.length > MAX_EXTRA_ARG_LENGTH) {
				return refuse(
					`extra_args entries hold at most ${MAX_EXTRA_ARG_LENGTH} characters`,
				);
			}
			if (arg.includes("\0")) {
				return refuse("extra_args entries must not contain a NUL character");
			}
		}
		value.extra_args = [...(raw as string[])];
	}

	if (record.max_concurrency !== undefined) {
		const n = record.max_concurrency;
		if (
			typeof n !== "number" ||
			!Number.isInteger(n) ||
			n < 1 ||
			n > MAX_CLAUDE_CODE_CONCURRENCY
		) {
			return refuse(
				`max_concurrency must be an integer from 1 to ${MAX_CLAUDE_CODE_CONCURRENCY}`,
			);
		}
		value.max_concurrency = n;
	}

	if (record.timeout_ms !== undefined) {
		const n = record.timeout_ms;
		if (
			typeof n !== "number" ||
			!Number.isInteger(n) ||
			n < MIN_CLAUDE_CODE_TIMEOUT_MS ||
			n > MAX_CLAUDE_CODE_TIMEOUT_MS
		) {
			return refuse(
				`timeout_ms must be an integer from ${MIN_CLAUDE_CODE_TIMEOUT_MS} to ${MAX_CLAUDE_CODE_TIMEOUT_MS}`,
			);
		}
		value.timeout_ms = n;
	}

	return { ok: true, value };
}

/**
 * Reads the stored map. An invalid entry is left out and reported in
 * `errors`, never repaired, so one bad endpoint cannot disable the others and
 * a caller can say exactly which one was skipped.
 */
export function parseClaudeCodeEndpoints(raw: unknown): {
	endpoints: ClaudeCodeEndpoints;
	errors: string[];
} {
	const endpoints: ClaudeCodeEndpoints = {};
	const errors: string[] = [];
	if (raw === undefined || raw === null) return { endpoints, errors };
	if (typeof raw !== "object" || Array.isArray(raw)) {
		errors.push(`${CLAUDE_CODE_ENDPOINTS_CONFIG_KEY} must be an object`);
		return { endpoints, errors };
	}
	for (const [name, config] of Object.entries(raw as Record<string, unknown>)) {
		if (!isValidClaudeCodeEndpointName(name)) {
			errors.push(`invalid endpoint name ${JSON.stringify(name)}`);
			continue;
		}
		const result = validateClaudeCodeEndpointConfig(config);
		if (!result.ok) {
			errors.push(`endpoint ${name}: ${result.error}`);
			continue;
		}
		endpoints[name] = result.value;
	}
	return { endpoints, errors };
}
