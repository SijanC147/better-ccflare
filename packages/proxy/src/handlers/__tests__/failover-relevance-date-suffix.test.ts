/**
 * SB23-10878 follow-up: an answer is native when its model and the requested
 * one match after one trailing `-YYYYMMDD` is stripped from each (Sean's
 * date-suffix ruling, 2026-11-08). No prefix matching, no version stripping.
 */
import { describe, expect, it } from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import {
	noteUpstreamAnswer,
	sameModelIgnoringDate,
	suppressForeignError,
} from "../failover-relevance";

describe("sameModelIgnoringDate", () => {
	it("an alias and its dated id are the same model", () => {
		expect(
			sameModelIgnoringDate("claude-sonnet-4-5", "claude-sonnet-4-5-20250929"),
		).toBe(true);
		expect(
			sameModelIgnoringDate("claude-sonnet-4-5-20250929", "claude-sonnet-4-5"),
		).toBe(true);
	});

	it("a different version is foreign", () => {
		expect(sameModelIgnoringDate("claude-opus-4", "claude-opus-4-8")).toBe(
			false,
		);
	});

	it("two dated ids of the same alias are the same model", () => {
		expect(
			sameModelIgnoringDate(
				"claude-sonnet-4-5-20250929",
				"claude-sonnet-4-5-20251101",
			),
		).toBe(true);
	});

	it("strips only an eight-digit date, and only one", () => {
		expect(sameModelIgnoringDate("model-2025092", "model")).toBe(false);
		expect(sameModelIgnoringDate("m-20250101-20250202", "m")).toBe(false);
	});
});

describe("noteUpstreamAnswer uses the date-suffix rule", () => {
	function acct(id: string): Account {
		return { id, provider: "openrouter" } as Account;
	}
	function req(model: string): RequestMeta {
		return {
			id: "r",
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now(),
			headers: new Headers(),
			originalModel: model,
		} as RequestMeta;
	}
	const err = (status: number) => new Response("{}", { status });

	it("a dated answer for an alias request is native, so it is not suppressed", () => {
		const meta = req("claude-sonnet-4-5");
		noteUpstreamAnswer(meta, acct("a"), err(429), "claude-sonnet-4-5");
		noteUpstreamAnswer(meta, acct("b"), err(402), "claude-sonnet-4-5-20250929");
		expect(suppressForeignError(meta, acct("b"), 402)).toBeNull();
	});

	it("another version after a native failure is foreign and suppressed", () => {
		const meta = req("claude-opus-4");
		noteUpstreamAnswer(meta, acct("a"), err(429), "claude-opus-4");
		noteUpstreamAnswer(meta, acct("b"), err(402), "claude-opus-4-8");
		expect(suppressForeignError(meta, acct("b"), 402)).not.toBeNull();
	});
});
