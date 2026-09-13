import type { Config } from "@better-ccflare/config";
import {
	BadRequest,
	errorResponse,
	jsonResponse,
} from "@better-ccflare/http-common";
import { MAINTAINER_REPO } from "../services/fork-identity";

interface UpstreamMaintainerPayload {
	token?: string;
}

/** Longest token GitHub issues today, with room to spare. */
const MAX_TOKEN_LENGTH = 512;

/**
 * Configuration for the upstream maintainer dispatch (`/api/config/upstream-maintainer`).
 *
 * The token's presence is the feature's only switch: set it and the dashboard
 * offers "Request upstream sync"; clear it and `POST /api/upstream/sync-dispatch`
 * answers 404 and no button renders.
 *
 * Shaped after the Postgres password handlers, the project's existing precedent
 * for a sensitive config value: the GET reports a boolean and never the value,
 * and the setter is the only way it travels, inbound.
 */
export function createUpstreamMaintainerConfigHandlers(config: Config) {
	return {
		/**
		 * GET /api/config/upstream-maintainer
		 *
		 * Reports only whether a token is configured, plus the fixed facts the UI
		 * needs to explain the feature. The token itself is never in this
		 * response, or any other.
		 */
		getUpstreamMaintainerConfig: (): Response => {
			return jsonResponse({
				tokenSet: config.hasUpstreamMaintainerToken(),
				// The environment wins over the config file, so the dashboard must
				// be able to say why clearing the stored value changed nothing.
				tokenFromEnvironment: Boolean(
					process.env.BETTER_CCFLARE_UPSTREAM_MAINTAINER_TOKEN,
				),
				controllerRepo: MAINTAINER_REPO,
			});
		},

		/**
		 * POST /api/config/upstream-maintainer
		 *
		 * `{ "token": "<value>" }` stores it; `{ "token": "" }` clears it. The
		 * response repeats the boolean, never the value.
		 */
		setUpstreamMaintainerConfig: async (req: Request): Promise<Response> => {
			let body: UpstreamMaintainerPayload;
			try {
				body = (await req.json()) as UpstreamMaintainerPayload;
			} catch {
				return errorResponse(BadRequest("Invalid JSON body"));
			}

			if (typeof body.token !== "string") {
				return errorResponse(
					BadRequest('token must be a string (use "" to clear it)'),
				);
			}

			const token = body.token.trim();
			if (token.length > MAX_TOKEN_LENGTH) {
				return errorResponse(
					BadRequest(`token must be at most ${MAX_TOKEN_LENGTH} characters`),
				);
			}
			// Anything outside printable, non-space ASCII would make a malformed
			// Authorization header, and a newline could inject one. The message
			// describes the rule and deliberately never echoes the input.
			if (token.length > 0 && /[^\x21-\x7e]/.test(token)) {
				return errorResponse(
					BadRequest(
						"token must contain only printable ASCII with no whitespace",
					),
				);
			}

			config.setUpstreamMaintainerToken(token);

			return jsonResponse({
				tokenSet: config.hasUpstreamMaintainerToken(),
				tokenFromEnvironment: Boolean(
					process.env.BETTER_CCFLARE_UPSTREAM_MAINTAINER_TOKEN,
				),
				controllerRepo: MAINTAINER_REPO,
			});
		},
	};
}
