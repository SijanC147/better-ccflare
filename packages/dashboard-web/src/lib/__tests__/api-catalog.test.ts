import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	API_ROUTES,
	fillPath,
	pathParams,
} from "@better-ccflare/types/api-catalog";

/**
 * The router is the authority on what this fork serves. These tests re-read it
 * and fail when it and the playground catalog disagree, so "every route is
 * reachable from the playground" stays a checked property rather than a claim
 * that rots on the next router edit.
 *
 * Two guards of unequal strength, and the difference matters.
 *
 * The static guard is exact. Routes are registered declaratively as
 * `this.handlers.set("<METHOD>:<path>", ...)`, so both directions are checked:
 * no router route is missing from the catalog, and no catalog route is absent
 * from the router.
 *
 * The dynamic guard is weaker. Dynamic routes are matched by
 * `path.startsWith("<prefix>")` inside `handleRequest`, and the method and the
 * remaining path segments are decided by control flow below that line, not by
 * any literal. So the prefix is all that can be extracted. The dynamic guard
 * therefore checks only that every `:param` catalog entry falls under some
 * prefix branch and that every prefix branch has at least one catalog entry.
 *
 * What that does NOT catch: a new dynamic route added under a prefix branch
 * that already has a catalog entry, a catalog entry whose method the branch
 * never handles, and a catalog entry whose tail segments the branch never
 * matches. Adding `GET /api/accounts/:accountId/invented` to the catalog
 * passes, because `/api/accounts/` is a live prefix. Treat the dynamic half
 * as a coarse containment check, not as parity with the static half.
 */

const ROUTER_PATH = join(import.meta.dir, "../../../../http-api/src/router.ts");

function staticRoutesFromRouter(): Set<string> {
	const source = readFileSync(ROUTER_PATH, "utf8");
	const matches = source.matchAll(/handlers\.set\(\s*"([A-Z]+):([^"]+)"/g);
	return new Set(Array.from(matches, (match) => `${match[1]}:${match[2]}`));
}

/**
 * The prefix literals of every `path.startsWith("...")` branch in
 * `handleRequest`. That literal is the only part of a dynamic route the source
 * states declaratively; everything after it is control flow.
 */
function dynamicPrefixesFromRouter(): Set<string> {
	const source = readFileSync(ROUTER_PATH, "utf8");
	const matches = source.matchAll(/path\.startsWith\(\s*"([^"]+)"/g);
	return new Set(Array.from(matches, (match) => match[1]));
}

const catalogKeys = new Set(
	API_ROUTES.map((route) => `${route.method}:${route.path}`),
);

const dynamicRoutes = API_ROUTES.filter((route) =>
	route.path.split("/").some((segment) => segment.startsWith(":")),
);

describe("api catalog", () => {
	test("covers every static route the router registers", () => {
		const routerRoutes = staticRoutesFromRouter();

		// Guard the extraction itself: a regex that silently stops matching
		// would make this test pass while checking nothing.
		expect(routerRoutes.size).toBeGreaterThan(100);

		const missing = Array.from(routerRoutes)
			.filter((key) => !catalogKeys.has(key))
			.sort();

		expect(missing).toEqual([]);
	});

	test("lists no static route the router does not serve", () => {
		const routerRoutes = staticRoutesFromRouter();

		// Dynamic routes carry a `:param`; they are matched by prefix in
		// handleRequest and never appear in the handlers map.
		const staticCatalogKeys = Array.from(catalogKeys).filter(
			(key) => !key.includes(":", key.indexOf(":") + 1),
		);

		// POST /api/logs/stream/token is real but handled inline in
		// handleRequest (#379) rather than through the handlers map, so it is
		// legitimately absent from the extraction.
		const unknown = staticCatalogKeys
			.filter((key) => key !== "POST:/api/logs/stream/token")
			.filter((key) => !routerRoutes.has(key))
			.sort();

		expect(unknown).toEqual([]);
	});

	test("serves itself: /api/meta/routes is in the catalog", () => {
		// A route that describes every route, absent from the list of routes,
		// is the one failure this catalog cannot afford.
		expect(catalogKeys.has("GET:/api/meta/routes")).toBe(true);
	});

	test("every route has a category and a summary", () => {
		for (const route of API_ROUTES) {
			expect(route.category).toBeTruthy();
			expect(route.summary).toBeTruthy();
		}
	});

	test("no duplicate method and path pairs", () => {
		expect(catalogKeys.size).toBe(API_ROUTES.length);
	});

	test("routes that mutate state irreversibly are marked dangerous", () => {
		// These are the ones a mis-click cannot be undone from. The playground
		// makes the caller type CONFIRM before firing any of them.
		const mustBeDangerous = [
			"POST:/api/admin/restart",
			"POST:/api/admin/self-update",
			"POST:/api/stats/reset",
			"POST:/api/maintenance/cleanup",
			"POST:/api/upstream/sync-dispatch",
			"DELETE:/api/accounts/:accountId",
		];

		for (const key of mustBeDangerous) {
			const route = API_ROUTES.find(
				(candidate) => `${candidate.method}:${candidate.path}` === key,
			);
			expect(route).toBeDefined();
			expect(route?.dangerous).toBe(true);
		}
	});
});

describe("api catalog, dynamic half", () => {
	// Weaker than the static guard by construction. See the header: containment
	// under a prefix, in both directions, and nothing about method or tail.

	test("every dynamic catalog route falls under a router prefix branch", () => {
		const prefixes = Array.from(dynamicPrefixesFromRouter());

		// Guard the extraction: a regex that silently stopped matching would
		// make this test pass while checking nothing.
		expect(prefixes.length).toBeGreaterThan(10);
		expect(dynamicRoutes.length).toBeGreaterThan(30);

		const unmatched = dynamicRoutes
			.filter((route) => !prefixes.some((p) => route.path.startsWith(p)))
			.map((route) => `${route.method}:${route.path}`)
			.sort();

		expect(unmatched).toEqual([]);
	});

	test("every router prefix branch has at least one catalog route", () => {
		const prefixes = Array.from(dynamicPrefixesFromRouter());

		const unlisted = prefixes
			.filter((prefix) => !dynamicRoutes.some((r) => r.path.startsWith(prefix)))
			.sort();

		expect(unlisted).toEqual([]);
	});
});

describe("path parameters", () => {
	test("pathParams finds every placeholder", () => {
		expect(pathParams("/api/combos/:comboId/slots/:slotId")).toEqual([
			"comboId",
			"slotId",
		]);
		expect(pathParams("/api/accounts")).toEqual([]);
	});

	test("fillPath substitutes and encodes values", () => {
		expect(fillPath("/api/projects/:projectId", { projectId: "a b/c" })).toBe(
			"/api/projects/a%20b%2Fc",
		);
	});

	test("fillPath leaves an unsupplied parameter empty rather than literal", () => {
		expect(fillPath("/api/projects/:projectId", {})).toBe("/api/projects/");
	});
});
