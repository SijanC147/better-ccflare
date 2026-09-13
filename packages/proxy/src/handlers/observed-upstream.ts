import { Logger } from "@better-ccflare/logger";
import type {
	Provider,
	UpstreamObservation,
	UpstreamObservationContext,
} from "@better-ccflare/providers";

const log = new Logger("UpstreamObservation");

/** All retries call this boundary after their final body mutations. Diagnostics
 * cannot fail an inference, disclose exceptions, or alter retry decisions. */
export async function forwardObservedUpstream(
	provider: Provider,
	request: Request,
	context: UpstreamObservationContext,
	send: (request: Request) => Promise<Response>,
): Promise<Response> {
	let observer: UpstreamObservation | undefined;
	const failed = () =>
		log.warn("Upstream observation failed", { capture_gap: true });
	try {
		observer = await provider.observeUpstream?.(request, context);
	} catch {
		failed();
	}
	let response: Response;
	try {
		response = await send(request);
	} catch (error) {
		try {
			observer?.error(error);
		} catch {
			failed();
		}
		throw error;
	}
	try {
		return observer?.response(response) ?? response;
	} catch {
		failed();
		return response;
	}
}
