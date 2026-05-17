import { describe, expect, test } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";
import { AuthService } from "../auth-service";
import { extractApiKey } from "../extract-api-key";

/**
 * Tests for extractApiKey header parsing logic
 *
 * Covers multi-header authentication support:
 * - x-api-key header (Vercel AI SDK / Opencode)
 * - Authorization: Bearer header (standard OAuth format)
 */

function makeRequest(headers: Record<string, string>): Request {
	return new Request("http://localhost/", { headers });
}

describe("API Key Header Extraction", () => {
	describe("x-api-key header", () => {
		test("extracts API key from x-api-key header", () => {
			const req = makeRequest({ "x-api-key": "sk-test-key-123" });
			expect(extractApiKey(req)).toBe("sk-test-key-123");
		});

		test("handles empty x-api-key header (falls back to Authorization)", () => {
			const req = makeRequest({ "x-api-key": "" });
			expect(extractApiKey(req)).toBeNull();
		});
	});

	describe("Authorization Bearer header", () => {
		test("extracts API key from Authorization: Bearer header", () => {
			const req = makeRequest({ authorization: "Bearer sk-test-key-456" });
			expect(extractApiKey(req)).toBe("sk-test-key-456");
		});

		test("handles lowercase bearer", () => {
			const req = makeRequest({ authorization: "bearer sk-test-key-789" });
			expect(extractApiKey(req)).toBe("sk-test-key-789");
		});

		test("handles mixed case bearer", () => {
			const req = makeRequest({ authorization: "BEARER sk-test-key-abc" });
			expect(extractApiKey(req)).toBe("sk-test-key-abc");
		});

		test("handles extra whitespace in Authorization header", () => {
			const req = makeRequest({
				authorization: "  Bearer   sk-test-key-def  ",
			});
			expect(extractApiKey(req)).toBe("sk-test-key-def");
		});

		test("returns null for malformed Authorization header (missing Bearer)", () => {
			const req = makeRequest({ authorization: "sk-test-key-ghi" });
			expect(extractApiKey(req)).toBeNull();
		});

		test("returns null for malformed Authorization header (wrong prefix)", () => {
			const req = makeRequest({ authorization: "Basic sk-test-key-jkl" });
			expect(extractApiKey(req)).toBeNull();
		});

		test("returns null for Authorization header with only Bearer", () => {
			const req = makeRequest({ authorization: "Bearer" });
			expect(extractApiKey(req)).toBeNull();
		});
	});

	describe("priority: x-api-key over Authorization", () => {
		test("prefers x-api-key when both headers are present", () => {
			const req = makeRequest({
				"x-api-key": "sk-from-x-api-key",
				authorization: "Bearer sk-from-auth",
			});
			expect(extractApiKey(req)).toBe("sk-from-x-api-key");
		});

		test("falls back to Authorization when x-api-key is empty", () => {
			const req = makeRequest({
				"x-api-key": "",
				authorization: "Bearer sk-from-auth",
			});
			expect(extractApiKey(req)).toBe("sk-from-auth");
		});
	});

	describe("no authentication headers", () => {
		test("returns null when no auth headers present", () => {
			const req = makeRequest({});
			expect(extractApiKey(req)).toBeNull();
		});

		test("returns null when unrelated headers present", () => {
			const req = makeRequest({
				"content-type": "application/json",
				"user-agent": "test-client",
			});
			expect(extractApiKey(req)).toBeNull();
		});
	});

	describe("Vercel AI SDK / Opencode compatibility", () => {
		test("supports Vercel AI SDK x-api-key format", () => {
			const req = makeRequest({
				"x-api-key": "sk-ant-api03-test-key",
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			});
			expect(extractApiKey(req)).toBe("sk-ant-api03-test-key");
		});

		test("supports Anthropic SDK Authorization Bearer format", () => {
			const req = makeRequest({
				authorization: "Bearer sk-ant-api03-test-key",
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			});
			expect(extractApiKey(req)).toBe("sk-ant-api03-test-key");
		});
	});
});

/**
 * Regression tests for the Codex P1 fix: OAuth token-mutating endpoints must
 * not be blanket-exempt from authentication. Only read-only status polling
 * stays exempt; init / reauth / callback fall through to API-key validation
 * once authentication is enabled.
 */
