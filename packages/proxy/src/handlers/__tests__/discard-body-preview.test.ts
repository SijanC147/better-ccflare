import { describe, expect, test } from "bun:test";
import {
	DISCARDED_BODY_PREVIEW_CHARS,
	drainDiscardedBodyWithPreview,
} from "../discard-body-cancel";

/** Resolves with the preview the helper hands over, or rejects on timeout. */
function previewOf(response: Response | null): Promise<string> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("no preview")), 1000);
		drainDiscardedBodyWithPreview(response, (preview) => {
			clearTimeout(timer);
			resolve(preview);
		});
	});
}

describe("drainDiscardedBodyWithPreview (SB23-2781)", () => {
	test("hands over the start of the body, whitespace collapsed", async () => {
		const body = JSON.stringify(
			{ type: "error", error: { type: "rate_limit_error", message: "x" } },
			null,
			2,
		);
		const preview = await previewOf(new Response(body, { status: 429 }));
		expect(preview).toBe(
			'{ "type": "error", "error": { "type": "rate_limit_error", "message": "x" } }',
		);
	});

	test("caps the preview and still drains a long body to the end", async () => {
		let pulled = 0;
		const chunks = 50;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (pulled >= chunks) {
					controller.close();
					return;
				}
				pulled++;
				controller.enqueue(new TextEncoder().encode("a".repeat(100)));
			},
		});
		const preview = await previewOf(new Response(stream));
		expect(preview).toHaveLength(DISCARDED_BODY_PREVIEW_CHARS);
		expect(pulled).toBe(chunks);
	});

	test("an empty body yields an empty preview", async () => {
		expect(await previewOf(new Response(""))).toBe("");
	});

	test("does nothing for a null response or a locked body", async () => {
		await expect(previewOf(null)).rejects.toThrow("no preview");
		const locked = new Response("held");
		locked.body?.getReader();
		await expect(previewOf(locked)).rejects.toThrow("no preview");
	});
});
