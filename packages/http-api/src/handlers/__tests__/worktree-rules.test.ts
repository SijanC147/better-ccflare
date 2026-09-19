import { describe, expect, it } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";
import type { WorktreeRule } from "@better-ccflare/types";
import {
	createWorktreeRuleCreateHandler,
	createWorktreeRuleTestHandler,
	createWorktreeRuleUpdateHandler,
} from "../worktree-rules";

// ── Minimal stub factory ───────────────────────────────────────────────────

function makeRule(overrides: Partial<WorktreeRule> = {}): WorktreeRule {
	return {
		id: "rule-1",
		kind: "directory",
		pattern: "/Users/test/Code/worktrees",
		parent_project_id: null,
		priority: 0,
		enabled: true,
		compile_error: null,
		created_at: 1_700_000_000_000,
		...overrides,
	};
}

interface Calls {
	created: unknown[];
	updated: unknown[];
	rebuilds: number;
}

function makeDbOps(overrides: Partial<Record<string, unknown>> = {}): {
	dbOps: DatabaseOperations;
	calls: Calls;
} {
	const calls: Calls = { created: [], updated: [], rebuilds: 0 };
	const dbOps = {
		listWorktreeRules: async () => [makeRule()],
		getWorktreeRule: async (_id: string) => makeRule(),
		createWorktreeRule: async (fields: Record<string, unknown>) => {
			calls.created.push(fields);
			return makeRule({
				kind: fields.kind as WorktreeRule["kind"],
				pattern: fields.pattern as string,
			});
		},
		updateWorktreeRule: async (
			_id: string,
			fields: Record<string, unknown>,
		) => {
			calls.updated.push(fields);
			return makeRule(fields as Partial<WorktreeRule>);
		},
		deleteWorktreeRule: async (_id: string) => {},
		rebuildResolver: async () => {
			calls.rebuilds += 1;
		},
		...overrides,
	} as unknown as DatabaseOperations;
	return { dbOps, calls };
}

function makeRequest(method: string, url: string, body?: unknown): Request {
	return new Request(url, {
		method,
		headers: body ? { "Content-Type": "application/json" } : {},
		body: body ? JSON.stringify(body) : undefined,
	});
}

// ── POST /api/worktree-rules ───────────────────────────────────────────────

describe("POST /api/worktree-rules — directory pattern must be absolute", () => {
	it("rejects a relative directory pattern with 400 and never writes", async () => {
		const { dbOps, calls } = makeDbOps();
		const handler = createWorktreeRuleCreateHandler(dbOps);

		const res = await handler(
			makeRequest("POST", "http://localhost/api/worktree-rules", {
				kind: "directory",
				pattern: "Code/worktrees",
			}),
		);

		expect(res.status).toBe(400);
		const body = await res.json();
		const message = JSON.stringify(body);
		// Name the field and say what was wrong with it, not merely that
		// something was wrong: the operator has to know which input to change.
		expect(message).toContain("pattern");
		expect(message).toContain("absolute");
		expect(message).toContain("Code/worktrees");
		expect(calls.created).toHaveLength(0);
		expect(calls.rebuilds).toBe(0);
	});

	it("rejects a tilde directory pattern, which is not absolute", async () => {
		const { dbOps, calls } = makeDbOps();
		const handler = createWorktreeRuleCreateHandler(dbOps);

		const res = await handler(
			makeRequest("POST", "http://localhost/api/worktree-rules", {
				kind: "directory",
				pattern: "~/Code/worktrees",
			}),
		);

		expect(res.status).toBe(400);
		expect(calls.created).toHaveLength(0);
	});

	it("accepts an absolute directory pattern and stores it trimmed", async () => {
		const { dbOps, calls } = makeDbOps();
		const handler = createWorktreeRuleCreateHandler(dbOps);

		const res = await handler(
			makeRequest("POST", "http://localhost/api/worktree-rules", {
				kind: "directory",
				pattern: "  /Users/test/Code/worktrees  ",
				priority: 5,
			}),
		);

		expect(res.status).toBe(201);
		expect(calls.created).toHaveLength(1);
		expect(calls.created[0]).toMatchObject({
			kind: "directory",
			pattern: "/Users/test/Code/worktrees",
			priority: 5,
		});
		expect(calls.rebuilds).toBe(1);
	});

	it("still accepts a glob pattern that is not a path", async () => {
		const { dbOps, calls } = makeDbOps();
		const handler = createWorktreeRuleCreateHandler(dbOps);

		const res = await handler(
			makeRequest("POST", "http://localhost/api/worktree-rules", {
				kind: "glob",
				pattern: "**/.worktrees/**",
			}),
		);

		expect(res.status).toBe(201);
		expect(calls.created).toHaveLength(1);
	});

	it("still rejects a regex pattern that does not compile", async () => {
		const { dbOps, calls } = makeDbOps();
		const handler = createWorktreeRuleCreateHandler(dbOps);

		const res = await handler(
			makeRequest("POST", "http://localhost/api/worktree-rules", {
				kind: "regex",
				pattern: "[",
			}),
		);

		expect(res.status).toBe(400);
		expect(JSON.stringify(await res.json())).toContain("regex");
		expect(calls.created).toHaveLength(0);
	});
});

// ── PATCH /api/worktree-rules/:id ─────────────────────────────────────────

