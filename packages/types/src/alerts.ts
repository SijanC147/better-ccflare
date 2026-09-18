/**
 * Types for the alerting system (issue #250): threshold rules,
 * anomaly-driven alerts, alert history, and alert configuration.
 *
 * Pure data shapes shared between the HTTP API, the alert engine,
 * and the dashboard.
 */

/** Severity level attached to an alert event. */
export type AlertSeverity = "info" | "warning" | "critical";

/** Discriminates which rule or anomaly detector produced an alert. */
export type AlertType =
	| "daily_spend"
	| "tokens_per_hour"
	| "request_tokens"
	| "anomaly_token_outlier"
	| "anomaly_output_blowup"
	| "anomaly_runaway_loop"
	| "anomaly_model_misrouting"
	| "auth_failure"
	| "reauth_deadline_warning"
	| "upstream_error";

/** A single alert raised by the alert engine. */
export interface AlertEvent {
	id: string;
	/** ms epoch */
	timestamp: number;
	type: AlertType;
	severity: AlertSeverity;
	title: string;
	message: string;
	/** Observed value that triggered the alert. */
	value: number | null;
	/** Configured threshold (null for anomaly alerts). */
	threshold: number | null;
	account: string | null;
	model: string | null;
	project: string | null;
	requestId: string | null;
	acknowledged: boolean;
}

/** Full response of GET /api/alerts. */
export interface AlertHistoryResponse {
	alerts: AlertEvent[];
	unacknowledgedCount: number;
}

/** Alert configuration payload exchanged with the settings API. */
export interface AlertsConfigPayload {
	/** Daily spend threshold in USD; 0 = disabled. */
	dailySpendUsd: number;
	/** Tokens-per-hour threshold; 0 = disabled. */
	tokensPerHour: number;
	/** Per-request token threshold; 0 = disabled. */
	requestTokens: number;
	anomalyEnabled: boolean;
	anomalyIntervalMinutes: number;
	/**
	 * Minutes of trailing history used to build token baselines (median/MAD),
	 * decoupled from anomalyIntervalMinutes (which only controls how often new
	 * rows are scored). Must be a stable window distinct from the rows being
	 * scored so a request is never scored against a baseline it is a member of.
	 */
	anomalyBaselineWindowMinutes: number;
	/**
	 * Minimum requests inside one (account, model, agent) window to qualify
	 * as a runaway loop. Default 25 — well above one agent's normal
	 * per-window traffic but still catches true repeated-request loops.
	 */
	loopMinRequests: number;
	cooldownMinutes: number;
	/** Webhook target URL; "" = disabled. */
	webhookUrl: string;
}

/**
 * The grouping key of an alert: its id with the trailing cooldown bucket
 * removed.
 *
 * Every alert id is `${type}:${scope}:${bucket}` (buildThresholdAlertId in
 * packages/http-api/src/services/alerts.ts), where `bucket` is
 * `Math.floor(timestamp / bucketMs)`. A scope may itself contain colons:
 * length-prefixed encodings such as `3:abc`, and the runaway-loop scope
 * `account:model:project:agentUsed`. The bucket is always the last segment
 * and is purely numeric, so stripping from the last colon is exact for all
 * twelve emitters.
 *
 * This is a string contract with the server, not a stored column. It holds
 * only while the bucket stays the last colon-separated segment of the id;
 * a server-side test pins that.
 */
export function alertGroupKey(id: string): string {
	const lastColon = id.lastIndexOf(":");
	// An id with no colon at all is not bucket-suffixed. Returning
	// `slice(0, -1)` there would silently drop its final character and
	// collide two unrelated ids, so return it unchanged instead.
	if (lastColon < 0) return id;
	return id.slice(0, lastColon);
}

/** A run of alerts sharing one grouping key, newest member first. */
export interface AlertGroup {
	key: string;
	/** Title of the newest member. */
	title: string;
	/** Severity of the newest member. */
	severity: AlertSeverity;
	/** Timestamp of the newest member, ms epoch. */
	newest: number;
	/** Members, newest first. Never empty. */
	members: AlertEvent[];
}

/**
 * The ids a group acknowledgement sends, captured at click time.
 *
 * This exists as a named function rather than an inline `map` at the button
 * because the inline form was pinned by nothing: a reviewer replaced it with
 * `[members[0].id]` and every test still passed, which would have
 * acknowledged one member of a four-member group and left the group to
 * return with three. This package has no DOM renderer, so the click cannot
 * be dispatched in a test; moving the expression here moves it into code the
 * tests can reach.
 */
export function groupMemberIds(group: AlertGroup): string[] {
	return group.members.map((member) => member.id);
}

/** Open and acknowledged groups of one loaded page of alerts. */
export interface GroupedAlerts {
	open: AlertGroup[];
	acknowledged: AlertGroup[];
}

function groupPartition(alerts: AlertEvent[]): AlertGroup[] {
	const byKey = new Map<string, AlertEvent[]>();
	for (const alert of alerts) {
		const key = alertGroupKey(alert.id);
		const existing = byKey.get(key);
		if (existing) existing.push(alert);
		else byKey.set(key, [alert]);
	}

	const groups: AlertGroup[] = [];
	for (const [key, members] of byKey) {
		// Sort explicitly rather than trusting the caller: listAlerts orders by
		// timestamp DESC today, but nothing in the type says so.
		members.sort((a, b) => b.timestamp - a.timestamp);
		const newestMember = members[0];
		groups.push({
			key,
			title: newestMember.title,
			severity: newestMember.severity,
			newest: newestMember.timestamp,
			members,
		});
	}
	groups.sort((a, b) => b.newest - a.newest);
	return groups;
}

/**
 * Partitions a loaded page of alerts on `acknowledged`, then groups within
 * each partition.
 *
 * Partitioning first is deliberate: a group whose members are partly
 * acknowledged would otherwise have to pick a section. It instead appears
 * in both, with only the matching members in each.
 */
export function groupAlerts(alerts: AlertEvent[]): GroupedAlerts {
	const open: AlertEvent[] = [];
	const acknowledged: AlertEvent[] = [];
	for (const alert of alerts) {
		if (alert.acknowledged) acknowledged.push(alert);
		else open.push(alert);
	}
	return {
		open: groupPartition(open),
		acknowledged: groupPartition(acknowledged),
	};
}
