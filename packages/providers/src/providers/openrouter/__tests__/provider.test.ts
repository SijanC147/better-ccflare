import { beforeEach, describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { makeAccount } from "../../../testing/account-fixture";
import { OpenRouterProvider } from "../provider";

const API_KEY = "test-api-key";
const ACCESS_TOKEN = "test-access-token";

describe("OpenRouterProvider", () => {
	let provider: OpenRouterProvider;
	let mockAccount: Account;

	beforeEach(() => {
		provider = new OpenRouterProvider();
		mockAccount = makeAccount({
			id: "test-id",
			name: "test-openrouter-account",
			provider: "openrouter",
			refresh_token: "test-api-key",
		});
	});

	describe("name", () => {
		it("should have the correct provider name", () => {
			expect(provider.name).toBe("openrouter");
		});
	});

	describe("prepareHeaders", () => {
		// The bearer branch in BaseAnthropicCompatibleProvider.prepareHeaders is
		// guarded by a case-sensitive comparison against "authorization", so a
		// capitalised authHeader silently sent the bare key. OpenRouter rejects
		// that with "Missing Authentication header" (401) — the key is never even
		// looked up. The authHeader spelling must therefore stay lowercase.
		it("should send the API key as bearer authorization", () => {
			const headers = provider.prepareHeaders(
				new Headers({ authorization: "Bearer client-token" }),
				undefined,
				API_KEY,
			);

			expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
			expect(headers.get("x-api-key")).toBeNull();
		});

		it("should use an access token as the bearer credential", () => {
			const headers = provider.prepareHeaders(new Headers(), ACCESS_TOKEN);

			expect(headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
		});

		it("should not leak the client's authorization header", () => {
			const headers = provider.prepareHeaders(
				new Headers({ authorization: "Bearer client-token" }),
				undefined,
				API_KEY,
			);

			expect(headers.get("authorization")).not.toContain("client-token");
		});
	});

	describe("buildUrl", () => {
		it("should join Claude Code /v1/messages onto OpenRouter's /api base", () => {
			const url = provider.buildUrl("/v1/messages", "", mockAccount);
			expect(url).toBe("https://openrouter.ai/api/v1/messages");
		});

		it("should honour a custom endpoint", () => {
			const url = provider.buildUrl("/v1/messages", "", {
				...mockAccount,
				custom_endpoint: "https://openrouter.ai/api",
			});
			expect(url).toBe("https://openrouter.ai/api/v1/messages");
		});
	});
});
