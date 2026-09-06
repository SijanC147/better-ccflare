import { createHash, randomUUID } from "node:crypto";

export const CODEX_CACHE_DIAGNOSTICS_ENV = "CCFLARE_CODEX_CACHE_DIAGNOSTICS";
const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 64;
const MAX_ITEMS = 2048;
const MAX_BYTES = 8 * 1024 * 1024;

type Fingerprint = {
	group: string;
	requestDigest: string;
	attemptDigest: string;
	complete: boolean;
	dimensions: Record<string, string | null>;
	items: string[];
	bytes: number[];
	instructions: string;
	tools: string;
	key: string;
	parameters: string;
	at: number;
};
type Facts = Record<string, number | boolean | string | null>;
type Pending = { fingerprint: Fingerprint; facts: Facts };

export type CacheObservationContext = {
	path?: "legacy" | "native";
	headers?: Headers;
	endpoint?: string;
	source?: { input?: unknown; instructions?: unknown; tools?: unknown };
};

function hash(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(value ?? null))
		.digest("hex");
}
function count(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: null;
}

/** Opt-in observation only. Retains bounded digests/counts, never request bodies,
 * output, keys, credentials, or raw session IDs. Does not route or rewrite.
 * Matches completed prior requests in a session rather than assuming the most
 * recent request belongs to the same subagent. Byte overlap is not token reuse.
 */
export class CodexCacheDiagnostics {
	private history: Fingerprint[] = [];
	private pending = new Map<string, Pending>();
	private instance = randomUUID();
	private sequence = 0;
	constructor(
		private emit: (facts: Facts) => void,
		private now = Date.now,
		private lifecycle: (facts: Facts) => void = () => {},
	) {}

	sweep(): void {
		const now = this.now();
		this.history = this.history.filter((row) => row.at + TTL_MS > now);
		for (const [id, row] of this.pending) {
			if (row.fingerprint.at + TTL_MS <= now)
				this.abort(id, "timeout", { gap_reason: "pending_expired" });
		}
	}

