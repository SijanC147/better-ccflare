import { registerHeartbeat } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";

const log = new Logger("ServiceStatus");

/**
 * Atlassian Statuspage summary document for status.claude.com. `summary.json`
 * is fetched rather than `status.json` because the top-level indicator alone is
 * not usable here: on 2026-09-14 the page read `minor` solely because of
 * `Claude Cowork` on Windows, a surface this proxy never touches. Only the
 * per-component array can tell those apart.
 */
const SUMMARY_URL = "https://status.claude.com/api/v2/summary.json";
const PAGE_URL = "https://status.claude.com";
const REQUEST_TIMEOUT_MS = 5_000;
/** Quiet period after a failed refresh before another outbound call is made. */
const FAILURE_BACKOFF_MS = 60 * 1000;
/** Default poll cadence; `0` in the environment variable disables the poller. */
const DEFAULT_REFRESH_SECONDS = 300;
const REFRESH_SECONDS_ENV = "BETTER_CCFLARE_SERVICE_STATUS_REFRESH_SECONDS";
const MIN_INITIAL_DELAY_MS = 30 * 1000;
const MAX_INITIAL_DELAY_MS = 120 * 1000;
const DEFAULT_TICK_SECONDS = 60;
const SERVICE_STATUS_REFRESH_INTERVAL_ID = "service-status-refresh";

/**
 * The components of status.claude.com that sit on paths better-ccflare
 * forwards. Matched by Statuspage component id, with the display name as a
 * fallback so a regenerated id does not silently empty the filter.
 *
 * Deliberately excluded: `claude.ai` and `Claude Console
 * (platform.claude.com)` are first-party web surfaces, `Claude Cowork` is a
 * separate product, and `Claude for Government` is a separate deployment. An
 * incident on any of those moves the page's top-level indicator without
 * affecting a single request this proxy makes.
 */
const RELEVANT_COMPONENT_IDS: ReadonlySet<string> = new Set([
	// Claude API (api.anthropic.com)
	"k8w3r06qmzrp",
	// Claude Code
	"yyzkbfz2thpt",
]);
const RELEVANT_COMPONENT_NAMES: ReadonlySet<string> = new Set([
	"Claude API (api.anthropic.com)",
	"Claude Code",
]);

/**
 * Worst state observed across the components this proxy depends on.
 *
 * `unknown` exists because the dangerous failure of a filtered status feature
 * is a permanently green display. If Anthropic deletes, recreates or regroups a
 * component, every watched id disappears, the filter matches nothing, and an
 * empty match set is indistinguishable from "all operational". `unknown` makes
 * that case render something instead of nothing.
 */
export type ServiceStatusLevel =
	| "operational"
	| "degraded"
	| "outage"
	| "unknown";

export interface ServiceStatusComponent {
	id: string;
	name: string;
	/** Raw Statuspage component status, passed through unmapped. */
	status: string;
}

export interface ServiceStatusIncident {
	id: string;
	name: string;
	/** Statuspage incident status, e.g. `investigating`, `resolved`. */
	status: string;
	/** Statuspage impact, e.g. `none`, `minor`, `major`, `critical`. */
	impact: string;
	url: string | null;
}

export interface ServiceStatusSnapshot {
	level: ServiceStatusLevel;
	/** Every relevant component, whatever its state. */
	components: ServiceStatusComponent[];
	/** The relevant components that are not operational. */
	affected: ServiceStatusComponent[];
	/** Unresolved incidents touching at least one relevant component. */
	incidents: ServiceStatusIncident[];
	/**
	 * Watched component ids the page did not carry. Non-empty means the filter
	 * has drifted from the page and the snapshot is under-reporting. Surfaced in
	 * the endpoint rather than only logged, so it is visible.
	 */
	missingComponentIds: string[];
	/**
	 * The page's own top-level indicator, carried for reference only. The
	 * banner is keyed on `level`, never on this: they disagree whenever an
	 * irrelevant component is degraded.
	 */
	pageIndicator: string;
	pageUrl: string;
	checkedAt: number;
}

export interface ServiceStatusResult {
	snapshot: ServiceStatusSnapshot | null;
	/** True when the snapshot is a previous result served after a failure. */
	stale: boolean;
	/** Human-readable reason the last refresh failed, if it did. */
	error: string | null;
}

interface RawComponent {
	id?: unknown;
	name?: unknown;
	status?: unknown;
}

interface RawIncident {
	id?: unknown;
	name?: unknown;
	status?: unknown;
	impact?: unknown;
	shortlink?: unknown;
	components?: unknown;
}

