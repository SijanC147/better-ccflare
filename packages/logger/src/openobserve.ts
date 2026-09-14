import type { LogEvent } from "@better-ccflare/types";
import { logBus } from "./log-bus";

/**
 * Ships application logs and full request/response records to an OpenObserve
 * instance over its plain JSON bulk endpoint:
 *
 *   POST {baseUrl}/api/{org}/{stream}/_json
 *   Authorization: Basic base64(user:token)
 *   Content-Type: application/json
 *   [ {...}, {...} ]
 *
 * Matching the OpenTelemetry wire format is deliberately not attempted. The
 * bulk endpoint was verified against a live instance: `_timestamp` in
 * milliseconds is accepted, and a record without one is stamped at ingest.
 *
 * This module lives in the logger package because it subscribes to `logBus`,
 * and it is configured by a getter pushed in at startup rather than by reading
 * the config package, which would be an import cycle.
 *
 * It must never call `Logger`: a log line emitted from the exporter would come
 * straight back through `logBus` and feed itself. Failures go to `console.warn`
 * on a throttle instead.
 */
export interface OpenObserveSettings {
	/** Base URL with no trailing slash, e.g. `http://host:5080`. */
	baseUrl: string;
	org: string;
	user: string;
	token: string;
	/** Stream that receives application log lines. */
	logStream: string;
	/** Stream that receives one record per proxied request. */
	requestStream: string;
	/**
	 * Whether request records carry the request and response bodies. Separate
	 * from the endpoint being configured on purpose: shipping bodies off the
	 * box is a different decision from shipping log lines.
	 */
	shipPayloads: boolean;
	/**
	 * Lowest level that reaches the log stream, by name: DEBUG, INFO, WARN or
	 * ERROR. Carried as a string rather than a parsed rank so the one place that
	 * can safely report a bad value is the one that parses it. This module warns
	 * on `console.warn` and never through `Logger`, which would feed itself.
	 *
	 * An unrecognized name falls back to INFO rather than dropping everything.
	 * The failure to avoid is a typo turning the log stream off, which looks
	 * exactly like a working exporter with nothing to say.
	 *
	 * Applies to the log stream only. Request records carry no level and are
	 * the other half of the feature.
	 */
	logMinLevel: string;
}

// Bound both buffers by count and by bytes, mirroring MAX_ACTIVE_PAYLOAD_BYTES
// in usage-collector.ts. Over the bound, the oldest records are dropped and
// counted: an unreachable endpoint must not become a second retention path.
const MAX_BUFFER_RECORDS = 1000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_BATCH_RECORDS = 100;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const FLUSH_INTERVAL_MS = 2000;
const REQUEST_TIMEOUT_MS = 10_000;
const WARN_THROTTLE_MS = 60_000;

interface BufferedRecord {
	json: string;
	bytes: number;
}

interface StreamBuffer {
	records: BufferedRecord[];
	bytes: number;
	dropped: number;
}

function emptyBuffer(): StreamBuffer {
	return { records: [], bytes: 0, dropped: 0 };
}

let getSettings: (() => OpenObserveSettings | null) | null = null;
let subscribed = false;
let timer: ReturnType<typeof setInterval> | null = null;
let flushing = false;
let lastWarnAt = 0;
let warnsSuppressed = 0;

const logBuffer = emptyBuffer();
const requestBuffer = emptyBuffer();

function warnThrottled(message: string): void {
	const now = Date.now();
	if (now - lastWarnAt < WARN_THROTTLE_MS) {
		warnsSuppressed++;
		return;
	}
	const suffix =
		warnsSuppressed > 0 ? ` (${warnsSuppressed} similar suppressed)` : "";
	lastWarnAt = now;
	warnsSuppressed = 0;
	console.warn(`[openobserve] ${message}${suffix}`);
}

