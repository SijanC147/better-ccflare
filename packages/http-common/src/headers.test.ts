import { describe, expect, test } from "bun:test";
import { sanitizeResponseHeaders } from "./headers";

describe("sanitizeResponseHeaders", () => {
	test("drops credential-bearing response headers", () => {
		const out = sanitizeResponseHeaders({
			"set-cookie": "session=abc; HttpOnly",
			authorization: "Bearer upstream-token",
			"proxy-authenticate": "Basic realm=proxy",
			"www-authenticate": "Bearer realm=api",
			"content-type": "application/json",
		});
		expect(out).toEqual({ "content-type": "application/json" });
	});

	test("matches header names case-insensitively", () => {
		// Bun's Headers lowercases, but this object is also built from plain
		// records in tests and from other runtimes, so the guard cannot assume it.
		const out = sanitizeResponseHeaders({
			"Set-Cookie": "session=abc",
			"X-Request-Id": "req_1",
		});
		expect(out).toEqual({ "X-Request-Id": "req_1" });
	});

	test("keeps the rate-limit headers the collector reads", () => {
		// usage-collector.ts reads anthropic-ratelimit-* off this object; stripping
		// them would silently disable overage detection.
		const out = sanitizeResponseHeaders({
			"anthropic-ratelimit-unified-overage-in-use": "true",
			"anthropic-ratelimit-unified-overage-status": "active",
			"set-cookie": "session=abc",
		});
		expect(out).toEqual({
			"anthropic-ratelimit-unified-overage-in-use": "true",
			"anthropic-ratelimit-unified-overage-status": "active",
		});
	});

	test("returns a new object and does not mutate the input", () => {
		const input = { "set-cookie": "session=abc", accept: "*/*" };
		const out = sanitizeResponseHeaders(input);
		expect(out).not.toBe(input);
		expect(input["set-cookie"]).toBe("session=abc");
	});
});
