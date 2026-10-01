import { beforeEach, describe, expect, it } from "bun:test";
import type { OpenAIRequest } from "@better-ccflare/openai-formats";
import type { Account } from "@better-ccflare/types";
import { OpenAICompatibleProvider } from "../providers/openai/provider";
import { makeAccount } from "../testing/account-fixture";

/**
 * Widens the three conversion steps to public so this file can drive each one
 * directly.
 *
 * `beforeConvert`, `afterConvert` and `injectDashScopeReasoning` are protected
 * on `OpenAICompatibleProvider`. Until SB23-2454 the last two were reached with
 * `(provider as any)` casts, seven of them, and `injectDashScopeReasoning` was
 * private, which no subclass can widen. Declaring the widening here keeps the
 * reach explicit, local to these tests and type-checked: a signature change in
 * any of the three fails this file rather than being cast past. `super` is
 * called unchanged, so the behaviour under test is the base class's own.
 */
class TestOpenAICompatibleProvider extends OpenAICompatibleProvider {
	public override beforeConvert(
		body: Record<string, unknown>,
		account?: Account,
	): Account | undefined {
		return super.beforeConvert(body, account);
	}

	public override afterConvert(
		body: OpenAIRequest,
		endpoint?: string,
		model?: string,
	): void {
		super.afterConvert(body, endpoint, model);
	}

	public override injectDashScopeReasoning(
		openaiBody: OpenAIRequest,
		anthropicBody: Record<string, unknown>,
		endpoint?: string,
		model?: string,
	): void {
		super.injectDashScopeReasoning(openaiBody, anthropicBody, endpoint, model);
	}
}

