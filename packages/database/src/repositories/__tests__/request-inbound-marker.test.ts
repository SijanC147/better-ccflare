/**
 * SB23-2727. Persistence of `requests.inbound_format` and
 * `requests.inbound_gateway`, the marker that tells a translated OpenAI
 * request from Claude Code traffic: both are stored with path `/v1/messages`.
 *
 * Same preserve-first UPSERT shape as the gateway hint columns, because the
 * error paths re-save a row without the marker and must not blank it out.
 * The PostgreSQL half is driven through a fake adapter recording the SQL it
 * would run, as migrations-pg-renewal-day.test.ts does.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "@better-ccflare/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { ensureSchemaPg, runMigrationsPg } from "../../migrations-pg";
import { RequestRepository } from "../request.repository";

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	return db;
}

function baseRequestData(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		method: "POST",
		path: "/v1/messages",
		accountUsed: null,
		statusCode: 200,
		success: true,
		errorMessage: null,
		responseTime: 100,
		failoverAttempts: 0,
		...overrides,
	};
}

interface MarkerRow {
	inbound_format: string | null;
	inbound_gateway: string | null;
}

function readMarker(db: Database, id: string): MarkerRow | null {
	return (
		(db
			.query(
				"SELECT inbound_format, inbound_gateway FROM requests WHERE id = ?",
			)
			.get(id) as MarkerRow | null) ?? null
	);
}

describe("RequestRepository — inbound marker persistence", () => {
	let db: Database;
	let repo: RequestRepository;

	beforeEach(() => {
		db = makeDb();
		repo = new RequestRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("saves and reads back the format and the gateway", async () => {
		await repo.save(
			baseRequestData("req-1", {
				inboundFormat: "openai-chat",
				inboundGateway: "work",
			}),
		);
		expect(readMarker(db, "req-1")).toEqual({
			inbound_format: "openai-chat",
			inbound_gateway: "work",
		});
	});

	it("stores NULL for a request that carries no marker", async () => {
		await repo.save(baseRequestData("req-2"));
		expect(readMarker(db, "req-2")).toEqual({
			inbound_format: null,
			inbound_gateway: null,
		});
	});

	it("a re-save without the marker keeps what the first save recorded", async () => {
		await repo.save(
			baseRequestData("req-3", {
				inboundFormat: "openai-responses",
				inboundGateway: "codex",
			}),
		);
		await repo.save(
			baseRequestData("req-3", { statusCode: 500, success: false }),
		);
		expect(readMarker(db, "req-3")).toEqual({
			inbound_format: "openai-responses",
			inbound_gateway: "codex",
		});
	});

	it("runMigrations adds both columns to a database created before them", () => {
		const legacy = new Database(":memory:");
		ensureSchema(legacy);
		runMigrations(legacy);
		for (const col of ["inbound_format", "inbound_gateway"]) {
			legacy.run(`ALTER TABLE requests DROP COLUMN ${col}`);
		}
		const names = () =>
			(
				legacy.query("PRAGMA table_info(requests)").all() as Array<{
					name: string;
				}>
			).map((c) => c.name);
		expect(names()).not.toContain("inbound_format");
		expect(names()).not.toContain("inbound_gateway");

		runMigrations(legacy);

		expect(names()).toContain("inbound_format");
		expect(names()).toContain("inbound_gateway");
		legacy.close();
	});
});

function recordingAdapter(missing: Set<string>): {
	adapter: BunSqlAdapter;
	executed: string[];
} {
	const executed: string[] = [];
	const adapter = {
		async get<R>(_sql: string, params: unknown[] = []): Promise<R | null> {
			const [table, column] = params as [string, string];
			return { exists: missing.has(`${table}.${column}`) ? 0 : 1 } as R;
		},
		async unsafe(sql: string): Promise<unknown> {
			executed.push(sql.replace(/\s+/g, " ").trim());
			return undefined;
		},
		async run(sql: string): Promise<void> {
			executed.push(sql.replace(/\s+/g, " ").trim());
		},
	} as unknown as BunSqlAdapter;
	return { adapter, executed };
}

describe("PostgreSQL parity for the inbound marker", () => {
	it("ensureSchemaPg creates both columns on a new install", async () => {
		const { adapter, executed } = recordingAdapter(new Set());
		await ensureSchemaPg(adapter);
		const create = executed.find((s) =>
			/CREATE TABLE IF NOT EXISTS requests\b/i.test(s),
		);
		expect(create).toMatch(/inbound_format TEXT/);
		expect(create).toMatch(/inbound_gateway TEXT/);
	});

	it("runMigrationsPg adds each column only when it is missing", async () => {
		const missing = recordingAdapter(
			new Set(["requests.inbound_format", "requests.inbound_gateway"]),
		);
		await runMigrationsPg(missing.adapter);
		expect(missing.executed).toContain(
			"ALTER TABLE requests ADD COLUMN inbound_format TEXT",
		);
		expect(missing.executed).toContain(
			"ALTER TABLE requests ADD COLUMN inbound_gateway TEXT",
		);

		const present = recordingAdapter(new Set());
		await runMigrationsPg(present.adapter);
		expect(
			present.executed.some((s) =>
				/ADD COLUMN inbound_(format|gateway)/.test(s),
			),
		).toBe(false);
	});
});
