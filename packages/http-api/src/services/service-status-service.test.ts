import { describe, expect, test } from "bun:test";
import type { FetchLike } from "./service-status-service";
import { buildSnapshot, ServiceStatusService } from "./service-status-service";

/**
 * Fixture JSON only — never the live page. A test that reaches the network
 * fails when Statuspage is slow and passes when the filter is wrong.
 */

const CLAUDE_API_ID = "k8w3r06qmzrp";
const CLAUDE_CODE_ID = "yyzkbfz2thpt";

function component(id: string, name: string, status: string) {
	return { id, name, status };
}

/**
 * The payload measured from status.claude.com on 2026-09-14. The page read
 * `minor` solely because of `Claude Cowork` on Windows.
 */
const MEASURED_SUMMARY = {
	page: { id: "tymt9n04zgry", name: "Claude", url: "https://status.claude.com" },
	status: { indicator: "minor", description: "Partially Degraded Service" },
	components: [
		component("rwppv331jlwc", "claude.ai", "operational"),
		component(
			"0qbwn08sd68x",
			"Claude Console (platform.claude.com)",
			"operational",
		),
		component(CLAUDE_API_ID, "Claude API (api.anthropic.com)", "operational"),
		component(CLAUDE_CODE_ID, "Claude Code", "operational"),
		component("bpp5gb3hpjcl", "Claude Cowork", "degraded_performance"),
		component("0scnb50nvy53", "Claude for Government", "operational"),
	],
	incidents: [
		{
			id: "incident-cowork",
			name: "Degraded functionality for Claude Cowork on Windows",
			status: "identified",
			impact: "major",
			shortlink: "https://stspg.io/cowork",
			components: [component("bpp5gb3hpjcl", "Claude Cowork", "degraded_performance")],
		},
	],
};

describe("buildSnapshot component filter", () => {
	test("the real measured payload reports operational despite a `minor` page indicator", () => {
		// This is the test that would have caught the false alarm: the page's own
		// indicator says `minor`, but the only degraded component is Claude
		// Cowork, which this proxy never touches.
		const snapshot = buildSnapshot(MEASURED_SUMMARY, 1_000);
		expect(snapshot).not.toBeNull();
		expect(snapshot?.pageIndicator).toBe("minor");
		expect(snapshot?.level).toBe("operational");
		expect(snapshot?.affected).toEqual([]);
		expect(snapshot?.incidents).toEqual([]);
		expect(snapshot?.components.map((c) => c.id).sort()).toEqual(
			[CLAUDE_API_ID, CLAUDE_CODE_ID].sort(),
		);
		expect(snapshot?.missingComponentIds).toEqual([]);
	});

	test("a major_outage on a component that matters reports an outage", () => {
		const payload = {
			...MEASURED_SUMMARY,
			status: { indicator: "critical", description: "Major Service Outage" },
			components: MEASURED_SUMMARY.components.map((c) =>
				c.id === CLAUDE_API_ID ? { ...c, status: "major_outage" } : c,
			),
			incidents: [
				{
					id: "incident-api",
					name: "Elevated errors on api.anthropic.com",
					status: "investigating",
					impact: "critical",
					shortlink: "https://stspg.io/api",
					components: [
						component(CLAUDE_API_ID, "Claude API (api.anthropic.com)", "major_outage"),
					],
				},
			],
		};
		const snapshot = buildSnapshot(payload, 2_000);
		expect(snapshot?.level).toBe("outage");
		expect(snapshot?.affected.map((c) => c.id)).toEqual([CLAUDE_API_ID]);
		expect(snapshot?.incidents.map((i) => i.id)).toEqual(["incident-api"]);
	});

	test("degraded_performance on a component that matters reports degraded", () => {
		const payload = {
			...MEASURED_SUMMARY,
			components: MEASURED_SUMMARY.components.map((c) =>
				c.id === CLAUDE_CODE_ID
					? { ...c, status: "degraded_performance" }
					: c,
			),
		};
		const snapshot = buildSnapshot(payload, 3_000);
		expect(snapshot?.level).toBe("degraded");
		expect(snapshot?.affected.map((c) => c.name)).toEqual(["Claude Code"]);
	});

	test("a payload carrying none of the watched components does not report healthy", () => {
		// The dangerous failure of a filtered status feature is a permanently
		// green display. If Anthropic regroups or recreates its components, the
		// ids vanish and an empty match set must not read as "all operational".
		const payload = {
			...MEASURED_SUMMARY,
			components: [
				component("newid1", "Claude Platform / API", "major_outage"),
				component("newid2", "Claude Agent Runtime", "operational"),
			],
			incidents: [],
		};
		const snapshot = buildSnapshot(payload, 4_000);
		expect(snapshot?.level).toBe("unknown");
		expect(snapshot?.components).toEqual([]);
		expect(snapshot?.missingComponentIds.sort()).toEqual(
			[CLAUDE_API_ID, CLAUDE_CODE_ID].sort(),
		);
	});

	test("a renamed component still matches on its id", () => {
		const payload = {
			...MEASURED_SUMMARY,
			components: MEASURED_SUMMARY.components.map((c) =>
				c.id === CLAUDE_API_ID
					? { ...c, name: "Claude API", status: "partial_outage" }
					: c,
			),
		};
		const snapshot = buildSnapshot(payload, 5_000);
		expect(snapshot?.level).toBe("outage");
		expect(snapshot?.missingComponentIds).toEqual([]);
	});

	test("a re-issued id still matches on the display name", () => {
		const payload = {
			...MEASURED_SUMMARY,
			components: MEASURED_SUMMARY.components.map((c) =>
				c.id === CLAUDE_CODE_ID
					? { ...c, id: "regenerated", status: "degraded_performance" }
					: c,
			),
		};
		const snapshot = buildSnapshot(payload, 6_000);
		expect(snapshot?.level).toBe("degraded");
		// The name matched, but the watched id really is gone, so the drift is
		// still reported rather than hidden by the fallback.
		expect(snapshot?.missingComponentIds).toEqual([CLAUDE_CODE_ID]);
	});

	test("an unreadable payload yields no snapshot", () => {
		expect(buildSnapshot(null, 1)).toBeNull();
		expect(buildSnapshot({ status: { indicator: "none" } }, 1)).toBeNull();
	});
});

