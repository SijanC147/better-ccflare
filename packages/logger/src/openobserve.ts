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
 * The byte accounting holds by construction rather than by test, which is the
 * only kind of argument available for it: every write to a buffer's `records`
 * or `bytes` lives in one of five functions (`resetBuffer`, `evictOverflow`,
 * `enqueue`, `requeue`, `takeBatch`), in each the array mutation and the byte
 * adjustment are adjacent statements with no branch between them, and every
 * `await` in this module is inside `post` or `flush` and never inside one of
 * those five. So no mutator can be observed part-way through, and
 * `bytes === sum(records[i].bytes)` survives any interleaving. Keep that true
 * when editing: putting an `await` inside a mutator breaks it silently.
 *
 * A batch that fails for a transient reason is kept and sent again later, but
 * there is no retry queue: the batch goes back into the same bounded buffer it
 * came from. That is the whole of the retry design, and it is what keeps the
 * one constraint the exporter is built around. Records still evict oldest-first
 * under pressure, so this stream is lossy by design and is not a record of
 * anything that must survive.
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

// Longest a stream waits between attempts. Held as a constant rather than a
// config key on purpose: an OpenObserve key costs five files plus the API
// catalog plus the dashboard card, and a retry cadence is not a thing an
// operator has any reason to tune.
const MAX_RETRY_BACKOFF_MS = 60_000;

// Attempts a single batch gets before it is dropped rather than put back.
//
// Without this, retry-to-front introduces head-of-line blocking that dropping
// never had. `takeBatch` takes an oversized record alone, so one 15MB record is
// one 15MB body; if the endpoint answers it with a 5xx rather than a 413 it is
// retryable, returns to the front, and is taken first by every later flush
// while the `break` stops the stream behind it. The stream would then ship
// nothing until 1000 newer records evicted the poison batch, and
// `consecutiveFailures` cannot tell "the endpoint is down" from "this batch is
// bad". Six attempts is where the backoff reaches its cap, so by here the
// stream has been failing for roughly two minutes. Bounded loss is the
// contract this exporter already advertises; an unbounded stall is not.
const MAX_BATCH_ATTEMPTS = 6;

interface BufferedRecord {
	json: string;
	bytes: number;
}

interface StreamBuffer {
	records: BufferedRecord[];
	bytes: number;
	dropped: number;
	/**
	 * Failed attempts since the last success, which is what the backoff window
	 * is computed from. Reset by a success, and by a failure that is not worth
	 * retrying.
	 */
	consecutiveFailures: number;
	/**
	 * Epoch milliseconds before which this stream is not attempted again. Zero
	 * means no window is open.
	 */
	retryAfter: number;
}

function emptyBuffer(): StreamBuffer {
	return {
		records: [],
		bytes: 0,
		dropped: 0,
		consecutiveFailures: 0,
		retryAfter: 0,
	};
}

/**
 * Discard everything a buffer holds, including its retry state. Used when the
 * exporter is turned off or a stream is unconfigured: the new settings must
 * not inherit a window the old ones opened.
 */
function resetBuffer(buffer: StreamBuffer): void {
	buffer.records = [];
	buffer.bytes = 0;
	buffer.dropped = 0;
	buffer.consecutiveFailures = 0;
	buffer.retryAfter = 0;
}

/**
 * The only thing in this module that discards records under pressure, and the
 * reason retry does not need a queue of its own: a deferred batch goes back
 * into this buffer and is bounded by exactly the same rule as a new record.
 */
function evictOverflow(buffer: StreamBuffer): void {
	while (
		buffer.records.length > MAX_BUFFER_RECORDS ||
		buffer.bytes > MAX_BUFFER_BYTES
	) {
		const evicted = buffer.records.shift();
		if (!evicted) break;
		buffer.bytes -= evicted.bytes;
		buffer.dropped++;
	}
}

/** An HTTP response the endpoint actually produced, carrying its status. */
class OpenObserveHttpError extends Error {
	readonly status: number;
	constructor(stream: string, status: number) {
		// The URL is safe to report; the Authorization header is never included.
		super(`${stream} responded ${status}`);
		this.name = "OpenObserveHttpError";
		this.status = status;
	}
}

/**
 * A base URL that cannot be parsed. Permanent until an operator changes the
 * setting, so it is never retried.
 */
class OpenObserveConfigError extends Error {
	constructor(stream: string, baseUrl: string) {
		super(`${stream} has an unusable base URL ${JSON.stringify(baseUrl)}`);
		this.name = "OpenObserveConfigError";
	}
}

