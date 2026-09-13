import { Logger } from "@better-ccflare/logger";
import {
	FORK_REPO,
	releaseUrl,
	SYNC_BRANCH_PREFIX,
	UPSTREAM_REPO,
} from "./fork-identity";

const log = new Logger("VersionStatus");

const GITHUB_API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 5_000;
/** How long a successful snapshot is served without re-querying GitHub. */
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
/** Upstream releases inspected when resolving the merged tag. */
const ANCESTRY_RELEASE_PAGE_SIZE = 30;
/** Hard cap on compare calls spent resolving the merged tag. */
const ANCESTRY_COMPARE_BUDGET = 10;
/** Quiet period after a refresh in which every GitHub call failed. */
const FAILURE_BACKOFF_MS = 60 * 1000;

export interface ForkStatus {
	/** Latest published release tag of this fork, e.g. "v3.9.0". */
	latestTag: string;
	latestTagUrl: string;
	updateAvailable: boolean;
}

export interface UpstreamStatus {
	/** Newest upstream release tag. */
	latestTag: string | null;
	latestTagUrl: string | null;
	/** Newest upstream release tag that is an ancestor of the merged sha. */
	mergedTag: string | null;
	mergedTagUrl: string | null;
	/** Commits on upstream's default branch not present in the merged sha. */
	commitsBehind: number | null;
}

export interface SyncPullRequest {
	number: number;
	url: string;
	title: string;
	headRef: string;
	draft: boolean;
}

export interface RemoteSnapshot {
	fork: ForkStatus | null;
	upstream: UpstreamStatus | null;
	syncPr: SyncPullRequest | null;
	checkedAt: number;
}

export interface VersionStatusResult {
	snapshot: RemoteSnapshot | null;
	/** True when the snapshot is a previous result served after a failure. */
	stale: boolean;
	/** Human-readable reason the last refresh failed, if it did. */
	error: string | null;
}

export interface VersionStatusServiceOptions {
	/** Current local version, with or without a leading "v". */
	currentVersion: string;
	/** Upstream sha recorded as merged into this fork, or null if unknown. */
	mergedSha: string | null;
	fetchImpl?: typeof fetch;
	now?: () => number;
	/**
	 * GitHub token used only to raise the rate limit. Never returned by an
	 * endpoint and never logged.
	 */
	token?: string;
	refreshIntervalMs?: number;
}

interface GithubResponse<T> {
	ok: boolean;
	status: number;
	data: T | null;
	/** Epoch millis until which requests are pointless, when rate-limited. */
	rateLimitedUntil: number | null;
	error: string | null;
}

/** Compare two dotted numeric versions; true when `latest` is greater. */
export function isNewerVersion(latest: string, current: string): boolean {
	const strip = (value: string) => value.replace(/^v/, "").split("-")[0] ?? "";
	const latestParts = strip(latest).split(".").map(Number);
	const currentParts = strip(current).split(".").map(Number);
	const length = Math.max(latestParts.length, currentParts.length);
	for (let index = 0; index < length; index++) {
		const a = latestParts[index] ?? 0;
		const b = currentParts[index] ?? 0;
		if (Number.isNaN(a) || Number.isNaN(b)) return false;
		if (a > b) return true;
		if (a < b) return false;
	}
	return false;
}

/**
 * Aggregates the fork's release state, the upstream sync gap and any open sync
 * PR into one snapshot.
 *
 * Every field degrades independently: one failing GitHub call nulls its own
 * section and leaves the rest intact, and a total failure serves the previous
 * snapshot marked stale. The caller always gets a 200 so the dashboard sidebar
 * can render local identity regardless of GitHub reachability.
 */
export class VersionStatusService {
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;
	private readonly token: string | undefined;
	private readonly refreshIntervalMs: number;
	private readonly currentVersion: string;
	private readonly mergedSha: string | null;

	private snapshot: RemoteSnapshot | null = null;
	private lastError: string | null = null;
	private rateLimitedUntil = 0;
	private lastFailureAt = 0;
	private inFlight: Promise<VersionStatusResult> | null = null;
	/** Merged-tag resolution is fixed for the process lifetime once known. */
	private mergedTagResolved = false;
	private mergedTag: string | null = null;

	constructor(options: VersionStatusServiceOptions) {
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.now = options.now ?? Date.now;
		this.token = options.token;
		this.refreshIntervalMs = options.refreshIntervalMs ?? REFRESH_INTERVAL_MS;
		this.currentVersion = options.currentVersion;
		this.mergedSha = options.mergedSha;
	}

	/** True when a token is configured, for reporting without revealing it. */
	hasToken(): boolean {
		return Boolean(this.token);
	}

