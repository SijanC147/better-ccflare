import { describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CacheTelemetryJournal,
	cacheDigest,
	sanitizeCacheFacts,
} from "./cache-telemetry";

describe("durable cache metadata journal", () => {
	test("survives replacement, rotates within bounds, and identifies capture instances", () => {
		const root = mkdtempSync(join(tmpdir(), "cache-journal-"));
		try {
			const path = join(root, "events.jsonl");
			const failures: number[] = [];
			let journal = new CacheTelemetryJournal(
				path,
				(n) => failures.push(n),
				1024,
				3,
			);
			journal.record({
				event: "prepared",
				request_digest: cacheDigest("first"),
			});
			journal = new CacheTelemetryJournal(
				path,
				(n) => failures.push(n),
				1024,
				3,
			);
			journal.record({
				event: "completed",
				request_digest: cacheDigest("first"),
				cached_tokens: null,
				cache_counters_known: false,
			});
			const events = readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(events.map((e) => e.event)).toEqual([
				"observer_started",
				"prepared",
				"observer_started",
				"completed",
			]);
			expect(events[0].instance_digest).not.toBe(events[2].instance_digest);
			expect(events[3].cached_tokens).toBeNull();
			for (let i = 0; i < 30; i++)
				journal.record({
					event: "completed",
					request_digest: cacheDigest(i),
					cached_tokens: 0,
				});
			expect(readdirSync(root).length).toBeLessThanOrEqual(3);
			const rotated = readdirSync(root).flatMap((file) =>
				readFileSync(join(root, file), "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line)),
			);
			expect(
				rotated.some((e) => e.event === "rotation" && e.retention_truncated),
			).toBe(true);
			expect(failures).toEqual([]);
			expect(statSync(path).mode & 0o777).toBe(0o600);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects payload-shaped values and never follows the journal symlink", () => {
		expect(
			sanitizeCacheFacts({
				event: "private-prompt",
				instructions_digest: "private-instructions",
				input_tokens: -1,
				upstream_cache_miss_reason: "private-reason",
				payload: "private-response",
				cached_tokens: null,
				cache_counters_known: false,
			}),
		).toEqual({ cached_tokens: null, cache_counters_known: false });
		const root = mkdtempSync(join(tmpdir(), "cache-journal-"));
		try {
			const target = join(root, "target");
			writeFileSync(target, "unchanged");
			const path = join(root, "journal");
			symlinkSync(target, path);
			const failures: number[] = [];
			const journal = new CacheTelemetryJournal(path, (n) => failures.push(n));
			expect(journal.record({ event: "prepared" })).toBe(false);
			expect(readFileSync(target, "utf8")).toBe("unchanged");
			expect(failures).toEqual([1]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