/**
 * Whether sending the same batch again could plausibly work.
 *
 * A throw means no response existed at all: DNS, a refused connection, TLS,
 * or the request timeout firing. Those are transient by nature, so they are
 * retried.
 *
 * With a response, only 429 and 5xx are. Every other 4xx is the caller's
 * fault and will not become right by being repeated: a 401 retried every two
 * seconds is a flood against an endpoint already rejecting us, and a 413 is
 * futile because the batch is the same size next time. Those drop exactly as
 * they did before retry existed.
 */
function isRetryable(error: unknown): boolean {
	if (error instanceof OpenObserveConfigError) return false;
	if (error instanceof OpenObserveHttpError) {
		return error.status === 429 || error.status >= 500;
	}
	return true;
}

let getSettings: (() => OpenObserveSettings | null) | null = null;
let subscribed = false;
let timer: ReturnType<typeof setInterval> | null = null;
let flushing = false;
// The promise of the pass currently running, so a forced flush can wait for it
// rather than silently returning while it holds `flushing`.
let inFlight: Promise<void> | null = null;
let lastWarnAt = 0;
let warnsSuppressed = 0;

const logBuffer = emptyBuffer();
const requestBuffer = emptyBuffer();

/**
 * Warn at most once per window. Returns whether the message was actually
 * emitted, so a caller carrying a number in it can keep that number for the
 * next attempt instead of discarding it into a suppressed message.
 */
function warnThrottled(message: string): boolean {
	const now = Date.now();
	if (now - lastWarnAt < WARN_THROTTLE_MS) {
		warnsSuppressed++;
		return false;
	}
	const suffix =
		warnsSuppressed > 0 ? ` (${warnsSuppressed} similar suppressed)` : "";
	lastWarnAt = now;
	warnsSuppressed = 0;
	console.warn(`[openobserve] ${message}${suffix}`);
	return true;
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
	evictOverflow(buffer);
	startTimer();
}

/**
 * Put a batch that could not be sent back where it came from: the front of
 * its own buffer, so ordering is preserved and the records stay the oldest,
 * which makes them the first evicted if the buffer is under pressure. Their
 * `_timestamp` is untouched, so a record shipped late is still indexed at the
 * time it happened.
 */
function requeue(buffer: StreamBuffer, batch: BufferedRecord[]): void {
	buffer.records.unshift(...batch);
	for (const record of batch) buffer.bytes += record.bytes;
	evictOverflow(buffer);
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
	// Reject a malformed base URL here rather than letting `fetch` throw, which
	// is indistinguishable from a network failure and would therefore be
	// retried forever: the records would never ship and would evict real ones
	// behind them while the warning promised another attempt in 60s. A typo in
	// the configured URL is permanent until an operator fixes it, so it drops.
	try {
		new URL(url);
	} catch {
		throw new OpenObserveConfigError(stream, settings.baseUrl);
	}
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
		throw new OpenObserveHttpError(stream, response.status);
	}
	// Drain the body so the connection can be reused.
	await response.text().catch(() => "");
}

/**
 * Handle a batch the endpoint did not take.
 *
 * A retryable failure puts the batch back on the front of its buffer and opens
 * a backoff window on that stream. Anything else drops the batch, which is
 * what every failure did before retry existed.
 */
function handleFailedBatch(
	buffer: StreamBuffer,
	stream: string,
	batch: BufferedRecord[],
	error: unknown,
): void {
	const reason = error instanceof Error ? error.message : "unknown error";
	if (!isRetryable(error)) {
		// Not a transient fault, so no window is opened: the next tick should be
		// free to drain whatever is behind this batch rather than wait out a
		// clock set for a failure nobody is retrying.
		buffer.consecutiveFailures = 0;
		buffer.retryAfter = 0;
		warnThrottled(
			`dropped ${batch.length} record(s) for stream ${stream}: ${reason}`,
		);
		return;
	}
	buffer.consecutiveFailures++;
	const wait = Math.min(
		FLUSH_INTERVAL_MS * 2 ** (buffer.consecutiveFailures - 1),
		MAX_RETRY_BACKOFF_MS,
	);
	buffer.retryAfter = Date.now() + wait;
	if (buffer.consecutiveFailures >= MAX_BATCH_ATTEMPTS) {
		// Out of attempts. Drop this batch instead of returning it to the front,
		// where it would be taken first every time and stall everything behind
		// it. Counted as a drop so the loss is reported, not silent.
		buffer.dropped += batch.length;
		warnThrottled(
			`dropped ${batch.length} record(s) for stream ${stream} after ${buffer.consecutiveFailures} attempts: ${reason}`,
		);
		return;
	}
	requeue(buffer, batch);
	// Fold the eviction count into this one message rather than leaving it to
	// the separate buffer-pressure warning. Both go through the same 60s
	// throttle window, and this one is emitted first on every attempting tick,
	// so the pressure warning would always be the suppressed one. Losing
	// records must not be the half that goes unreported.
	const lost = buffer.dropped;
	// "lost", not "evicted": buffer.dropped also counts the unserializable and
	// oversized records enqueue rejected outright, which were never in the
	// buffer to be evicted from it.
	const losses = lost > 0 ? `; ${lost} older record(s) lost` : "";
	const emitted = warnThrottled(
		`deferring ${batch.length} record(s) for stream ${stream}: ${reason}; next attempt in ${Math.round(wait / 1000)}s${losses}`,
	);
	// Only clear the count once it has actually reached an operator. At the
	// 60s backoff cap this message lands right on the throttle boundary, so
	// zeroing unconditionally would discard the loss figure into a suppressed
	// message and report it nowhere.
	if (emitted) buffer.dropped = 0;
}

