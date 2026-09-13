import type { VersionStatusService } from "../services/version-status-service";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "../utils/http-error";

/**
 * GET /api/version/check
 *
 * Reports the latest released version of **this fork**.
 *
 * It used to read https://registry.npmjs.org/better-ccflare/latest, which is
 * upstream's npm package. This fork does not publish to npm: it releases as
 * `v*` tags on SijanC147/better-ccflare plus a private Homebrew tap,
 * and `package.json` deliberately lags the release (docs/release.md). Comparing
 * the running fork version against upstream's npm version produced a verdict
 * about two unrelated release lines, so the card could claim an update that did
 * not exist or hide one that did.
 *
 * The response shape (`{ version, cached }`) is unchanged, as is the route and
 * its static auth exemption — only the source of truth moved. Richer state
 * (upstream gap, sync PR) lives on GET /api/version/status.
 */
export function createVersionCheckHandler(service: VersionStatusService) {
	return async (): Promise<Response> => {
		const result = await service.getStatus();
		const latest = result.snapshot?.fork?.latestTag;

		if (!latest) {
			return errorResponse(
				InternalServerError(
					`Update check failed: ${result.error ?? "no published release found"}`,
				),
			);
		}

		return jsonResponse({
			// Trim the tag's leading "v" so the value stays a bare semver string,
			// matching what the dashboard's comparison has always expected.
			version: latest.replace(/^v/, ""),
			// True when the value came from the stored snapshot rather than a fresh
			// GitHub read. This route stays auth-exempt, so the snapshot TTL and
			// in-flight de-duplication in VersionStatusService are what stop an
			// unauthenticated caller from driving outbound requests.
			cached: result.stale,
		});
	};
}