describe("OAuth path authentication gating (Codex P1)", () => {
	// isPathExempt() never touches the DB for /api/oauth or static paths, so a
	// stub that throws if countActiveApiKeys is called also asserts that.
	const stubDbOps = {
		countActiveApiKeys: () => {
			throw new Error("DB must not be hit for OAuth/static path gating");
		},
	} as unknown as DatabaseOperations;
	const auth = new AuthService(stubDbOps);

	describe("isStaticPathExempt() — no blanket OAuth exemption", () => {
		test("/health stays exempt", () => {
			expect(auth.isStaticPathExempt("/health")).toBe(true);
		});

		// isStaticPathExempt is /health-only. Dashboard/SPA/static reachability
		// is handled in isPathExempt() with a GET/HEAD method gate (see below),
		// not statically — a broad static "non-/api => exempt" rule had let
		// arbitrary proxy paths through without a key (Codex P1).
		test.each([
			"/dashboard",
			"/assets/app.js",
			"/chunk-abc123.js",
			"/static/logo.png",
			"/foo",
			"/",
		])("%s is NOT statically exempt (served pre-auth or proxied)", (path) => {
			expect(auth.isStaticPathExempt(path)).toBe(false);
		});

		test.each([
			"/api/oauth/init",
			"/api/oauth/callback",
			"/api/oauth/qwen/init",
			"/api/oauth/qwen/reauth",
			"/api/oauth/anthropic/reauth/init",
			"/api/oauth/anthropic/reauth/callback",
			"/api/oauth/codex/init",
			"/api/oauth/codex/reauth",
			"/api/oauth/qwen/status/abc",
			"/api/oauth/codex/status/abc",
		])("%s is NOT statically exempt", (path) => {
			expect(auth.isStaticPathExempt(path)).toBe(false);
		});
	});

	describe("isPathExempt() — only read-only status polling is exempt", () => {
		test.each([
			["GET", "/api/oauth/qwen/status/session-1"],
			["GET", "/api/oauth/codex/status/session-2"],
		])("%s %s is exempt (read-only status)", async (method, path) => {
			expect(await auth.isPathExempt(path, method)).toBe(true);
		});

		test.each([
			["POST", "/api/oauth/init"],
			["POST", "/api/oauth/callback"],
			["POST", "/api/oauth/qwen/init"],
			["POST", "/api/oauth/qwen/reauth"],
			["POST", "/api/oauth/anthropic/reauth/init"],
			["POST", "/api/oauth/anthropic/reauth/callback"],
			["POST", "/api/oauth/codex/init"],
			["POST", "/api/oauth/codex/reauth"],
			// A GET on a mutating endpoint must not slip through the status check
			["GET", "/api/oauth/init"],
			["GET", "/api/oauth/codex/reauth"],
			// Method-spoofing the status path with a non-GET is not exempt
			["POST", "/api/oauth/codex/status/abc"],
		])("%s %s is NOT exempt (requires auth when enabled)", async (method, path) => {
			expect(await auth.isPathExempt(path, method)).toBe(false);
		});
	});

	describe("isPathExempt() — dashboard reachable via GET/HEAD only (Codex P1)", () => {
		test.each([
			["GET", "/"],
			["HEAD", "/"],
			["GET", "/dashboard"],
			["GET", "/accounts"],
			["GET", "/chunk-abc123.js"],
			["GET", "/assets/font.woff2"],
			["GET", "/static/logo.png"],
		])("%s %s is exempt (dashboard/static navigation)", async (method, path) => {
			expect(await auth.isPathExempt(path, method)).toBe(true);
		});

		test.each([
			// Body-bearing arbitrary paths are proxy requests — not exempt.
			["POST", "/foo"],
			["PUT", "/foo"],
			["DELETE", "/bar/baz"],
			["PATCH", "/anything"],
			// API/proxy prefixes are never exempt regardless of method.
			["GET", "/api/stats"],
			["GET", "/v1/models"],
			["POST", "/v1/messages"],
			["GET", "/messages/x"],
		])("%s %s is NOT exempt", async (method, path) => {
			expect(await auth.isPathExempt(path, method)).toBe(false);
		});
	});
});