	prepare(
		requestId: string,
		account: string,
		session: string,
		body: Record<string, unknown>,
		context: CacheObservationContext = {},
	): void {
		const now = this.now();
		this.sweep();
		this.abort(requestId, "coverage_gap", { gap_reason: "replaced_attempt" });
		const attempt = ++this.sequence;
		const callerIdentity = (name: string) => {
			const value = context.headers?.get(name);
			return value && value.length <= 256 ? hash(value) : null;
		};
		const gatewayIdentity = (name: string) => {
			const value = context.headers?.get(name);
			return value && /^[0-9a-f]{64}$/.test(value) ? value : null;
		};
		const suppliedDigest = (name: string) => gatewayIdentity(name);
		const conversation =
			suppliedDigest("x-lanetally-conversation-digest") ??
			callerIdentity("x-lanetally-conversation-id");
		const ordinal = context.headers?.get("x-lanetally-gateway-attempt-number");
		const metadata: Facts = {
			event: "prepared",
			ts_ms: now,
			request_digest: hash(requestId),
			attempt_digest: hash([this.instance, attempt]),
			observer_attempt_sequence: attempt,
			gateway_request_digest: gatewayIdentity(
				"x-lanetally-gateway-request-digest",
			),
			gateway_attempt_digest: gatewayIdentity(
				"x-lanetally-gateway-attempt-digest",
			),
			account_digest: account ? hash(account) : null,
			session_digest: session ? hash([account, session]) : null,
			conversation_digest: conversation,
			agent_digest:
				suppliedDigest("x-lanetally-agent-digest") ??
				callerIdentity("x-lanetally-agent-id"),
			parent_agent_digest:
				suppliedDigest("x-lanetally-parent-agent-digest") ??
				callerIdentity("x-lanetally-parent-agent-id"),
			gateway_attempt_number:
				ordinal && /^\d{1,6}$/.test(ordinal) ? count(Number(ordinal)) : null,
			gateway_identity_source: "header_hint",
			identity_source: conversation
				? "caller"
				: session
					? "inferred"
					: "missing",
			path: context.path ?? "legacy",
			model_digest: hash(body.model),
			endpoint_digest: context.endpoint ? hash(context.endpoint) : null,
			cache_key_present:
				typeof body.prompt_cache_key === "string" &&
				body.prompt_cache_key.length > 0,
			previous_response_present:
				typeof body.previous_response_id === "string" &&
				body.previous_response_id.length > 0,
		};
		const skip = (reason: string) => {
			const facts = {
				...metadata,
				fingerprint_complete: false,
				input_items: Array.isArray(body.input) ? body.input.length : null,
			};
			this.lifecycle(facts);
			this.lifecycle({ ...facts, event: "coverage_gap", gap_reason: reason });
			this.retain(requestId, {
				facts,
				fingerprint: {
					group: "",
					requestDigest: hash(requestId),
					attemptDigest: metadata.attempt_digest as string,
					complete: false,
					dimensions: {},
					at: now,
					items: [],
					bytes: [],
					instructions: "",
					tools: "",
					key: "",
					parameters: "",
				},
			});
		};
		for (const [present, reason] of [
			[requestId, "missing_request_id"],
			[account, "missing_account"],
			[session, "missing_session"],
		]) {
			if (!present)
				this.lifecycle({
					...metadata,
					event: "coverage_gap",
					gap_reason: reason,
				});
		}
		if (!Array.isArray(body.input) || body.input.length > MAX_ITEMS) {
			skip(!Array.isArray(body.input) ? "invalid_input" : "item_limit");
			return;
		}
		const items: string[] = [];
		const bytes: number[] = [];
		let totalBytes = 0;
		for (const item of body.input) {
			const serialized = JSON.stringify(item);
			if (serialized === undefined) {
				skip("invalid_input");
				return;
			}
			const size = Buffer.byteLength(serialized);
			totalBytes += size;
			if (totalBytes > MAX_BYTES) {
				skip("byte_limit");
				return;
			}
			items.push(createHash("sha256").update(serialized).digest("hex"));
			bytes.push(size);
		}
		const {
			input: _input,
			instructions,
			tools,
			prompt_cache_key,
			...parameters
		} = body;
		const fingerprint: Fingerprint = {
			group: hash([account || requestId, session || requestId, body.model]),
			requestDigest: hash(requestId),
			attemptDigest: metadata.attempt_digest as string,
			complete: true,
			dimensions: {
				reasoning: hash(body.reasoning),
				text_format: hash(body.text),
				service_tier: hash(body.service_tier),
				cache_options: hash(body.prompt_cache_options),
				parallel_tools: hash(body.parallel_tool_calls),
				source_input: context.source ? hash(context.source.input) : null,
				source_instructions: context.source
					? hash(context.source.instructions)
					: null,
				source_tools: context.source ? hash(context.source.tools) : null,
			},
			items,
			bytes,
			at: now,
			instructions: hash(instructions),
			tools: hash(tools),
			key: hash(prompt_cache_key),
			parameters: hash(parameters),
		};
		let best: Fingerprint | undefined;
		let matchedItems = 0;
		let matchedBytes = 0;
		let candidates = 0;
		for (const prior of this.history) {
			if (prior.group !== fingerprint.group) continue;
			candidates++;
			let n = 0;
			let size = 0;
			while (
				n < items.length &&
				n < prior.items.length &&
				items[n] === prior.items[n]
			)
				size += bytes[n++];
			// On equal prefix overlap prefer the most recent completed candidate.
			if (!best || size >= matchedBytes) {
				best = prior;
				matchedItems = n;
				matchedBytes = size;
			}
		}
		const facts: Facts = {
			...metadata,
			event: "prepared",
			ts_ms: now,
			request_digest: fingerprint.requestDigest,
			comparison_group_digest: fingerprint.group,
			fingerprint_complete: true,
			inferred_conversation_digest: hash([
				session,
				fingerprint.instructions,
				items[0],
			]),
			input_digest: hash(items),
			instructions_digest: fingerprint.instructions,
			tools_digest: fingerprint.tools,
			cache_key_digest: fingerprint.key,
			parameters_digest: fingerprint.parameters,
			prior_candidates: candidates,
			prior_request_digest: best?.requestDigest ?? null,
			prior_attempt_digest: best?.attemptDigest ?? null,
			prior_age_ms: best ? now - best.at : null,
			input_items: items.length,
			input_bytes: totalBytes,
			matched_input_items: best ? matchedItems : null,
			matched_input_bytes: best ? matchedBytes : null,
			prior_input_items: best?.items.length ?? null,
			prior_input_prefix_preserved: best
				? matchedItems === best.items.length
				: null,
			instructions_changed: best
				? best.instructions !== fingerprint.instructions
				: null,
			tools_changed: best ? best.tools !== fingerprint.tools : null,
			cache_key_changed: best ? best.key !== fingerprint.key : null,
			parameters_changed: best
				? best.parameters !== fingerprint.parameters
				: null,
			cache_key_present:
				typeof prompt_cache_key === "string" && prompt_cache_key.length > 0,
		};
		for (const [name, digest] of Object.entries(fingerprint.dimensions)) {
			facts[`${name}_digest`] = digest;
			facts[`${name}_changed`] =
				best && best.dimensions[name] != null && digest != null
					? best.dimensions[name] !== digest
					: null;
		}
		this.lifecycle(facts);
		this.retain(requestId, { fingerprint, facts });
	}

