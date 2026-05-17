import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "@better-ccflare/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { WorktreeRuleRepository } from "../worktree-rule.repository";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: Database; repo: WorktreeRuleRepository } {
	const db = new Database(":memory:");

	db.run(`
		CREATE TABLE IF NOT EXISTS worktree_rules (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			pattern TEXT NOT NULL,
			parent_project_id TEXT,
			priority INTEGER NOT NULL DEFAULT 0,
			enabled INTEGER NOT NULL DEFAULT 1,
			compile_error TEXT,
			created_at INTEGER NOT NULL
		)
	`);

	const adapter = new BunSqlAdapter(db);
	const repo = new WorktreeRuleRepository(adapter);
	return { db, repo };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorktreeRuleRepository", () => {
	let db: Database;
	let repo: WorktreeRuleRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});

	afterEach(() => {
		db.close();
	});

	// ── create with valid regex ─────────────────────────────────────────────

	describe("create — valid regex", () => {
		it("inserts enabled rule with no compile_error", async () => {
			const rule = await repo.create({
				kind: "regex",
				pattern: "^/home/user/projects/.+\\.worktree$",
			});

			expect(rule.kind).toBe("regex");
			expect(rule.pattern).toBe("^/home/user/projects/.+\\.worktree$");
			expect(rule.enabled).toBe(true);
			expect(rule.compile_error).toBeNull();
			expect(rule.priority).toBe(0);
			expect(rule.id).toBeTruthy();
		});
	});

	// ── create with invalid regex ───────────────────────────────────────────

	describe("create — invalid regex", () => {
		it("sets enabled=false and populates compile_error", async () => {
			const rule = await repo.create({
				kind: "regex",
				pattern: "[invalid(regex",
			});

			expect(rule.enabled).toBe(false);
			expect(rule.compile_error).not.toBeNull();
			expect(typeof rule.compile_error).toBe("string");
			expect((rule.compile_error ?? "").length).toBeGreaterThan(0);
		});
	});

	// ── create with directory missing leading slash ─────────────────────────

	describe("create — directory without leading slash", () => {
		it("sets enabled=false and populates compile_error", async () => {
			const rule = await repo.create({
				kind: "directory",
				pattern: "home/user/worktrees/my-feature",
			});

			expect(rule.enabled).toBe(false);
			expect(rule.compile_error).toMatch(/absolute/i);
		});

		it("accepts directory with leading slash", async () => {
			const rule = await repo.create({
				kind: "directory",
				pattern: "/home/user/worktrees/my-feature",
			});

			expect(rule.enabled).toBe(true);
			expect(rule.compile_error).toBeNull();
		});
	});

	// ── create with valid glob ──────────────────────────────────────────────

	describe("create — glob", () => {
		it("accepts a valid glob pattern", async () => {
			const rule = await repo.create({
				kind: "glob",
				pattern: "/home/user/projects/**/*.worktree",
			});

			expect(rule.enabled).toBe(true);
			expect(rule.compile_error).toBeNull();
		});

		it("rejects empty glob pattern", async () => {
			const rule = await repo.create({
				kind: "glob",
				pattern: "",
			});

			expect(rule.enabled).toBe(false);
			expect(rule.compile_error).not.toBeNull();
		});
	});

	// ── findAllOrdered — priority DESC ──────────────────────────────────────

	describe("findAllOrdered — ordering by priority DESC", () => {
		it("returns rules ordered by priority DESC, created_at ASC", async () => {
			const low = await repo.create({
				kind: "directory",
				pattern: "/p/low",
				priority: 1,
			});
			const high = await repo.create({
				kind: "directory",
				pattern: "/p/high",
				priority: 10,
			});
			const mid = await repo.create({
				kind: "directory",
				pattern: "/p/mid",
				priority: 5,
			});

			const all = await repo.findAllOrdered();
			const ids = all.map((r) => r.id);

			expect(ids[0]).toBe(high.id); // priority 10
			expect(ids[1]).toBe(mid.id); // priority 5
			expect(ids[2]).toBe(low.id); // priority 1
		});
	});

	// ── findById ────────────────────────────────────────────────────────────

	describe("findById", () => {
		it("returns rule when found", async () => {
			const created = await repo.create({
				kind: "regex",
				pattern: ".*",
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

	// ── update re-runs compile ──────────────────────────────────────────────

	describe("update — re-runs compile check on kind/pattern change", () => {
		it("re-enables rule when pattern is fixed", async () => {
			const rule = await repo.create({
				kind: "regex",
				pattern: "[bad",
			});
			expect(rule.enabled).toBe(false);

			const fixed = await repo.update(rule.id, { pattern: "^good$" });
			expect(fixed.enabled).toBe(true);
			expect(fixed.compile_error).toBeNull();
		});

		it("disables rule when pattern is broken by update", async () => {
			const rule = await repo.create({
				kind: "regex",
				pattern: "^good$",
			});
			expect(rule.enabled).toBe(true);

			const broken = await repo.update(rule.id, { pattern: "[bad(" });
			expect(broken.enabled).toBe(false);
			expect(broken.compile_error).not.toBeNull();
		});

		it("updates priority without re-running compile", async () => {
			const rule = await repo.create({
				kind: "regex",
				pattern: "^fine$",
				priority: 0,
			});

			const updated = await repo.update(rule.id, { priority: 99 });
			expect(updated.priority).toBe(99);
			expect(updated.enabled).toBe(true);
			expect(updated.compile_error).toBeNull();
		});

		it("re-runs compile when kind changes", async () => {
			// Start as a valid regex
			const rule = await repo.create({
				kind: "regex",
				pattern: "no-leading-slash",
			});
			expect(rule.enabled).toBe(true);

			// Change kind to 'directory' — same pattern is now invalid
			const updated = await repo.update(rule.id, { kind: "directory" });
			expect(updated.enabled).toBe(false);
			expect(updated.compile_error).toMatch(/absolute/i);
		});
	});

	// ── delete ──────────────────────────────────────────────────────────────

	describe("delete", () => {
		it("removes the rule", async () => {
			const rule = await repo.create({
				kind: "regex",
				pattern: ".*",
			});
			await repo.delete(rule.id);
			const found = await repo.findById(rule.id);
			expect(found).toBeNull();
		});

		it("is idempotent for non-existent id", async () => {
			await expect(repo.delete("ghost")).resolves.toBeUndefined();
		});
	});
});
