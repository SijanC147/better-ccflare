import type { DatabaseOperations } from "@better-ccflare/database";
import { BadRequest, NotFound } from "@better-ccflare/errors";
import type { WorktreeRuleKind } from "@better-ccflare/types";
import { errorResponse } from "../utils/http-error";

const VALID_KINDS: WorktreeRuleKind[] = ["glob", "regex", "directory"];

// ── GET /api/worktree-rules ────────────────────────────────────────────────

/**
 * GET /api/worktree-rules
 *
 * Returns all rules ordered by priority DESC.
 */
export function createWorktreeRulesListHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		try {
			const rules = await dbOps.listWorktreeRules();
			return new Response(
				JSON.stringify({ success: true, data: rules, count: rules.length }),
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

// ── POST /api/worktree-rules ───────────────────────────────────────────────

/**
 * POST /api/worktree-rules
 *
 * Create a worktree rule. Body:
 *   { kind: 'glob'|'regex'|'directory'; pattern: string; parent_project_id?: string|null; priority?: number }
 *
 * Validates that the pattern compiles for regex kind.
 */
export function createWorktreeRuleCreateHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();
			const { kind, pattern, parent_project_id = null, priority = 0 } = body;

			if (!kind || !VALID_KINDS.includes(kind)) {
				return errorResponse(
					BadRequest(
						`kind must be one of: ${VALID_KINDS.join(", ")}`,
					),
				);
			}

			if (
				!pattern ||
				typeof pattern !== "string" ||
				pattern.trim().length === 0
			) {
				return errorResponse(
					BadRequest("pattern is required and must be a non-empty string"),
				);
			}

			const trimmedPattern = pattern.trim();

			// Validate regex compiles
			if (kind === "regex") {
				try {
					new RegExp(trimmedPattern);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					return errorResponse(BadRequest(`Invalid regex pattern: ${msg}`));
				}
			}

			const rule = await dbOps.createWorktreeRule({
				kind: kind as WorktreeRuleKind,
				pattern: trimmedPattern,
				parentProjectId: parent_project_id ?? null,
				priority: typeof priority === "number" ? priority : 0,
			});

			// Refresh the live ResolverManager snapshot so the new rule takes
			// effect immediately. Without this, request attribution would keep
			// using the stale snapshot until the next discovery tick (Codex
			// round 6 P2).
			await dbOps.rebuildResolver();

			return new Response(JSON.stringify({ success: true, data: rule }), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

// ── PATCH /api/worktree-rules/:id ─────────────────────────────────────────

/**
 * PATCH /api/worktree-rules/:id
 *
 * Update mutable fields of a worktree rule.
 */
export function createWorktreeRuleUpdateHandler(dbOps: DatabaseOperations) {
	return async (req: Request, id: string): Promise<Response> => {
		try {
			const rule = await dbOps.getWorktreeRule(id);
			if (!rule) {
				return errorResponse(NotFound("Worktree rule not found"));
			}

			const body = await req.json();
			const { kind, pattern, parent_project_id, priority, enabled } = body;

			const fields: Partial<{
				kind: WorktreeRuleKind;
				pattern: string;
				parentProjectId: string | null;
				priority: number;
				enabled: boolean;
			}> = {};

			if (kind !== undefined) {
				if (!VALID_KINDS.includes(kind)) {
					return errorResponse(
						BadRequest(`kind must be one of: ${VALID_KINDS.join(", ")}`),
					);
				}
				fields.kind = kind as WorktreeRuleKind;
			}

			if (pattern !== undefined) {
				if (typeof pattern !== "string" || pattern.trim().length === 0) {
					return errorResponse(
						BadRequest("pattern must be a non-empty string"),
					);
				}
				const trimmedPattern = pattern.trim();
				const resolvedKind = fields.kind ?? rule.kind;
				if (resolvedKind === "regex") {
					try {
						new RegExp(trimmedPattern);
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						return errorResponse(BadRequest(`Invalid regex pattern: ${msg}`));
					}
				}
				fields.pattern = trimmedPattern;
			}

			if (parent_project_id !== undefined) {
				fields.parentProjectId = parent_project_id ?? null;
			}

			if (priority !== undefined) {
				if (typeof priority !== "number") {
					return errorResponse(BadRequest("priority must be a number"));
				}
				fields.priority = priority;
			}

			if (enabled !== undefined) {
				fields.enabled = !!enabled;
			}

			const updated = await dbOps.updateWorktreeRule(id, fields);

			await dbOps.rebuildResolver();

			return new Response(JSON.stringify({ success: true, data: updated }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

// ── DELETE /api/worktree-rules/:id ────────────────────────────────────────

/**
 * DELETE /api/worktree-rules/:id
 */
export function createWorktreeRuleDeleteHandler(dbOps: DatabaseOperations) {
	return async (id: string): Promise<Response> => {
		try {
			const rule = await dbOps.getWorktreeRule(id);
			if (!rule) {
				return errorResponse(NotFound("Worktree rule not found"));
			}

			await dbOps.deleteWorktreeRule(id);

			await dbOps.rebuildResolver();

			return new Response(
				JSON.stringify({ success: true, message: "Worktree rule deleted successfully" }),
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

// ── POST /api/worktree-rules/test ─────────────────────────────────────────

/**
 * POST /api/worktree-rules/test
 *
 * Stateless pattern tester. Body:
 *   { kind: 'glob'|'regex'|'directory'; pattern: string; samplePaths: string[] }
 *
 * Returns:
 *   { matches: Array<{ path: string; matched: boolean; error?: string }> }
 *
 * Does NOT persist anything.
 */
export function createWorktreeRuleTestHandler() {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();
			const { kind, pattern, samplePaths } = body;

			if (!kind || !VALID_KINDS.includes(kind)) {
				return errorResponse(
					BadRequest(`kind must be one of: ${VALID_KINDS.join(", ")}`),
				);
			}

			if (
				!pattern ||
				typeof pattern !== "string" ||
				pattern.trim().length === 0
			) {
				return errorResponse(
					BadRequest("pattern is required and must be a non-empty string"),
				);
			}

			if (!Array.isArray(samplePaths)) {
				return errorResponse(BadRequest("samplePaths must be an array of strings"));
			}

			const trimmedPattern = pattern.trim();

			// Try to compile the matcher once; propagate error to every path if it fails
			let compilationError: string | null = null;
			let matcher: ((p: string) => boolean) | null = null;

			try {
				if (kind === "regex") {
					const re = new RegExp(trimmedPattern);
					matcher = (p: string) => re.test(p);
				} else if (kind === "glob") {
					const glob = new Bun.Glob(trimmedPattern);
					matcher = (p: string) => glob.match(p);
				} else {
					// directory — prefix equality (canonicalise trailing slash away)
					const normalised = trimmedPattern.replace(/\/+$/, "");
					matcher = (p: string) => {
						const np = p.replace(/\/+$/, "");
						return np === normalised || np.startsWith(`${normalised}/`);
					};
				}
			} catch (e) {
				compilationError = e instanceof Error ? e.message : String(e);
			}

			const matches = (samplePaths as unknown[]).map((raw) => {
				const path = typeof raw === "string" ? raw : String(raw);
				if (compilationError !== null) {
					return { path, matched: false, error: compilationError };
				}
				try {
					// biome-ignore lint/style/noNonNullAssertion: matcher is set when compilationError is null
					const matched = matcher!(path);
					return { path, matched };
				} catch (e) {
					return {
						path,
						matched: false,
						error: e instanceof Error ? e.message : String(e),
					};
				}
			});

			return new Response(JSON.stringify({ success: true, matches }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}