function currentSettings(): OpenObserveSettings | null {
	if (!getSettings) return null;
	try {
		const settings = getSettings();
		if (!settings) return null;
		// An endpoint being configured is the switch. Credentials are optional:
		// an instance may sit behind something else that authenticates.
		if (!settings.baseUrl || !settings.org) return null;
		return settings;
	} catch {
		return null;
	}
}

/** Whether request records should carry bodies right now. */
export function openObserveShipsPayloads(): boolean {
	const settings = currentSettings();
	return settings !== null && settings.shipPayloads;
}

/** Whether anything is being shipped right now. */
export function openObserveEnabled(): boolean {
	return currentSettings() !== null;
}

function enqueue(buffer: StreamBuffer, value: unknown): void {
	let json: string;
	try {
		json = JSON.stringify(value);
	} catch {
		// A record that cannot be serialized is dropped rather than retried.
		buffer.dropped++;
		return;
	}
	const bytes = Buffer.byteLength(json);
	if (bytes > MAX_BUFFER_BYTES) {
		buffer.dropped++;
		return;
	}
	buffer.records.push({ json, bytes });
	buffer.bytes += bytes;
	while (
		buffer.records.length > MAX_BUFFER_RECORDS ||
		buffer.bytes > MAX_BUFFER_BYTES
	) {
		const evicted = buffer.records.shift();
		if (!evicted) break;
		buffer.bytes -= evicted.bytes;
		buffer.dropped++;
	}
	startTimer();
}

function startTimer(): void {
	if (timer) return;
	timer = setInterval(() => {
		void flush();
	}, FLUSH_INTERVAL_MS);
	// Never hold the process (or a test run) open on the exporter's account.
	timer.unref?.();
}

function stopTimer(): void {
	if (!timer) return;
	clearInterval(timer);
	timer = null;
}

function takeBatch(buffer: StreamBuffer): BufferedRecord[] {
	const batch: BufferedRecord[] = [];
	let bytes = 0;
	while (buffer.records.length > 0 && batch.length < MAX_BATCH_RECORDS) {
		const next = buffer.records[0];
		if (batch.length > 0 && bytes + next.bytes > MAX_BATCH_BYTES) break;
		buffer.records.shift();
		buffer.bytes -= next.bytes;
		batch.push(next);
		bytes += next.bytes;
	}
	return batch;
}