describe("PATCH /api/worktree-rules/:id — kind and pattern validate as a pair", () => {
	it("rejects a relative directory pattern", async () => {
		const { dbOps, calls } = makeDbOps();
		const handler = createWorktreeRuleUpdateHandler(dbOps);

		const res = await handler(
			makeRequest("PATCH", "http://localhost/api/worktree-rules/rule-1", {
				pattern: "../elsewhere",
			}),
			"rule-1",
		);

		expect(res.status).toBe(400);
		expect(JSON.stringify(await res.json())).toContain("absolute");
		expect(calls.updated).toHaveLength(0);
	});

	it("rejects a kind change to directory when the stored pattern is relative", async () => {
		// The pattern on the row is not supplied in this request, so a check
		// gated on `pattern !== undefined` never runs and the rule is stored
		// with a pattern nothing validated against the kind now reading it.
		const { dbOps, calls } = makeDbOps({
			getWorktreeRule: async () =>
				makeRule({ kind: "glob", pattern: "Code/**/worktrees" }),
		});
		const handler = createWorktreeRuleUpdateHandler(dbOps);

		const res = await handler(
			makeRequest("PATCH", "http://localhost/api/worktree-rules/rule-1", {
				kind: "directory",
			}),
			"rule-1",
		);

		expect(res.status).toBe(400);
		expect(JSON.stringify(await res.json())).toContain("absolute");
		expect(calls.updated).toHaveLength(0);
		expect(calls.rebuilds).toBe(0);
	});

	it("rejects a kind change to regex when the stored pattern does not compile", async () => {
		const { dbOps, calls } = makeDbOps({
			getWorktreeRule: async () =>
				makeRule({ kind: "directory", pattern: "[" }),
		});
		const handler = createWorktreeRuleUpdateHandler(dbOps);

		const res = await handler(
			makeRequest("PATCH", "http://localhost/api/worktree-rules/rule-1", {
				kind: "regex",
			}),
			"rule-1",
		);

		expect(res.status).toBe(400);
		expect(JSON.stringify(await res.json())).toContain("regex");
		expect(calls.updated).toHaveLength(0);
	});

	it("accepts a kind change to directory when the stored pattern is absolute", async () => {
		const { dbOps, calls } = makeDbOps({
			getWorktreeRule: async () =>
				makeRule({ kind: "glob", pattern: "/Users/test/Code/worktrees" }),
		});
		const handler = createWorktreeRuleUpdateHandler(dbOps);

		const res = await handler(
			makeRequest("PATCH", "http://localhost/api/worktree-rules/rule-1", {
				kind: "directory",
			}),
			"rule-1",
		);

		expect(res.status).toBe(200);
		expect(calls.updated).toHaveLength(1);
		expect(calls.updated[0]).toMatchObject({ kind: "directory" });
	});

	it("accepts an absolute directory pattern", async () => {
		const { dbOps, calls } = makeDbOps();
		const handler = createWorktreeRuleUpdateHandler(dbOps);

		const res = await handler(
			makeRequest("PATCH", "http://localhost/api/worktree-rules/rule-1", {
				pattern: "/Users/test/Code/other",
			}),
			"rule-1",
		);

		expect(res.status).toBe(200);
		expect(calls.updated[0]).toMatchObject({
			pattern: "/Users/test/Code/other",
		});
	});

	it("leaves a priority-only update alone, validating nothing", async () => {
		// The stored pattern is relative and stays that way: this PATCH does not
		// touch kind or pattern, so it must not start failing on a pre-existing
		// row that the create handler let through before this guard existed.
		const { dbOps, calls } = makeDbOps({
			getWorktreeRule: async () =>
				makeRule({ kind: "directory", pattern: "Code/worktrees" }),
		});
		const handler = createWorktreeRuleUpdateHandler(dbOps);

		const res = await handler(
			makeRequest("PATCH", "http://localhost/api/worktree-rules/rule-1", {
				priority: 9,
			}),
			"rule-1",
		);

		expect(res.status).toBe(200);
		expect(calls.updated[0]).toMatchObject({ priority: 9 });
	});
});

// ── POST /api/worktree-rules/test ─────────────────────────────────────────

describe("POST /api/worktree-rules/test — refuses what create refuses", () => {
	it("rejects a relative directory pattern with 400", async () => {
		const handler = createWorktreeRuleTestHandler();

		const res = await handler(
			makeRequest("POST", "http://localhost/api/worktree-rules/test", {
				kind: "directory",
				pattern: "Code/worktrees",
				samplePaths: ["/Users/test/Code/worktrees/a"],
			}),
		);

		expect(res.status).toBe(400);
		expect(JSON.stringify(await res.json())).toContain("absolute");
	});

	it("still matches an absolute directory pattern", async () => {
		const handler = createWorktreeRuleTestHandler();

		const res = await handler(
			makeRequest("POST", "http://localhost/api/worktree-rules/test", {
				kind: "directory",
				pattern: "/Users/test/Code/worktrees",
				samplePaths: [
					"/Users/test/Code/worktrees/a",
					"/Users/test/Code/elsewhere",
				],
			}),
		);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.matches[0].matched).toBe(true);
		expect(body.matches[1].matched).toBe(false);
	});

	it("still reports a bad regex per sample path rather than 400", async () => {
		// The dashboard's tester renders a per-path error; the directory guard
		// must not convert compile failures on the other kinds into a 400.
		const handler = createWorktreeRuleTestHandler();

		const res = await handler(
			makeRequest("POST", "http://localhost/api/worktree-rules/test", {
				kind: "regex",
				pattern: "[",
				samplePaths: ["/Users/test/Code/worktrees/a"],
			}),
		);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.matches[0].matched).toBe(false);
		expect(typeof body.matches[0].error).toBe("string");
	});
});
