import { describe, expect, it } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";
import type { Project } from "@better-ccflare/types";
import {
	createProjectCreateHandler,
	createProjectDeleteHandler,
	createProjectGetHandler,
	createProjectsListHandler,
} from "../projects";

// ── Minimal stub factory ───────────────────────────────────────────────────

function makeProject(overrides: Partial<Project> = {}): Project {
	return {
		id: "abc123",
		canonical_path: "/Users/test/Code/my-app",
		display_name: "my-app",
		enabled: true,
		source: "manual",
		parent_project_id: null,
		last_session_at: null,
		session_count: 0,
		discovered_at: Date.now(),
		metadata: null,
		...overrides,
	};
}

function makeDiscoveredProject(overrides: Partial<Project> = {}): Project {
	return makeProject({ source: "discovered", id: "def456", ...overrides });
}

/** Build a partial DatabaseOperations stub — only methods used by projects.ts */
function makeDbOps(overrides: Partial<DatabaseOperations> = {}): DatabaseOperations {
	return {
		listProjects: async () => [],
		getProject: async (_id: string) => null,
		createProject: async (fields) =>
			makeProject({
				canonical_path: fields.canonicalPath,
				display_name: fields.displayName,
				source: fields.source ?? "manual",
			}),
		deleteProject: async (_id: string) => {},
		...overrides,
	} as unknown as DatabaseOperations;
}

function makeRequest(
	method: string,
	url: string,
	body?: unknown,
): Request {
	return new Request(url, {
		method,
		headers: body ? { "Content-Type": "application/json" } : {},
		body: body ? JSON.stringify(body) : undefined,
	});
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("GET /api/projects", () => {
	it("returns { success, data, count } shape by default", async () => {
		const projects = [makeProject(), makeProject({ id: "xyz", display_name: "other-app" })];
		const handler = createProjectsListHandler(
			makeDbOps({ listProjects: async () => projects }),
		);

		const res = await handler(makeRequest("GET", "http://localhost/api/projects"));
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body.success).toBe(true);
		expect(Array.isArray(body.data)).toBe(true);
		expect(body.count).toBe(2);
		expect(body.data[0].display_name).toBe("my-app");
	});

	it("returns string[] when ?legacy=1", async () => {
		const projects = [makeProject(), makeProject({ id: "xyz", display_name: "other-app" })];
		const handler = createProjectsListHandler(
			makeDbOps({ listProjects: async () => projects }),
		);

		const res = await handler(
			makeRequest("GET", "http://localhost/api/projects?legacy=1"),
		);
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(Array.isArray(body)).toBe(true);
		expect(body).toEqual(["my-app", "other-app"]);
	});
});

describe("POST /api/projects", () => {
	it("creates project and returns 201", async () => {
		const handler = createProjectCreateHandler(makeDbOps());

		const res = await handler(
			makeRequest("POST", "http://localhost/api/projects", {
				canonical_path: "/Users/test/Code/new-app",
				display_name: "new-app",
			}),
		);

		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.success).toBe(true);
		expect(body.data).toBeDefined();
	});

	it("returns 400 when canonical_path is missing", async () => {
		const handler = createProjectCreateHandler(makeDbOps());

		const res = await handler(
			makeRequest("POST", "http://localhost/api/projects", { display_name: "oops" }),
		);

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBeDefined();
	});
});

describe("GET /api/projects/:id", () => {
	it("returns 404 when project does not exist", async () => {
		const handler = createProjectGetHandler(makeDbOps({ getProject: async () => null }));

		const res = await handler("nonexistent-id");
		expect(res.status).toBe(404);

		const body = await res.json();
		expect(body.error).toBeDefined();
	});

	it("returns the project when it exists", async () => {
		const project = makeProject();
		const handler = createProjectGetHandler(
			makeDbOps({ getProject: async () => project }),
		);

		const res = await handler("abc123");
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body.success).toBe(true);
		expect(body.data.id).toBe("abc123");
	});
});

describe("DELETE /api/projects/:id", () => {
	it("returns 400 when project source is 'discovered'", async () => {
		const discovered = makeDiscoveredProject();
		const handler = createProjectDeleteHandler(
			makeDbOps({ getProject: async () => discovered }),
		);

		const res = await handler("def456");
		expect(res.status).toBe(400);

		const body = await res.json();
		expect(body.error).toMatch(/manual/i);
	});

	it("returns 200 when project source is 'manual'", async () => {
		const manual = makeProject({ source: "manual" });
		const handler = createProjectDeleteHandler(
			makeDbOps({
				getProject: async () => manual,
				deleteProject: async () => {},
			}),
		);

		const res = await handler("abc123");
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body.success).toBe(true);
	});
});
