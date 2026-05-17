import { createHash } from "node:crypto";
import { BadRequest, NotFound } from "@better-ccflare/errors";
import {
	type Project,
	type ProjectRow,
	type ProjectSource,
	toProject,
} from "@better-ccflare/types";
import { BaseRepository } from "./base.repository";

function projectIdFromPath(canonicalPath: string): string {
	return createHash("sha1").update(canonicalPath).digest("hex").slice(0, 16);
}

export class ProjectRepository extends BaseRepository<Project> {
	async create(fields: {
		canonicalPath: string;
		displayName: string;
		source?: "discovered" | "manual";
		enabled?: boolean;
		parentProjectId?: string | null;
		metadata?: object | null;
	}): Promise<Project> {
		const id = projectIdFromPath(fields.canonicalPath);
		const now = Date.now();
		const source: ProjectSource = fields.source ?? "discovered";
		const enabled = fields.enabled !== undefined ? fields.enabled : true;
		const metadataJson = fields.metadata ? JSON.stringify(fields.metadata) : null;

		await this.run(
			`INSERT INTO projects (id, canonical_path, display_name, enabled, source, parent_project_id, last_session_at, session_count, discovered_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)
       ON CONFLICT(canonical_path) DO NOTHING`,
			[
				id,
				fields.canonicalPath,
				fields.displayName,
				enabled ? 1 : 0,
				source,
				fields.parentProjectId ?? null,
				now,
				metadataJson,
			],
		);

		const row = await this.get<ProjectRow>(
			`SELECT id, canonical_path, display_name, enabled, source, parent_project_id, last_session_at, session_count, discovered_at, metadata
       FROM projects WHERE canonical_path = ?`,
			[fields.canonicalPath],
		);
		if (!row) throw new Error(`Failed to create/find project: ${fields.canonicalPath}`);
		return toProject(row);
	}

	async findAll(): Promise<Project[]> {
		// LOWER() works on both SQLite and Postgres. COLLATE NOCASE is a
		// SQLite-only collation that the BunSqlAdapter passes through
		// verbatim, so on Postgres it fails with a "collation does not
		// exist" error (Codex round 6 P1).
		const rows = await this.query<ProjectRow>(
			`SELECT id, canonical_path, display_name, enabled, source, parent_project_id, last_session_at, session_count, discovered_at, metadata
       FROM projects ORDER BY LOWER(display_name) ASC`,
		);
		return rows.map(toProject);
	}

	async findById(id: string): Promise<Project | null> {
		const row = await this.get<ProjectRow>(
			`SELECT id, canonical_path, display_name, enabled, source, parent_project_id, last_session_at, session_count, discovered_at, metadata
       FROM projects WHERE id = ?`,
			[id],
		);
		return row ? toProject(row) : null;
	}

	async findByCanonicalPath(path: string): Promise<Project | null> {
		const row = await this.get<ProjectRow>(
			`SELECT id, canonical_path, display_name, enabled, source, parent_project_id, last_session_at, session_count, discovered_at, metadata
       FROM projects WHERE canonical_path = ?`,
			[path],
		);
		return row ? toProject(row) : null;
	}

	async findByParent(parentId: string): Promise<Project[]> {
		const rows = await this.query<ProjectRow>(
			`SELECT id, canonical_path, display_name, enabled, source, parent_project_id, last_session_at, session_count, discovered_at, metadata
       FROM projects WHERE parent_project_id = ? ORDER BY display_name COLLATE NOCASE ASC`,
			[parentId],
		);
		return rows.map(toProject);
	}

