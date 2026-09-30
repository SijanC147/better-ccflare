/**
 * Named OpenAI-compatible gateways (SB23-2720).
 *
 * Each gateway is its own base URL, `/v1/gateways/<name>`, that a third-party
 * app configures as a custom OpenAI provider. The app then calls
 * `<base>/chat/completions` and `<base>/models`. The path stays under `/v1/`
 * on purpose: `auth-service.ts` lets an API-only key reach `/v1/*` and
 * `/messages/*` and nothing else, so any other prefix would refuse those keys.
 *
 * The plain `/v1/chat/completions` is the default gateway and applies no rules.
 *
 * Gateways live in the config file under `openai_gateways`. They are pure data
 * so that the server, which routes by them, and the HTTP API, which edits
 * them, validate with one function and cannot disagree.
 */

export const OPENAI_GATEWAYS_CONFIG_KEY = "openai_gateways";

/** Lowercase, digits, `-` and `_`, 1 to 64 characters, starting alphanumeric. */
export const OPENAI_GATEWAY_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * `anthropic-oauth` is Anthropic accounts holding a refresh token, leaving
 * Anthropic API-key accounts eligible. Any other value is matched against
 * `account.provider` exactly. This is the vocabulary of the existing
 * `x-better-ccflare-exclude-providers` header, honoured in
 * `packages/proxy/src/handlers/account-selector.ts`.
 */
export const ANTHROPIC_OAUTH_PROVIDER_KEY = "anthropic-oauth";

export interface OpenAIGatewayConfig {
	/** Providers this gateway never routes to. Empty or absent means none. */
	exclude_providers?: string[];
	/** Free text shown in listings. */
	description?: string;
	/**
	 * The gateway's model set. When present, the gateway serves exactly these
	 * ids: `GET <gateway>/models` lists their names, and a chat request naming
	 * any other model is refused rather than routed. Absent means the gateway
	 * passes the client's model through, as before.
	 */
	models?: OpenAIGatewayModelEntry[];
}

/**
 * One model a gateway exposes. `name` is the id the client sends and sees;
 * `model` is the upstream id every account is asked for; `combo` optionally
 * names a combo whose slots are the fallback ladder for this entry, in slot
 * priority order. Without a combo, the request goes to any account that can
 * serve `model`, so a GPT id reaches only accounts whose listing carries it.
 */
export interface OpenAIGatewayModelEntry {
	name: string;
	model: string;
	combo?: string;
}

export type OpenAIGateways = Record<string, OpenAIGatewayConfig>;

export interface OpenAIGatewayListing {
	name: string;
	/** Relative to the server origin, e.g. `/v1/gateways/work`. */
	base_path: string;
	exclude_providers: string[];
	description: string | null;
	models: OpenAIGatewayModelEntry[];
}

const PROVIDER_VALUE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const MAX_EXCLUDED_PROVIDERS = 32;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_GATEWAY_MODELS = 64;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const MAX_COMBO_NAME_LENGTH = 128;

export type OpenAIGatewayValidation =
	| { ok: true; value: OpenAIGatewayConfig }
	| { ok: false; error: string };

export function isValidOpenAIGatewayName(name: unknown): name is string {
	return typeof name === "string" && OPENAI_GATEWAY_NAME_PATTERN.test(name);
}

/**
 * Validates one gateway's configuration. Unknown keys are refused rather than
 * dropped, so a typo such as `exclude_provider` fails loudly instead of
 * silently producing a gateway with no rules.
 */