	private retain(requestId: string, pending: Pending): void {
		this.pending.set(requestId, pending);
		while (this.pending.size > MAX_ENTRIES) {
			const oldest = this.pending.keys().next().value;
			if (oldest === undefined) break;
			this.abort(oldest, "coverage_gap", { gap_reason: "pending_evicted" });
		}
	}

	finish(
		requestId: string,
		usage: unknown,
		completed: boolean,
		response?: unknown,
	): void {
		this.sweep();
		const pending = this.pending.get(requestId);
		this.pending.delete(requestId);
		if (!pending || pending.fingerprint.at + TTL_MS <= this.now()) return;
		const raw =
			usage && typeof usage === "object"
				? (usage as Record<string, unknown>)
				: {};
		const details =
			raw.input_tokens_details && typeof raw.input_tokens_details === "object"
				? (raw.input_tokens_details as Record<string, unknown>)
				: {};
		const input = count(raw.input_tokens);
		const cached = count(details.cached_tokens);
		const outputDetails =
			raw.output_tokens_details && typeof raw.output_tokens_details === "object"
				? (raw.output_tokens_details as Record<string, unknown>)
				: {};
		const terminal =
			response && typeof response === "object"
				? (response as Record<string, unknown>)
				: {};
		const diagnostic =
			terminal.prompt_cache_diagnostics &&
			typeof terminal.prompt_cache_diagnostics === "object"
				? (terminal.prompt_cache_diagnostics as Record<string, unknown>)
				: {};
		// Never forward arbitrary provider strings: they may contain payloads.
		const diagnosticType =
			[
				"cache_miss",
				"cache_hit",
				"comparison_response_not_found",
				"unavailable",
			].find((value) => value === diagnostic.type) ?? null;
		const reason =
			[
				"model_changed",
				"prompt_cache_key_changed",
				"tools_changed",
				"text_format_changed",
				"reasoning_effort_changed",
				"verbosity_changed",
				"context_compacted",
				"input_changed",
				"service_tier_changed",
			].find((value) => value === diagnostic.reason) ?? null;
		this.emit({
			...pending.facts,
			event: completed ? "completed" : "incomplete",
			attempt_terminal: true,
			ts_ms: this.now(),
			duration_ms: this.now() - pending.fingerprint.at,
			completed,
			input_tokens: input,
			cached_tokens: cached,
			cache_write_tokens: count(details.cache_write_tokens),
			output_tokens: count(raw.output_tokens),
			reasoning_tokens: count(outputDetails.reasoning_tokens),
			upstream_response_digest:
				typeof terminal.id === "string" && terminal.id.length <= 256
					? hash(terminal.id)
					: null,
			upstream_cache_diagnostic_type: diagnosticType,
			upstream_cache_miss_reason:
				diagnosticType === "cache_miss" ? reason : null,
			upstream_cache_missed_tokens:
				diagnosticType === "cache_miss"
					? count(diagnostic.cache_missed_tokens)
					: null,
			upstream_comparison_reusable_tokens:
				diagnosticType === "cache_miss"
					? count(diagnostic.comparison_reusable_tokens)
					: null,
			cache_counters_known:
				input !== null && cached !== null && cached <= input,
		});
		if (completed && pending.fingerprint.complete) {
			pending.fingerprint.at = this.now();
			this.history.push(pending.fingerprint);
			if (this.history.length > MAX_ENTRIES) this.history.shift();
		}
	}

	abort(requestId: string, event: string, facts: Facts = {}): void {
		const pending = this.pending.get(requestId);
		this.pending.delete(requestId);
		if (pending)
			this.lifecycle({
				...pending.facts,
				...facts,
				event,
				attempt_terminal: true,
				ts_ms: this.now(),
				cache_counters_known: false,
				input_tokens: null,
				cached_tokens: null,
				cache_write_tokens: null,
				output_tokens: null,
				duration_ms: this.now() - pending.fingerprint.at,
			});
	}

	annotate(requestId: string, facts: Facts): void {
		const pending = this.pending.get(requestId);
		if (pending) Object.assign(pending.facts, facts);
	}

	gap(requestId: string | null, reason: string): void {
		this.lifecycle({
			...(requestId ? this.pending.get(requestId)?.facts : {}),
			event: "coverage_gap",
			ts_ms: this.now(),
			request_digest: requestId ? hash(requestId) : null,
			gap_reason: reason,
		});
	}

	forget(requestId: string): void {
		this.abort(requestId, "coverage_gap", { gap_reason: "missing_terminal" });
	}
}