	async update(
		id: string,
		fields: Partial<{
			displayName: string;
			enabled: boolean;
			parentProjectId: string | null;
			metadata: object | null;
		}>,
	): Promise<Project> {
		const setClauses: string[] = [];
		const params: unknown[] = [];

		if (fields.displayName !== undefined) {
			setClauses.push("display_name = ?");
			params.push(fields.displayName);
		}
		if (fields.enabled !== undefined) {
			setClauses.push("enabled = ?");
			params.push(fields.enabled ? 1 : 0);
		}
		if (Object.hasOwn(fields, "parentProjectId")) {
			setClauses.push("parent_project_id = ?");
			params.push(fields.parentProjectId ?? null);
		}
		if (Object.hasOwn(fields, "metadata")) {
			setClauses.push("metadata = ?");
			params.push(fields.metadata ? JSON.stringify(fields.metadata) : null);
		}

		if (setClauses.length === 0) {
			const existing = await this.findById(id);
			if (!existing) throw NotFound(`Project not found: ${id}`);
			return existing;
		}

		params.push(id);
		await this.run(
			`UPDATE projects SET ${setClauses.join(", ")} WHERE id = ?`,
			params,
		);

		const row = await this.get<ProjectRow>(
			`SELECT id, canonical_path, display_name, enabled, source, parent_project_id, last_session_at, session_count, discovered_at, metadata
       FROM projects WHERE id = ?`,
			[id],
		);
		if (!row) throw NotFound(`Project not found after update: ${id}`);
		return toProject(row);
	}

	async delete(id: string): Promise<void> {
		const row = await this.get<{ source: string }>(
			`SELECT source FROM projects WHERE id = ?`,
			[id],
		);
		if (!row) return; // already gone — idempotent
		if (row.source !== "manual") {
			throw BadRequest(
				"Cannot delete discovered project; disable instead",
			);
		}
		await this.run(`DELETE FROM projects WHERE id = ?`, [id]);
	}

	async upsertFromDiscovery(
		rows: Array<{
			canonicalPath: string;
			displayName: string;
			sessionCount: number;
			lastSessionAt: number | null;
		}>,
	): Promise<{ added: number; updated: number; unchanged: number }> {
		let added = 0;
		let updated = 0;
		let unchanged = 0;

		for (const row of rows) {
			const id = projectIdFromPath(row.canonicalPath);
			const now = Date.now();

			// Try to insert first. If the row already exists, DO NOTHING.
			// We track changes to know if it was inserted.
			const changes = await this.runWithChanges(
				`INSERT INTO projects (id, canonical_path, display_name, enabled, source, parent_project_id, last_session_at, session_count, discovered_at, metadata)
         VALUES (?, ?, ?, 1, 'discovered', NULL, ?, ?, ?, NULL)
         ON CONFLICT(canonical_path) DO NOTHING`,
				[
					id,
					row.canonicalPath,
					row.displayName,
					row.lastSessionAt ?? null,
					row.sessionCount,
					now,
				],
			);

			if (changes > 0) {
				added++;
			} else {
				// Row already exists. Update session_count and last_session_at only.
				// Leave display_name alone so manual renames are preserved.
				// COALESCE-based null-safe value comparison works on both SQLite
				// and Postgres. The previous `IS NOT $param` is a SQLite-ism: PG
				// only accepts `IS [NOT] {NULL,TRUE,FALSE,UNKNOWN}` after IS, so
				// `IS NOT $5` with a numeric placeholder errors and the whole
				// upsert fails on existing rows (Codex round 6 P1). Sentinel -1
				// is safe because last_session_at is a non-negative ms epoch.
				const updateChanges = await this.runWithChanges(
					`UPDATE projects
           SET session_count = ?, last_session_at = ?
           WHERE canonical_path = ?
             AND (session_count != ? OR COALESCE(last_session_at, -1) != COALESCE(?, -1))`,
					[
						row.sessionCount,
						row.lastSessionAt ?? null,
						row.canonicalPath,
						row.sessionCount,
						row.lastSessionAt ?? null,
					],
				);

				if (updateChanges > 0) {
					updated++;
				} else {
					unchanged++;
				}
			}
		}

		return { added, updated, unchanged };
	}
}
