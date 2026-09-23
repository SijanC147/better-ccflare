import type { Config } from "@better-ccflare/config";
import {
	BadRequest,
	Conflict,
	errorResponse,
	jsonResponse,
	NotFound,
} from "@better-ccflare/http-common";
import {
	isValidOpenAIGatewayName,
	listOpenAIGateways,
	OPENAI_GATEWAYS_CONFIG_KEY,
	parseOpenAIGateways,
	validateOpenAIGatewayConfig,
} from "@better-ccflare/types";

/**
 * Named OpenAI-compatible gateways (`/api/openai-gateways`, SB23-2720).
 *
 * Writes go through `setObjectSetting`, never `config.set`: `set` takes
 * scalars only, and `get(key, default)` persists its default on a miss.
 *
 * A write replaces one key of the STORED object rather than re-serialising the
 * parsed map. `parseOpenAIGateways` leaves invalid entries out, so saving its
 * output would delete every hand-edited gateway with a typo the first time the
 * dashboard touched an unrelated one. The invalid entry stays on disk, the
 * router keeps skipping it, and GET keeps naming it in `errors`.
 */
export function createOpenAIGatewayHandlers(config: Config) {
	/**
	 * The stored object, copied so the write is a fresh value. Null when the
	 * key holds something other than an object: overwriting that would destroy
	 * whatever the operator put there, so the write refuses instead.
	 */
	const readStoredMap = (): Record<string, unknown> | null => {
		const raw = config.getObjectSetting(OPENAI_GATEWAYS_CONFIG_KEY);
		if (raw === undefined || raw === null) return {};
		if (typeof raw !== "object" || Array.isArray(raw)) return null;
		return { ...(raw as Record<string, unknown>) };
	};

	const notAnObject = () =>
		errorResponse(
			Conflict(
				`${OPENAI_GATEWAYS_CONFIG_KEY} in the config file is not an object; fix it by hand before editing gateways here`,
			),
		);

	return {
		listGateways: (): Response => {
			const parsed = parseOpenAIGateways(
				config.getObjectSetting(OPENAI_GATEWAYS_CONFIG_KEY),
			);
			return jsonResponse({
				gateways: listOpenAIGateways(parsed.gateways),
				errors: parsed.errors,
			});
		},

		putGateway: async (req: Request, name: string): Promise<Response> => {
			if (!isValidOpenAIGatewayName(name)) {
				return errorResponse(
					BadRequest(
						`invalid gateway name ${JSON.stringify(name)}: lowercase letters, digits, "-" and "_", 1 to 64 characters, starting with a letter or digit`,
					),
				);
			}
			let body: unknown;
			try {
				body = await req.json();
			} catch {
				return errorResponse(BadRequest("Invalid JSON body"));
			}
			const result = validateOpenAIGatewayConfig(body);
			if (!result.ok) {
				return errorResponse(BadRequest(result.error));
			}

			const stored = readStoredMap();
			if (stored === null) return notAnObject();
			stored[name] = result.value;
			config.setObjectSetting(OPENAI_GATEWAYS_CONFIG_KEY, stored);

			return jsonResponse(listOpenAIGateways({ [name]: result.value })[0]);
		},

		/**
		 * Removes the stored key whether or not its entry is valid, because this
		 * is the one API route that can clear an entry GET reports as broken.
		 */
		deleteGateway: (name: string): Response => {
			const stored = readStoredMap();
			if (stored === null) return notAnObject();
			if (!Object.hasOwn(stored, name)) {
				return errorResponse(NotFound(`gateway ${JSON.stringify(name)}`));
			}
			delete stored[name];
			config.setObjectSetting(OPENAI_GATEWAYS_CONFIG_KEY, stored);
			return new Response(null, { status: 204 });
		},
	};
}
