/**
 * Tests for VersionStatusService and the MERGELOG marker parser.
 *
 * The service makes every GitHub call this widget needs, so the cases that
 * matter are the failure paths: GitHub unreachable, GitHub rate-limited, and a
 * partial failure where one section is missing and the rest must still render.
 * Fetch call counts are asserted directly, because the cost controls (snapshot
 * TTL, negative caching, the bounded ancestry walk) are only observable there.
 */
import { describe, expect, it } from "bun:test";
import { parseLastSyncSha } from "../fork-identity";
import {
	isNewerVersion,
	VersionStatusService,
} from "../version-status-service";

const MERGED_SHA = "ea0e332097ed8f6b2d214f0433ec1024752afadd";

interface StubRoute {
	status?: number;
	body?: unknown;
	headers?: Record<string, string>;
	throws?: string;
}

/**
 * Minimal fetch stub that matches on a substring of the request URL and records
 * every call in order.
 */
function stubFetch(routes: Array<[string, StubRoute]>) {
	const calls: string[] = [];
	const impl = (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		calls.push(url);
		for (const [needle, route] of routes) {
			if (url.includes(needle)) {
				if (route.throws) throw new Error(route.throws);
				return new Response(JSON.stringify(route.body ?? {}), {
					status: route.status ?? 200,
					headers: route.headers,
				});
			}
		}
		return new Response("{}", { status: 404 });
	}) as unknown as typeof fetch;
	return { impl, calls };
}

const HAPPY_ROUTES: Array<[string, StubRoute]> = [
	[
		"/repos/SijanC147/better-ccflare/releases/latest",
		{ body: { tag_name: "v3.9.1" } },
	],
	[
		"/repos/tombii/better-ccflare/releases/latest",
		{ body: { tag_name: "v3.5.90" } },
	],
	[`/compare/${MERGED_SHA}...main`, { body: { ahead_by: 42 } }],
	[
		"/repos/tombii/better-ccflare/releases?per_page=30",
		{ body: [{ tag_name: "v3.5.90" }, { tag_name: "v3.5.81" }] },
	],
	["/compare/v3.5.90...", { body: { status: "behind" } }],
	["/compare/v3.5.81...", { body: { status: "ahead" } }],
	["/pulls?state=open", { body: [] }],
];

function makeService(
	routes: Array<[string, StubRoute]>,
	overrides: { currentVersion?: string; now?: () => number } = {},
) {
	const { impl, calls } = stubFetch(routes);
	const service = new VersionStatusService({
		currentVersion: overrides.currentVersion ?? "3.9.0",
		mergedSha: MERGED_SHA,
		fetchImpl: impl,
		now: overrides.now,
	});
	return { service, calls };
}

describe("parseLastSyncSha", () => {
	it("extracts the marker sha", () => {
		expect(
			parseLastSyncSha(`intro\n<!-- last-sync-sha: ${MERGED_SHA} -->\nrest`),
		).toBe(MERGED_SHA);
	});

	it("returns null when the marker is absent", () => {
		expect(parseLastSyncSha("# MERGELOG\n\nno marker here")).toBeNull();
	});

	it("returns null for a malformed marker", () => {
		expect(parseLastSyncSha("<!-- last-sync-sha: not-a-sha -->")).toBeNull();
		expect(parseLastSyncSha("<!-- last-sync: abcdef1 -->")).toBeNull();
	});

	it("accepts a short sha", () => {
		expect(parseLastSyncSha("<!-- last-sync-sha: ea0e332 -->")).toBe("ea0e332");
	});

	it("reads the real MERGELOG through the module constant", async () => {
		const { MERGED_UPSTREAM_SHA } = await import("../fork-identity");
		// The committed marker is a full 40-character sha.
		expect(MERGED_UPSTREAM_SHA).toMatch(/^[0-9a-f]{40}$/);
	});
});

describe("isNewerVersion", () => {
	it("compares tags with and without a v prefix", () => {
		expect(isNewerVersion("v3.9.1", "3.9.0")).toBe(true);
		expect(isNewerVersion("3.9.0", "v3.9.0")).toBe(false);
		expect(isNewerVersion("v3.8.9", "3.9.0")).toBe(false);
		expect(isNewerVersion("v3.10.0", "3.9.0")).toBe(true);
	});

	it("ignores prerelease suffixes rather than guessing their order", () => {
		expect(isNewerVersion("v3.9.0-rc.1", "3.9.0")).toBe(false);
	});

	it("treats unparseable input as no update", () => {
		expect(isNewerVersion("latest", "3.9.0")).toBe(false);
	});
});

