import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every `forwardToClient` call must pass `cwdHint`, because that field is what
 * lets `response-handler.ts:224` resolve a `project_id` for the request
 * (`resolverInput = cwdHint ?? project ?? null`). A call site that omits it
 * silently downgrades to project-name attribution for that path only.
 *
 * This test exists because the omission was missed twice, by two separate
 * sessions, and both times for the same reason: they ran `grep -n cwdHint`,
 * found the occurrences that exist, and read occurrences as call sites. A site
 * that lacks the field has nothing for that grep to match, so the check was
 * structurally blind to the only case it was run to find.
 *
 * So this asserts over the **population** (the call sites) rather than over the
 * matches (the occurrences of the field). That is the whole point of it, and it
 * is why it reads the source rather than exercising the function: the defect is
 * the absence of a line, which no runtime path can observe.
 */

const SOURCE = join(import.meta.dir, "..", "handlers", "proxy-operations.ts");
const CALLEE = "forwardToClient(";

/**
 * Returns the source text of the first argument to each `forwardToClient` call,
 * by walking braces from the `{` that opens the argument object.
 *
 * Brace counting is enough here and a parser is not: the argument is always an
 * object literal of plain `key: value` pairs. If that ever stops being true
 * this returns something unexpected and the assertion below fails loudly, which
 * is the correct outcome for a check whose job is to notice a change.
 */
function argumentObjects(source: string): string[] {
	const objects: string[] = [];
	let from = 0;

	for (;;) {
		const call = source.indexOf(CALLEE, from);
		if (call === -1) break;
		from = call + CALLEE.length;

		const open = source.indexOf("{", from);
		if (open === -1) break;

		let depth = 0;
		let end = -1;
		for (let i = open; i < source.length; i++) {
			const ch = source[i];
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
		if (end === -1) break;

		objects.push(source.slice(open, end + 1));
		from = end + 1;
	}

	return objects;
}

describe("forwardToClient call sites", () => {
	const source = readFileSync(SOURCE, "utf8");
	const objects = argumentObjects(source);

	test("there is more than one call site, so the sweep is meaningful", () => {
		// Guards the guard. If a refactor collapses these to one call, or renames
		// the callee, this test would otherwise pass by inspecting nothing, which
		// is exactly the failure mode it was written against.
		expect(objects.length).toBeGreaterThan(1);
	});

	test("every call site passes cwdHint", () => {
		const missing = objects
			.map((object, index) => ({ index, object }))
			.filter(({ object }) => !/\bcwdHint\s*:/.test(object))
			.map(({ index }) => index);

		expect(missing).toEqual([]);
	});

	test("every call site passes project, which cwdHint falls back to", () => {
		// `resolverInput = cwdHint ?? project ?? null`. A site passing neither
		// resolves nothing at all, so the pair is checked together.
		const missing = objects
			.map((object, index) => ({ index, object }))
			.filter(({ object }) => !/\bproject\s*:/.test(object))
			.map(({ index }) => index);

		expect(missing).toEqual([]);
	});
});
