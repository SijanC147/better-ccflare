import type { DatabaseOperations } from "@better-ccflare/database";
import { BadRequest, NotFound } from "@better-ccflare/errors";
import type { Project, WorktreeRuleKind } from "@better-ccflare/types";
import { basename } from "node:path";
import { errorResponse } from "../utils/http-error";

// ── GET /api/projects ──────────────────────────────────────────────────────

/**
 * GET /api/projects
 *
 * Returns `{ success, data: Project[], count }` by default.
 * If `?legacy=1` is present, returns `string[]` of display_name values
 * for backwards compatibility with the old distinct-values endpoint.
 */
export function createProjectsListHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		try {
			const url = new URL(req.url);
			const legacy = url.searchParams.get("legacy") === "1";

			const projects = await dbOps.listProjects();

			if (legacy) {
				const names = projects.map((p: Project) => p.display_name);
				return new Response(JSON.stringify(names), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			return new Response(
				JSON.stringify({ success: true, data: projects, count: projects.length }),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		} catch (error) {
			return errorResponse(error);
		}
	};
}

// ── POST /api/projects ─────────────────────────────────────────────────────

/**
 * POST /api/projects
 *
 * Manually create a project. Body:
 *   { canonical_path: string; display_name?: string; parent_project_id?: string | null; enabled?: boolean }
 *
 * Source is always 'manual'.
 * display_name defaults to basename(canonical_path).
 */
export function createProjectCreateHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();
			const {
				canonical_path,
				display_name,
				parent_project_id = null,
				enabled = true,
			} = body;

			if (
				!canonical_path ||
				typeof canonical_path !== "string" ||
				canonical_path.trim().length === 0
			) {
				return errorResponse(
					BadRequest("canonical_path is required and must be a non-empty string"),
				);
			}

			const trimmedPath = canonical_path.trim();
			const resolvedName =
				display_name && typeof display_name === "string" && display_name.trim().length > 0
					? display_name.trim()
					: basename(trimmedPath) || trimmedPath;

			const project = await dbOps.createProject({
				canonicalPath: trimmedPath,
				displayName: resolvedName,
				source: "manual",
				enabled: !!enabled,
				parentProjectId: parent_project_id ?? null,
			});

			return new Response(JSON.stringify({ success: true, data: project }), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

// ── GET /api/projects/:id ──────────────────────────────────────────────────

/**
 * GET /api/projects/:id
 *
 * Returns the single project or 404.
 */
export function createProjectGetHandler(dbOps: DatabaseOperations) {
	return async (id: string): Promise<Response> => {
		try {
			const project = await dbOps.getProject(id);
			if (!project) {
				return errorResponse(NotFound("Project not found"));
			}

			return new Response(JSON.stringify({ success: true, data: project }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

// ── PATCH /api/projects/:id ────────────────────────────────────────────────

/**
 * PATCH /api/projects/:id
 *
 * Update a subset of mutable project fields.
 * Body (all optional):
 *   { display_name?, enabled?, parent_project_id?, metadata? }
 */
export function createProjectUpdateHandler(dbOps: DatabaseOperations) {
	return async (req: Request, id: string): Promise<Response> => {
		try {
			const project = await dbOps.getProject(id);
			if (!project) {
				return errorResponse(NotFound("Project not found"));
			}

			const body = await req.json();
			const { display_name, enabled, parent_project_id, metadata } = body;

			const fields: Partial<{
				displayName: string;
				enabled: boolean;
				parentProjectId: string | null;
				metadata: object | null;
			}> = {};

			if (display_name !== undefined) {
				if (
					typeof display_name !== "string" ||
					display_name.trim().length === 0
				) {
					return errorResponse(
						BadRequest("display_name must be a non-empty string"),
					);
				}
				fields.displayName = display_name.trim();
			}

			if (enabled !== undefined) {
				fields.enabled = !!enabled;
			}

			if (parent_project_id !== undefined) {
				fields.parentProjectId = parent_project_id ?? null;
			}

			if (metadata !== undefined) {
				fields.metadata =
					metadata === null || typeof metadata === "object" ? metadata : null;
			}

			const updated = await dbOps.updateProject(id, fields);

			return new Response(JSON.stringify({ success: true, data: updated }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

// ── DELETE /api/projects/:id ───────────────────────────────────────────────

/**
 * DELETE /api/projects/:id
 *
 * Only projects with source='manual' may be hard-deleted.
 * Discovered projects should be disabled via PATCH instead.
 */
export function createProjectDeleteHandler(dbOps: DatabaseOperations) {
	return async (id: string): Promise<Response> => {
		try {
			const project = await dbOps.getProject(id);
			if (!project) {
				return errorResponse(NotFound("Project not found"));
			}

			if (project.source !== "manual") {
				return errorResponse(
					BadRequest(
						"Only manually created projects can be deleted. To hide a discovered project, disable it via PATCH instead.",
					),
				);
			}

			await dbOps.deleteProject(id);

			return new Response(
				JSON.stringify({ success: true, message: "Project deleted successfully" }),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		} catch (error) {
			return errorResponse(error);
		}
	};
}

// ── POST /api/projects/discover ────────────────────────────────────────────

/**
 * POST /api/projects/discover
 *
 * Triggers an immediate discovery rescan via the injected DiscoveryScheduler
 * runner (wired in Phase 3.C via dbOps.runDiscoveryScan).
 */
export function createProjectsDiscoverHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		try {
			const result = await dbOps.runDiscoveryScan();
			return new Response(JSON.stringify({ success: true, data: result }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}
