import type { Config } from "@better-ccflare/config";
import { jsonResponse } from "@better-ccflare/http-common";
import { MAINTAINER_REPO } from "../services/fork-identity";

/**
 * Read-only status of the upstream maintainer dispatch configuration
 * (`GET /api/config/upstream-maintainer`).
 *
 * The token's presence is the feature's only switch: configure one and the
 * dashboard offers "Request upstream sync"; configure none and
 * `POST /api/upstream/sync-dispatch` answers 404 and no button renders.
 *
 * **There is deliberately no setter here.** The operator writes the token into
 * the config file (or the environment); nothing reachable from the dashboard can
 * set or overwrite it. The read reports booleans and the controller's name, never
 * the value — the same posture as the Postgres handlers next door, which report
 * `passwordSet` and never the password, and one step stricter because those do
 * accept a write.
 */
export function createUpstreamMaintainerConfigHandlers(config: Config) {
	return {
		getUpstreamMaintainerConfig: (): Response => {
			return jsonResponse({
				tokenSet: config.hasUpstreamMaintainerToken(),
				// The environment wins over the config file, so the dashboard can
				// explain why editing the stored value changed nothing.
				tokenFromEnvironment: Boolean(
					process.env.BETTER_CCFLARE_UPSTREAM_MAINTAINER_TOKEN,
				),
				controllerRepo: MAINTAINER_REPO,
			});
		},
	};
}