describe("VersionStatusService", () => {
	it("assembles fork, upstream and sync-PR state", async () => {
		const { service } = makeService(HAPPY_ROUTES);
		const result = await service.getStatus();

		expect(result.error).toBeNull();
		expect(result.stale).toBe(false);
		expect(result.snapshot?.fork).toEqual({
			latestTag: "v3.9.1",
			latestTagUrl:
				"https://github.com/SijanC147/better-ccflare/releases/tag/v3.9.1",
			updateAvailable: true,
		});
		expect(result.snapshot?.upstream?.latestTag).toBe("v3.5.90");
		expect(result.snapshot?.upstream?.commitsBehind).toBe(42);
		expect(result.snapshot?.syncPr).toBeNull();
	});

	it("resolves the merged upstream tag as the newest ancestor release", async () => {
		const { service } = makeService(HAPPY_ROUTES);
		const result = await service.getStatus();
		// v3.5.90 is "behind" the merged sha, v3.5.81 is "ahead" of it, so the
		// merged tag is v3.5.81.
		expect(result.snapshot?.upstream?.mergedTag).toBe("v3.5.81");
	});

	it("resolves the merged tag once and never re-walks it", async () => {
		let clock = 1_000_000;
		const { service, calls } = makeService(HAPPY_ROUTES, {
			now: () => clock,
		});
		await service.getStatus();
		const ancestryCalls = calls.filter(
			(url) =>
				url.includes("releases?per_page") || url.includes("/compare/v3.5"),
		).length;
		expect(ancestryCalls).toBe(3); // one release page, two compares

		clock += 60 * 60 * 1000; // past the refresh interval
		await service.getStatus();
		const ancestryCallsAfter = calls.filter(
			(url) =>
				url.includes("releases?per_page") || url.includes("/compare/v3.5"),
		).length;
		expect(ancestryCallsAfter).toBe(3);
	});

	it("bounds the ancestry walk to the compare budget", async () => {
		const manyReleases = Array.from({ length: 30 }, (_, index) => ({
			tag_name: `v9.0.${30 - index}`,
		}));
		const { service, calls } = makeService([
			...HAPPY_ROUTES.filter(
				([needle]) =>
					!needle.includes("releases?per_page") &&
					!needle.includes("/compare/v3.5"),
			),
			["releases?per_page=30", { body: manyReleases }],
			// Nothing matches, so the walk must stop on its own budget.
			["/compare/v9.0.", { body: { status: "behind" } }],
		]);
		await service.getStatus();
		const compares = calls.filter((url) =>
			url.includes("/compare/v9.0."),
		).length;
		expect(compares).toBe(10);
	});

	it("does not cache a merged tag of null when a compare failed", async () => {
		// Found live with the unauthenticated rate limit exhausted: the compares
		// 403'd, and caching that as "no merged tag" made the card read
		// "untagged merged" for the rest of the process even after GitHub
		// recovered. A failed compare proves nothing about ancestry.
		let clock = 1_000_000;
		let comparesFail = true;
		const routes: Array<[string, StubRoute]> = HAPPY_ROUTES.filter(
			([needle]) => !needle.includes("/compare/v3.5"),
		);
		const { impl } = stubFetch(routes);
		const fetchImpl = (async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("/compare/v3.5.81...")) {
				return comparesFail
					? new Response("{}", { status: 500 })
					: new Response(JSON.stringify({ status: "ahead" }));
			}
			if (url.includes("/compare/v3.5.90...")) {
				return comparesFail
					? new Response("{}", { status: 500 })
					: new Response(JSON.stringify({ status: "behind" }));
			}
			return impl(url);
		}) as unknown as typeof fetch;

		const service = new VersionStatusService({
			currentVersion: "3.9.0",
			mergedSha: MERGED_SHA,
			fetchImpl,
			now: () => clock,
		});

		const first = await service.getStatus();
		expect(first.snapshot?.upstream?.mergedTag).toBeNull();

		comparesFail = false;
		clock += 60 * 60 * 1000;
		const second = await service.getStatus();
		expect(second.snapshot?.upstream?.mergedTag).toBe("v3.5.81");
	});

	it("serves the stored snapshot inside the refresh interval", async () => {
		let clock = 1_000_000;
		const { service, calls } = makeService(HAPPY_ROUTES, { now: () => clock });
		await service.getStatus();
		const afterFirst = calls.length;
		clock += 60_000;
		const second = await service.getStatus();
		expect(calls.length).toBe(afterFirst);
		expect(second.stale).toBe(false);
	});

	it("backs off after a total failure instead of re-requesting every call", async () => {
		// /api/version/check is auth-exempt and reaches this service, so with no
		// snapshot to serve and no rate-limit header to read, nothing else bounds
		// the outbound requests an unauthenticated caller can drive.
		let clock = 1_000_000;
		const { impl, calls } = stubFetch([
			["api.github.com", { throws: "network down" }],
		]);
		const service = new VersionStatusService({
			currentVersion: "3.9.0",
			mergedSha: MERGED_SHA,
			fetchImpl: impl,
			now: () => clock,
		});

		await service.getStatus();
		const afterFirst = calls.length;
		expect(afterFirst).toBeGreaterThan(0);

		clock += 10_000;
		const second = await service.getStatus();
		expect(calls.length).toBe(afterFirst);
		expect(second.error).toContain("network down");

		clock += 60_000; // past the backoff
		await service.getStatus();
		expect(calls.length).toBeGreaterThan(afterFirst);
	});

	it("returns no snapshot and an error when GitHub is unreachable", async () => {
		const { service } = makeService([
			["api.github.com", { throws: "getaddrinfo ENOTFOUND api.github.com" }],
		]);
		const result = await service.getStatus();
		expect(result.snapshot).toBeNull();
		expect(result.error).toContain("ENOTFOUND");
	});

	it("serves the previous snapshot marked stale after a later failure", async () => {
		let clock = 1_000_000;
		let failing = false;
		const { impl } = stubFetch(HAPPY_ROUTES);
		const fetchImpl = (async (input: string | URL | Request) => {
			if (failing) throw new Error("network down");
			return impl(input as string);
		}) as unknown as typeof fetch;

		const service = new VersionStatusService({
			currentVersion: "3.9.0",
			mergedSha: MERGED_SHA,
			fetchImpl,
			now: () => clock,
		});
		const first = await service.getStatus();
		expect(first.snapshot?.fork?.latestTag).toBe("v3.9.1");

		failing = true;
		clock += 60 * 60 * 1000;
		const second = await service.getStatus();
		expect(second.stale).toBe(true);
		expect(second.snapshot?.fork?.latestTag).toBe("v3.9.1");
		expect(second.error).toContain("network down");
	});

	it("honours a rate limit reset without issuing more requests", async () => {
		let clock = 1_000_000;
		const resetEpochSeconds = Math.floor(clock / 1000) + 600;
		const { service, calls } = makeService(
			[
				[
					"api.github.com",
					{
						status: 403,
						headers: {
							"x-ratelimit-remaining": "0",
							"x-ratelimit-reset": String(resetEpochSeconds),
						},
					},
				],
			],
			{ now: () => clock },
		);

		const first = await service.getStatus();
		expect(first.snapshot).toBeNull();
		const afterFirst = calls.length;
		expect(afterFirst).toBeGreaterThan(0);

		clock += 60_000; // still inside the rate-limit window
		const second = await service.getStatus();
		expect(calls.length).toBe(afterFirst);
		expect(second.error).toContain("rate limit");
	});

	it("keeps the fork half when only the upstream calls fail", async () => {
		const { service } = makeService([
			[
				"/repos/SijanC147/better-ccflare/releases/latest",
				{ body: { tag_name: "v3.9.1" } },
			],
			["/pulls?state=open", { body: [] }],
			["/repos/tombii/", { status: 500 }],
		]);
		const result = await service.getStatus();
		expect(result.snapshot?.fork?.latestTag).toBe("v3.9.1");
		expect(result.snapshot?.upstream).toBeNull();
	});

	it("matches only a head branch under the maintainer's prefix", async () => {
		const { service } = makeService([
			...HAPPY_ROUTES.filter(
				([needle]) => !needle.includes("/pulls?state=open"),
			),
			[
				"/pulls?state=open",
				{
					body: [
						{
							number: 50,
							html_url: "https://github.com/SijanC147/better-ccflare/pull/50",
							title: "feat/upstream-sync lookalike",
							head: { ref: "feature/upstream-sync/nope" },
						},
						{
							number: 52,
							html_url: "https://github.com/SijanC147/better-ccflare/pull/52",
							title: "sync upstream",
							draft: false,
							head: { ref: "upstream-sync/tombii-better-ccflare/abc...def" },
						},
					],
				},
			],
		]);
		const result = await service.getStatus();
		expect(result.snapshot?.syncPr?.number).toBe(52);
		expect(result.snapshot?.syncPr?.headRef).toStartWith("upstream-sync/");
	});

	it("de-duplicates concurrent refreshes into one network pass", async () => {
		const { service, calls } = makeService(HAPPY_ROUTES);
		await Promise.all([service.getStatus(), service.getStatus()]);
		const forkCalls = calls.filter((url) =>
			url.includes("/repos/SijanC147/better-ccflare/releases/latest"),
		).length;
		expect(forkCalls).toBe(1);
	});

	it("never puts the token in a reported error", async () => {
		const { impl } = stubFetch([["api.github.com", { throws: "boom" }]]);
		const service = new VersionStatusService({
			currentVersion: "3.9.0",
			mergedSha: MERGED_SHA,
			fetchImpl: impl,
			token: "ghp_supersecrettoken",
		});
		const result = await service.getStatus();
		expect(service.hasToken()).toBe(true);
		expect(JSON.stringify(result)).not.toContain("ghp_supersecrettoken");
	});
});
