import { realpathSync, statSync } from "node:fs";
import os from "node:os";
import type { Config } from "@better-ccflare/config";
import {
	BadRequest,
	Conflict,
	errorResponse,
	jsonResponse,
	NotFound,
} from "@better-ccflare/http-common";
import {
	CLAUDE_CODE_ALLOWED_HOSTS_CONFIG_KEY,
	CLAUDE_CODE_DIRECTORY_ROOTS_CONFIG_KEY,
	CLAUDE_CODE_ENDPOINTS_CONFIG_KEY,
	type ClaudeCodeEndpointConfig,
	type ClaudeCodeEndpointListing,
	type ClaudeCodeEndpoints,
	claudeCodeDirectoryRootsMessage,
	claudeCodeEndpointBasePath,
	claudeCodeHostRefusalMessage,
	claudeCodeMachineHostnames,
	isClaudeCodeHostAllowed,
	isPathWithinRoots,
	isValidClaudeCodeEndpointName,
	OPENAI_GATEWAYS_CONFIG_KEY,
	parseClaudeCodeAllowedHosts,
	parseClaudeCodeDirectoryRoots,
	parseClaudeCodeEndpoints,
	resolveClaudeCodeEndpoint,
	validateClaudeCodeEndpointConfig,
} from "@better-ccflare/types";

/**
 * Claude Code project endpoints (`/api/claude-code-endpoints`): a name mapped
 * to a directory on the host, served at `/<name>/v1`.
 *
 * Same write discipline as the OpenAI gateway handlers. A write replaces one
 * key of the STORED object, never the parsed map, because the parser leaves
 * invalid entries out and saving its output would delete every hand-edited
 * endpoint with a typo the first time the dashboard touched an unrelated one.
 *
 * Endpoint names share the `/<name>/v1` namespace with `openai_gateways`; PUT
 * refuses a name the other key already holds, and the gateway handler refuses
 * the reverse.
 */
/** Refused beyond this, so a runaway client cannot grow the config file without bound. */
export const MAX_CLAUDE_CODE_ENDPOINTS = 100;

/** Overridable facts about the host, for tests. */
export interface ClaudeCodeHostFacts {
	/** Default root when `claude_code_directory_roots` is unset. */
	homeDir?: string;
	/** This machine's name, as `os.hostname()` gives it. */
	hostname?: string;
}

/** `path` through symlinks when it exists, else as written. */
function realOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * The roots an endpoint directory must sit in, resolved through symlinks, so
 * a link inside a root that points at `/` is judged by where it lands.
 */
export function claudeCodeDirectoryRoots(
	config: Config,
	facts: ClaudeCodeHostFacts = {},
): { roots: string[]; errors: string[] } {
	const parsed = parseClaudeCodeDirectoryRoots(
		config.getObjectSetting(CLAUDE_CODE_DIRECTORY_ROOTS_CONFIG_KEY),
	);
	const roots = parsed.roots ?? [facts.homeDir ?? os.homedir()];
	return { roots: roots.map(realOrSelf), errors: parsed.errors };
}

export function isClaudeCodeDirectoryAllowed(
	directory: string,
	roots: readonly string[],
): boolean {
	return isPathWithinRoots(realOrSelf(directory), roots);
}

/**
 * The Host check for every request that can make this server run a command
 * (SB23-3408, item 6): null when allowed, else the 403 to send. A request
 * whose URL has no host (no Host header) is refused.
 */
export function claudeCodeHostRefusal(
	req: Request,
	config: Config,
	facts: ClaudeCodeHostFacts = {},
): Response | null {
	let hostname: string | null = null;
	try {
		hostname = new URL(req.url).hostname || null;
	} catch {
		hostname = null;
	}
	const extra = parseClaudeCodeAllowedHosts(
		config.getObjectSetting(CLAUDE_CODE_ALLOWED_HOSTS_CONFIG_KEY),
	).hosts;
	const machine = claudeCodeMachineHostnames(facts.hostname ?? os.hostname());
	if (isClaudeCodeHostAllowed(hostname, machine, extra)) return null;
	return new Response(
		JSON.stringify({
			error: claudeCodeHostRefusalMessage(hostname),
			config_key: CLAUDE_CODE_ALLOWED_HOSTS_CONFIG_KEY,
		}),
		{ status: 403, headers: { "content-type": "application/json" } },
	);
}

