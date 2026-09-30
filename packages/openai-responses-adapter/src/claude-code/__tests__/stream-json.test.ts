import { describe, expect, test } from "bun:test";
import { parseStreamJsonLine } from "../stream-json";

const line = (o: unknown) => JSON.stringify(o);

describe("parseStreamJsonLine", () => {
	test("blank, non-JSON and non-object lines are skipped", () => {
		expect(parseStreamJsonLine("")).toBeNull();
		expect(parseStreamJsonLine("   ")).toBeNull();
		expect(parseStreamJsonLine("not json")).toBeNull();
		expect(parseStreamJsonLine("[1,2]")).toBeNull();
		expect(parseStreamJsonLine("null")).toBeNull();
	});

	test("unknown event types are ignored, not errors", () => {
		expect(parseStreamJsonLine(line({ type: "rate_limit_event" }))).toEqual({
			kind: "ignored",
		});
		expect(
			parseStreamJsonLine(line({ type: "system", subtype: "hook" })),
		).toEqual({
			kind: "ignored",
		});
	});

	test("init carries the session id", () => {
		expect(
			parseStreamJsonLine(
				line({ type: "system", subtype: "init", session_id: "abc" }),
			),
		).toEqual({ kind: "init", sessionId: "abc" });
	});

	test("only text deltas become text; tool input deltas are dropped", () => {
		const delta = (d: unknown) =>
			parseStreamJsonLine(
				line({
					type: "stream_event",
					event: { type: "content_block_delta", delta: d },
				}),
			);
		expect(delta({ type: "text_delta", text: "hi" })).toEqual({
			kind: "partial-text",
			text: "hi",
		});
		expect(delta({ type: "input_json_delta", partial_json: "{" })).toEqual({
			kind: "ignored",
		});
		expect(delta({ type: "text_delta", text: 5 })).toEqual({ kind: "ignored" });
	});

	test("assistant messages keep text blocks and drop tool_use blocks", () => {
		expect(
			parseStreamJsonLine(
				line({
					type: "assistant",
					message: {
						content: [
							{ type: "text", text: "a" },
							{ type: "tool_use", id: "t", name: "Read", input: {} },
							{ type: "text", text: "b" },
						],
					},
				}),
			),
		).toEqual({ kind: "assistant-text", text: "ab" });
	});

	test("result reads is_error, error subtypes, text and usage defensively", () => {
		expect(
			parseStreamJsonLine(
				line({
					type: "result",
					subtype: "success",
					is_error: false,
					result: "done",
					session_id: "s",
					usage: {
						input_tokens: 4,
						output_tokens: "x",
						cache_read_input_tokens: -1,
					},
				}),
			),
		).toEqual({
			kind: "result",
			isError: false,
			text: "done",
			sessionId: "s",
			usage: { input: 4, output: 0, cacheRead: 0, cacheCreation: 0 },
		});
		expect(
			parseStreamJsonLine(line({ type: "result", subtype: "error_max_turns" })),
		).toMatchObject({ kind: "result", isError: true, text: null, usage: null });
	});
});
