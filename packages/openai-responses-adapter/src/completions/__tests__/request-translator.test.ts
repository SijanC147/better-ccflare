import { describe, expect, test } from "bun:test";
import { translateCompletionRequestToChat } from "../request-translator";
import {
	type CompletionRequest,
	DEFAULT_COMPLETION_MAX_TOKENS,
} from "../types";

function translate(body: Partial<CompletionRequest>) {
	return translateCompletionRequestToChat({
		model: "claude-haiku-4-5",
		...body,
	} as CompletionRequest);
}

function refusal(body: Partial<CompletionRequest>) {
	const result = translate(body);
	if (result.ok) throw new Error("expected a refusal");
	return result.error;
}

describe("translateCompletionRequestToChat", () => {
	test("the prompt becomes the single user turn", () => {
		const result = translate({ prompt: "Once upon a time" });
		expect(result).toEqual({
			ok: true,
			echo: null,
			chat: {
				model: "claude-haiku-4-5",
				messages: [{ role: "user", content: "Once upon a time" }],
				max_tokens: DEFAULT_COMPLETION_MAX_TOKENS,
			},
		});
	});

	test("an absent max_tokens is the legacy default of 16, not the chat default", () => {
		expect(DEFAULT_COMPLETION_MAX_TOKENS).toBe(16);
		const result = translate({ prompt: "x", max_tokens: null });
		expect(result.ok && result.chat.max_tokens).toBe(16);
	});

	test("max_tokens and the sampling, stop, stream and user keys pass through", () => {
		const result = translate({
			prompt: "x",
			max_tokens: 64,
			temperature: 0.3,
			top_p: 0.9,
			stop: ["\n"],
			n: 1,
			stream: true,
			stream_options: { include_usage: true },
			user: "u-1",
			// Ignored, as on the chat path.
			presence_penalty: 1,
			logit_bias: { "50256": -100 },
		});
		if (!result.ok) throw new Error("expected ok");
		expect(result.chat).toEqual({
			model: "claude-haiku-4-5",
			messages: [{ role: "user", content: "x" }],
			max_tokens: 64,
			temperature: 0.3,
			top_p: 0.9,
			stop: ["\n"],
			n: 1,
			stream: true,
			stream_options: { include_usage: true },
			user: "u-1",
		});
	});

	test("echo: true carries the prompt back; anything else does not", () => {
		const on = translate({ prompt: "Say", echo: true });
		expect(on.ok && on.echo).toBe("Say");
		const off = translate({ prompt: "Say", echo: false });
		expect(off.ok && off.echo).toBeNull();
	});

	test("a missing prompt is refused", () => {
		expect(refusal({})).toEqual({
			status: 400,
			message: "prompt is required.",
			type: "invalid_request_error",
			param: "prompt",
			code: "missing_required_parameter",
		});
	});

	test("every array prompt is refused, never partly honoured", () => {
		const message =
			"prompt must be a single string. Arrays of strings and token arrays are not supported: each array element is a separate completion, and this endpoint returns one.";
		for (const prompt of [["a", "b"], ["only one"], [1, 2, 3], [[1, 2]], []]) {
			expect(refusal({ prompt })).toEqual({
				status: 400,
				message,
				type: "invalid_request_error",
				param: "prompt",
				code: "unsupported_value",
			});
		}
	});

	test("a non-string prompt is refused", () => {
		expect(refusal({ prompt: 42 })).toMatchObject({
			param: "prompt",
			code: "invalid_type",
			message: "prompt must be a string.",
		});
	});

	test("an empty or whitespace prompt is refused before anything is sent", () => {
		for (const prompt of ["", "   \n\t"]) {
			expect(refusal({ prompt })).toMatchObject({
				param: "prompt",
				code: "invalid_value",
				message: "prompt must contain text other than whitespace.",
			});
		}
	});

	test("a non-empty suffix is refused; an empty one is not", () => {
		expect(refusal({ prompt: "x", suffix: "tail" })).toMatchObject({
			param: "suffix",
			code: "unsupported_value",
		});
		expect(translate({ prompt: "x", suffix: "" }).ok).toBe(true);
		expect(translate({ prompt: "x", suffix: null }).ok).toBe(true);
	});

	test("best_of above 1 is refused; 1 is not", () => {
		expect(refusal({ prompt: "x", best_of: 2 })).toMatchObject({
			param: "best_of",
			code: "unsupported_value",
			message: "Only best_of = 1 is supported.",
		});
		expect(translate({ prompt: "x", best_of: 1 }).ok).toBe(true);
	});

	test("logprobs is an integer here, so 0 is refused as well as 5", () => {
		for (const logprobs of [0, 5]) {
			expect(refusal({ prompt: "x", logprobs })).toMatchObject({
				param: "logprobs",
				code: "unsupported_value",
			});
		}
		expect(translate({ prompt: "x", logprobs: null }).ok).toBe(true);
	});
});
