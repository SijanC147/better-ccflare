import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	renameSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";

export const CODEX_CACHE_TELEMETRY_PATH_ENV =
	"CCFLARE_CODEX_CACHE_TELEMETRY_PATH";
export type CacheFacts = Record<string, string | number | boolean | null>;

// This is a serialization allowlist, not just a TypeScript type. Arbitrary
// provider/caller strings and future fields cannot accidentally reach disk.
const digests = new Set([
	"request_digest",
	"ingress_digest",
	"attempt_digest",
	"gateway_request_digest",
	"gateway_attempt_digest",
	"upstream_request_digest",
	"upstream_response_digest",
	"prior_request_digest",
	"prior_attempt_digest",
	"account_digest",
	"session_digest",
	"comparison_group_digest",
	"conversation_digest",
	"agent_digest",
	"parent_agent_digest",
	"model_digest",
	"endpoint_digest",
	"input_digest",
	"instructions_digest",
	"tools_digest",
	"cache_key_digest",
	"parameters_digest",
	"source_input_digest",
	"source_instructions_digest",
	"source_tools_digest",
	"reasoning_digest",
	"text_format_digest",
	"service_tier_digest",
	"cache_options_digest",
	"parallel_tools_digest",
	"inferred_conversation_digest",
	"instance_digest",
]);
const counts = new Set([
	"ts_ms",
	"sequence",
	"observer_attempt_sequence",
	"gateway_attempt_number",
	"prior_age_ms",
	"prior_candidates",
	"input_items",
	"input_bytes",
	"matched_input_items",
	"matched_input_bytes",
	"prior_input_items",
	"input_tokens",
	"cached_tokens",
	"cache_write_tokens",
	"output_tokens",
	"reasoning_tokens",
	"upstream_cache_missed_tokens",
	"upstream_comparison_reusable_tokens",
	"status_code",
	"duration_ms",
	"pending_count",
	"history_count",
	"dropped_events",
	"rotations",
	"event_bytes",
	"observed_items",
]);
const flags = new Set([
	"completed",
	"attempt_terminal",
	"cache_counters_known",
	"cache_key_present",
	"prior_input_prefix_preserved",
	"instructions_changed",
	"tools_changed",
	"cache_key_changed",
	"parameters_changed",
	"reasoning_changed",
	"text_format_changed",
	"service_tier_changed",
	"cache_options_changed",
	"parallel_tools_changed",
	"source_input_changed",
	"source_instructions_changed",
	"source_tools_changed",
	"previous_response_present",
	"upstream_comparison_requested",
	"client_aborted",
	"fingerprint_complete",
	"retention_truncated",
]);
const enums: Record<string, readonly string[]> = {
	schema: ["codex.cache_event.v1"],
	event: [
		"observer_started",
		"observer_ready",
		"request_received",
		"request_identified",
		"request_headers",
		"request_error",
		"prepared",
		"completed",
		"incomplete",
		"coverage_gap",
		"upstream_error",
		"canceled",
		"timeout",
		"transport_error",
		"truncated",
		"rotation",
	],
	path: ["legacy", "native"],
	refusal_reason: ["pool_exhausted"],
	transport: ["sse", "http", "unknown"],
	identity_source: ["caller", "inferred", "missing"],
	gateway_identity_source: ["header_hint"],
	gap_reason: [
		"missing_request_id",
		"missing_account",
		"missing_session",
		"invalid_input",
		"item_limit",
		"byte_limit",
		"pending_evicted",
		"pending_expired",
		"replaced_attempt",
		"invalid_json",
		"missing_content_type",
		"missing_terminal",
		"stream_error",
		"native_parse_limit",
		"unobserved_attempt",
		"source_unobserved",
		"unsupported_content_type",
	],
	upstream_cache_diagnostic_type: [
		"cache_miss",
		"cache_hit",
		"comparison_response_not_found",
		"unavailable",
	],
	upstream_cache_miss_reason: [
		"model_changed",
		"prompt_cache_key_changed",
		"tools_changed",
		"text_format_changed",
		"reasoning_effort_changed",
		"verbosity_changed",
		"context_compacted",
		"input_changed",
		"service_tier_changed",
	],
};

export function cacheDigest(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(value ?? null))
		.digest("hex");
}

