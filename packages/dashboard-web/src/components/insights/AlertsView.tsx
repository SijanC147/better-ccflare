import type { AlertEvent, AlertGroup } from "@better-ccflare/types";
import { groupAlerts } from "@better-ccflare/types";
import { useQueryClient } from "@tanstack/react-query";
import { Check, CheckCheck, TriangleAlert } from "lucide-react";
import React from "react";
import {
	useAcknowledgeAlert,
	useAcknowledgeAlerts,
	useAcknowledgeAllAlerts,
	useAlerts,
} from "../../hooks/queries";
import { useAlertStream } from "../../hooks/useAlertStream";
import { queryKeys } from "../../lib/query-keys";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader } from "../ui/card";

function formatTimestamp(ts: number): string {
	return new Date(ts).toLocaleString();
}

// Severity has always been stored and returned but never rendered, so a
// critical upstream-error alert looked identical to an informational one.
function severityColor(severity: string): string {
	if (severity === "critical") return "text-red-500";
	if (severity === "info") return "text-sky-500";
	return "text-amber-500";
}

function AlertCard({
	alert,
	onAcknowledge,
	acknowledgeDisabled,
}: {
	alert: AlertEvent;
	onAcknowledge?: (id: string) => void;
	acknowledgeDisabled?: boolean;
}) {
	return (
		<Card>
			<CardHeader>
				<div className="flex items-start justify-between gap-3">
					<div className="space-y-1">
						<div className="flex items-center gap-2">
							<TriangleAlert
								className={`h-4 w-4 ${severityColor(alert.severity)}`}
							/>
							<span className="font-medium">{alert.title}</span>
						</div>
						<p className="text-sm text-muted-foreground">{alert.message}</p>
					</div>
					<Badge variant={alert.acknowledged ? "outline" : "destructive"}>
						{alert.acknowledged ? "Acked" : "New"}
					</Badge>
				</div>
			</CardHeader>
			<CardContent className="pb-3 pt-0 flex items-center justify-between text-xs text-muted-foreground">
				<span>{formatTimestamp(alert.timestamp)}</span>
				{onAcknowledge ? (
					<Button
						size="sm"
						variant="ghost"
						disabled={alert.acknowledged || acknowledgeDisabled}
						onClick={() => onAcknowledge(alert.id)}
					>
						<Check className="h-4 w-4 mr-1" />
						Acknowledge
					</Button>
				) : null}
			</CardContent>
		</Card>
	);
}

/**
 * One group, folded by default.
 *
 * The count is in the summary line rather than behind the fold: grouping
 * that hides how many times a condition fired turns "this fired 12 times
 * since 5am" into something that reads as a single event.
 *
 * The acknowledge button sits outside <summary> because a button inside it
 * toggles the fold when clicked.
 */
function AlertGroupRow({
	group,
	loadedCount,
	onAcknowledgeGroup,
	onAcknowledgeAlert,
	groupPending,
	singlePending,
}: {
	group: AlertGroup;
	loadedCount: number;
	onAcknowledgeGroup?: (ids: string[]) => void;
	onAcknowledgeAlert?: (id: string) => void;
	groupPending?: boolean;
	singlePending?: boolean;
}) {
	const count = group.members.length;

	return (
		<li>
			<Card>
				<CardContent className="p-0">
					<details>
						<summary className="cursor-pointer select-none p-4 flex items-start justify-between gap-3">
							<div className="space-y-1">
								<div className="flex items-center gap-2">
									<TriangleAlert
										className={`h-4 w-4 ${severityColor(group.severity)}`}
									/>
									<span className="font-medium">{group.title}</span>
									<Badge variant="secondary">
										{count} of the last {loadedCount} loaded
									</Badge>
								</div>
								<p className="text-xs text-muted-foreground">
									Most recent {formatTimestamp(group.newest)}
								</p>
							</div>
						</summary>
						<ul className="space-y-3 p-4 pt-0">
							{group.members.map((member) => (
								<li key={member.id}>
									<AlertCard
										alert={member}
										onAcknowledge={onAcknowledgeAlert}
										acknowledgeDisabled={singlePending}
									/>
								</li>
							))}
						</ul>
					</details>
					{onAcknowledgeGroup ? (
						<div className="flex justify-end px-4 pb-3">
							<Button
								size="sm"
								variant="ghost"
								disabled={groupPending}
								onClick={() =>
									onAcknowledgeGroup(group.members.map((m) => m.id))
								}
							>
								<Check className="h-4 w-4 mr-1" />
								Acknowledge group
							</Button>
						</div>
					) : null}
				</CardContent>
			</Card>
		</li>
	);
}

