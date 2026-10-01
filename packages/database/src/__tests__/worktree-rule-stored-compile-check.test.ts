import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { logBus } from "@better-ccflare/logger";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { DatabaseOperations } from "../database-operations";
import { WorktreeRuleRepository } from "../repositories/worktree-rule.repository";

/**
 * SB23-2377. `WorktreeRuleRepository.create` and `update` refuse a bad pattern
 * on the way into the table (disabled, `compile_error` set), and the HTTP
 * handlers 400 it before that. A row that reaches the table another way,
 * meaning a direct database edit, a restored or imported database, or a
 * diagnosis cleared by hand, passed through neither. Such a row then compiled
 * in the resolver: a relative `directory` pattern through `path.resolve`
 * against the proxy's own working directory, and an invalid regex dropped by
 * `compileRule` with no log line and no error anywhere.
 *
 * `rebuildResolver` is the one place every stored rule passes through on its
 * way to being compiled, and it holds the database, so the check is there.
 * Every row below is inserted with raw SQL on purpose: going through the
 * repository would run the write-time check and prove nothing about rows
 * that never did.
 */

type Row = { enabled: number; compile_error: string | null };

let dbOps: DatabaseOperations;
let warnings: string[];
const onLog = (event: { level: string; msg: string }) => {
	if (event.level === "WARN") warnings.push(event.msg);
};

beforeEach(() => {
	// ":memory:" opens no real path, so nothing here can reach the operator's
	// config or database (SB23-2277).
	dbOps = new DatabaseOperations(":memory:", { walMode: false });
	warnings = [];
	logBus.on("log", onLog);
});

afterEach(async () => {
	logBus.off("log", onLog);
	await dbOps.dispose();
});

/** What the rebuild read and diagnosed for the row `insertRaw("rel", ...)` makes. */
const DIAGNOSED = {
	kind: "directory" as const,
	pattern: "relative/worktrees",
};

function insertRaw(id: string, kind: string, pattern: string): void {
	dbOps
		.getDatabase()
		.prepare(
			`INSERT INTO worktree_rules (id, kind, pattern, parent_project_id, priority, enabled, compile_error, created_at)
			 VALUES (?, ?, ?, NULL, 0, 1, NULL, 1)`,
		)
		.run(id, kind, pattern);
}

function row(id: string): Row {
	return dbOps
		.getDatabase()
		.query("SELECT enabled, compile_error FROM worktree_rules WHERE id = ?")
		.get(id) as Row;
}

describe("rebuildResolver re-checks stored worktree rules", () => {
	it("records and disables a relative directory rule instead of compiling it against the cwd", async () => {
		insertRaw("rel", "directory", "relative/worktrees");

		// The control: what the rule would have matched. path.resolve completes
		// the pattern against process.cwd(), so this absolute path is exactly
		// the one a relative rule silently captured.
		const captured = join(process.cwd(), "relative/worktrees", "feature-x");

		await dbOps.rebuildResolver();

		const r = row("rel");
		expect(r.enabled).toBe(0);
		expect(r.compile_error).toBe(
			"Directory pattern must be an absolute path (start with '/')",
		);
		expect(
			dbOps.resolverManager.current().resolve(captured).matchedRuleId,
		).toBe(null);
		expect(warnings).toEqual([
			"Worktree rule rel (directory) cannot compile and has been disabled: Directory pattern must be an absolute path (start with '/')",
		]);
	});

	it("records an invalid regex that compileRule would have dropped silently", async () => {
		insertRaw("bad-re", "regex", "(unclosed");

		await dbOps.rebuildResolver();

		const r = row("bad-re");
		expect(r.enabled).toBe(0);
		expect(r.compile_error).not.toBeNull();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toStartWith(
			"Worktree rule bad-re (regex) cannot compile and has been disabled: ",
		);
	});

	it("leaves an absolute directory rule enabled, undiagnosed and matching", async () => {
		// The shape of all 7 rules on the maintainer's host (measured on a
		// copy of the live database before this change).
		insertRaw("abs", "directory", "/tmp/sb23-2377/worktrees");

		await dbOps.rebuildResolver();

		expect(row("abs")).toEqual({ enabled: 1, compile_error: null });
		expect(
			dbOps.resolverManager
				.current()
				.resolve("/tmp/sb23-2377/worktrees/feature-x").matchedRuleId,
		).toBe("abs");
		expect(warnings).toEqual([]);
	});

	it("diagnoses a row once, not on every rebuild", async () => {
		insertRaw("rel", "directory", "relative/worktrees");

		await dbOps.rebuildResolver();
		await dbOps.rebuildResolver();
		await dbOps.rebuildResolver();

		expect(warnings).toHaveLength(1);
	});

	it("logs once when two rebuilds race over the same bad row", async () => {
		// The discovery tick and a handler can rebuild at the same moment. Both
		// read the row before either writes, so the single diagnosis rests on
		// the write being conditional and the warning following the write.
		insertRaw("rel", "directory", "relative/worktrees");

		await Promise.all([dbOps.rebuildResolver(), dbOps.rebuildResolver()]);

		expect(warnings).toHaveLength(1);
		expect(row("rel").enabled).toBe(0);
	});

	it("recordCompileError reports whether it wrote, and never overwrites", async () => {
		insertRaw("rel", "directory", "relative/worktrees");
		const repo = new WorktreeRuleRepository(
			new BunSqlAdapter(dbOps.getDatabase()),
		);

		expect(await repo.recordCompileError("rel", DIAGNOSED, "first")).toBe(true);
		expect(await repo.recordCompileError("rel", DIAGNOSED, "second")).toBe(
			false,
		);
		expect(row("rel")).toEqual({ enabled: 0, compile_error: "first" });
	});

	it("recordCompileError does not land on a row whose pattern was fixed after the read", async () => {
		// The PATCH-in-the-window case: the rebuild diagnosed "relative/worktrees",
		// then a PATCH replaced it with an absolute pattern (clearing the
		// diagnosis and re-enabling the rule) before the rebuild's write ran.
		insertRaw("rel", "directory", "relative/worktrees");
		const repo = new WorktreeRuleRepository(
			new BunSqlAdapter(dbOps.getDatabase()),
		);
		await repo.update("rel", { pattern: "/abs/fixed" });

		expect(await repo.recordCompileError("rel", DIAGNOSED, "stale")).toBe(
			false,
		);
		expect(row("rel")).toEqual({ enabled: 1, compile_error: null });
	});

	it("recordCompileError does not land on a row whose kind changed after the read", async () => {
		// A kind-only PATCH recompiles the stored pattern under the new kind
		// and clears the diagnosis too, so the kind is part of the key.
		insertRaw("rel", "directory", "relative/worktrees");
		const repo = new WorktreeRuleRepository(
			new BunSqlAdapter(dbOps.getDatabase()),
		);
		await repo.update("rel", { kind: "glob" });

		expect(await repo.recordCompileError("rel", DIAGNOSED, "stale")).toBe(
			false,
		);
		expect(row("rel")).toEqual({ enabled: 1, compile_error: null });
	});

	it("never overwrites a diagnosis already on the row", async () => {
		insertRaw("rel", "directory", "relative/worktrees");
		dbOps
			.getDatabase()
			.run(
				"UPDATE worktree_rules SET enabled = 0, compile_error = 'set by hand' WHERE id = 'rel'",
			);

		await dbOps.rebuildResolver();

		expect(row("rel").compile_error).toBe("set by hand");
		expect(warnings).toEqual([]);
	});
});
