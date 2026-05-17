import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Force @better-ccflare/core to initialise before @better-ccflare/types resolves
// its circular dependency (types/agent.ts → core → core/strategy.ts → types/StrategyName).
import "@better-ccflare/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ProjectRepository } from "../project.repository";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: Database; repo: ProjectRepository } {
	const db = new Database(":memory:");

	db.run(`
		CREATE TABLE IF NOT EXISTS projects (
			id TEXT PRIMARY KEY,
			canonical_path TEXT NOT NULL UNIQUE,
			display_name TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1,
			source TEXT NOT NULL DEFAULT 'discovered',
			parent_project_id TEXT,
			last_session_at INTEGER,
			session_count INTEGER NOT NULL DEFAULT 0,
			discovered_at INTEGER NOT NULL,
			metadata TEXT,
			FOREIGN KEY (parent_project_id) REFERENCES projects(id) ON DELETE SET NULL
		)
	`);

	const adapter = new BunSqlAdapter(db);
	const repo = new ProjectRepository(adapter);
	return { db, repo };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProjectRepository", () => {
	let db: Database;
	let repo: ProjectRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});

	afterEach(() => {
		db.close();
	});

	// ── create ──────────────────────────────────────────────────────────────

	describe("create", () => {
		it("inserts a new project and returns it", async () => {
			const project = await repo.create({
				canonicalPath: "/home/user/projects/my-app",
				displayName: "My App",
			});

			expect(project.canonical_path).toBe("/home/user/projects/my-app");
			expect(project.display_name).toBe("My App");
			expect(project.enabled).toBe(true);
			expect(project.source).toBe("discovered");
			expect(project.parent_project_id).toBeNull();
			expect(project.session_count).toBe(0);
			expect(project.id).toHaveLength(16);
		});

		it("returns the existing project on canonical_path conflict (upsert-safe)", async () => {
			const first = await repo.create({
				canonicalPath: "/home/user/projects/my-app",
				displayName: "My App",
				source: "manual",
			});
			// second call with same canonical_path — should return same id
			const second = await repo.create({
				canonicalPath: "/home/user/projects/my-app",
				displayName: "Different Name",
				source: "discovered",
			});

			expect(second.id).toBe(first.id);
			// Original display_name preserved
			expect(second.display_name).toBe("My App");
			expect(second.source).toBe("manual");
		});

		it("generates deterministic id from canonical_path sha1", async () => {
			const a = await repo.create({
				canonicalPath: "/home/user/alpha",
				displayName: "Alpha",
			});
			const b = await repo.create({
				canonicalPath: "/home/user/beta",
				displayName: "Beta",
			});
			expect(a.id).not.toBe(b.id);

			// Same path → same id
			db.run("DELETE FROM projects");
			const a2 = await repo.create({
				canonicalPath: "/home/user/alpha",
				displayName: "Alpha",
			});
			expect(a2.id).toBe(a.id);
		});

		it("stores metadata as JSON blob", async () => {
			const project = await repo.create({
				canonicalPath: "/home/user/projects/meta-app",
				displayName: "Meta App",
				metadata: { foo: "bar", count: 42 },
			});

			expect(project.metadata).toEqual({ foo: "bar", count: 42 });
		});
	});

	// ── findAll ─────────────────────────────────────────────────────────────

	describe("findAll", () => {
		it("returns empty array when no projects", async () => {
			const all = await repo.findAll();
			expect(all).toHaveLength(0);
		});

		it("returns all projects ordered by display_name COLLATE NOCASE ASC", async () => {
			await repo.create({ canonicalPath: "/p/zebra", displayName: "Zebra" });
			await repo.create({ canonicalPath: "/p/apple", displayName: "apple" });
			await repo.create({ canonicalPath: "/p/mango", displayName: "Mango" });

			const all = await repo.findAll();
			expect(all.map((p) => p.display_name)).toEqual(["apple", "Mango", "Zebra"]);
		});
	});

	// ── findById ────────────────────────────────────────────────────────────

	describe("findById", () => {
		it("returns project when found", async () => {
			const created = await repo.create({
				canonicalPath: "/p/my-proj",
				displayName: "My Proj",
			});
			const found = await repo.findById(created.id);
			expect(found).not.toBeNull();
			expect(found?.id).toBe(created.id);
		});

		it("returns null when not found", async () => {
			const found = await repo.findById("nonexistent");
			expect(found).toBeNull();
		});
	});

	// ── findByCanonicalPath ─────────────────────────────────────────────────

	describe("findByCanonicalPath", () => {
		it("returns project matching canonical path", async () => {
			await repo.create({ canonicalPath: "/p/alpha", displayName: "Alpha" });
			const found = await repo.findByCanonicalPath("/p/alpha");
			expect(found).not.toBeNull();
			expect(found?.canonical_path).toBe("/p/alpha");
		});

		it("returns null for unknown path", async () => {
			const found = await repo.findByCanonicalPath("/p/does-not-exist");
			expect(found).toBeNull();
		});
	});

	// ── findByParent ────────────────────────────────────────────────────────

	describe("findByParent", () => {
		it("returns children of a parent project", async () => {
			const parent = await repo.create({
				canonicalPath: "/p/parent",
				displayName: "Parent",
				source: "manual",
			});
			const child1 = await repo.create({
				canonicalPath: "/p/child1",
				displayName: "Child1",
				source: "manual",
				parentProjectId: parent.id,
			});
			const child2 = await repo.create({
				canonicalPath: "/p/child2",
				displayName: "Child2",
				source: "manual",
				parentProjectId: parent.id,
			});

			const children = await repo.findByParent(parent.id);
			expect(children).toHaveLength(2);
			const ids = children.map((c) => c.id);
			expect(ids).toContain(child1.id);
			expect(ids).toContain(child2.id);
		});

		it("returns empty array when parent has no children", async () => {
			const parent = await repo.create({
				canonicalPath: "/p/lonely",
				displayName: "Lonely",
			});
			const children = await repo.findByParent(parent.id);
			expect(children).toHaveLength(0);
		});
	});

	// ── update display_name ─────────────────────────────────────────────────

	describe("update displayName", () => {
		it("updates display_name and returns updated project", async () => {
			const created = await repo.create({
				canonicalPath: "/p/rename-me",
				displayName: "Old Name",
			});
			const updated = await repo.update(created.id, { displayName: "New Name" });
			expect(updated.display_name).toBe("New Name");
			expect(updated.id).toBe(created.id);
		});

		it("throws NotFound when updating non-existent project", async () => {
			await expect(
				repo.update("ghost-id", { displayName: "Ghost" }),
			).rejects.toThrow();
		});
	});

	// ── update parent ───────────────────────────────────────────────────────

	describe("update parentProjectId", () => {
		it("sets parent_project_id on an existing project", async () => {
			const parent = await repo.create({
				canonicalPath: "/p/parent2",
				displayName: "Parent2",
				source: "manual",
			});
			const child = await repo.create({
				canonicalPath: "/p/orphan",
				displayName: "Orphan",
			});
			expect(child.parent_project_id).toBeNull();

			const updated = await repo.update(child.id, {
				parentProjectId: parent.id,
			});
			expect(updated.parent_project_id).toBe(parent.id);
		});

		it("clears parent_project_id when set to null", async () => {
			const parent = await repo.create({
				canonicalPath: "/p/parent3",
				displayName: "Parent3",
				source: "manual",
			});
			const child = await repo.create({
				canonicalPath: "/p/child-to-orphan",
				displayName: "Child To Orphan",
				source: "manual",
				parentProjectId: parent.id,
			});
			expect(child.parent_project_id).toBe(parent.id);

			const updated = await repo.update(child.id, { parentProjectId: null });
			expect(updated.parent_project_id).toBeNull();
		});
	});

	// ── delete manual ───────────────────────────────────────────────────────

	describe("delete", () => {
		it("deletes a manual project successfully", async () => {
			const project = await repo.create({
				canonicalPath: "/p/manual-delete",
				displayName: "Manual Delete",
				source: "manual",
			});
			await repo.delete(project.id);
			const found = await repo.findById(project.id);
			expect(found).toBeNull();
		});

		it("throws BadRequest when deleting a discovered project", async () => {
			const project = await repo.create({
				canonicalPath: "/p/discovered-delete",
				displayName: "Discovered Delete",
				source: "discovered",
			});
			await expect(repo.delete(project.id)).rejects.toThrow(
				"Cannot delete discovered project",
			);
			// Still exists
			const found = await repo.findById(project.id);
			expect(found).not.toBeNull();
		});

		it("is idempotent for non-existent id", async () => {
			await expect(repo.delete("nonexistent")).resolves.toBeUndefined();
		});
	});

	// ── upsertFromDiscovery ─────────────────────────────────────────────────

	describe("upsertFromDiscovery", () => {
		it("adds new projects on empty DB", async () => {
			const result = await repo.upsertFromDiscovery([
				{
					canonicalPath: "/p/new1",
					displayName: "New1",
					sessionCount: 5,
					lastSessionAt: 1000,
				},
				{
					canonicalPath: "/p/new2",
					displayName: "New2",
					sessionCount: 0,
					lastSessionAt: null,
				},
			]);

			expect(result.added).toBe(2);
			expect(result.updated).toBe(0);
			expect(result.unchanged).toBe(0);

			const all = await repo.findAll();
			expect(all).toHaveLength(2);
		});

		it("preserves manual rename on conflict", async () => {
			// Pre-create the project with a user-chosen display name
			await repo.create({
				canonicalPath: "/p/renamed",
				displayName: "User Renamed",
				source: "discovered",
			});
			// Update display_name to simulate manual rename
			const proj = await repo.findByCanonicalPath("/p/renamed");
			if (!proj) throw new Error("project not found");
			await repo.update(proj.id, { displayName: "User Renamed" });

			// Discovery runs and brings a different display_name
			const result = await repo.upsertFromDiscovery([
				{
					canonicalPath: "/p/renamed",
					displayName: "Auto Generated Name",
					sessionCount: 10,
					lastSessionAt: 2000,
				},
			]);

			// Could be updated (session_count changed) or unchanged (same values)
			expect(result.added).toBe(0);

			const found = await repo.findByCanonicalPath("/p/renamed");
			// display_name must NOT have changed to the auto-generated one
			expect(found?.display_name).toBe("User Renamed");
			// session stats should be updated
			expect(found?.session_count).toBe(10);
			expect(found?.last_session_at).toBe(2000);
		});

		it("returns unchanged when session stats have not changed", async () => {
			await repo.upsertFromDiscovery([
				{
					canonicalPath: "/p/stable",
					displayName: "Stable",
					sessionCount: 3,
					lastSessionAt: 999,
				},
			]);

			// Same data again
			const result = await repo.upsertFromDiscovery([
				{
					canonicalPath: "/p/stable",
					displayName: "Stable",
					sessionCount: 3,
					lastSessionAt: 999,
				},
			]);

			expect(result.added).toBe(0);
			expect(result.updated).toBe(0);
			expect(result.unchanged).toBe(1);
		});

		it("sets enabled=1 and source='discovered' on new rows", async () => {
			await repo.upsertFromDiscovery([
				{
					canonicalPath: "/p/auto",
					displayName: "Auto",
					sessionCount: 1,
					lastSessionAt: null,
				},
			]);

			const found = await repo.findByCanonicalPath("/p/auto");
			expect(found?.enabled).toBe(true);
			expect(found?.source).toBe("discovered");
		});
	});
});
