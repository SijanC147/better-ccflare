import type { Config } from "@better-ccflare/config";
import {
	BadRequest,
	errorResponse,
	jsonResponse,
} from "@better-ccflare/http-common";

/**
 * Create request-storage config handlers
 */
export function createRequestStorageHandlers(config: Config) {
	return {
		/**
		 * GET /api/config/request-storage
		 * Returns the current headers-only storage setting.
		 */
		getRequestStorage: (): Response => {
			return jsonResponse({
				headersOnly: config.getRequestStorageHeadersOnly(),
			});
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
