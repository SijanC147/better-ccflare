// Project + worktree-rule domain types
//
// Projects are canonical entities sourced by scanning ~/.claude/projects/ on
// the host where the proxy runs (and/or manually created via the dashboard).
// Worktree rules let users mark detected paths as worktrees of a parent
// project so request attribution rolls up to the parent while preserving the
// worktree label for display.

export type ProjectSource = "discovered" | "manual";
export type WorktreeRuleKind = "glob" | "regex" | "directory";

// --- Database row types (snake_case, INTEGER booleans) ---

export interface ProjectRow {
	id: string;
	canonical_path: string;
	display_name: string;
	enabled: number; // 0 or 1
	source: string; // ProjectSource
	parent_project_id: string | null;
	last_session_at: number | null;
	session_count: number;
	discovered_at: number;
	metadata: string | null; // JSON blob
}

export interface WorktreeRuleRow {
	id: string;
	kind: string; // WorktreeRuleKind
	pattern: string;
	parent_project_id: string | null;
	priority: number;
	enabled: number; // 0 or 1
	compile_error: string | null;
	created_at: number;
}

// --- Domain model types (camelCase, proper booleans) ---

export interface Project {
	id: string;
	canonical_path: string;
	display_name: string;
	enabled: boolean;
	source: ProjectSource;
	parent_project_id: string | null;
	last_session_at: number | null;
	session_count: number;
	discovered_at: number;
	metadata: Record<string, unknown> | null;
}

export interface WorktreeRule {
	id: string;
	kind: WorktreeRuleKind;
	pattern: string;
	parent_project_id: string | null;
	priority: number;
	enabled: boolean;
	compile_error: string | null;
	created_at: number;
}

// Tree-friendly shape used by the dashboard
export interface ProjectWithChildren extends Project {
	children: Project[];
}

// --- Mappers ---

export function toProject(row: ProjectRow): Project {
	let metadata: Record<string, unknown> | null = null;
	if (row.metadata) {
		try {
			const parsed = JSON.parse(row.metadata);
			if (parsed && typeof parsed === "object") {
				metadata = parsed as Record<string, unknown>;
			}
		} catch {
			// Corrupt metadata blob — drop silently; not actionable for callers.
			metadata = null;
		}
	}
	const source: ProjectSource =
		row.source === "manual" ? "manual" : "discovered";
	return {
		id: row.id,
		canonical_path: row.canonical_path,
		display_name: row.display_name,
		enabled: !!row.enabled,
		source,
		parent_project_id: row.parent_project_id,
		last_session_at:
			row.last_session_at != null ? Number(row.last_session_at) : null,
		session_count: Number(row.session_count) || 0,
		discovered_at: Number(row.discovered_at),
		metadata,
	};
}

export function toWorktreeRule(row: WorktreeRuleRow): WorktreeRule {
	const validKinds: WorktreeRuleKind[] = ["glob", "regex", "directory"];
	const kind: WorktreeRuleKind = validKinds.includes(
		row.kind as WorktreeRuleKind,
	)
		? (row.kind as WorktreeRuleKind)
		: "directory";
	return {
		id: row.id,
		kind,
		pattern: row.pattern,
		parent_project_id: row.parent_project_id,
		priority: Number(row.priority) || 0,
		enabled: !!row.enabled,
		compile_error: row.compile_error,
		created_at: Number(row.created_at),
	};
}