interface RawSummary {
	status?: { indicator?: unknown; description?: unknown };
	components?: unknown;
	incidents?: unknown;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** True when a Statuspage component is one this proxy actually depends on. */
export function isRelevantComponent(component: {
	id: string;
	name: string;
}): boolean {
	return (
		RELEVANT_COMPONENT_IDS.has(component.id) ||
		RELEVANT_COMPONENT_NAMES.has(component.name)
	);
}

/**
 * Map a raw Statuspage component status onto the three levels the banner
 * understands. An unrecognised status that is not `operational` counts as
 * `degraded` rather than being ignored: a new Statuspage state should show
 * something, not nothing.
 */
function levelForComponentStatus(status: string): ServiceStatusLevel {
	if (status === "operational") return "operational";
	if (status === "major_outage" || status === "partial_outage") return "outage";
	return "degraded";
}

function worstLevel(
	a: ServiceStatusLevel,
	b: ServiceStatusLevel,
): ServiceStatusLevel {
	if (a === "outage" || b === "outage") return "outage";
	if (a === "degraded" || b === "degraded") return "degraded";
	if (a === "unknown" || b === "unknown") return "unknown";
	return "operational";
}

/**
 * Reduce a Statuspage summary document to the components this proxy depends
 * on. Exported for tests, which run against fixture JSON and never the live
 * page.
 */
export function buildSnapshot(
	payload: unknown,
	checkedAt: number,
): ServiceStatusSnapshot | null {
	if (typeof payload !== "object" || payload === null) return null;
	const summary = payload as RawSummary;
	if (!Array.isArray(summary.components)) return null;

	const components: ServiceStatusComponent[] = [];
	for (const raw of summary.components as RawComponent[]) {
		const id = asString(raw?.id);
		const name = asString(raw?.name);
		const status = asString(raw?.status);
		if (!id || !name || !status) continue;
		if (!isRelevantComponent({ id, name })) continue;
		components.push({ id, name, status });
	}

	const seenIds = new Set(components.map((component) => component.id));
	const missingComponentIds = [...RELEVANT_COMPONENT_IDS].filter(
		(id) => !seenIds.has(id),
	);

	let level: ServiceStatusLevel =
		components.length === 0 ? "unknown" : "operational";
	const affected: ServiceStatusComponent[] = [];
	for (const component of components) {
		const componentLevel = levelForComponentStatus(component.status);
		if (componentLevel !== "operational") affected.push(component);
		level = worstLevel(level, componentLevel);
	}
	if (missingComponentIds.length > 0) {
		log.warn(
			`status.claude.com no longer carries watched component id(s): ${missingComponentIds.join(", ")}. ` +
				"The service-status filter has drifted and is under-reporting.",
		);
	}

	const relevantIds = new Set(components.map((component) => component.id));
	const incidents: ServiceStatusIncident[] = [];
	if (Array.isArray(summary.incidents)) {
		for (const raw of summary.incidents as RawIncident[]) {
			const id = asString(raw?.id);
			const name = asString(raw?.name);
			if (!id || !name) continue;
			if (raw?.status === "resolved" || raw?.status === "postmortem") continue;
			const touches =
				Array.isArray(raw?.components) &&
				(raw.components as RawComponent[]).some((component) => {
					const componentId = asString(component?.id);
					const componentName = asString(component?.name);
					if (componentId && relevantIds.has(componentId)) return true;
					return (
						(componentId !== null || componentName !== null) &&
						isRelevantComponent({
							id: componentId ?? "",
							name: componentName ?? "",
						})
					);
				});
			if (!touches) continue;
			incidents.push({
				id,
				name,
				status: asString(raw?.status) ?? "unknown",
				impact: asString(raw?.impact) ?? "none",
				url: asString(raw?.shortlink),
			});
		}
	}

	return {
		level,
		components,
		affected,
		incidents,
		missingComponentIds,
		pageIndicator: asString(summary.status?.indicator) ?? "unknown",
		pageUrl: PAGE_URL,
		checkedAt,
	};
}

export interface ServiceStatusServiceOptions {
	/** How long a successful snapshot is served without re-querying. */
	refreshIntervalMs?: number;
	/** Injected for tests; defaults to `globalThis.fetch`. */
	fetchImpl?: typeof fetch;
	/** Injected for tests; defaults to `Date.now`. */
	now?: () => number;
}

/**
 * Caches the filtered status snapshot. Modelled on `VersionStatusService`:
 * in-memory snapshot with a TTL, single-flight refresh, a failure backoff, and
 * the last good snapshot served with `stale: true` rather than an error. A
 * status-page outage must never make this proxy look broken.
 */
export class ServiceStatusService {
	private snapshot: ServiceStatusSnapshot | null = null;
	private lastError: string | null = null;
	// `null`, not `0`: an injected clock legitimately reads 0, and a sentinel
	// of 0 would silently disable the brake at that instant.
	private lastFailureAt: number | null = null;
	private inFlight: Promise<ServiceStatusResult> | null = null;
	private readonly refreshIntervalMs: number;
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;

	constructor(options: ServiceStatusServiceOptions = {}) {
		this.refreshIntervalMs =
			options.refreshIntervalMs ?? DEFAULT_REFRESH_SECONDS * 1000;
		this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
		this.now = options.now ?? (() => Date.now());
	}

