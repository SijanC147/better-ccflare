/**
 * Phase 3.A — Project attribution happy-path tests.
 *
 * These tests verify the pure resolver logic used by the proxy's main thread
 * before handing off a StartMessage to the post-processor worker. No real DB
 * or network calls are made.
 */
import { describe, expect, it } from "bun:test";
import { ResolverSnapshot } from "@better-ccflare/core";

describe("ResolverSnapshot — project attribution", () => {
	it("resolves a path that is a direct prefix of a project's canonicalPath", () => {
		const projectId = "proj-abc-123";
		const snapshot = ResolverSnapshot.build(
			[{ id: projectId, canonicalPath: "/tmp/foo", enabled: true }],
			[],
		);

		const result = snapshot.resolve("/tmp/foo/sub");

		expect(result.projectId).toBe(projectId);
		expect(result.worktreePath).toBeNull(); // prefix match, not rule match
		expect(result.matchedProjectPath).toBe("/tmp/foo");
	});

	it("returns all nulls for a path that does not match any project", () => {
		const snapshot = ResolverSnapshot.build(
			[{ id: "proj-xyz", canonicalPath: "/tmp/foo", enabled: true }],
			[],
		);

		const result = snapshot.resolve("/home/other/project");

		expect(result.projectId).toBeNull();
		expect(result.worktreePath).toBeNull();
		expect(result.matchedRuleId).toBeNull();
		expect(result.matchedProjectPath).toBeNull();
	});

	it("returns all nulls for null/undefined input", () => {
		const snapshot = ResolverSnapshot.build(
			[{ id: "proj-xyz", canonicalPath: "/tmp/foo", enabled: true }],
			[],
		);

		expect(snapshot.resolve(null).projectId).toBeNull();
		expect(snapshot.resolve(undefined).projectId).toBeNull();
		expect(snapshot.resolve("").projectId).toBeNull();
	});

	it("resolves via a directory worktree rule to its parent project", () => {
		const projectId = "proj-parent";
		const ruleId = "rule-dir-1";
		const snapshot = ResolverSnapshot.build(
			[{ id: projectId, canonicalPath: "/home/user/projects/main", enabled: true }],
			[
				{
					id: ruleId,
					kind: "directory",
					pattern: "/home/user/worktrees/feature-a",
					parentProjectId: projectId,
					priority: 10,
					enabled: true,
					compileError: null,
				},
			],
		);

		const result = snapshot.resolve("/home/user/worktrees/feature-a");

		expect(result.projectId).toBe(projectId);
		expect(result.worktreePath).toBe("/home/user/worktrees/feature-a");
		expect(result.matchedRuleId).toBe(ruleId);
	});

	it("picks longest-prefix project when multiple projects overlap", () => {
		const innerProjectId = "proj-inner";
		const outerProjectId = "proj-outer";
		const snapshot = ResolverSnapshot.build(
			[
				{ id: outerProjectId, canonicalPath: "/tmp/foo", enabled: true },
				{ id: innerProjectId, canonicalPath: "/tmp/foo/bar", enabled: true },
			],
			[],
		);

		const result = snapshot.resolve("/tmp/foo/bar/baz");

		expect(result.projectId).toBe(innerProjectId);
	});

	it("ignores disabled projects", () => {
		const snapshot = ResolverSnapshot.build(
			[{ id: "proj-disabled", canonicalPath: "/tmp/foo", enabled: false }],
			[],
		);

		const result = snapshot.resolve("/tmp/foo/sub");

		expect(result.projectId).toBeNull();
	});
});
