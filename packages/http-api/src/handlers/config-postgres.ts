import type { Config } from "@better-ccflare/config";
import { validateNumber, validateString } from "@better-ccflare/core";
import {
	BadRequest,
	errorResponse,
	jsonResponse,
} from "@better-ccflare/http-common";

const VALID_SSL_MODES = [
	"disable",
	"require",
	"verify-ca",
	"verify-full",
] as const;
type SslMode = (typeof VALID_SSL_MODES)[number];

interface PostgresConfigPayload {
	enabled?: boolean;
	host?: string;
	port?: number;
	database?: string;
	user?: string;
	password?: string;
	sslMode?: SslMode;
}

/**
 * Attempt a lightweight test connection to a PostgreSQL server using Bun's SQL client.
 * Returns null on success, or an error message string on failure.
 */
async function testPgConnection(url: string): Promise<string | null> {
	try {
		const { SQL } = await import("bun" as string);
		const client = new SQL({ url, max: 1, idleTimeout: 5 });
		// A simple query sufficient to verify connectivity
		await client`SELECT 1`;
		await client.end();
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

/**
 * Create Postgres configuration handlers (GET + POST /api/config/postgres)
 */
export function createPostgresConfigHandlers(config: Config) {
	return {
		/**
		 * GET /api/config/postgres
		 * Returns current Postgres settings (password is redacted).
		 */
		getPostgresConfig: (): Response => {
			return jsonResponse({
				enabled: config.getPgEnabled(),
				host: config.getPgHost(),
				port: config.getPgPort(),
				database: config.getPgDatabase(),
				user: config.getPgUser(),
				// Never expose the stored password to the UI
				passwordSet: config.getPgPassword().length > 0,
				sslMode: config.getPgSslMode(),
			});
		},

		/**
		 * POST /api/config/postgres
		 * Validates inputs, optionally tests the connection, then persists.
		 */
		setPostgresConfig: async (req: Request): Promise<Response> => {
			let body: PostgresConfigPayload;
			try {
				body = (await req.json()) as PostgresConfigPayload;
			} catch {
				return errorResponse(BadRequest("Invalid JSON body"));
			}

			// Validate individual fields when present
			if (body.host !== undefined) {
				const host = validateString(body.host, "host", {
					required: true,
					minLength: 1,
					maxLength: 255,
				});
				if (!host) return errorResponse(BadRequest("Invalid 'host'"));
			}

			if (body.port !== undefined) {
				const port = validateNumber(body.port, "port", {
					min: 1,
					max: 65535,
					integer: true,
				});
				if (typeof port !== "number")
					return errorResponse(BadRequest("Invalid 'port': must be 1-65535"));
			}

			if (body.database !== undefined) {
				const db = validateString(body.database, "database", {
					required: true,
					minLength: 1,
					maxLength: 63,
				});
				if (!db) return errorResponse(BadRequest("Invalid 'database'"));
			}

			if (body.user !== undefined) {
				const user = validateString(body.user, "user", {
					required: true,
					minLength: 1,
					maxLength: 63,
				});
				if (!user) return errorResponse(BadRequest("Invalid 'user'"));
			}

			if (body.sslMode !== undefined) {
				if (!VALID_SSL_MODES.includes(body.sslMode)) {
					return errorResponse(
						BadRequest(
							`Invalid 'sslMode': must be one of ${VALID_SSL_MODES.join(", ")}`,
						),
					);
				}
			}

			// When enabling PG, attempt a test connection before persisting
			if (body.enabled === true) {
				// Build a temporary URL using the incoming values merged with existing config
				const host = body.host ?? config.getPgHost();
				const port = body.port ?? config.getPgPort();
				const database = body.database ?? config.getPgDatabase();
				const user = body.user ?? config.getPgUser();
				// Only update password if explicitly provided (non-empty string)
				const password =
					typeof body.password === "string" && body.password.length > 0
						? body.password
						: config.getPgPassword();
				const ssl = body.sslMode ?? config.getPgSslMode();

				const encodedUser = encodeURIComponent(user);
				const encodedPassword = encodeURIComponent(password);
				const encodedDb = encodeURIComponent(database);
				const sslParam = ssl !== "disable" ? `?sslmode=${ssl}` : "";
				const testUrl = `postgresql://${encodedUser}:${encodedPassword}@${host}:${port}/${encodedDb}${sslParam}`;

				const connError = await testPgConnection(testUrl);
				if (connError) {
					return errorResponse(
						BadRequest(`PostgreSQL connection test failed: ${connError}`),
					);
				}
			}

			// Persist all provided fields
			if (typeof body.enabled === "boolean") config.setPgEnabled(body.enabled);
			if (typeof body.host === "string") config.setPgHost(body.host);
			if (typeof body.port === "number") config.setPgPort(body.port);
			if (typeof body.database === "string")
				config.setPgDatabase(body.database);
			if (typeof body.user === "string") config.setPgUser(body.user);
			if (typeof body.password === "string" && body.password.length > 0)
				config.setPgPassword(body.password);
			if (body.sslMode !== undefined) config.setPgSslMode(body.sslMode);

			return new Response(null, { status: 204 });
		},
	};
}
