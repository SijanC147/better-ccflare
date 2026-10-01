import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import { jsonResponse } from "@better-ccflare/http-common";
import { resolvePayloadPersistence } from "@better-ccflare/types/request";
import type { CleanupResponse } from "../types";

export function createCleanupHandler(
	dbOps: DatabaseOperations,
	config: Config,
) {
	return async (): Promise<Response> => {
		const requestDays = config.getRequestRetentionDays();
		const requestMs = requestDays * 24 * 60 * 60 * 1000;
		// When nothing is persisted, delete all existing payloads (cutoff = now).
		// When anything is, including headers-only rows with store_payloads off,
		// honour the configured retention window.
		const persistsPayloads =
			resolvePayloadPersistence(
				config.getStorePayloads(),
				config.getRequestStorageHeadersOnly(),
			) !== "none";
		const payloadMs = persistsPayloads
			? config.getDataRetentionDays() * 24 * 60 * 60 * 1000
			: 0;
		const { removedRequests, removedPayloads } = await dbOps.cleanupOldRequests(
			payloadMs,
			requestMs,
		);
		const [tableRowCounts, dbSizeBytes] = await Promise.all([
			dbOps.getTableRowCounts(),
			dbOps.getDbSizeBytes(),
		]);
		const now = Date.now();
		const payload: CleanupResponse = {
			removedRequests,
			removedPayloads,
			// null signals "all payloads removed" (storage disabled); avoids
			// rendering a misleading "older than [right now]" timestamp in the UI.
			payloadCutoffIso: persistsPayloads
				? new Date(now - payloadMs).toISOString()
				: null,
			requestCutoffIso: new Date(now - requestMs).toISOString(),
			dbSizeBytes,
			tableRowCounts,
		};
		return jsonResponse(payload);
	};
}
