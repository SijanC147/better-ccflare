import { describe, expect, test } from "bun:test";
import { CodexCacheDiagnostics } from "./cache-diagnostics";

const body = (
	input: unknown[] = [{ role: "user", content: "synthetic private prompt" }],
) => ({
	model: "synthetic-model",
	instructions: "synthetic private instructions",
	tools: [],
	prompt_cache_key: "synthetic private key",
	input,
});
const usage = {
	input_tokens: 1000,
	output_tokens: 10,
	input_tokens_details: { cached_tokens: 900 },
};

describe("payload-free outgoing cache diagnostics", () => {
	test("finds the preserved prefix across interleaved subagent requests", () => {
		const rows: Record<string, unknown>[] = [];
		const observer = new CodexCacheDiagnostics((row) => rows.push(row));
		const a = body();
		observer.prepare("a", "account", "session", a);
		observer.finish("a", usage, true);
		observer.prepare(
			"b",
			"account",
			"session",
			body([{ role: "user", content: "other subagent" }]),
		);
		observer.finish("b", usage, true);
		observer.prepare(
			"c",
			"account",
			"session",
			body([...a.input, { role: "assistant", content: "synthetic reply" }]),
		);
		observer.finish("c", usage, true);
		expect(rows[0].prior_candidates).toBe(0);
		expect(rows[2]).toMatchObject({
			prior_candidates: 2,
			prior_input_prefix_preserved: true,
			instructions_changed: false,
			tools_changed: false,
			cache_key_changed: false,
			cache_counters_known: true,
			cached_tokens: 900,
		});
		expect(rows[2].matched_input_bytes).toBe(rows[0].input_bytes);
	});

	test("separates key, instructions, tool, parameter and history changes", () => {
		const rows: Record<string, unknown>[] = [];
		const observer = new CodexCacheDiagnostics((row) => rows.push(row));
		observer.prepare("a", "account", "session", body());
		observer.finish("a", usage, true);
		observer.prepare("b", "account", "session", {
			...body(),
			instructions: "different",
			tools: [{ type: "function", name: "other" }],
			prompt_cache_key: "other",
			reasoning: { effort: "high" },
		});
		observer.finish("b", usage, true);
		expect(rows[1]).toMatchObject({
			prior_input_prefix_preserved: true,
			instructions_changed: true,
			tools_changed: true,
			cache_key_changed: true,
			parameters_changed: true,
		});
		observer.prepare(
			"c",
			"account",
			"session",
			body([{ role: "user", content: "rewritten" }]),
		);
		observer.finish("c", usage, true);
		expect(rows[2].prior_input_prefix_preserved).toBe(false);
		expect(rows[2].matched_input_bytes).toBe(0);
	});

	test("missing and invalid usage stays unknown; explicit zero stays known", () => {
		const rows: Record<string, unknown>[] = [];
		const observer = new CodexCacheDiagnostics((row) => rows.push(row));
		for (const [i, details] of [
			undefined,
			{ cached_tokens: 0 },
			{ cached_tokens: -1 },
			{ cached_tokens: 1001 },
		].entries()) {
			observer.prepare(String(i), "account", "session", body());
			observer.finish(
				String(i),
				{ input_tokens: 1000, input_tokens_details: details },
				true,
			);
		}
		expect(rows.map((row) => row.cache_counters_known)).toEqual([
			false,
			true,
			false,
			false,
		]);
		expect(rows[0].cached_tokens).toBeNull();
	});

	test("failed, expired, canceled and foreign conversations cannot seed a match", () => {
		const rows: Record<string, unknown>[] = [];
		let now = 0;
		const observer = new CodexCacheDiagnostics(
			(row) => rows.push(row),
			() => now,
		);
		observer.prepare("a", "account", "session", body());
		observer.finish("a", usage, false);
		observer.prepare("b", "account", "session", body());
		observer.forget("b");
		observer.finish("b", usage, true);
		observer.prepare("c", "foreign-account", "session", body());
		observer.finish("c", usage, true);
		observer.prepare("d", "account", "foreign-session", body());
		observer.finish("d", usage, true);
		observer.prepare("e", "account", "session", { ...body(), model: "other" });
		observer.finish("e", usage, true);
		observer.prepare("f", "account", "session", body());
		observer.finish("f", usage, true);
		expect(rows[rows.length - 1].prior_candidates).toBe(0);
		now += 1800001;
		observer.prepare("g", "account", "session", body());
		observer.finish("g", usage, true);
		expect(rows[rows.length - 1].prior_candidates).toBe(0);
	});

	test("bounds retained state and emits no raw request, key, session, account, or output", () => {
		const rows: Record<string, unknown>[] = [];
		const observer = new CodexCacheDiagnostics((row) => rows.push(row));
		for (let i = 0; i < 100; i++) {
			observer.prepare(
				`secret-request-${i}`,
				"secret-account",
				"secret-session",
				body(),
			);
			observer.finish(
				`secret-request-${i}`,
				{ ...usage, output: "secret-output" },
				true,
			);
		}
		expect(rows[rows.length - 1].prior_candidates).toBe(64);
		for (let i = 0; i < 100; i++)
			observer.prepare(`pending-${i}`, "account", "session", body());
		observer.finish("pending-0", usage, true);
		expect(rows).toHaveLength(100);
		observer.prepare(
			"oversize",
			"account",
			"session",
			body(Array(2049).fill("x")),
		);
		observer.finish("oversize", usage, true);
		expect(rows).toHaveLength(100);
		const retained = JSON.stringify(observer);
		const emitted = JSON.stringify(rows);
		for (const sentinel of [
			"synthetic private prompt",
			"synthetic private instructions",
			"synthetic private key",
			"secret-account",
			"secret-session",
			"secret-output",
		]) {
			expect(retained).not.toContain(sentinel);
			expect(emitted).not.toContain(sentinel);
		}
		expect(emitted).not.toContain("secret-request");
	});
});
