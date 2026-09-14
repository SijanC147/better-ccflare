import type { ServiceStatusService } from "../services/service-status-service";
import { jsonResponse } from "../utils/http-error";

/**
 * `GET /api/service-status` — the filtered status.claude.com snapshot.
 *
 * Always 200, even when the status page is unreachable: a third party being
 * down must never make this proxy look broken. A failure returns the last good
 * snapshot with `stale: true` and the reason in `error`, or a null snapshot if
 * nothing has ever been fetched.
 */
export function createServiceStatusHandler(service: ServiceStatusService) {
	return async (url: URL): Promise<Response> => {
		const force = url.searchParams.get("refresh") === "1";
		const result = await service.getStatus(force);
		return jsonResponse({
			snapshot: result.snapshot,
			stale: result.stale,
			error: result.error,
		});
	};
}
