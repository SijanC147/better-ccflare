import { useQueryClient } from "@tanstack/react-query";
import {
	ArrowUpCircle,
	CheckCircle2,
	CloudOff,
	Download,
	GitBranch,
	GitCompareArrows,
	GitPullRequest,
	Loader2,
	RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type VersionStatusResponse } from "../api";
import { useVersionStatus } from "../hooks/queries";
import { queryKeys } from "../lib/query-keys";
import { cn } from "../lib/utils";
import { commit, version } from "../lib/version";
import { CopyButton } from "./CopyButton";

/** Opens GitHub in a new tab; every version and commit reference uses this. */
function Ref({
	href,
	children,
	title,
	className,
}: {
	href: string | null;
	children: React.ReactNode;
	title?: string;
	className?: string;
}) {
	if (!href) {
		return (
			<span className={className} title={title}>
				{children}
			</span>
		);
	}
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			title={title}
			className={cn("hover:text-primary hover:underline", className)}
		>
			{children}
		</a>
	);
}

function Card({
	icon: Icon,
	iconClass,
	title,
	children,
}: {
	icon: React.ComponentType<{ className?: string }>;
	iconClass?: string;
	title: React.ReactNode;
	children?: React.ReactNode;
}) {
	return (
		<div className="rounded-lg bg-muted/50 p-3">
			<div className="flex items-center gap-2 text-sm">
				<Icon className={cn("h-4 w-4 shrink-0", iconClass)} />
				<span className="font-medium truncate">{title}</span>
			</div>
			{children}
		</div>
	);
}

/** The fork's own release state, and the button that acts on it. */
/**
 * Exported for tests only. The recheck control lived inside an early return
 * that cannot be taken once a snapshot exists, so it never rendered in the one
 * state that needed it (SB23-1790). That is unreachable code, not wrong code:
 * it reads correctly in the source and a type-checker cannot see it. Pinning it
 * per-state needs the component itself, not the fetching wrapper.
 */