export function sanitizeCacheFacts(facts: CacheFacts): CacheFacts {
	const result: CacheFacts = {};
	for (const [key, value] of Object.entries(facts)) {
		if (!(digests.has(key) || counts.has(key) || flags.has(key) || enums[key]))
			continue;
		if (value === null) result[key] = null;
		else if (
			digests.has(key) &&
			typeof value === "string" &&
			/^[0-9a-f]{64}$/.test(value)
		)
			result[key] = value;
		else if (
			counts.has(key) &&
			typeof value === "number" &&
			Number.isSafeInteger(value) &&
			value >= 0
		)
			result[key] = value;
		else if (flags.has(key) && typeof value === "boolean") result[key] = value;
		else if (enums[key]?.includes(value as string)) result[key] = value;
	}
	return result;
}

/** Dedicated metadata journal: synchronous bounded writes + fsync make a
 * successful append survive process replacement. O_NOFOLLOW prevents a file
 * symlink from redirecting diagnostics. One writer owns each journal path.
 * Rotated files remain readable; rotation explicitly records retention loss.
 */
export class CacheTelemetryJournal {
	private sequence = 0;
	private rotations = 0;
	private dropped = 0;
	private started = false;
	private readonly instance = cacheDigest(randomUUID());
	constructor(
		private readonly path: string,
		private readonly onFailure: (dropped: number) => void,
		private readonly maxBytes = 16 * 1024 * 1024,
		private readonly retainedFiles = 4,
		private readonly now = Date.now,
	) {
		if (
			!Number.isSafeInteger(maxBytes) ||
			maxBytes < 1024 ||
			!Number.isSafeInteger(retainedFiles) ||
			retainedFiles < 2 ||
			retainedFiles > 16
		)
			throw new Error("invalid telemetry retention bounds");
	}

	private append(facts: CacheFacts): void {
		if (!isAbsolute(this.path))
			throw new Error("absolute telemetry path required");
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const fd = openSync(
			this.path,
			constants.O_CREAT |
				constants.O_APPEND |
				constants.O_WRONLY |
				constants.O_NOFOLLOW,
			0o600,
		);
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
				throw new Error("private regular telemetry file required");
			if (stat.size >= this.maxBytes) {
				const retentionTruncated = existsSync(
					`${this.path}.${this.retainedFiles - 1}`,
				);
				for (let i = this.retainedFiles - 1; i >= 1; i--) {
					const source = i === 1 ? this.path : `${this.path}.${i - 1}`;
					if (existsSync(source)) renameSync(source, `${this.path}.${i}`);
				}
				this.rotations++;
				this.append({
					event: "rotation",
					rotations: this.rotations,
					retention_truncated: retentionTruncated,
				});
				this.append(facts);
				return;
			}
			const event = sanitizeCacheFacts({
				...facts,
				schema: "codex.cache_event.v1",
				instance_digest: this.instance,
				ts_ms: this.now(),
				sequence: ++this.sequence,
				dropped_events: this.dropped,
			});
			const line = Buffer.from(`${JSON.stringify(event)}\n`);
			if (line.length > 16 * 1024) throw new Error("telemetry event limit");
			let offset = 0;
			while (offset < line.length) {
				const written = writeSync(fd, line, offset, line.length - offset);
				if (written <= 0) throw new Error("incomplete telemetry write");
				offset += written;
			}
			fsyncSync(fd);
			const directory = openSync(
				dirname(this.path),
				constants.O_RDONLY | constants.O_DIRECTORY,
			);
			try {
				fsyncSync(directory);
			} finally {
				closeSync(directory);
			}
		} finally {
			closeSync(fd);
		}
	}

	record(facts: CacheFacts): boolean {
		try {
			if (!this.started) {
				this.append({ event: "observer_started" });
				this.started = true;
			}
			this.append(facts);
			return true;
		} catch {
			this.dropped++;
			// Error text/paths are intentionally not emitted. The caller can expose
			// this counter through its logger/health surface without payloads.
			try {
				this.onFailure(this.dropped);
			} catch {
				/* telemetry never fails inference */
			}
			return false;
		}
	}
	status() {
		return {
			started: this.started,
			dropped_events: this.dropped,
			rotations: this.rotations,
		};
	}
}

let configuredPath: string | undefined;
let journal: CacheTelemetryJournal | undefined;
export function persistCacheTelemetry(
	facts: CacheFacts,
	onFailure: (dropped: number) => void,
): void {
	const path = process.env[CODEX_CACHE_TELEMETRY_PATH_ENV];
	if (!path) return;
	try {
		if (!journal || path !== configuredPath) {
			journal = new CacheTelemetryJournal(path, onFailure);
			configuredPath = path;
		}
		journal.record(facts);
	} catch {
		try {
			onFailure(1);
		} catch {
			/* observation is fail-open */
		}
	}
}
