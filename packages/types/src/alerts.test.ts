import { describe, expect, test } from "bun:test";
import type { AlertEvent } from "./alerts";
import { alertGroupKey, groupAlerts } from "./alerts";

function makeAlert(
	overrides: Partial<AlertEvent> & { id: string },
): AlertEvent {
	return {
		timestamp: 0,
		type: "auth_failure",
		severity: "warning",
		title: "Account authentication failed",
		message:
			"Account ICLD (anthropic) requires re-authentication: invalid_grant",
		value: null,
		threshold: null,
		account: "ICLD",
		model: null,
		project: null,
		requestId: null,
		acknowledged: false,
		...overrides,
	};
}

const HOUR = 60 * 60 * 1000;

describe("alertGroupKey", () => {
	test("strips the trailing bucket", () => {
		expect(alertGroupKey("auth_failure:ICLD:479999")).toBe("auth_failure:ICLD");
	});

	test("keeps a scope that itself contains colons", () => {
		// encodeScopePart shape: `${length}:${value}`.
		expect(alertGroupKey("anomaly_token_outlier:3:abc:12345")).toBe(
			"anomaly_token_outlier:3:abc",
		);
	});

	test("keeps a runaway-loop scope whose last parts are empty", () => {
		// `${account}:${model}:${project ?? ""}:${agentUsed ?? ""}` with both
		// optional parts null leaves two empty segments before the bucket.
		expect(alertGroupKey("anomaly_runaway_loop:acct:sonnet:::9001")).toBe(
			"anomaly_runaway_loop:acct:sonnet::",
		);
	});

	test("returns an id with no colon unchanged", () => {
		// slice(0, -1) would drop the final character and collide two
		// unrelated ids.
		expect(alertGroupKey("bare")).toBe("bare");
	});

	test("does not merge two different types", () => {
		expect(alertGroupKey("auth_failure:ICLD:1")).not.toBe(
			alertGroupKey("upstream_error:ICLD:1"),
		);
	});
});

describe("groupAlerts", () => {
	test("collapses the four hourly ICLD alerts into one group", () => {
		const base = Date.UTC(2026, 8, 17, 5, 21, 4);
		const alerts = [3, 2, 1, 0].map((n) =>
			makeAlert({
				id: `auth_failure:ICLD:${1000 + n}`,
				timestamp: base + n * HOUR,
			}),
		);

		const { open, acknowledged } = groupAlerts(alerts);

		expect(open).toHaveLength(1);
		expect(open[0].members).toHaveLength(4);
		expect(open[0].key).toBe("auth_failure:ICLD");
		expect(acknowledged).toHaveLength(0);
	});

	test("orders members newest first and takes the newest member's fields", () => {
		const alerts = [
			makeAlert({ id: "a:s:1", timestamp: 100, title: "older" }),
			makeAlert({
				id: "a:s:3",
				timestamp: 300,
				title: "newest",
				severity: "critical",
			}),
			makeAlert({ id: "a:s:2", timestamp: 200, title: "middle" }),
		];

		const [group] = groupAlerts(alerts).open;

		expect(group.members.map((m) => m.timestamp)).toEqual([300, 200, 100]);
		expect(group.newest).toBe(300);
		expect(group.title).toBe("newest");
		expect(group.severity).toBe("critical");
	});

	test("orders groups by their newest member, descending", () => {
		const alerts = [
			makeAlert({ id: "auth_failure:OLD:1", timestamp: 100 }),
			makeAlert({ id: "auth_failure:NEW:1", timestamp: 900 }),
			makeAlert({ id: "auth_failure:MID:1", timestamp: 500 }),
		];

		expect(groupAlerts(alerts).open.map((g) => g.key)).toEqual([
			"auth_failure:NEW",
			"auth_failure:MID",
			"auth_failure:OLD",
		]);
	});

	test("does not join an unrelated type sharing a scope", () => {
		const alerts = [
			makeAlert({ id: "auth_failure:ICLD:1", timestamp: 200 }),
			makeAlert({ id: "upstream_error:ICLD:1", timestamp: 100 }),
		];

		expect(groupAlerts(alerts).open).toHaveLength(2);
	});

	test("splits a partly acknowledged group across both sections", () => {
		const alerts = [
			makeAlert({ id: "auth_failure:ICLD:4", timestamp: 400 }),
			makeAlert({ id: "auth_failure:ICLD:3", timestamp: 300 }),
			makeAlert({
				id: "auth_failure:ICLD:2",
				timestamp: 200,
				acknowledged: true,
			}),
			makeAlert({
				id: "auth_failure:ICLD:1",
				timestamp: 100,
				acknowledged: true,
			}),
		];

		const { open, acknowledged } = groupAlerts(alerts);

		expect(open).toHaveLength(1);
		expect(acknowledged).toHaveLength(1);
		expect(open[0].key).toBe(acknowledged[0].key);
		expect(open[0].members.map((m) => m.timestamp)).toEqual([400, 300]);
		expect(acknowledged[0].members.map((m) => m.timestamp)).toEqual([200, 100]);
	});

	test("returns empty partitions for no alerts", () => {
		expect(groupAlerts([])).toEqual({ open: [], acknowledged: [] });
	});

	test("never yields an empty member list", () => {
		const { open } = groupAlerts([makeAlert({ id: "auth_failure:X:1" })]);
		expect(open.every((g) => g.members.length > 0)).toBe(true);
	});
});