export function validateOpenAIGatewayConfig(
	input: unknown,
): OpenAIGatewayValidation {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		return { ok: false, error: "gateway config must be an object" };
	}
	const record = input as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (
			key !== "exclude_providers" &&
			key !== "description" &&
			key !== "models"
		) {
			return { ok: false, error: `unknown gateway field: ${key}` };
		}
	}

	const value: OpenAIGatewayConfig = {};

	if (record.exclude_providers !== undefined) {
		const raw = record.exclude_providers;
		if (!Array.isArray(raw)) {
			return { ok: false, error: "exclude_providers must be an array" };
		}
		if (raw.length > MAX_EXCLUDED_PROVIDERS) {
			return {
				ok: false,
				error: `exclude_providers holds at most ${MAX_EXCLUDED_PROVIDERS} entries`,
			};
		}
		const seen = new Set<string>();
		for (const entry of raw) {
			if (typeof entry !== "string" || !PROVIDER_VALUE_PATTERN.test(entry)) {
				return {
					ok: false,
					error: `exclude_providers entries must be provider names such as "${ANTHROPIC_OAUTH_PROVIDER_KEY}" or "codex"; got ${JSON.stringify(entry)}`,
				};
			}
			seen.add(entry);
		}
		value.exclude_providers = [...seen];
	}

	if (record.description !== undefined) {
		if (typeof record.description !== "string") {
			return { ok: false, error: "description must be a string" };
		}
		if (record.description.length > MAX_DESCRIPTION_LENGTH) {
			return {
				ok: false,
				error: `description holds at most ${MAX_DESCRIPTION_LENGTH} characters`,
			};
		}
		value.description = record.description;
	}

	if (record.models !== undefined) {
		const models = validateGatewayModels(record.models);
		if (!models.ok) return models;
		value.models = models.value;
	}

	return { ok: true, value };
}

function validateGatewayModels(
	raw: unknown,
):
	| { ok: true; value: OpenAIGatewayModelEntry[] }
	| { ok: false; error: string } {
	if (!Array.isArray(raw)) {
		return { ok: false, error: "models must be an array" };
	}
	if (raw.length === 0) {
		return {
			ok: false,
			error:
				"models must name at least one model; omit it to pass every model through",
		};
	}
	if (raw.length > MAX_GATEWAY_MODELS) {
		return {
			ok: false,
			error: `models holds at most ${MAX_GATEWAY_MODELS} entries`,
		};
	}
	const names = new Set<string>();
	const entries: OpenAIGatewayModelEntry[] = [];
	for (const item of raw) {
		if (item === null || typeof item !== "object" || Array.isArray(item)) {
			return { ok: false, error: "each models entry must be an object" };
		}
		const entry = item as Record<string, unknown>;
		for (const key of Object.keys(entry)) {
			if (key !== "name" && key !== "model" && key !== "combo") {
				return { ok: false, error: `unknown models entry field: ${key}` };
			}
		}
		const name = entry.name;
		const model = entry.model ?? entry.name;
		if (typeof name !== "string" || !MODEL_ID_PATTERN.test(name)) {
			return {
				ok: false,
				error: `models entry name must be a model id such as "gpt-5.5"; got ${JSON.stringify(name)}`,
			};
		}
		if (typeof model !== "string" || !MODEL_ID_PATTERN.test(model)) {
			return {
				ok: false,
				error: `models entry ${name}: model must be a model id; got ${JSON.stringify(model)}`,
			};
		}
		if (names.has(name)) {
			return { ok: false, error: `models entry ${name} is listed twice` };
		}
		names.add(name);
		const value: OpenAIGatewayModelEntry = { name, model };
		if (entry.combo !== undefined) {
			if (
				typeof entry.combo !== "string" ||
				entry.combo.trim().length === 0 ||
				entry.combo.length > MAX_COMBO_NAME_LENGTH
			) {
				return {
					ok: false,
					error: `models entry ${name}: combo must be a combo name`,
				};
			}
			value.combo = entry.combo;
		}
		entries.push(value);
	}
	return { ok: true, value: entries };
}

/**
 * Reads the stored map. An invalid entry is left out and reported in
 * `errors`, never repaired, so one bad gateway cannot disable the others and
 * a caller can say exactly which one was skipped.
 */