async function post(
	settings: OpenObserveSettings,
	stream: string,
	batch: BufferedRecord[],
): Promise<void> {
	const url = `${settings.baseUrl.replace(/\/+$/, "")}/api/${encodeURIComponent(
		settings.org,
	)}/${encodeURIComponent(stream)}/_json`;
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (settings.user || settings.token) {
		const basic = Buffer.from(`${settings.user}:${settings.token}`).toString(
			"base64",
		);
		headers.Authorization = `Basic ${basic}`;
	}
	const body = `[${batch.map((r) => r.json).join(",")}]`;
	const response = await fetch(url, {
		method: "POST",
		headers,
		body,
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		// The URL is safe to report; the Authorization header is never included.
		throw new Error(`${stream} responded ${response.status}`);
	}
	// Drain the body so the connection can be reused.
	await response.text().catch(() => "");
}

/**
 * Send everything buffered. Records in a batch that fails are dropped, not
 * retried: retry semantics are deliberately out of scope, and a retry queue
 * would be the second retention path this exporter exists to avoid.
 */
export async function flush(): Promise<void> {
	if (flushing) return;
	const settings = currentSettings();
	if (!settings) {
		// Not configured (any more). Discard rather than grow.
		logBuffer.records = [];
		logBuffer.bytes = 0;
		requestBuffer.records = [];
		requestBuffer.bytes = 0;
		stopTimer();
		return;
	}
	flushing = true;
	try {
		for (const [buffer, stream] of [
			[logBuffer, settings.logStream] as const,
			[requestBuffer, settings.requestStream] as const,
		]) {
			if (!stream) {
				buffer.records = [];
				buffer.bytes = 0;
				continue;
			}
			while (buffer.records.length > 0) {
				const batch = takeBatch(buffer);
				if (batch.length === 0) break;
				try {
					await post(settings, stream, batch);
				} catch (error) {
					const reason =
						error instanceof Error ? error.message : "unknown error";
					warnThrottled(
						`dropped ${batch.length} record(s) for stream ${stream}: ${reason}`,
					);
					break;
				}
			}
			if (buffer.dropped > 0) {
				warnThrottled(
					`dropped ${buffer.dropped} record(s) for stream ${stream} under buffer pressure`,
				);
				buffer.dropped = 0;
			}
		}
	} finally {
		flushing = false;
		if (logBuffer.records.length === 0 && requestBuffer.records.length === 0) {
			stopTimer();
		}
	}
}

// Ranks, not the LogLevel enum from ./index, which would be an import cycle:
// index.ts owns Logger and this module is subscribed from the same package.
const LEVEL_RANK: Record<string, number> = {
	DEBUG: 0,
	INFO: 1,
	WARN: 2,
	ERROR: 3,
};
const DEFAULT_MIN_LEVEL_RANK = LEVEL_RANK.INFO;

// One warning per distinct bad value, not per event: a misconfigured level is
// on every log line, and warnThrottled's shared window would then suppress the
// exporter's real failures for a minute at a time.
const warnedBadLevels = new Set<string>();

/**
 * Rank of a configured minimum level. An unrecognized name warns once and
 * falls back to the default rather than filtering everything out.
 */
function minLevelRank(configured: string): number {
	const key = configured.trim().toUpperCase();
	if (!key) return DEFAULT_MIN_LEVEL_RANK;
	const rank = LEVEL_RANK[key];
	if (rank !== undefined) return rank;
	if (!warnedBadLevels.has(key)) {
		warnedBadLevels.add(key);
		console.warn(
			`[openobserve] unrecognized log min level ${JSON.stringify(key)}; shipping at INFO and above`,
		);
	}
	return DEFAULT_MIN_LEVEL_RANK;
}

function onLog(event: LogEvent): void {
	const settings = currentSettings();
	if (!settings) return;
	// Filter before the record is built, so a filtered event costs only the
	// comparison. Read through currentSettings() so a level changed in the
	// dashboard takes effect with no restart.
	const eventRank = LEVEL_RANK[event.level];
	if (eventRank !== undefined && eventRank < minLevelRank(settings.logMinLevel))
		return;
	enqueue(logBuffer, {
		_timestamp: event.ts,
		level: event.level,
		msg: event.msg,
		// Nested objects are flattened into columns by OpenObserve, and log data
		// is arbitrarily shaped, so it is shipped as a string.
		data: event.data === undefined ? undefined : safeStringify(event.data),
		service: "better-ccflare",
	});
}

function safeStringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return "[unserializable]";
	}
}

/**
 * Install the settings getter. A getter rather than a value so a change made
 * through the dashboard takes effect without a restart. Passing `null` turns
 * the exporter off and discards whatever is buffered.
 */
export function configureOpenObserve(
	getter: (() => OpenObserveSettings | null) | null,
): void {
	getSettings = getter;
	if (!getter) {
		stopTimer();
		logBuffer.records = [];
		logBuffer.bytes = 0;
		requestBuffer.records = [];
		requestBuffer.bytes = 0;
		return;
	}
	if (!subscribed) {
		logBus.on("log", onLog);
		subscribed = true;
	}
}

/**
 * Ship one request record. Called from the proxy's usage collector at the
 * point the payload would otherwise be dropped, so "not persisted locally"
 * holds by construction.
 */
export function shipRequestRecord(record: Record<string, unknown>): void {
	if (!currentSettings()) return;
	enqueue(requestBuffer, { _timestamp: Date.now(), ...record });
}

/** Test seam: buffered counts, without exposing the records. */
export function openObserveBufferSizes(): {
	logs: number;
	requests: number;
} {
	return {
		logs: logBuffer.records.length,
		requests: requestBuffer.records.length,
	};
}
