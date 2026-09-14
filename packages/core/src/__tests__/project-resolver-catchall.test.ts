/**
 * SB23-1975. An enabled `projects` row for the home directory itself prefix-
 * matches every path a developer works in. Once attribution resolves at all,
 * that row silently turns every per-project figure into a whole-machine figure.
 */

import { describe, expect, test } from "bun:test";
import { isCatchAllPath, ResolverSnapshot } from "../project-resolver";

const HOME = "/users/seanbugeja";

function snapshot(paths: Array<{ id: string; canonicalPath: string }>) {
	return ResolverSnapshot.build(
		paths.map((p) => ({ ...p, enabled: true })),
		[],
		{ caseSensitive: false, homeDir: HOME },
	);
}

describe("isCatchAllPath", () => {
	test("the home directory itself is a catch-all", () => {
		expect(isCatchAllPath(HOME, HOME)).toBe(true);
	});
	test("an ancestor of home is a catch-all", () => {
		expect(isCatchAllPath("/users", HOME)).toBe(true);
		expect(isCatchAllPath("/", HOME)).toBe(true);
	});
	test("a real project under home is not", () => {
		expect(isCatchAllPath("/users/seanbugeja/code/claude-meta", HOME)).toBe(
			false,
		);
	});
	test("a sibling that merely shares a prefix string is not", () => {
		expect(isCatchAllPath("/users/seanbugeja2", HOME)).toBe(false);
	});
});

describe("the home-directory row cannot win a prefix match", () => {
	test("a path under home with no other row resolves to null, not to home", () => {
		const snap = snapshot([{ id: "home", canonicalPath: HOME }]);
		const res = snap.resolve("/users/seanbugeja/Code/unregistered-repo");
		expect(res.projectId).toBeNull();
	});

	test("a real project under home still resolves", () => {
		const snap = snapshot([
			{ id: "home", canonicalPath: HOME },
			{ id: "meta", canonicalPath: "/users/seanbugeja/code/claude-meta" },
		]);
		expect(snap.resolve("/users/seanbugeja/Code/claude-meta/src").projectId).toBe(
			"meta",
		);
	});

	test("runpod_workspace still resolves, the one case known to pass today", () => {
		const snap = snapshot([
			{ id: "home", canonicalPath: HOME },
			{ id: "084f767d0b7bbb27", canonicalPath: "/users/seanbugeja/code/runpod_workspace" },
		]);
		expect(
			snap.resolve("/Users/seanbugeja/Code/runpod_workspace").projectId,
		).toBe("084f767d0b7bbb27");
	});

	test("homeDir: null keeps the old behaviour for callers that want it", () => {
		const snap = ResolverSnapshot.build(
			[{ id: "home", canonicalPath: HOME, enabled: true }],
			[],
			{ caseSensitive: false, homeDir: null },
		);
		expect(snap.resolve("/users/seanbugeja/anything").projectId).toBe("home");
	});
});
