import { createHash } from "node:crypto";

export const CODEX_CACHE_DIAGNOSTICS_ENV = "CCFLARE_CODEX_CACHE_DIAGNOSTICS";
const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 64;
const MAX_ITEMS = 2048;
const MAX_BYTES = 8 * 1024 * 1024;

type Fingerprint = {
	group: string;
	requestDigest: string;
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
	constructor(
		private emit: (facts: Facts) => void,
		private now = Date.now,
	) {}

	prepare(
		requestId: string,
		account: string,
		session: string,
		body: Record<string, unknown>,
	): void {
		const now = this.now();
		this.history = this.history.filter((row) => row.at + TTL_MS > now);
		for (const [id, row] of this.pending) {
			if (row.fingerprint.at + TTL_MS <= now) this.pending.delete(id);
		}
		this.pending.delete(requestId);
		if (
			!account ||
			!session ||
			!Array.isArray(body.input) ||
			body.input.length > MAX_ITEMS
		)
			return;
		const items: string[] = [];
		const bytes: number[] = [];
		let totalBytes = 0;
		for (const item of body.input) {
			const serialized = JSON.stringify(item);
			if (serialized === undefined) return;
			const size = Buffer.byteLength(serialized);
			totalBytes += size;
			if (totalBytes > MAX_BYTES) return;
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
			group: hash([account, session, body.model]),
			requestDigest: hash(requestId),
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
			request_digest: fingerprint.requestDigest,
			session_digest: fingerprint.group,
			prior_candidates: candidates,
			prior_request_digest: best?.requestDigest ?? null,
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
		this.pending.set(requestId, { fingerprint, facts });
		while (this.pending.size > MAX_ENTRIES) {
			const oldest = this.pending.keys().next().value;
			if (oldest === undefined) break;
			this.pending.delete(oldest);
		}
	}

	finish(
		requestId: string,
		usage: unknown,
		completed: boolean,
		response?: unknown,
	): void {
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
		if (completed) {
			pending.fingerprint.at = this.now();
			this.history.push(pending.fingerprint);
			if (this.history.length > MAX_ENTRIES) this.history.shift();
		}
	}

	forget(requestId: string): void {
		this.pending.delete(requestId);
	}
}