	async getStatus(force = false): Promise<VersionStatusResult> {
		const now = this.now();
		if (
			!force &&
			this.snapshot &&
			now - this.snapshot.checkedAt < this.refreshIntervalMs
		) {
			return { snapshot: this.snapshot, stale: false, error: null };
		}
		if (now < this.rateLimitedUntil) {
			return {
				snapshot: this.snapshot,
				stale: this.snapshot !== null,
				error: `GitHub rate limit exceeded; retrying after ${new Date(
					this.rateLimitedUntil,
				).toISOString()}`,
			};
		}
		// Back off after a total failure. The snapshot TTL above cannot cover this
		// case: with no snapshot to serve, every call would otherwise fire a fresh
		// round of outbound requests, and /api/version/check reaches this service
		// without authentication. A DNS failure, timeout or 5xx sets no rate-limit
		// header, so this is the only thing bounding that.
		//
		// Applies to a forced refresh too. `force` is meant to skip the freshness
		// TTL, not the failure brake: on an install with no API keys configured
		// every /api route is open, so an exempt caller looping ?refresh=1 would
		// otherwise drive outbound requests with nothing damping them.
		if (
			this.lastFailureAt !== 0 &&
			now - this.lastFailureAt < FAILURE_BACKOFF_MS
		) {
			return {
				snapshot: this.snapshot,
				stale: this.snapshot !== null,
				error: this.lastError,
			};
		}
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.refresh().finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	private async refresh(): Promise<VersionStatusResult> {
		const [forkRelease, upstreamRelease, compare, pulls] = await Promise.all([
			this.request<{ tag_name?: string }>(
				`/repos/${FORK_REPO}/releases/latest`,
			),
			this.request<{ tag_name?: string }>(
				`/repos/${UPSTREAM_REPO}/releases/latest`,
			),
			this.mergedSha
				? this.request<{ ahead_by?: number }>(
						`/repos/${UPSTREAM_REPO}/compare/${this.mergedSha}...main`,
					)
				: Promise.resolve(emptyResponse<{ ahead_by?: number }>()),
			this.request<
				Array<{
					number?: number;
					html_url?: string;
					title?: string;
					draft?: boolean;
					head?: { ref?: string; repo?: { full_name?: string } };
				}>
			>(`/repos/${FORK_REPO}/pulls?state=open&per_page=50`),
		]);

		const errors: string[] = [];
		for (const response of [forkRelease, upstreamRelease, compare, pulls]) {
			if (response.rateLimitedUntil) {
				this.rateLimitedUntil = Math.max(
					this.rateLimitedUntil,
					response.rateLimitedUntil,
				);
			}
			if (response.error) errors.push(response.error);
		}

		let fork: ForkStatus | null = null;
		if (forkRelease.ok && forkRelease.data?.tag_name) {
			const tag = forkRelease.data.tag_name;
			fork = {
				latestTag: tag,
				latestTagUrl: releaseUrl(FORK_REPO, tag),
				updateAvailable: isNewerVersion(tag, this.currentVersion),
			};
		}

		let upstream: UpstreamStatus | null = null;
		const upstreamTag = upstreamRelease.ok
			? (upstreamRelease.data?.tag_name ?? null)
			: null;
		const commitsBehind =
			compare.ok && typeof compare.data?.ahead_by === "number"
				? compare.data.ahead_by
				: null;
		if (upstreamTag !== null || commitsBehind !== null) {
			const mergedTag = await this.resolveMergedTag();
			upstream = {
				latestTag: upstreamTag,
				latestTagUrl: upstreamTag
					? releaseUrl(UPSTREAM_REPO, upstreamTag)
					: null,
				mergedTag,
				mergedTagUrl: mergedTag ? releaseUrl(UPSTREAM_REPO, mergedTag) : null,
				commitsBehind,
			};
		}

		let syncPr: SyncPullRequest | null = null;
		if (pulls.ok && Array.isArray(pulls.data)) {
			for (const pull of pulls.data) {
				const ref = pull.head?.ref;
				// The head branch must live on the fork itself, not on someone
				// else's fork of it. This repository is public and accepts pull
				// requests from anyone, so a branch-name test alone would let an
				// outsider open "upstream-sync/anything" and have the dashboard
				// present it as the maintainer's own sync PR. Only an account with
				// push access can put a branch on FORK_REPO.
				if (
					ref?.startsWith(SYNC_BRANCH_PREFIX) &&
					pull.head?.repo?.full_name === FORK_REPO &&
					typeof pull.number === "number" &&
					pull.html_url
				) {
					syncPr = {
						number: pull.number,
						url: pull.html_url,
						title: pull.title ?? `Pull request #${pull.number}`,
						headRef: ref,
						draft: pull.draft === true,
					};
					break;
				}
			}
		}

		if (fork === null && upstream === null && !pulls.ok) {
			// Nothing usable came back. Keep the previous snapshot if we have one.
			this.lastError = errors[0] ?? "GitHub is unreachable";
			this.lastFailureAt = this.now();
			log.warn(`Version status refresh failed: ${this.lastError}`);
			return {
				snapshot: this.snapshot,
				stale: this.snapshot !== null,
				error: this.lastError,
			};
		}

		this.lastFailureAt = 0;
		this.snapshot = { fork, upstream, syncPr, checkedAt: this.now() };
		this.lastError = errors.length > 0 ? (errors[0] ?? null) : null;
		return { snapshot: this.snapshot, stale: false, error: this.lastError };
	}

	/**
	 * Newest upstream release tag that is an ancestor of the merged sha.
	 *
	 * Bounded by construction: one page of releases, then at most
	 * ANCESTRY_COMPARE_BUDGET compares walking newest-first, stopping at the
	 * first tag the merged sha is at or ahead of. The answer cannot change while
	 * the process runs, so it is resolved once and cached.
	 */
	private async resolveMergedTag(): Promise<string | null> {
		if (this.mergedTagResolved) return this.mergedTag;
		if (!this.mergedSha) {
			this.mergedTagResolved = true;
			return null;
		}

		const releases = await this.request<
			Array<{ tag_name?: string; draft?: boolean }>
		>(
			`/repos/${UPSTREAM_REPO}/releases?per_page=${ANCESTRY_RELEASE_PAGE_SIZE}`,
		);
		if (releases.rateLimitedUntil) {
			this.rateLimitedUntil = Math.max(
				this.rateLimitedUntil,
				releases.rateLimitedUntil,
			);
		}
		if (!releases.ok || !Array.isArray(releases.data)) return null;

		const tags = releases.data
			.filter((release) => release.draft !== true)
			.map((release) => release.tag_name)
			.filter((tag): tag is string => typeof tag === "string")
			.slice(0, ANCESTRY_COMPARE_BUDGET);

		// A compare that failed proves nothing about ancestry, so a walk that hit
		// one must not be cached as a negative answer. Observed live: with the
		// unauthenticated limit exhausted, the compares 403 and the fork would
		// otherwise remember "no merged tag" for the rest of the process.
		let sawFailure = false;

		for (const tag of tags) {
			const compare = await this.request<{ status?: string }>(
				`/repos/${UPSTREAM_REPO}/compare/${encodeURIComponent(tag)}...${
					this.mergedSha
				}`,
			);
			if (compare.rateLimitedUntil) {
				this.rateLimitedUntil = Math.max(
					this.rateLimitedUntil,
					compare.rateLimitedUntil,
				);
				return null;
			}
			if (!compare.ok) {
				sawFailure = true;
				continue;
			}
			const status = compare.data?.status;
			if (status === "identical" || status === "ahead") {
				this.mergedTag = tag;
				this.mergedTagResolved = true;
				return tag;
			}
		}

		if (sawFailure) return null;

		// The release list came back and every compare in budget finished without
		// a match, so the merged sha sits behind all of them. Cache the negative
		// answer: it cannot change while the process runs, and re-walking the
		// page on every refresh would spend the whole compare budget hourly.
		this.mergedTagResolved = true;
		return null;
	}

	private async request<T>(path: string): Promise<GithubResponse<T>> {
		const headers: Record<string, string> = {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "better-ccflare-version-status",
		};
		if (this.token) headers.Authorization = `Bearer ${this.token}`;

		try {
			const response = await this.fetchImpl(`${GITHUB_API}${path}`, {
				headers,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});

			if (response.status === 403 || response.status === 429) {
				const remaining = response.headers.get("x-ratelimit-remaining");
				const reset = response.headers.get("x-ratelimit-reset");
				if (remaining === "0" && reset) {
					const resetMs = Number(reset) * 1000;
					return {
						ok: false,
						status: response.status,
						data: null,
						rateLimitedUntil: Number.isFinite(resetMs) ? resetMs : null,
						error: "GitHub rate limit exceeded",
					};
				}
			}

			if (!response.ok) {
				return {
					ok: false,
					status: response.status,
					data: null,
					rateLimitedUntil: null,
					error: `GitHub returned ${response.status} for ${path}`,
				};
			}

			return {
				ok: true,
				status: response.status,
				data: (await response.json()) as T,
				rateLimitedUntil: null,
				error: null,
			};
		} catch (error) {
			// Never include the token or the full request in the message.
			const message = error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				status: 0,
				data: null,
				rateLimitedUntil: null,
				error: `GitHub request failed for ${path}: ${message}`,
			};
		}
	}
}

function emptyResponse<T>(): GithubResponse<T> {
	return {
		ok: false,
		status: 0,
		data: null,
		rateLimitedUntil: null,
		error: null,
	};
}