/**
 * What may be served right now: endpoints whose config is valid and whose
 * directory is inside the roots, plus every reason an entry was left out and
 * every problem with the two allowlist keys. The server dispatch and the list
 * route both read this, so an entry the list reports as an error is never
 * served.
 */
export function loadClaudeCodeEndpointState(
	config: Config,
	facts: ClaudeCodeHostFacts = {},
): {
	endpoints: ClaudeCodeEndpoints;
	errors: string[];
	allowedHosts: string[];
} {
	const parsed = parseClaudeCodeEndpoints(
		config.getObjectSetting(CLAUDE_CODE_ENDPOINTS_CONFIG_KEY),
	);
	const hosts = parseClaudeCodeAllowedHosts(
		config.getObjectSetting(CLAUDE_CODE_ALLOWED_HOSTS_CONFIG_KEY),
	);
	const { roots, errors: rootErrors } = claudeCodeDirectoryRoots(config, facts);
	const errors = [...parsed.errors, ...hosts.errors, ...rootErrors];
	const endpoints: ClaudeCodeEndpoints = {};
	for (const [name, endpoint] of Object.entries(parsed.endpoints)) {
		if (!isClaudeCodeDirectoryAllowed(endpoint.directory, roots)) {
			errors.push(
				`endpoint ${name}: ${claudeCodeDirectoryRootsMessage(endpoint.directory)}`,
			);
			continue;
		}
		endpoints[name] = endpoint;
	}
	return { endpoints, errors, allowedHosts: hosts.hosts };
}

function directoryExists(directory: string): boolean {
	try {
		return statSync(directory).isDirectory();
	} catch {
		return false;
	}
}

function toListing(
	name: string,
	config: ClaudeCodeEndpointConfig,
): ClaudeCodeEndpointListing {
	return {
		...resolveClaudeCodeEndpoint(name, config),
		base_path: claudeCodeEndpointBasePath(name),
		directory_exists: directoryExists(config.directory),
	};
}

function listEndpoints(
	endpoints: ClaudeCodeEndpoints,
): ClaudeCodeEndpointListing[] {
	return Object.keys(endpoints)
		.sort()
		.map((name) => toListing(name, endpoints[name]));
}

