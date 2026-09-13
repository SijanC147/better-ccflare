import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_ROUTES, fillPath, pathParams } from "../api-catalog";

/**
 * The router is the authority on what this fork serves. These tests re-read it
 * and fail when it and the playground catalog disagree, so "every route is
 * reachable from the playground" stays a checked property rather than a claim
 * that rots on the next router edit.
 *
 * Static routes only: they are registered declaratively as
 * `this.handlers.set("<METHOD>:<path>", ...)` and can be extracted exactly.
 * Dynamic routes are matched by prefix inside `handleRequest` and cannot be,
 * so they are listed in the catalog by hand and are not covered here.
 */

const ROUTER_PATH = join(
	import.meta.dir,
	"../../../../http-api/src/router.ts",
);

function staticRoutesFromRouter(): Set<string> {
	const source = readFileSync(ROUTER_PATH, "utf8");
	const matches = source.matchAll(/handlers\.set\(\s*"([A-Z]+):([^"]+)"/g);
	return new Set(
		Array.from(matches, (match) => `${match[1]}:${match[2]}`),
	);
}

const catalogKeys = new Set(
	API_ROUTES.map((route) => `${route.method}:${route.path}`),
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

describe("path parameters", () => {
	test("pathParams finds every placeholder", () => {
		expect(pathParams("/api/combos/:comboId/slots/:slotId")).toEqual([
			"comboId",
			"slotId",
		]);
		expect(pathParams("/api/accounts")).toEqual([]);
	});

	test("fillPath substitutes and encodes values", () => {
		expect(
			fillPath("/api/projects/:projectId", { projectId: "a b/c" }),
		).toBe("/api/projects/a%20b%2Fc");
	});

	test("fillPath leaves an unsupplied parameter empty rather than literal", () => {
		expect(fillPath("/api/projects/:projectId", {})).toBe("/api/projects/");
	});
});
