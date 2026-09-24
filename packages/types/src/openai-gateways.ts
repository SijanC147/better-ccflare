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
}

export type OpenAIGateways = Record<string, OpenAIGatewayConfig>;

export interface OpenAIGatewayListing {
	name: string;
	/** Relative to the server origin, e.g. `/v1/gateways/work`. */
	base_path: string;
	exclude_providers: string[];
	description: string | null;
}

const PROVIDER_VALUE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const MAX_EXCLUDED_PROVIDERS = 32;
const MAX_DESCRIPTION_LENGTH = 500;

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
		if (key !== "exclude_providers" && key !== "description") {
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

	return { ok: true, value };
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
		}));
}

/**
 * Splits `/v1/gateways/<name>/<rest>` into its parts. `rest` is the path the
 * client appended to the base URL, such as `/chat/completions` or `/models`.
 * Returns null for anything else, including a name that fails validation.
 */
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
