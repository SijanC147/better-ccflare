import { describe, expect, test } from "bun:test";
import {
	isCredentialHeaderName,
	REDACTED_HEADER_VALUE,
	redactRequestHeadersForStorage,
	sanitizeRequestHeaders,
	sanitizeResponseHeaders,
} from "./headers";

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

describe("sanitizeRequestHeaders", () => {
	test("redacts credential values and keeps the names", () => {
		const out = Object.fromEntries(
			sanitizeRequestHeaders(
				new Headers({
					authorization: "Bearer sk-ant-oat-secret",
					"x-api-key": "sk-ant-api-secret",
					"proxy-authorization": "Basic cHJveHk=",
					cookie: "session=abc",
					"cf-access-jwt-assertion": "eyJhbGciOi.jwt.sig",
					"cf-access-client-secret": "cf-secret",
					"x-goog-api-key": "goog-secret",
					"x-auth-token": "auth-secret",
					"x-better-ccflare-internal-probe-secret": "probe-secret",
					"user-agent": "claude-cli/2.1.0 (external, cli)",
					"anthropic-version": "2023-06-01",
				}),
			).entries(),
		);
		expect(out).toEqual({
			authorization: REDACTED_HEADER_VALUE,
			"x-api-key": REDACTED_HEADER_VALUE,
			"proxy-authorization": REDACTED_HEADER_VALUE,
			cookie: REDACTED_HEADER_VALUE,
			"cf-access-jwt-assertion": REDACTED_HEADER_VALUE,
			"cf-access-client-secret": REDACTED_HEADER_VALUE,
			"x-goog-api-key": REDACTED_HEADER_VALUE,
			"x-auth-token": REDACTED_HEADER_VALUE,
			"x-better-ccflare-internal-probe-secret": REDACTED_HEADER_VALUE,
			"user-agent": "claude-cli/2.1.0 (external, cli)",
			"anthropic-version": "2023-06-01",
		});
	});

	test("drops hop-by-hop and compression headers", () => {
		const out = sanitizeRequestHeaders(
			new Headers({
				"accept-encoding": "gzip",
				"content-length": "12",
				"transfer-encoding": "chunked",
				"content-encoding": "gzip",
				accept: "*/*",
			}),
		);
		expect(Object.fromEntries(out.entries())).toEqual({ accept: "*/*" });
	});

	test("keeps x-better-ccflare control headers the collector reads", () => {
		const out = sanitizeRequestHeaders(
			new Headers({ "x-better-ccflare-project": "better-ccflare" }),
		);
		expect(out.get("x-better-ccflare-project")).toBe("better-ccflare");
	});
});

describe("isCredentialHeaderName", () => {
	test("matches the named set and the suffix rule, case-insensitively", () => {
		for (const name of [
			"Authorization",
			"X-API-KEY",
			"api-key",
			"Cookie",
			"x-csrf-token",
			"x-client-secret",
			"db-password",
			"token",
		]) {
			expect(isCredentialHeaderName(name)).toBe(true);
		}
	});

	test("does not match ordinary headers", () => {
		for (const name of [
			"user-agent",
			"anthropic-beta",
			"x-stainless-os",
			"x-claude-code-session-id",
			"keyboard",
			"tokenizer",
			"x-better-ccflare-project",
		]) {
			expect(isCredentialHeaderName(name)).toBe(false);
		}
	});
});

describe("redactRequestHeadersForStorage", () => {
	test("redacts credentials and every x-better-ccflare-* header, keeps the rest", () => {
		const input = {
			Authorization: "Bearer raw",
			"x-api-key": "raw-key",
			"x-better-ccflare-local-control-secret": "local",
			"X-Better-CCFlare-Project": "p",
			"user-agent": "curl/8",
		};
		expect(redactRequestHeadersForStorage(input)).toEqual({
			Authorization: REDACTED_HEADER_VALUE,
			"x-api-key": REDACTED_HEADER_VALUE,
			"x-better-ccflare-local-control-secret": REDACTED_HEADER_VALUE,
			"X-Better-CCFlare-Project": REDACTED_HEADER_VALUE,
			"user-agent": "curl/8",
		});
		// A copy: the collector still reads the original set after this runs.
		expect(input.Authorization).toBe("Bearer raw");
	});

	test("returns an empty object for a missing header set", () => {
		expect(redactRequestHeadersForStorage(undefined)).toEqual({});
		expect(redactRequestHeadersForStorage(null)).toEqual({});
	});
});

describe("x-codex-turn-state is never persisted (SB23-2370)", () => {
	test("its request value is redacted at storage, under any casing", () => {
		expect(
			redactRequestHeadersForStorage({
				"x-codex-turn-state": "opaque-routing-token",
				"X-Codex-Turn-State": "opaque-routing-token",
				"x-codex-turn-metadata": '{"turn_id":"t1"}',
			}),
		).toEqual({
			"x-codex-turn-state": REDACTED_HEADER_VALUE,
			"X-Codex-Turn-State": REDACTED_HEADER_VALUE,
			"x-codex-turn-metadata": '{"turn_id":"t1"}',
		});
	});

	test("its response value is redacted, its name kept", () => {
		expect(
			sanitizeResponseHeaders({
				"x-codex-turn-state": "opaque-routing-token",
				"X-CODEX-TURN-STATE": "opaque-routing-token",
				"x-codex-primary-used-percent": "12",
			}),
		).toEqual({
			"x-codex-turn-state": REDACTED_HEADER_VALUE,
			"X-CODEX-TURN-STATE": REDACTED_HEADER_VALUE,
			"x-codex-primary-used-percent": "12",
		});
	});

	test("it is not a credential, so the collector's own copy keeps it", () => {
		expect(isCredentialHeaderName("x-codex-turn-state")).toBe(false);
	});
});
