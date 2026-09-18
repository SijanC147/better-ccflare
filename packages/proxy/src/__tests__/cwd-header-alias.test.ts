/**
 * SB23-2268 — `X-CCFlare-Path` is a cwd-bearing alias of `X-CCFlare-CWD`.
 *
 * Twenty of the 21 files under ~/Code that set ANTHROPIC_CUSTOM_HEADERS named
 * `X-CCFlare-Path`, which no code read, so those requests reached the proxy
 * with no attribution input at all. These tests pin the alias, the precedence
 * between the two names, and the fact that the aliased value reaches the
 * resolver as a PATH rather than a project name.
 *
 * The last case is the one that matters: it is not enough that
 * `createRequestMetadata` returns the string, because what the issue asks for
 * is the same `project_id`. A project id is
 * `sha1(canonical_path).slice(0, 16)` over the path as STORED, and stored paths
 * are lowercased on this platform, so the expected id is computed from the
 * lowercased path here rather than from the literal one.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ResolverSnapshot } from "@better-ccflare/core";
import { createRequestMetadata } from "../handlers/request-handler";

const CWD = "/users/someone/code/widget";

function metaFor(headers: Record<string, string>) {
	return createRequestMetadata(
		new Request("http://localhost:8081/v1/messages", { headers }),
		new URL("http://localhost:8081/v1/messages"),
	);
}

/** Mirrors projectIdFromPath in packages/database/src/repositories/project.repository.ts. */
function projectIdFromPath(canonicalPath: string): string {
	return createHash("sha1").update(canonicalPath).digest("hex").slice(0, 16);
}

describe("X-CCFlare-Path alias (SB23-2268)", () => {
	test("a request carrying only X-CCFlare-Path yields the path as cwdHint", () => {
		expect(metaFor({ "X-CCFlare-Path": CWD }).cwdHint).toBe(CWD);
	});

	test("a request carrying only X-CCFlare-CWD yields the same cwdHint", () => {
		expect(metaFor({ "X-CCFlare-CWD": CWD }).cwdHint).toBe(CWD);
	});

	test("X-CCFlare-CWD wins when both headers are present", () => {
		const meta = metaFor({
			"X-CCFlare-CWD": CWD,
			"X-CCFlare-Path": "/users/someone/code/other",
		});
		expect(meta.cwdHint).toBe(CWD);
	});

	test("X-CCFlare-Path is used when X-CCFlare-CWD is present but empty", () => {
		const meta = metaFor({ "X-CCFlare-CWD": "", "X-CCFlare-Path": CWD });
		expect(meta.cwdHint).toBe(CWD);
	});

	test("neither header present leaves cwdHint null", () => {
		expect(metaFor({}).cwdHint).toBeNull();
	});

	test("the aliased value is treated as a path and resolves to the same project id", () => {
		// Stored canonical paths are lowercased on darwin (PROJECTS_CASE_SENSITIVE
		// false), so the id is computed from the lowercased path, not the literal.
		const canonicalPath = CWD.toLowerCase();
		const projectId = projectIdFromPath(canonicalPath);
		const snapshot = ResolverSnapshot.build(
			[{ id: projectId, canonicalPath, enabled: true }],
			[],
		);

		const viaPath = snapshot.resolve(
			metaFor({ "X-CCFlare-Path": CWD }).cwdHint,
		);
		const viaCwd = snapshot.resolve(metaFor({ "X-CCFlare-CWD": CWD }).cwdHint);

		expect(viaPath.projectId).toBe(projectId);
		expect(viaPath.projectId).toBe(viaCwd.projectId);
		expect(viaPath.matchedProjectPath).toBe(canonicalPath);
	});

	test("X-CCFlare-Path does not leak into the project NAME, which stays null", () => {
		// The name aliases live in usage-collector.ts; a path must never become a
		// display name. This is the mistake the issue names as the one that must
		// not happen.
		expect(metaFor({ "X-CCFlare-Path": CWD }).project).toBeNull();
	});
});