/**
 * Presentational half of the Insights alerts list.
 *
 * Split out from the container so it can be rendered in a test without a
 * query client or an SSE stream: packages/dashboard-web has no DOM renderer,
 * and renderToStaticMarkup is what the other component tests here use.
 */
export function AlertsList({
	alerts,
	unacknowledgedCount,
	onAcknowledgeAll,
	onAcknowledgeGroup,
	onAcknowledgeAlert,
	acknowledgeAllDisabled,
	pendingGroupKey,
	singlePending,
}: {
	alerts: AlertEvent[];
	unacknowledgedCount: number;
	onAcknowledgeAll?: () => void;
	onAcknowledgeGroup?: (key: string, ids: string[]) => void;
	onAcknowledgeAlert?: (id: string) => void;
	acknowledgeAllDisabled?: boolean;
	pendingGroupKey?: string | null;
	singlePending?: boolean;
}) {
	const { open, acknowledged } = groupAlerts(alerts);
	// Count over what the page actually loaded, not over the 100 the client
	// asks for: the database may hold far more, and claiming a page size the
	// response did not have would be a claim about rows nobody fetched.
	const loadedCount = alerts.length;
	const acknowledgedCount = acknowledged.reduce(
		(sum, group) => sum + group.members.length,
		0,
	);

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<h3 className="text-lg font-medium">
					Unacknowledged: {unacknowledgedCount}
				</h3>
				<Button
					size="sm"
					variant="outline"
					disabled={unacknowledgedCount === 0 || acknowledgeAllDisabled}
					onClick={() => onAcknowledgeAll?.()}
				>
					<CheckCheck className="h-4 w-4 mr-1" />
					Acknowledge all
				</Button>
			</div>

			{alerts.length === 0 ? (
				<Card>
					<CardContent className="p-6 text-muted-foreground">
						No alerts yet.
					</CardContent>
				</Card>
			) : (
				<>
					{open.length === 0 ? (
						<Card>
							<CardContent className="p-6 text-muted-foreground">
								Nothing unacknowledged.
							</CardContent>
						</Card>
					) : (
						<ul className="space-y-3">
							{open.map((group) => (
								<AlertGroupRow
									key={group.key}
									group={group}
									loadedCount={loadedCount}
									onAcknowledgeGroup={
										onAcknowledgeGroup
											? (ids) => onAcknowledgeGroup(group.key, ids)
											: undefined
									}
									onAcknowledgeAlert={onAcknowledgeAlert}
									// Only this group's button disables while its own
									// acknowledgement is in flight.
									groupPending={pendingGroupKey === group.key}
									singlePending={singlePending}
								/>
							))}
						</ul>
					)}

					{acknowledged.length > 0 ? (
						<details className="rounded-lg border">
							<summary className="cursor-pointer select-none p-4 text-sm font-medium">
								Acknowledged ({acknowledgedCount} of the last {loadedCount}{" "}
								loaded)
							</summary>
							<ul className="space-y-3 p-4 pt-0">
								{acknowledged.map((group) => (
									<AlertGroupRow
										key={group.key}
										group={group}
										loadedCount={loadedCount}
									/>
								))}
							</ul>
						</details>
					) : null}
				</>
			)}
		</div>
	);
}

export const AlertsView = React.memo(() => {
	const queryClient = useQueryClient();
	const { data, isLoading } = useAlerts();
	const ack = useAcknowledgeAlert();
	const ackGroup = useAcknowledgeAlerts();
	const ackAll = useAcknowledgeAllAlerts();
	const [pendingGroupKey, setPendingGroupKey] = React.useState<string | null>(
		null,
	);

	// Connect SSE stream and invalidate alerts query on new events.
	useAlertStream({
		onAlert: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.insightsAlerts() });
		},
	});

	if (isLoading) {
		return (
			<Card>
				<CardContent className="p-6">Loading alerts…</CardContent>
			</Card>
		);
	}

	return (
		<AlertsList
			alerts={data?.alerts ?? []}
			unacknowledgedCount={data?.unacknowledgedCount ?? 0}
			acknowledgeAllDisabled={ackAll.isPending}
			onAcknowledgeAll={() => void ackAll.mutateAsync()}
			onAcknowledgeAlert={(id) => void ack.mutateAsync(id)}
			onAcknowledgeGroup={(key, ids) => {
				// The mutation's own isPending is shared by every group, so track
				// which group is in flight separately and disable only that one.
				setPendingGroupKey(key);
				void ackGroup.mutateAsync(ids).finally(() => setPendingGroupKey(null));
			}}
			pendingGroupKey={pendingGroupKey}
			singlePending={ack.isPending}
		/>
	);
});

AlertsView.displayName = "AlertsView";
