import type { Config } from "@better-ccflare/config";
import {
	BadRequest,
	errorResponse,
	jsonResponse,
} from "@better-ccflare/http-common";

// Mirrors the LogLevel enum in @better-ccflare/logger. Duplicated rather than
// imported: this package does not otherwise depend on the logger, and the set
// of level names is fixed by the LogEvent type.
const LOG_MIN_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"];

/**
 * OpenObserve shipping (`/api/config/openobserve`).
 *
 * Settable from the dashboard on the same reasoning as the version widget's
 * GitHub token and `pg_password`: the endpoint is the operator's own, and the
 * token authorizes nothing but writes into their own org.
 *
 * The token is never returned. The read reports booleans only, the same posture
 * as the Postgres handlers, which report `passwordSet` and never the password.
 *
 * Nothing here reconfigures the exporter. `apps/server/src/server.ts` installs a
 * getter, and `currentSettings()` in `packages/logger/src/openobserve.ts` calls
 * it on every decision, so a value written here takes effect on the next
 * request with no restart.
 */
export function createOpenObserveConfigHandlers(config: Config) {
	return {
		getOpenObserveConfig: (): Response => {
			// Null means the base URL is unset, which is what "off" means.
			const settings = config.getOpenObserveSettings();
			return jsonResponse({
				enabled: settings !== null,
				url: settings?.baseUrl ?? "",
				org: settings?.org ?? "default",
				user: settings?.user ?? "",
				logStream: settings?.logStream ?? "better_ccflare_logs",
				requestStream: settings?.requestStream ?? "better_ccflare_requests",
				shipPayloads: settings?.shipPayloads ?? false,
				logMinLevel: settings?.logMinLevel ?? "INFO",
				tokenSet: config.hasOpenObserveToken(),
				// The environment wins over the config file, so the dashboard can
				// explain why saving here changed nothing.
				tokenFromEnvironment: config.openObserveTokenFromEnvironment(),
				endpointFromEnvironment: Boolean(
					process.env.BETTER_CCFLARE_OPENOBSERVE_URL,
				),
			});
		},

		updateOpenObserveConfig: async (req: Request): Promise<Response> => {
			let body: {
				url?: unknown;
				org?: unknown;
				user?: unknown;
				token?: unknown;
				logStream?: unknown;
				requestStream?: unknown;
				shipPayloads?: unknown;
				logMinLevel?: unknown;
			};
			try {
				body = (await req.json()) as typeof body;
			} catch {
				return errorResponse(BadRequest("Invalid JSON body"));
			}

			// Trimmed because a value pasted from a terminal picks up whitespace,
			// and a trailing newline in an Authorization header is a 401 with no
			// useful message.
			const strings: Record<string, string> = {};
			for (const field of [
				"url",
				"org",
				"user",
				"logStream",
				"requestStream",
			] as const) {
				const value = body[field];
				if (typeof value !== "string") {
					return errorResponse(BadRequest(`${field} must be a string`));
				}
				strings[field] = value.trim();
			}
			if (typeof body.shipPayloads !== "boolean") {
				return errorResponse(BadRequest("shipPayloads must be a boolean"));
			}

			// Absent leaves the stored level alone, the same posture as the token:
			// a client written before this field existed sends the rest of the
			// form, and must not silently reset a configured level to the default.
			let logMinLevel = config.getOpenObserveSettings()?.logMinLevel ?? "INFO";
			if (body.logMinLevel !== undefined) {
				if (typeof body.logMinLevel !== "string") {
					return errorResponse(BadRequest("logMinLevel must be a string"));
				}
				const candidate = body.logMinLevel.trim().toUpperCase();
				// Rejected here rather than accepted and coerced, because this is the
				// one write path that can tell the operator. A bad value arriving by
				// config file or environment variable still falls back in the
				// exporter rather than turning the log stream off.
				if (!LOG_MIN_LEVELS.includes(candidate)) {
					return errorResponse(
						BadRequest(
							`logMinLevel must be one of ${LOG_MIN_LEVELS.join(", ")}`,
						),
					);
				}
				logMinLevel = candidate;
			}

			config.setOpenObserveEndpoint({
				url: strings.url,
				// Empty falls back to the same default the config read applies, so a
				// cleared field does not leave the org blank.
				org: strings.org || "default",
				user: strings.user,
				logStream: strings.logStream || "better_ccflare_logs",
				requestStream: strings.requestStream || "better_ccflare_requests",
				shipPayloads: body.shipPayloads,
				logMinLevel,
			});

			// Absent leaves the stored token alone; the form does not read it back,
			// so an untouched field must not clear it. An empty string clears it,
			// which is the only way to remove the token from the dashboard.
			if (body.token !== undefined) {
				if (typeof body.token !== "string") {
					return errorResponse(BadRequest("token must be a string"));
				}
				config.setOpenObserveToken(body.token.trim());
			}

			return new Response(null, { status: 204 });
		},
	};
}
