import { describe, expect, test } from "bun:test";
import {
	getAllowedModelsMessage,
	getModelFamily,
	isValidClaudeModel,
	mapModelName,
	parseModelMappings,
} from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";

// Every fixture below differs only in `name` and `model_mappings`. Spelling the
// whole Account out once keeps the declared type honest: the literal is checked
// against Account directly, so a field added to the interface fails here rather
// than being filled with `undefined` at runtime. `Object.assign` is used rather
// than a spread because spreading a `Partial<Account>` over a complete object
// widens every overridable property to include `undefined`, which would make the
// declared `: Account` return type a lie. Same fix as packages/load-balancer in
// PR #180.
function makeAccount(overrides: Partial<Account> = {}): Account {
	const base: Account = {
		id: "test",
		name: "test-account",
		provider: "openai-compatible",
		api_key: "test-key",
		refresh_token: "",
		access_token: "",
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		requires_reauth: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 10,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		request_transformer: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		last_manual_reauth_at: null,
		consecutive_rate_limits: 0,
		renewal_day: null,
	};
	return Object.assign(base, overrides);
}

describe("Model Mapping", () => {
	test("parseModelMappings handles valid JSON", () => {
		const mappings = JSON.stringify({
			sonnet: "gpt-4",
			opus: "gpt-4-turbo",
			haiku: "gpt-3.5-turbo",
		});

		const result = parseModelMappings(mappings);
		expect(result).toEqual({
			sonnet: "gpt-4",
			opus: "gpt-4-turbo",
			haiku: "gpt-3.5-turbo",
		});
	});

	test("parseModelMappings handles invalid JSON", () => {
		const result = parseModelMappings("invalid-json");
		expect(result).toBeNull();
	});

	test("parseModelMappings handles null/empty", () => {
		expect(parseModelMappings(null)).toBeNull();
		expect(parseModelMappings("")).toBeNull();
	});

	test("mapModelName uses direct pattern matching", () => {
		const mockAccount = makeAccount({
			name: "test-account",
			model_mappings: JSON.stringify({
				sonnet: "gpt-4",
				opus: "gpt-4-turbo",
				haiku: "gpt-3.5-turbo",
			}),
		});

		// Test direct pattern matching with realistic mappings
		const result1 = mapModelName("claude-sonnet-4-5-20250929", mockAccount); // Current
		const result2 = mapModelName("claude-haiku-4-5-20251001", mockAccount); // Current
		const result3 = mapModelName("claude-opus-4-1-20250805", mockAccount); // Current

		// Future model versions - demonstrating future-proof behavior
		const result4 = mapModelName("claude-sonnet-4-6-20251129", mockAccount); // Future version
		const result5 = mapModelName("claude-haiku-4-6-20251101", mockAccount); // Future version
		const result6 = mapModelName("claude-opus-4-5-20251105", mockAccount); // Future version

		// Current models
		expect(result1).toBe("gpt-4"); // Matches "sonnet"
		expect(result2).toBe("gpt-3.5-turbo"); // Matches "haiku"
		expect(result3).toBe("gpt-4-turbo"); // Matches "opus"

		// Future models - should still work without any code changes
		expect(result4).toBe("gpt-4"); // Still matches "sonnet"
		expect(result5).toBe("gpt-3.5-turbo"); // Still matches "haiku"
		expect(result6).toBe("gpt-4-turbo"); // Still matches "opus"
	});

	test("real database mappings work correctly", () => {
		// Test with real mappings from the database
		const openrouterMappings =
			'{"opus":"z-ai/glm-4.5-air:free","sonnet":"z-ai/glm-4.5-air:free","haiku":"z-ai/glm-4.5-air:free"}';

		const mockAccount = makeAccount({
			name: "openrouter-test",
			model_mappings: openrouterMappings,
		});

		// Test real client model names
		const sonnetRequest = "claude-sonnet-4-5-20250929";
		const haikuRequest = "claude-haiku-4-5-20251001";
		const opusRequest = "claude-opus-4-1-20250805";

		// These should be mapped using the direct pattern matching logic
		const sonnetMapped = mapModelName(sonnetRequest, mockAccount);
		const haikuMapped = mapModelName(haikuRequest, mockAccount);
		const opusMapped = mapModelName(opusRequest, mockAccount);

		expect(sonnetMapped).toBe("z-ai/glm-4.5-air:free"); // matches "sonnet"
		expect(haikuMapped).toBe("z-ai/glm-4.5-air:free"); // matches "haiku"
		expect(opusMapped).toBe("z-ai/glm-4.5-air:free"); // matches "opus"

		// Test future model versions work
		const futureSonnet = mapModelName(
			"claude-sonnet-5-0-20251201",
			mockAccount,
		);
		expect(futureSonnet).toBe("z-ai/glm-4.5-air:free"); // still matches "sonnet"
	});

	test("mapModelName passes through original model when no mappings configured", () => {
		const mockAccount = makeAccount({
			name: "test-account",
			model_mappings: null, // No custom mappings
		});

		// Should return the original model name unchanged
		const result1 = mapModelName("claude-sonnet-4-5-20250929", mockAccount);
		const result2 = mapModelName("claude-haiku-4-5-20251001", mockAccount);
		const result3 = mapModelName("claude-opus-4-1-20250805", mockAccount);

		expect(result1).toBe("claude-sonnet-4-5-20250929");
		expect(result2).toBe("claude-haiku-4-5-20251001");
		expect(result3).toBe("claude-opus-4-1-20250805");
	});

	test("mapModelName handles case insensitive pattern matching correctly", () => {
		const mockAccount = makeAccount({
			name: "test-account",
			model_mappings: JSON.stringify({
				sonnet: "lowercase-gpt-4",
				opus: "lowercase-gpt-4-turbo",
				haiku: "lowercase-gpt-3.5",
			}),
		});

		// Should match using case-insensitive pattern matching
		const sonnetResult = mapModelName(
			"claude-sonnet-4-5-20250929",
			mockAccount,
		);
		const haikuResult = mapModelName("claude-haiku-4-5-20251001", mockAccount);
		const opusResult = mapModelName("claude-opus-4-1-20250805", mockAccount);

		// Should match the lowercase mappings due to case-insensitive pattern matching
		expect(sonnetResult).toBe("lowercase-gpt-4");
		expect(haikuResult).toBe("lowercase-gpt-3.5");
		expect(opusResult).toBe("lowercase-gpt-4-turbo");
	});

	test("mapModelName passes through unmapped model when only sonnet is configured (regression: no implicit sonnet catch-all)", () => {
		// Regression test: previously, if an account had a sonnet mapping but no haiku mapping,
		// requesting a haiku model would silently remap it to the sonnet target.
		const mockAccount = makeAccount({
			name: "test-account",
			model_mappings: JSON.stringify({
				sonnet: "claude-sonnet-4-6", // Only sonnet is mapped; haiku is NOT
			}),
		});

		// Sonnet should be mapped
		expect(mapModelName("claude-sonnet-4-5", mockAccount)).toBe(
			"claude-sonnet-4-6",
		);

		// Haiku has no mapping — must pass through unchanged, NOT remap to sonnet target
		expect(mapModelName("claude-haiku-4-5", mockAccount)).toBe(
			"claude-haiku-4-5",
		);

		// Opus has no mapping — must also pass through unchanged
		expect(mapModelName("claude-opus-4-5", mockAccount)).toBe(
			"claude-opus-4-5",
		);
	});
});