describe("OpenAICompatibleProvider Alibaba Features", () => {
	let provider: TestOpenAICompatibleProvider;
	let mockAccount: Account;

	beforeEach(() => {
		provider = new TestOpenAICompatibleProvider();
		mockAccount = makeAccount({
			name: "test-dashscope",
			provider: "openai-compatible",
			custom_endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			refresh_token: "test-api-key",
			priority: 1,
			created_at: Date.now(),
		});
	});

	describe("Alibaba caching injection", () => {
		it("should inject cache_control for Qwen models on DashScope endpoint", async () => {
			// Build URL to set endpoint
			const _url = provider.buildUrl("/v1/messages", "", mockAccount);

			// Simulate request body
			const anthropicBody = {
				model: "qwen3.5-plus",
				system: "You are a helpful assistant",
				messages: [
					{ role: "user", content: "Hello" },
					{ role: "assistant", content: "Hi" },
				],
			};

			// Trigger beforeConvert to set model
			provider.beforeConvert(anthropicBody, mockAccount);

			// Create OpenAI request
			const openaiBody: OpenAIRequest = {
				model: "qwen3.5-plus",
				messages: [
					{ role: "system", content: "You are a helpful assistant" },
					{ role: "user", content: "Hello" },
					{ role: "assistant", content: "Hi" },
				],
			};

			// Call afterConvert to inject caching
			provider.afterConvert(
				openaiBody,
				mockAccount.custom_endpoint ?? undefined,
				anthropicBody.model,
			);

			// The injection turns string content into a one-part array carrying
			// cache_control. Asserted whole, rather than guarded on
			// `Array.isArray`, so a skipped injection fails here instead of
			// silently skipping every assertion about it.
			const systemMsg = openaiBody.messages[0];
			expect(systemMsg.role).toBe("system");
			expect(systemMsg.content).toEqual([
				{
					type: "text",
					text: "You are a helpful assistant",
					cache_control: { type: "ephemeral" },
				},
			]);

			// The last message is cached too.
			const lastMsg = openaiBody.messages[openaiBody.messages.length - 1];
			expect(lastMsg.content).toEqual([
				{ type: "text", text: "Hi", cache_control: { type: "ephemeral" } },
			]);
		});

		it("should NOT inject cache_control for non-Qwen models", async () => {
			// Build URL to set endpoint
			const _url = provider.buildUrl("/v1/messages", "", mockAccount);

			// Simulate request body with different model
			const anthropicBody = {
				model: "glm-5.1", // Not a Qwen model
				system: "You are a helpful assistant",
				messages: [{ role: "user", content: "Hello" }],
			};

			provider.beforeConvert(anthropicBody, mockAccount);

			const openaiBody: OpenAIRequest = {
				model: "glm-5.1",
				messages: [
					{ role: "system", content: "You are a helpful assistant" },
					{ role: "user", content: "Hello" },
				],
			};

			provider.afterConvert(
				openaiBody,
				mockAccount.custom_endpoint ?? undefined,
				anthropicBody.model,
			);

			// Verify NO cache_control was injected
			const systemMsg = openaiBody.messages[0];
			if (typeof systemMsg.content === "string") {
				expect(systemMsg.content).toBe("You are a helpful assistant");
			} else if (Array.isArray(systemMsg.content)) {
				expect(systemMsg.content[0]).not.toHaveProperty("cache_control");
			}
		});

		it("should NOT inject cache_control for non-DashScope endpoints", async () => {
			// Use a regular OpenAI endpoint
			mockAccount.custom_endpoint = "https://api.openai.com";
			const _url = provider.buildUrl("/v1/messages", "", mockAccount);

			const anthropicBody = {
				model: "qwen3.5-plus",
				messages: [{ role: "user", content: "Hello" }],
			};

			provider.beforeConvert(anthropicBody, mockAccount);

			const openaiBody: OpenAIRequest = {
				model: "qwen3.5-plus",
				messages: [{ role: "user", content: "Hello" }],
			};

			provider.afterConvert(
				openaiBody,
				mockAccount.custom_endpoint ?? undefined,
				anthropicBody.model,
			);

			// Verify NO cache_control was injected (wrong endpoint)
			const userMsg = openaiBody.messages[0];
			expect(userMsg.content).toBe("Hello");
			expect(userMsg).not.toHaveProperty("cache_control");
		});
	});

	describe("enable_thinking injection", () => {
		it("should inject enable_thinking for Qwen models", async () => {
			provider.buildUrl("/v1/messages", "", mockAccount);

			const anthropicBody = {
				model: "qwen3.5-plus",
				messages: [{ role: "user", content: "Hello" }],
			};

			provider.beforeConvert(anthropicBody, mockAccount);

			const openaiBody: OpenAIRequest = {
				model: "qwen3.5-plus",
				messages: [{ role: "user", content: "Hello" }],
			};

			// Call afterConvert first (injects caching)
			provider.afterConvert(
				openaiBody,
				mockAccount.custom_endpoint ?? undefined,
				anthropicBody.model,
			);

			// Then call injectDashScopeReasoning (as done in transformRequestBody)
			provider.injectDashScopeReasoning(
				openaiBody,
				anthropicBody,
				mockAccount.custom_endpoint ?? undefined,
				anthropicBody.model,
			);

			// enable_thinking should be injected for Qwen reasoning models
			expect(
				(openaiBody as OpenAIRequest & { enable_thinking?: boolean })
					.enable_thinking,
			).toBe(true);
		});

		it("should NOT inject enable_thinking for kimi-k2-thinking", async () => {
			provider.buildUrl("/v1/messages", "", mockAccount);

			const anthropicBody = {
				model: "kimi-k2-thinking",
				messages: [{ role: "user", content: "Hello" }],
			};

			provider.beforeConvert(anthropicBody, mockAccount);

			const openaiBody: OpenAIRequest = {
				model: "kimi-k2-thinking",
				messages: [{ role: "user", content: "Hello" }],
			};

			provider.afterConvert(
				openaiBody,
				mockAccount.custom_endpoint ?? undefined,
				anthropicBody.model,
			);
			provider.injectDashScopeReasoning(
				openaiBody,
				anthropicBody,
				mockAccount.custom_endpoint ?? undefined,
				anthropicBody.model,
			);

			expect(
				(openaiBody as OpenAIRequest & { enable_thinking?: boolean })
					.enable_thinking,
			).toBeUndefined();
		});
	});

	/**
	 * The tests above drive each step alone, which proves the steps and says
	 * nothing about whether `transformRequestBody` calls them. Deleting its
	 * `afterConvert` call or its `injectDashScopeReasoning` call left all 1080
	 * providers tests green (SB23-2454), so these go through the public entry
	 * point and read the body it actually sends.
	 */
	describe("through transformRequestBody", () => {
		async function sentBody(
			account: Account,
			anthropicBody: Record<string, unknown>,
		): Promise<Record<string, unknown>> {
			const request = new Request("http://localhost/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(anthropicBody),
			});
			const out = await provider.transformRequestBody(request, account);
			return (await out.json()) as Record<string, unknown>;
		}

		it("caches and enables thinking for a Qwen model on DashScope", async () => {
			const body = await sentBody(mockAccount, {
				model: "qwen3.5-plus",
				system: "You are a helpful assistant",
				messages: [{ role: "user", content: "Hello" }],
				max_tokens: 16,
			});

			expect(body.enable_thinking).toBe(true);
			const messages = body.messages as Array<{
				role: string;
				content: unknown;
			}>;
			expect(messages[0]).toEqual({
				role: "system",
				content: [
					{
						type: "text",
						text: "You are a helpful assistant",
						cache_control: { type: "ephemeral" },
					},
				],
			});
		});

		it("adds neither off DashScope", async () => {
			const body = await sentBody(
				{ ...mockAccount, custom_endpoint: "https://api.openai.com" },
				{
					model: "qwen3.5-plus",
					system: "You are a helpful assistant",
					messages: [{ role: "user", content: "Hello" }],
					max_tokens: 16,
				},
			);

			// The conversion still ran (the system prompt moved into `messages`),
			// so the absences below are the endpoint gate, not a skipped pipeline.
			expect((body.messages as unknown[])[0]).toEqual({
				role: "system",
				content: "You are a helpful assistant",
			});
			expect(body).not.toHaveProperty("enable_thinking");
			expect(JSON.stringify(body)).not.toContain("cache_control");
		});
	});
});
