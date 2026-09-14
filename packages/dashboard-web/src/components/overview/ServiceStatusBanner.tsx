import { AlertTriangle, HelpCircle, XCircle } from "lucide-react";
import { useServiceStatus } from "../../hooks/queries";

/**
 * Banner shown on the overview when status.claude.com reports a problem with a
 * component this proxy actually depends on.
 *
 * Returns `null` in the healthy case so it takes no vertical space, the same
 * shape as `StorageIntegrityBanner`. It is keyed on the filtered `level`, never
 * on the page's own top-level indicator: those disagree whenever an unrelated
 * product is degraded, and keying on the indicator would have shown a false
 * alarm on 2026-09-14, when the page read `minor` solely because of Claude
 * Cowork on Windows.
 */
export function ServiceStatusBanner() {
	const { data, isLoading } = useServiceStatus();
	const snapshot = data?.snapshot ?? null;

	// Three doors onto the same silent failure, all of which used to render
	// nothing and so looked exactly like "everything is fine":
	//   1. no snapshot at all, because the page has been unreachable since
	//      startup,
	//   2. a snapshot whose watched components have partly vanished, where the
	//      surviving one is operational, and
	//   3. an empty match set, which `level` already reports as `unknown`.
	// The whole point of this feature is that its failure mode is not a green
	// screen, so each of them renders. Quiet, not alarming.
	const hasDrifted = (snapshot?.missingComponentIds.length ?? 0) > 0;
	const isUnreadable = snapshot === null;
	if (isLoading && isUnreadable) return null;
	if (snapshot !== null && snapshot.level === "operational" && !hasDrifted) {
		return null;
	}

	const isOutage = snapshot?.level === "outage";
	const isUnknown = isUnreadable || hasDrifted || snapshot?.level === "unknown";
	const tone = isOutage
		? {
				container: "bg-destructive/15 border-destructive/30",
				icon: "text-destructive",
				title: "text-destructive",
			}
		: {
				container: "bg-amber-500/15 border-amber-500/30",
				icon: "text-amber-600 dark:text-amber-500",
				title: "text-amber-700 dark:text-amber-500",
			};
	const Icon = isOutage ? XCircle : isUnknown ? HelpCircle : AlertTriangle;

	const heading = isOutage
		? "Claude service outage reported"
		: isUnknown
			? "Claude service status unavailable"
			: "Claude service degraded";

	const detail = isUnreadable
		? `status.claude.com could not be read${data?.error ? `: ${data.error}` : "."} Requests through this proxy are unaffected.`
		: hasDrifted
			? "status.claude.com no longer lists every component better-ccflare watches, so this reading is incomplete. Requests are unaffected; the filter needs updating."
			: snapshot !== null && snapshot.level === "unknown"
				? "status.claude.com no longer lists the components better-ccflare watches, so its status cannot be read. Requests are unaffected; the filter needs updating."
				: (snapshot?.affected.map((component) => component.name).join(", ") ??
					"");

	return (
		<div
			role="alert"
			className={`flex items-start gap-3 p-3 rounded-lg border ${tone.container}`}
		>
			<Icon className={`h-5 w-5 mt-0.5 shrink-0 ${tone.icon}`} />
			<div className="text-sm space-y-1">
				<p className={`font-medium ${tone.title}`}>{heading}</p>
				{detail ? <p className="text-muted-foreground">{detail}</p> : null}
				{snapshot !== null && snapshot.incidents.length > 0 ? (
					<ul className="text-muted-foreground list-disc pl-4">
						{snapshot.incidents.map((incident) => (
							<li key={incident.id}>
								{incident.url ? (
									<a
										href={incident.url}
										target="_blank"
										rel="noreferrer"
										className="underline underline-offset-2"
									>
										{incident.name}
									</a>
								) : (
									incident.name
								)}
							</li>
						))}
					</ul>
				) : null}
				<p className="text-muted-foreground">
					<a
						href={snapshot?.pageUrl ?? "https://status.claude.com"}
						target="_blank"
						rel="noreferrer"
						className="underline underline-offset-2"
					>
						status.claude.com
					</a>
					{data?.stale
						? ", showing the last reading; the page is unreachable"
						: null}
				</p>
			</div>
		</div>
	);
}
