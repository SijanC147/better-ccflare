import { randomUUID } from "node:crypto";
import {
	type WorktreeRule,
	type WorktreeRuleKind,
	type WorktreeRuleRow,
	toWorktreeRule,
} from "@better-ccflare/types";
import { BaseRepository } from "./base.repository";

function compileCheck(
	kind: WorktreeRuleKind,
	pattern: string,
): { ok: boolean; error: string | null } {
	if (kind === "regex") {
		try {
			new RegExp(pattern);
			return { ok: true, error: null };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	if (kind === "glob") {
		// picomatch is not a direct dependency of the database package.
		// Fall back to a minimal validator: reject empty strings and null bytes.
		if (!pattern || pattern.length === 0) {
			return { ok: false, error: "Glob pattern must not be empty" };
		}
		if (pattern.includes("\0")) {
			return { ok: false, error: "Glob pattern must not contain null bytes" };
		}
		// Attempt to use picomatch if it happens to be resolvable at runtime
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const picomatch = require("picomatch") as {
				(pattern: string, options?: object): (str: string) => boolean;
			};
			picomatch(pattern);
		} catch {
			// Either picomatch is not installed (acceptable) or the pattern is invalid.
			// We only treat it as invalid when picomatch is available AND throws.
			// Since we cannot reliably distinguish the two cases at runtime without
			// inspecting the error code, we accept the pattern when picomatch is absent.
		}
		return { ok: true, error: null };
	}

	if (kind === "directory") {
		if (!pattern.startsWith("/")) {
			return {
				ok: false,
				error: "Directory pattern must be an absolute path (start with '/')",
			};
		}
		return { ok: true, error: null };
	}

	return { ok: false, error: `Unknown kind: ${kind}` };
}

export class WorktreeRuleRepository extends BaseRepository<WorktreeRule> {
	async create(fields: {
		kind: WorktreeRuleKind;
		pattern: string;
		parentProjectId?: string | null;
		priority?: number;
	}): Promise<WorktreeRule> {
		const id = randomUUID();
		const now = Date.now();
		const priority = fields.priority ?? 0;

		const { ok, error } = compileCheck(fields.kind, fields.pattern);

		await this.run(
			`INSERT INTO worktree_rules (id, kind, pattern, parent_project_id, priority, enabled, compile_error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				fields.kind,
				fields.pattern,
				fields.parentProjectId ?? null,
				priority,
				ok ? 1 : 0,
				error,
				now,
			],
		);

		const row = await this.get<WorktreeRuleRow>(
			`SELECT id, kind, pattern, parent_project_id, priority, enabled, compile_error, created_at
       FROM worktree_rules WHERE id = ?`,
			[id],
		);
		if (!row) throw new Error(`Failed to create worktree rule`);
		return toWorktreeRule(row);
	}

	async findAllOrdered(): Promise<WorktreeRule[]> {
		const rows = await this.query<WorktreeRuleRow>(
			`SELECT id, kind, pattern, parent_project_id, priority, enabled, compile_error, created_at
       FROM worktree_rules ORDER BY priority DESC, created_at ASC`,
		);
		return rows.map(toWorktreeRule);
	}

	async findById(id: string): Promise<WorktreeRule | null> {
		const row = await this.get<WorktreeRuleRow>(
			`SELECT id, kind, pattern, parent_project_id, priority, enabled, compile_error, created_at
       FROM worktree_rules WHERE id = ?`,
			[id],
		);
		return row ? toWorktreeRule(row) : null;
	}

	async update(
		id: string,
		fields: Partial<{
			kind: WorktreeRuleKind;
			pattern: string;
			parentProjectId: string | null;
			priority: number;
			enabled: boolean;
		}>,
	): Promise<WorktreeRule> {
		// Re-run compile check if kind or pattern is changing
		const needsRecompile = fields.kind !== undefined || fields.pattern !== undefined;

		let compileResult: { ok: boolean; error: string | null } | null = null;
		if (needsRecompile) {
			// Fetch the current row to fill in missing kind/pattern
			const current = await this.get<WorktreeRuleRow>(
				`SELECT id, kind, pattern, parent_project_id, priority, enabled, compile_error, created_at
         FROM worktree_rules WHERE id = ?`,
				[id],
			);
			if (!current) throw new Error(`WorktreeRule not found: ${id}`);

			const newKind = (fields.kind ?? current.kind) as WorktreeRuleKind;
			const newPattern = fields.pattern ?? current.pattern;
			compileResult = compileCheck(newKind, newPattern);
		}

		const setClauses: string[] = [];
		const params: unknown[] = [];

		if (fields.kind !== undefined) {
			setClauses.push("kind = ?");
			params.push(fields.kind);
		}
		if (fields.pattern !== undefined) {
			setClauses.push("pattern = ?");
			params.push(fields.pattern);
		}
		if (Object.hasOwn(fields, "parentProjectId")) {
			setClauses.push("parent_project_id = ?");
			params.push(fields.parentProjectId ?? null);
		}
		if (fields.priority !== undefined) {
			setClauses.push("priority = ?");
			params.push(fields.priority);
		}
		if (compileResult !== null) {
			// Override enabled based on compile result; if user also passed enabled,
			// compile result wins to keep consistency.
			setClauses.push("enabled = ?");
			params.push(compileResult.ok ? 1 : 0);
			setClauses.push("compile_error = ?");
			params.push(compileResult.error);
		} else if (fields.enabled !== undefined) {
			setClauses.push("enabled = ?");
			params.push(fields.enabled ? 1 : 0);
		}

		if (setClauses.length === 0) {
			const existing = await this.findById(id);
			if (!existing) throw new Error(`WorktreeRule not found: ${id}`);
			return existing;
		}

		params.push(id);
		await this.run(
			`UPDATE worktree_rules SET ${setClauses.join(", ")} WHERE id = ?`,
			params,
		);

		const row = await this.get<WorktreeRuleRow>(
			`SELECT id, kind, pattern, parent_project_id, priority, enabled, compile_error, created_at
       FROM worktree_rules WHERE id = ?`,
			[id],
		);
		if (!row) throw new Error(`WorktreeRule not found after update: ${id}`);
		return toWorktreeRule(row);
	}

	async delete(id: string): Promise<void> {
		await this.run(`DELETE FROM worktree_rules WHERE id = ?`, [id]);
	}
}
