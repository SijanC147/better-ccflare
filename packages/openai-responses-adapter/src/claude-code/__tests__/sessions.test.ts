import { beforeEach, describe, expect, test } from "bun:test";
import {
	claudeCodeSessionCount,
	getClaudeCodeSession,
	putClaudeCodeSession,
	resetClaudeCodeSessions,
} from "../sessions";

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => resetClaudeCodeSessions());

describe("session map", () => {
	test("returns what was stored", () => {
		putClaudeCodeSession("k", "s1", 1000);
		expect(getClaudeCodeSession("k", 2000)).toBe("s1");
		expect(getClaudeCodeSession("other", 2000)).toBeNull();
	});

	test("an entry older than 24h is a miss and is dropped", () => {
		putClaudeCodeSession("k", "s1", 0);
		expect(getClaudeCodeSession("k", DAY)).toBe("s1");
		putClaudeCodeSession("old", "s2", 0);
		expect(getClaudeCodeSession("old", DAY + 1)).toBeNull();
		expect(claudeCodeSessionCount()).toBe(1);
	});

	test("the least recently used entry goes first once 500 are stored", () => {
		for (let i = 0; i < 500; i++) putClaudeCodeSession(`k${i}`, `s${i}`, 1000);
		// Touch k0 so k1 becomes the oldest.
		expect(getClaudeCodeSession("k0", 1000)).toBe("s0");
		putClaudeCodeSession("new", "sNew", 1000);
		expect(claudeCodeSessionCount()).toBe(500);
		expect(getClaudeCodeSession("k1", 1000)).toBeNull();
		expect(getClaudeCodeSession("k0", 1000)).toBe("s0");
		expect(getClaudeCodeSession("new", 1000)).toBe("sNew");
	});
});
