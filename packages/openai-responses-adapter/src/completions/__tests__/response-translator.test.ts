import { describe, expect, test } from "bun:test";
import { toCompletionFinishReason } from "../response-translator";

describe("toCompletionFinishReason", () => {
	test("tool_calls has no place in this API and reads as stop", () => {
		// Unreachable through /v1/completions, which sends no tools; pinned so
		// a client never sees a finish reason outside stop | length |
		// content_filter, the legacy schema's enum.
		expect(toCompletionFinishReason("tool_calls")).toBe("stop");
	});

	test("the other reasons pass through, and absence stays null", () => {
		expect(toCompletionFinishReason("stop")).toBe("stop");
		expect(toCompletionFinishReason("length")).toBe("length");
		expect(toCompletionFinishReason("content_filter")).toBe("content_filter");
		expect(toCompletionFinishReason(null)).toBeNull();
		expect(toCompletionFinishReason(undefined)).toBeNull();
	});
});
