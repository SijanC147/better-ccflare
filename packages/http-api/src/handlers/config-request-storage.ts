import type { Config } from "@better-ccflare/config";
import {
	BadRequest,
	errorResponse,
	jsonResponse,
} from "@better-ccflare/http-common";
import type { RequestStorageGetResponse } from "@better-ccflare/types";
import { resolvePayloadPersistence } from "@better-ccflare/types/request";

/**
 * Create request-storage config handlers
 */
export function createRequestStorageHandlers(config: Config) {
	return {
		/**
		 * GET /api/config/request-storage
		 * Returns both switches that decide what a request's payload row holds,
		 * and `persists`, what is actually written as a result. Headers-only
		 * mode used to be reported alone, and read as "headers are kept" on an
		 * install where store_payloads was off and nothing was kept (SB23-2572).
		 */
		getRequestStorage: (): Response => {
			const headersOnly = config.getRequestStorageHeadersOnly();
			const storePayloads = config.getStorePayloads();
			const body: RequestStorageGetResponse = {
				headersOnly,
				storePayloads,
				persists: resolvePayloadPersistence(storePayloads, headersOnly),
			};
			return jsonResponse(body);
		},

		/**
		 * POST /api/config/request-storage
		 * Body: { headersOnly: boolean }
		 * Sets the headers-only storage flag.
		 */
		setRequestStorage: async (req: Request): Promise<Response> => {
			const body = await req.json();
			if (typeof body.headersOnly !== "boolean") {
				return errorResponse(
					BadRequest("Invalid 'headersOnly': must be boolean"),
				);
			}
			config.setRequestStorageHeadersOnly(body.headersOnly);
			return new Response(null, { status: 204 });
		},
	};
}