export function createClaudeCodeEndpointHandlers(
	config: Config,
	facts: ClaudeCodeHostFacts = {},
) {
	/**
	 * The stored object, copied so the write is a fresh value. Null when the
	 * key holds something other than an object: overwriting that would destroy
	 * whatever the operator put there, so the write refuses instead.
	 */
	const readStoredMap = (): Record<string, unknown> | null => {
		const raw = config.getObjectSetting(CLAUDE_CODE_ENDPOINTS_CONFIG_KEY);
		if (raw === undefined || raw === null) return {};
		if (typeof raw !== "object" || Array.isArray(raw)) return null;
		return { ...(raw as Record<string, unknown>) };
	};

	const notAnObject = () =>
		errorResponse(
			Conflict(
				`${CLAUDE_CODE_ENDPOINTS_CONFIG_KEY} in the config file is not an object; fix it by hand before editing endpoints here`,
			),
		);

	return {
		listEndpoints: (): Response => {
			const parsed = loadClaudeCodeEndpointState(config, facts);
			return jsonResponse({
				endpoints: listEndpoints(parsed.endpoints),
				errors: parsed.errors,
			});
		},

		getEndpoint: (name: string): Response => {
			const parsed = loadClaudeCodeEndpointState(config, facts);
			if (!Object.hasOwn(parsed.endpoints, name)) {
				return errorResponse(NotFound(`endpoint ${JSON.stringify(name)}`));
			}
			return jsonResponse(toListing(name, parsed.endpoints[name]));
		},

		putEndpoint: async (req: Request, name: string): Promise<Response> => {
			const hostRefusal = claudeCodeHostRefusal(req, config, facts);
			if (hostRefusal) return hostRefusal;
			if (!isValidClaudeCodeEndpointName(name)) {
				return errorResponse(
					BadRequest(
						`invalid endpoint name ${JSON.stringify(name)}: lowercase letters, digits, "-" and "_", 1 to 64 characters, starting with a letter or digit, and not a reserved name such as "api" or "v1"`,
					),
				);
			}
			let body: unknown;
			try {
				body = await req.json();
			} catch {
				return errorResponse(BadRequest("Invalid JSON body"));
			}
			const result = validateClaudeCodeEndpointConfig(body);
			if (!result.ok) {
				return errorResponse(BadRequest(result.error));
			}

			// Roots first, so a path outside them is refused before anything
			// says whether it exists: the reply must not probe the host.
			const { roots } = claudeCodeDirectoryRoots(config, facts);
			if (!isClaudeCodeDirectoryAllowed(result.value.directory, roots)) {
				return errorResponse(
					BadRequest(claudeCodeDirectoryRootsMessage(result.value.directory)),
				);
			}

			let isDirectory = false;
			try {
				isDirectory = statSync(result.value.directory).isDirectory();
			} catch {
				return errorResponse(
					BadRequest(
						`directory ${JSON.stringify(result.value.directory)} does not exist on this host`,
					),
				);
			}
			if (!isDirectory) {
				return errorResponse(
					BadRequest(
						`directory ${JSON.stringify(result.value.directory)} is not a directory`,
					),
				);
			}

			const gateways = config.getObjectSetting(OPENAI_GATEWAYS_CONFIG_KEY);
			if (
				gateways !== null &&
				typeof gateways === "object" &&
				!Array.isArray(gateways) &&
				Object.hasOwn(gateways, name)
			) {
				return errorResponse(
					Conflict(
						`${JSON.stringify(name)} is already an OpenAI gateway; both are served at /${name}/v1, so the name can belong to only one`,
					),
				);
			}

			const stored = readStoredMap();
			if (stored === null) return notAnObject();
			// Counted over stored keys, invalid entries included, so the cap
			// bounds the file rather than the valid subset. Replacing an existing
			// endpoint at the cap still works.
			if (
				!Object.hasOwn(stored, name) &&
				Object.keys(stored).length >= MAX_CLAUDE_CODE_ENDPOINTS
			) {
				return errorResponse(
					BadRequest(
						`at most ${MAX_CLAUDE_CODE_ENDPOINTS} endpoints can be configured; delete one first`,
					),
				);
			}
			stored[name] = result.value;
			config.setObjectSetting(CLAUDE_CODE_ENDPOINTS_CONFIG_KEY, stored);

			return jsonResponse(toListing(name, result.value));
		},

		/**
		 * Removes the stored key whether or not its entry is valid, because this
		 * is the one API route that can clear an entry GET reports as broken.
		 */
		deleteEndpoint: (req: Request, name: string): Response => {
			const hostRefusal = claudeCodeHostRefusal(req, config, facts);
			if (hostRefusal) return hostRefusal;
			const stored = readStoredMap();
			if (stored === null) return notAnObject();
			if (!Object.hasOwn(stored, name)) {
				return errorResponse(NotFound(`endpoint ${JSON.stringify(name)}`));
			}
			delete stored[name];
			config.setObjectSetting(CLAUDE_CODE_ENDPOINTS_CONFIG_KEY, stored);
			return new Response(null, { status: 204 });
		},
	};
}