export function ForkCard({ status }: { status: VersionStatusResponse }) {
	const queryClient = useQueryClient();
	const [updating, setUpdating] = useState(false);
	const [rechecking, setRechecking] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const pollRef = useRef<number | null>(null);

	useEffect(() => {
		return () => {
			if (pollRef.current !== null) window.clearInterval(pollRef.current);
		};
	}, []);

	/**
	 * Poll the status endpoint until the reported version changes, then reload.
	 *
	 * Deliberately not /api/health or /api/version: both proxy to real accounts
	 * and answer 503 even when the server is fine.
	 */
	const waitForRestart = useCallback((previousVersion: string) => {
		pollRef.current = window.setInterval(async () => {
			try {
				const next = await api.getVersionStatus();
				if (next.local.version !== previousVersion) {
					if (pollRef.current !== null) window.clearInterval(pollRef.current);
					window.location.reload();
				}
			} catch {
				// The server is mid-restart; keep polling.
			}
		}, 3000);
	}, []);

	const runUpdate = useCallback(async () => {
		setUpdating(true);
		setError(null);
		const previousVersion = status.local.version;
		try {
			await api.selfUpdate();
			waitForRestart(previousVersion);
		} catch (cause) {
			setUpdating(false);
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, [status.local.version, waitForRestart]);

	/**
	 * Force the server past its 15-minute snapshot TTL and write the answer
	 * straight into the cache.
	 *
	 * `invalidateQueries` would refetch without `?refresh=1`, spending a second
	 * request to read back the snapshot this one just stored.
	 */
	const refresh = useCallback(async () => {
		setRechecking(true);
		setError(null);
		try {
			const next = await api.getVersionStatus(true);
			queryClient.setQueryData(queryKeys.versionStatus(), next);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setRechecking(false);
		}
	}, [queryClient]);

	/**
	 * The recheck control, shown in every state.
	 *
	 * A stale snapshot renders a version number that looks authoritative, so the
	 * widget has to admit both that the number is old and why the last refresh
	 * failed. The server backs off for a minute after a total failure and honours
	 * a rate-limit reset regardless of `force`, so a recheck can legitimately
	 * return the same stale snapshot; saying so is the difference between this
	 * button and a placebo.
	 */
	const recheckButton = (
		<button
			type="button"
			onClick={refresh}
			disabled={rechecking}
			className="mt-2 flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-primary disabled:opacity-50"
		>
			<RefreshCw
				className={cn("h-3 w-3 shrink-0", rechecking && "animate-spin")}
			/>
			{rechecking ? "Checking…" : "Check again"}
		</button>
	);

	if (!status.remote.available && !status.fork) {
		return (
			<Card
				icon={CloudOff}
				iconClass="text-muted-foreground"
				title="Release check unavailable"
			>
				<p className="mt-1 text-xs text-muted-foreground break-words">
					Running{" "}
					<Ref
						href={status.local.versionUrl}
						title={`release notes for ${version} (commit ${commit})`}
					>
						{version}
					</Ref>
					. {status.remote.error ?? "GitHub could not be reached."}
				</p>
				{recheckButton}
				{error ? (
					<p className="mt-2 text-xs text-destructive break-words">{error}</p>
				) : null}
			</Card>
		);
	}

	const updateAvailable = status.fork?.updateAvailable === true;

	return (
		<Card
			icon={updating ? Loader2 : updateAvailable ? ArrowUpCircle : CheckCircle2}
			iconClass={cn(
				updating && "animate-spin text-primary",
				!updating && updateAvailable && "text-green-500",
				!updating && !updateAvailable && "text-primary",
			)}
			title={
				updating
					? "Updating…"
					: updateAvailable
						? "Update available"
						: "Up to date"
			}
		>
			<p className="mt-1 text-xs text-muted-foreground break-words">
				<Ref
					href={status.local.versionUrl}
					title={`release notes for ${version} (commit ${commit})`}
				>
					{version}
				</Ref>
				{updateAvailable && status.fork ? (
					<>
						{" → "}
						<Ref
							href={status.fork.latestTagUrl}
							className="font-medium text-foreground"
						>
							{status.fork.latestTag}
						</Ref>
					</>
				) : null}
				{status.remote.stale ? " (cached)" : null}
			</p>

			{status.remote.stale ? (
				<p className="mt-1 text-xs text-amber-500 break-words">
					{status.remote.error ??
						"The last check of GitHub failed; this is the previous result."}
				</p>
			) : null}

			{recheckButton}

			{updateAvailable ? (
				status.capabilities.selfUpdate ? (
					<button
						type="button"
						onClick={runUpdate}
						disabled={updating}
						className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md bg-primary/10 px-2 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
					>
						<Download className="h-3 w-3" />
						{updating ? "Installing…" : "Install update"}
					</button>
				) : (
					<div className="mt-2 space-y-1">
						<div className="flex items-center gap-1">
							<code className="flex-1 truncate rounded bg-background px-1 py-0.5 font-mono text-xs">
								{status.capabilities.manualUpdateCommand}
							</code>
							<CopyButton
								value={status.capabilities.manualUpdateCommand}
								size="sm"
								variant="ghost"
								className="h-6 w-6 p-0"
								title="Copy update command"
							/>
						</div>
						<p className="text-xs text-muted-foreground">
							{status.capabilities.selfUpdateBlockedReason
								? `Manual update: ${status.capabilities.selfUpdateBlockedReason}.`
								: "Run this to update."}
						</p>
					</div>
				)
			) : null}

			{error ? (
				<p className="mt-2 text-xs text-destructive break-words">{error}</p>
			) : null}
		</Card>
	);
}

/** The gap between upstream's latest release and what this fork has merged. */
function UpstreamCard({ status }: { status: VersionStatusResponse }) {
	const [dispatching, setDispatching] = useState(false);
	const [dispatched, setDispatched] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const dispatch = useCallback(async () => {
		setDispatching(true);
		setError(null);
		try {
			await api.dispatchUpstreamSync();
			setDispatched(true);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setDispatching(false);
		}
	}, []);

	// An open sync PR replaces the whole card: the work is already queued, so
	// the only useful action is to go read it.
	if (status.syncPr) {
		return (
			<Card
				icon={GitPullRequest}
				iconClass="text-green-500"
				title={`Sync PR #${status.syncPr.number}`}
			>
				<p className="mt-1 text-xs text-muted-foreground break-words">
					{status.syncPr.draft ? "Draft: " : ""}
					{status.syncPr.title}
				</p>
				<a
					href={status.syncPr.url}
					target="_blank"
					rel="noopener noreferrer"
					className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md bg-primary/10 px-2 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
				>
					<GitPullRequest className="h-3 w-3" />
					Review pull request
				</a>
			</Card>
		);
	}

	if (!status.upstream) {
		return (
			<Card
				icon={CloudOff}
				iconClass="text-muted-foreground"
				title="Upstream check unavailable"
			>
				<p className="mt-1 text-xs text-muted-foreground break-words">
					Merged{" "}
					<Ref
						href={status.local.mergedUpstreamShaUrl}
						title={status.local.mergedUpstreamSha ?? undefined}
					>
						{status.local.mergedUpstreamShaShort ?? "unknown"}
					</Ref>
					. {status.remote.error ?? "GitHub could not be reached."}
				</p>
			</Card>
		);
	}

	const behind = status.upstream.commitsBehind;
	const inSync = behind === 0;

	return (
		<Card
			icon={inSync ? CheckCircle2 : GitCompareArrows}
			iconClass={inSync ? "text-primary" : "text-amber-500"}
			title={
				inSync
					? "In sync with upstream"
					: behind === null
						? "Upstream gap unknown"
						: `${behind} commit${behind === 1 ? "" : "s"} behind upstream`
			}
		>
			<p className="mt-1 text-xs text-muted-foreground break-words">
				<Ref
					href={status.upstream.mergedTagUrl}
					title={
						status.upstream.mergedTag
							? `upstream release ${status.upstream.mergedTag}, merged into this fork at ${status.local.mergedUpstreamSha}`
							: undefined
					}
				>
					{status.upstream.mergedTag ?? "untagged"}
				</Ref>{" "}
				merged
				{status.upstream.latestTag &&
				status.upstream.latestTag !== status.upstream.mergedTag ? (
					<>
						{", latest "}
						<Ref
							href={status.upstream.latestTagUrl}
							className="font-medium text-foreground"
						>
							{status.upstream.latestTag}
						</Ref>
					</>
				) : null}
			</p>

			{!inSync && status.capabilities.dispatch ? (
				<button
					type="button"
					onClick={dispatch}
					disabled={dispatching || dispatched}
					className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md bg-primary/10 px-2 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
				>
					{dispatching ? (
						<Loader2 className="h-3 w-3 animate-spin" />
					) : (
						<GitCompareArrows className="h-3 w-3" />
					)}
					{dispatched
						? "Sync requested"
						: dispatching
							? "Requesting…"
							: "Request upstream sync"}
				</button>
			) : null}

			{dispatched ? (
				<p className="mt-1 text-xs text-muted-foreground">
					The maintainer opens a PR when it finishes.
				</p>
			) : null}
			{error ? (
				<p className="mt-2 text-xs text-destructive break-words">{error}</p>
			) : null}
		</Card>
	);
}

/**
 * Sidebar footer line: this fork's release and the upstream commit it carries.
 * Both are links to the repository they belong to.
 *
 * The upstream release tag is deliberately absent. The card above already reads
 * "<tag> merged", and repeating it here made the line long enough to collide
 * with the theme toggle at the far right of the same row.
 */
export function VersionFooterLine() {
	// Shares the cache entry with VersionStatusCards, so this costs no request.
	const { data: status } = useVersionStatus();
	return (
		<div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
			<GitBranch className="h-3 w-3 shrink-0" />
			<Ref
				href={status?.local.versionUrl ?? null}
				title={`release notes for ${version} (commit ${commit})`}
				className="font-medium"
			>
				{version}
			</Ref>
			{status?.local.mergedUpstreamShaShort ? (
				<>
					<span aria-hidden="true">·</span>
					<Ref
						href={status.local.mergedUpstreamShaUrl}
						title={`upstream commit ${status.local.mergedUpstreamSha} merged into this fork`}
						className="font-mono"
					>
						{status.local.mergedUpstreamShaShort}
					</Ref>
				</>
			) : null}
		</div>
	);
}

/**
 * Version and upstream status for the sidebar footer.
 *
 * Two statuses: this fork's release against its own latest GitHub release, and
 * upstream's latest release against the upstream tag this fork has merged.
 * Local identity always renders, including when GitHub is unreachable.
 */
export function VersionStatusCards() {
	const { data, isLoading, error } = useVersionStatus();

	if (isLoading) {
		return (
			<Card icon={Loader2} iconClass="animate-spin" title="Checking version…">
				<p className="mt-1 text-xs text-muted-foreground">{version}</p>
			</Card>
		);
	}

	// The status endpoint answers 200 even when GitHub fails, so an error here
	// means the server did not answer. Fall back to compile-time identity.
	if (error || !data) {
		return (
			<Card
				icon={CloudOff}
				iconClass="text-muted-foreground"
				title="Version check unavailable"
			>
				<p className="mt-1 text-xs text-muted-foreground break-words">
					Running {version}. The status endpoint did not respond.
				</p>
			</Card>
		);
	}

	return (
		<>
			<ForkCard status={data} />
			<UpstreamCard status={data} />
		</>
	);
}

export { VersionStatusCards as default };
