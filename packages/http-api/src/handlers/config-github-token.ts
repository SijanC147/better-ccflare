import type { Config } from "@better-ccflare/config";
import {
	BadRequest,
	errorResponse,
	jsonResponse,
} from "@better-ccflare/http-common";

/**
 * The version widget's GitHub token (`/api/config/github-token`).
 *
 * Unlike the upstream maintainer's token next door, this one accepts a write.
 * The asymmetry is the point: this token needs no scopes and only reads public
 * releases and commits, so an authenticated dashboard user installing one gains
 * nothing they did not already have, while the maintainer token authorizes a
 * `repository_dispatch` on another repository. `pg_password` is settable from
 * the dashboard on the same reasoning.
 *
 * The value is never returned. The read reports booleans only, the same posture
 * as the Postgres handlers, which report `passwordSet` and never the password.
 */
export function createGithubTokenConfigHandlers(config: Config) {
	return {
		getGithubTokenConfig: (): Response => {
			return jsonResponse({
				tokenSet: config.hasGithubReadToken(),
				// The environment wins over the config file, so the dashboard can
				// explain why saving a token here changed nothing.
				tokenFromEnvironment: config.githubReadTokenFromEnvironment(),
			});
		},

		updateGithubTokenConfig: async (req: Request): Promise<Response> => {
			let body: { token?: unknown };
			try {
				body = (await req.json()) as { token?: unknown };
			} catch {
				return errorResponse(BadRequest("Invalid JSON body"));
			}
			if (typeof body.token !== "string") {
				return errorResponse(BadRequest("token must be a string"));
			}
			// Trimmed because a token pasted from a terminal or a web page picks up
			// whitespace, and a trailing newline in an Authorization header is a
			// 401 with no useful message.
			const token = body.token.trim();
			// An empty string clears it, which is the only way to remove a token
			// from the dashboard.
			config.setGithubReadToken(token);
			return new Response(null, { status: 204 });
		},
	};
}