/**
 * Send everything buffered.
 *
 * A batch that fails for a transient reason is kept and tried again on a
 * later tick. It is kept in the same bounded buffer it came from, which is
 * what stops retry becoming the second retention path this exporter exists to
 * avoid: a deferred batch competes for the same thousand records as a new one
 * and, being the oldest, loses first. Nothing is written to disk, nothing is
 * held outside the bound, and an endpoint that stays down still costs a fixed
 * ceiling of memory.
 *
 * Pass `force` to ignore an open backoff window for one attempt. That is for
 * the flush at shutdown, where the alternative to trying is losing the records
 * outright.
 */
export async function flush(force = false): Promise<void> {
	// A forced flush must not be defeated by a tick already in progress. The
	// timer-driven pass can be sitting in `post` for up to REQUEST_TIMEOUT_MS
	// against the failing endpoint, and it has already skipped every stream in
	// backoff, so returning early here would let shutdown proceed and lose
	// exactly the records `force` exists to save. Wait for it, then run.
	if (flushing) {
		if (!force) return;
		await inFlight?.catch(() => {});
		if (flushing) return;
	}
	const run = runFlush(force);
	inFlight = run;
	try {
		await run;
	} finally {
		if (inFlight === run) inFlight = null;
	}
}

async function runFlush(force: boolean): Promise<void> {
	const settings = currentSettings();
	if (!settings) {
		// Not configured (any more). Discard rather than grow.
		resetBuffer(logBuffer);
		resetBuffer(requestBuffer);
		stopTimer();
		return;
	}
	flushing = true;
	try {
		const now = Date.now();
		for (const [buffer, stream] of [
			[logBuffer, settings.logStream] as const,
			[requestBuffer, settings.requestStream] as const,
		]) {
			if (!stream) {
				resetBuffer(buffer);
				continue;
			}
			// Each stream carries its own window: one failing endpoint must not
			// hold up the other, and they can fail for unrelated reasons.
			if (!force && buffer.retryAfter > now) continue;
			while (buffer.records.length > 0) {
				const batch = takeBatch(buffer);
				if (batch.length === 0) break;
				try {
					await post(settings, stream, batch);
					buffer.consecutiveFailures = 0;
					buffer.retryAfter = 0;
				} catch (error) {
					handleFailedBatch(buffer, stream, batch, error);
					// Stop after one failure. Continuing would re-take the batch
					// just put back and spin against an endpoint already failing.
					break;
				}
			}
			if (buffer.dropped > 0) {
				// Same rule as the deferral message: keep the count until it has
				// been reported, rather than losing it to a suppressed warning.
				const emitted = warnThrottled(
					`dropped ${buffer.dropped} record(s) for stream ${stream} under buffer pressure`,
				);
				if (emitted) buffer.dropped = 0;
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
		resetBuffer(logBuffer);
		resetBuffer(requestBuffer);
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

/**
 * Test seam: reset the warning throttle to a given "last warned at".
 *
 * The throttle's state is module-level and outlives any one test. A test that
 * controls `Date.now` and does not reset this can read `now - lastWarnAt` as
 * negative against a stamp left by an earlier test, suppress the warning it is
 * asserting on, and pass while checking nothing.
 */
export function resetWarnThrottleForTests(lastWarnedAt = 0): void {
	lastWarnAt = lastWarnedAt - WARN_THROTTLE_MS - 1;
	warnsSuppressed = 0;
	warnedBadLevels.clear();
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
