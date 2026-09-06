import type {
	UpstreamObservation,
	UpstreamObservationContext,
} from "../../types";
import type {
	CacheObservationContext,
	CodexCacheDiagnostics,
} from "./cache-diagnostics";
import { cacheDigest } from "./cache-telemetry";

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const DEADLINE_MS = 30 * 60 * 1000;

/** Reads only a bounded clone. Cancellation of a tee must not be awaited: the
 * original request has not been dispatched yet and owns the other branch. */
async function boundedRequestText(request: Request): Promise<string | null> {
	const reader = request.clone().body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder();
	let text = "",
		bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return text + decoder.decode();
			bytes += value.byteLength;
			if (bytes > MAX_CAPTURE_BYTES) {
				void reader.cancel().catch(() => {});
				return null;
			}
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
}

export async function observeCodexWire(
	diagnostics: CodexCacheDiagnostics,
	request: Request,
	context: UpstreamObservationContext,
	extractSession: (source: Record<string, unknown>) => string | null,
): Promise<UpstreamObservation> {
	const id = context.requestId;
	// Never capture the source-body/header context in response/timer closures.
	const signal = context.signal;
	let source: Record<string, unknown> = {};
	if (
		context.sourceBody &&
		context.sourceBody.byteLength <= MAX_CAPTURE_BYTES
	) {
		try {
			const parsed = JSON.parse(new TextDecoder().decode(context.sourceBody));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
				source = parsed;
		} catch {
			/* explicit source gap below */
		}
	}
	let body: Record<string, unknown> = {},
		gap: string | null = null;
	try {
		const text = await boundedRequestText(request);
		if (text === null) gap = "byte_limit";
		else {
			const parsed = JSON.parse(text);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				gap = "invalid_json";
			else body = parsed;
		}
	} catch {
		gap = "invalid_json";
	}
	const observation: CacheObservationContext = {
		path: context.nativeResponses ? "native" : "legacy",
		headers: context.sourceHeaders,
		// Omit query strings: credentials or request-specific values can occur there.
		endpoint: new URL(request.url).origin + new URL(request.url).pathname,
		source: Object.keys(source).length
			? {
					input: source.messages ?? source.input,
					instructions: source.system ?? source.instructions,
					tools: source.tools,
				}
			: undefined,
	};
	diagnostics.prepare(
		id,
		context.account?.id ?? "",
		extractSession(source) ?? "",
		body,
		observation,
	);
	if (gap) diagnostics.gap(id, gap);
	if (!Object.keys(source).length) diagnostics.gap(id, "source_unobserved");
	let settled = false;
	const cleanup = () => {
		clearTimeout(timer);
		signal.removeEventListener("abort", canceled);
	};
	const abort = (event: string, reason?: string) => {
		if (settled) return;
		settled = true;
		cleanup();
		diagnostics.abort(id, event, reason ? { gap_reason: reason } : {});
	};
	const canceled = () => abort("canceled");
	const timer = setTimeout(
		() => abort("timeout", "pending_expired"),
		DEADLINE_MS,
	);
	timer.unref?.();
	signal.addEventListener("abort", canceled, { once: true });
	if (signal.aborted) canceled();
	const finish = (response: Record<string, unknown>, completed: boolean) => {
		if (settled) return;
		settled = true;
		cleanup();
		diagnostics.finish(id, response.usage, completed, response);
	};
	const observeJson = (text: string, eventName = "") => {
		if (settled || !text.trim() || text.trim() === "[DONE]") return;
		let data: Record<string, unknown>;
		try {
			data = JSON.parse(text);
			if (!data || typeof data !== "object" || Array.isArray(data))
				throw new Error();
		} catch {
			abort("coverage_gap", "invalid_json");
			return;
		}
		if (eventName && typeof data.type === "string" && eventName !== data.type) {
			abort("coverage_gap", "invalid_json");
			return;
		}
		const type = eventName || data.type;
		if (type === "error" || type === "response.failed") {
			abort("upstream_error", "stream_error");
			return;
		}
		if (type === "response.completed" || type === "response.incomplete") {
			const response = data.response;
			if (
				!response ||
				typeof response !== "object" ||
				Array.isArray(response)
			) {
				abort("coverage_gap", "invalid_json");
				return;
			}
			finish(
				response as Record<string, unknown>,
				type === "response.completed",
			);
		} else if (
			!type &&
			(data.status === "completed" || data.status === "incomplete")
		) {
			finish(data, data.status === "completed");
		} else if (!type && data.status === "failed") abort("upstream_error");
	};
	return {
		error(error) {
			abort(
				signal.aborted
					? "canceled"
					: error instanceof Error &&
							(error.name === "TimeoutError" || error.name === "AbortError")
						? "timeout"
						: "transport_error",
			);
		},
		response(response) {
			const upstreamId =
				response.headers.get("x-request-id") ??
				response.headers.get("request-id");
			const contentType = response.headers.get("content-type") ?? "";
			let mode: "sse" | "http" | "unknown" = contentType.includes(
				"text/event-stream",
			)
				? "sse"
				: contentType.includes("application/json")
					? "http"
					: "unknown";
			diagnostics.annotate(id, {
				status_code: response.status,
				transport: mode,
				upstream_request_digest:
					upstreamId && upstreamId.length <= 256
						? cacheDigest(upstreamId)
						: null,
			});
			if (!response.ok) {
				abort("upstream_error");
				return response;
			}
			if (!response.body) {
				abort("truncated", "missing_terminal");
				return response;
			}
			if (!contentType) diagnostics.gap(id, "missing_content_type");
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			const consume = (end = false) => {
				if (settled) {
					buffer = "";
					return;
				}
				if (Buffer.byteLength(buffer) > MAX_CAPTURE_BYTES) {
					abort("coverage_gap", "native_parse_limit");
					buffer = "";
					return;
				}
				if (
					mode === "unknown" &&
					buffer.trimStart() &&
					(end ||
						buffer.includes("\n") ||
						/^[{[]/.test(buffer.trimStart()) ||
						buffer.length >= 14)
				) {
					mode = /^(event:|data:|:)/.test(buffer.trimStart()) ? "sse" : "http";
					diagnostics.annotate(id, { transport: mode });
				}
				if (mode === "sse") {
					const events = buffer.split(/\r?\n\r?\n/);
					buffer = events.pop() ?? "";
					for (const event of events) {
						const lines = event.split(/\r?\n/);
						const name =
							lines
								.find((line) => line.startsWith("event:"))
								?.slice(6)
								.trim() ?? "";
						const data = lines
							.filter((line) => line.startsWith("data:"))
							.map((line) => line.slice(5).replace(/^ /, ""))
							.join("\n");
						observeJson(data, name);
					}
				} else if (end) {
					observeJson(buffer);
					buffer = "";
				}
				if (Buffer.byteLength(buffer) > MAX_CAPTURE_BYTES) {
					abort("coverage_gap", "native_parse_limit");
					buffer = "";
				}
				if (end) abort("truncated", "missing_terminal");
			};
			return new Response(
				new ReadableStream<Uint8Array>(
					{
						async pull(controller) {
							try {
								const { done, value } = await reader.read();
								if (done) {
									buffer += decoder.decode();
									consume(true);
									controller.close();
									return;
								}
								if (!settled) {
									buffer += decoder.decode(value, { stream: true });
									consume();
								}
								controller.enqueue(value);
							} catch (error) {
								abort(signal.aborted ? "canceled" : "transport_error");
								controller.error(error);
							}
						},
						async cancel(reason) {
							abort("canceled");
							await reader.cancel(reason);
						},
					},
					{ highWaterMark: 0 },
				),
				{
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				},
			);
		},
	};
}