	getStatus(force = false): Promise<ServiceStatusResult> {
		const now = this.now();
		if (
			!force &&
			this.snapshot !== null &&
			now - this.snapshot.checkedAt < this.refreshIntervalMs
		) {
			return Promise.resolve({
				snapshot: this.snapshot,
				stale: false,
				error: null,
			});
		}
		// Brake on repeated failures, so a caller looping `?refresh=1` cannot
		// drive outbound requests at a status page that is already down.
		if (
			this.lastFailureAt !== null &&
			now - this.lastFailureAt < FAILURE_BACKOFF_MS
		) {
			return Promise.resolve({
				snapshot: this.snapshot,
				stale: this.snapshot !== null,
				error: this.lastError,
			});
		}
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.refresh().finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	private failure(message: string): ServiceStatusResult {
		this.lastError = message;
		this.lastFailureAt = this.now();
		log.warn(`Service status refresh failed: ${message}`);
		return {
			snapshot: this.snapshot,
			stale: this.snapshot !== null,
			error: message,
		};
	}

	private async refresh(): Promise<ServiceStatusResult> {
		let payload: unknown;
		try {
			const response = await this.fetchImpl(SUMMARY_URL, {
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (!response.ok) {
				return this.failure(`status.claude.com returned ${response.status}`);
			}
			payload = await response.json();
		} catch (error) {
			return this.failure(
				error instanceof Error ? error.message : String(error),
			);
		}

		const snapshot = buildSnapshot(payload, this.now());
		if (snapshot === null) {
			return this.failure("status.claude.com returned an unreadable payload");
		}

		this.lastError = null;
		this.lastFailureAt = null;
		this.snapshot = snapshot;
		return { snapshot, stale: false, error: null };
	}
}

let sharedService: ServiceStatusService | null = null;

/**
 * The one instance the router's handler and the server's poller share, so the
 * poller's fetches are what keep the handler's snapshot warm.
 */
export function getServiceStatusService(): ServiceStatusService {
	if (sharedService === null) sharedService = new ServiceStatusService();
	return sharedService;
}

/** Test cleanup only. */
export function resetServiceStatusServiceForTest(): void {
	sharedService = null;
}

function getRefreshSeconds(): number {
	const raw = process.env[REFRESH_SECONDS_ENV];
	if (raw === undefined || raw.trim() === "") return DEFAULT_REFRESH_SECONDS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) {
		log.warn(`Ignoring invalid ${REFRESH_SECONDS_ENV}=${raw}`);
		return DEFAULT_REFRESH_SECONDS;
	}
	return parsed;
}

export interface ServiceStatusRefreshTestOverrides {
	/** Override the random 30-120s initial-tick delay, for tests. */
	initialDelayMs?: number;
	/** Override the heartbeat tick interval (in seconds), for tests. */
	tickSeconds?: number;
}

/**
 * Keep the cached snapshot warm from the server so the dashboard never has to
 * wait on an outbound fetch. Shaped after `initModelCatalogRefresh`: a random
 * first tick so a fleet restart does not stampede the status page, then a
 * coarse `IntervalManager` heartbeat that only acts once the interval has
 * elapsed. Returns an unregister function for the shutdown sequence.
 */
export function initServiceStatusRefresh(
	service: ServiceStatusService,
	testOverrides?: ServiceStatusRefreshTestOverrides,
): () => void {
	const seconds = getRefreshSeconds();
	if (seconds <= 0) {
		log.info(`Service status polling disabled (${REFRESH_SECONDS_ENV}=0)`);
		return () => {};
	}

	let isRefreshing = false;
	let unregistered = false;

	const tick = async () => {
		if (isRefreshing || unregistered) return;
		isRefreshing = true;
		try {
			// The service owns the TTL and the failure backoff, so a tick that
			// arrives early is a no-op rather than an outbound request.
			await service.getStatus();
		} finally {
			isRefreshing = false;
		}
	};

	const initialDelayMs =
		testOverrides?.initialDelayMs ??
		MIN_INITIAL_DELAY_MS +
			Math.random() * (MAX_INITIAL_DELAY_MS - MIN_INITIAL_DELAY_MS);
	const initialTimeoutId = setTimeout(() => {
		void tick();
	}, initialDelayMs);

	const tickSeconds = testOverrides?.tickSeconds ?? DEFAULT_TICK_SECONDS;
	const unregisterHeartbeat = registerHeartbeat({
		id: SERVICE_STATUS_REFRESH_INTERVAL_ID,
		callback: tick,
		seconds: tickSeconds,
		description: `Claude service status check every ${tickSeconds}s (cadence ~${seconds}s)`,
	});

	return () => {
		unregistered = true;
		clearTimeout(initialTimeoutId);
		unregisterHeartbeat();
	};
}