function jsonFetch(payload: unknown, status = 200): FetchLike {
	return async () =>
		new Response(JSON.stringify(payload), {
			status,
			headers: { "Content-Type": "application/json" },
		});
}

describe("ServiceStatusService", () => {
	test("serves a cached snapshot inside the TTL without re-fetching", async () => {
		let calls = 0;
		const service = new ServiceStatusService({
			refreshIntervalMs: 60_000,
			now: () => 10_000,
			fetchImpl: (async () => {
				calls += 1;
				return new Response(JSON.stringify(MEASURED_SUMMARY), { status: 200 });
			}),
		});
		const first = await service.getStatus();
		const second = await service.getStatus();
		expect(calls).toBe(1);
		expect(first.snapshot?.level).toBe("operational");
		expect(second.stale).toBe(false);
	});

	test("serves the last good snapshot as stale when the page is unreachable", async () => {
		let now = 0;
		let shouldFail = false;
		const service = new ServiceStatusService({
			refreshIntervalMs: 1_000,
			now: () => now,
			fetchImpl: (async () => {
				if (shouldFail) throw new Error("connect ECONNREFUSED");
				return new Response(JSON.stringify(MEASURED_SUMMARY), { status: 200 });
			}),
		});

		const good = await service.getStatus();
		expect(good.stale).toBe(false);
		expect(good.snapshot).not.toBeNull();

		shouldFail = true;
		now = 5_000;
		const failed = await service.getStatus();
		expect(failed.stale).toBe(true);
		expect(failed.snapshot?.level).toBe("operational");
		expect(failed.error).toContain("ECONNREFUSED");
	});

	test("a failure with no prior snapshot is reported, not thrown", async () => {
		const service = new ServiceStatusService({
			now: () => 0,
			fetchImpl: jsonFetch({}, 503),
		});
		const result = await service.getStatus();
		expect(result.snapshot).toBeNull();
		expect(result.stale).toBe(false);
		expect(result.error).toContain("503");
	});

	test("the failure backoff stops a forced refresh from hammering the page", async () => {
		let calls = 0;
		let now = 0;
		const service = new ServiceStatusService({
			now: () => now,
			fetchImpl: (async () => {
				calls += 1;
				throw new Error("boom");
			}),
		});
		await service.getStatus(true);
		now = 1_000;
		await service.getStatus(true);
		await service.getStatus(true);
		expect(calls).toBe(1);
	});

	test("concurrent callers share one in-flight refresh", async () => {
		let calls = 0;
		const service = new ServiceStatusService({
			now: () => 0,
			fetchImpl: (async () => {
				calls += 1;
				await new Promise((resolve) => setTimeout(resolve, 5));
				return new Response(JSON.stringify(MEASURED_SUMMARY), { status: 200 });
			}),
		});
		const [a, b] = await Promise.all([
			service.getStatus(),
			service.getStatus(),
		]);
		expect(calls).toBe(1);
		expect(a.snapshot?.level).toBe("operational");
		expect(b.snapshot?.level).toBe("operational");
	});
});