export function parseOpenAIGateways(raw: unknown): {
	gateways: OpenAIGateways;
	errors: string[];
} {
	const gateways: OpenAIGateways = {};
	const errors: string[] = [];
	if (raw === undefined || raw === null) return { gateways, errors };
	if (typeof raw !== "object" || Array.isArray(raw)) {
		errors.push(`${OPENAI_GATEWAYS_CONFIG_KEY} must be an object`);
		return { gateways, errors };
	}
	for (const [name, config] of Object.entries(raw as Record<string, unknown>)) {
		if (!isValidOpenAIGatewayName(name)) {
			errors.push(`invalid gateway name ${JSON.stringify(name)}`);
			continue;
		}
		const result = validateOpenAIGatewayConfig(config);
		if (!result.ok) {
			errors.push(`gateway ${name}: ${result.error}`);
			continue;
		}
		gateways[name] = result.value;
	}
	return { gateways, errors };
}

export function openAIGatewayBasePath(name: string): string {
	return `/v1/gateways/${name}`;
}

export function listOpenAIGateways(
	gateways: OpenAIGateways,
): OpenAIGatewayListing[] {
	return Object.keys(gateways)
		.sort()
		.map((name) => ({
			name,
			base_path: openAIGatewayBasePath(name),
			exclude_providers: gateways[name].exclude_providers ?? [],
			description: gateways[name].description ?? null,
			models: gateways[name].models ?? [],
		}));
}

/**
 * Splits `/v1/gateways/<name>/<rest>` into its parts. `rest` is the path the
 * client appended to the base URL, such as `/chat/completions` or `/models`.
 * Returns null for anything else, including a name that fails validation.
 */
/**
 * First path segments that can never be a gateway alias, because the server
 * already answers `/<segment>/v1/...` or a dashboard route could grow one.
 */
export const RESERVED_GATEWAY_ALIAS_NAMES: ReadonlySet<string> = new Set([
	"api",
	"v1",
	"messages",
	"assets",
	"health",
	"dashboard",
	"gateways",
]);

/**
 * The short form `/<name>/v1/<rest>`, e.g. `/gpt/v1/chat/completions`. It
 * resolves to the same gateway as `/v1/gateways/<name>/<rest>`. A reserved
 * first segment is never an alias.
 */
export function matchOpenAIGatewayAliasPath(
	pathname: string,
): { name: string; rest: string } | null {
	const match = /^\/([^/]+)\/v1(\/.*)?$/.exec(pathname);
	if (!match) return null;
	const name = match[1];
	if (!isValidOpenAIGatewayName(name)) return null;
	if (RESERVED_GATEWAY_ALIAS_NAMES.has(name)) return null;
	return { name, rest: match[2] ?? "" };
}

export function matchOpenAIGatewayPath(
	pathname: string,
): { name: string; rest: string } | null {
	const prefix = "/v1/gateways/";
	if (!pathname.startsWith(prefix)) return null;
	const remainder = pathname.slice(prefix.length);
	const slash = remainder.indexOf("/");
	const name = slash === -1 ? remainder : remainder.slice(0, slash);
	if (!isValidOpenAIGatewayName(name)) return null;
	const rest = slash === -1 ? "" : remainder.slice(slash);
	return { name, rest };
}

/**
 * Set by the OpenAI gateway on its synthetic `/v1/messages` request. It tells
 * `forwardToClient` not to alias the response's `model` back to the requested
 * name, because an OpenAI client should be told which model answered when a
 * failover lands on another family (SB23-2781). Claude Code traffic never
 * carries it, so its aliasing is unchanged. A client that sets it only changes
 * the model label it is shown. Stripped before the request goes upstream.
 */
export const REPORT_UPSTREAM_MODEL_HEADER =
	"x-better-ccflare-report-upstream-model";

/**
 * Internal: names the combo whose slots are the fallback ladder for this
 * request. Set only by the gateway handler from its own config, stripped from
 * any client request on the gateway path, and removed before the request goes
 * upstream.
 */
export const GATEWAY_COMBO_HEADER = "x-better-ccflare-gateway-combo";

/**
 * Internal: with value "1", account selection keeps only accounts that can
 * serve the requested model, so a gateway entry without a combo never sends a
 * GPT id to an Anthropic account. Same lifecycle as `GATEWAY_COMBO_HEADER`.
 */
export const GATEWAY_REQUIRE_MODEL_HEADER =
	"x-better-ccflare-gateway-require-model";