describe("Model Validation Utilities", () => {
	test("getModelFamily detects opus models", () => {
		expect(getModelFamily("claude-opus-4-6")).toBe("opus");
		expect(getModelFamily("claude-opus-4-20250514")).toBe("opus");
		expect(getModelFamily("CLAUDE-OPUS-5-0")).toBe("opus"); // case insensitive
	});

	test("getModelFamily detects sonnet models", () => {
		expect(getModelFamily("claude-sonnet-4-5-20250929")).toBe("sonnet");
		expect(getModelFamily("claude-sonnet-5-0")).toBe("sonnet");
	});

	test("getModelFamily detects haiku models", () => {
		expect(getModelFamily("claude-haiku-4-5-20251001")).toBe("haiku");
		expect(getModelFamily("claude-haiku-5-0")).toBe("haiku");
	});

	test("getModelFamily detects fable models", () => {
		expect(getModelFamily("claude-fable-5")).toBe("fable");
		expect(getModelFamily("claude-fable-5-20260601")).toBe("fable");
		expect(getModelFamily("CLAUDE-FABLE-5")).toBe("fable"); // case insensitive
	});

	test("getModelFamily returns null for invalid models", () => {
		expect(getModelFamily("gpt-4")).toBeNull();
		expect(getModelFamily("invalid-model")).toBeNull();
		expect(getModelFamily("")).toBeNull();
	});

	test("isValidClaudeModel accepts valid patterns", () => {
		expect(isValidClaudeModel("claude-opus-4-6")).toBe(true);
		expect(isValidClaudeModel("claude-sonnet-4-5-20250929")).toBe(true);
		expect(isValidClaudeModel("claude-haiku-4-5-20251001")).toBe(true);
		expect(isValidClaudeModel("claude-fable-5")).toBe(true);
		expect(isValidClaudeModel("claude-opus-5-0-future")).toBe(true); // future models
	});

	test("isValidClaudeModel rejects invalid patterns", () => {
		expect(isValidClaudeModel("gpt-4")).toBe(false);
		expect(isValidClaudeModel("invalid-model")).toBe(false);
		expect(isValidClaudeModel("")).toBe(false);
	});

	test("getAllowedModelsMessage returns user-friendly error", () => {
		const message = getAllowedModelsMessage();
		expect(message).toContain("opus");
		expect(message).toContain("sonnet");
		expect(message).toContain("haiku");
		expect(message).toContain("fable");
	});

	test("mapModelName maps fable family via family mapping", () => {
		const mockAccount = makeAccount({
			name: "test-account",
			model_mappings: JSON.stringify({
				fable: "my-fable-model",
			}),
		});

		expect(mapModelName("claude-fable-5", mockAccount)).toBe("my-fable-model");
		// Unmapped families pass through unchanged
		expect(mapModelName("claude-opus-4-6", mockAccount)).toBe(
			"claude-opus-4-6",
		);
	});
});
