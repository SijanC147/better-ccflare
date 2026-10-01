import { describe, expect, it } from "bun:test";
import { act, useState } from "react";
import { mount } from "../dom";

/**
 * SB23-3556: react-dom has to load after happy-dom is registered, or it reads
 * `canUseDOM` as false, routes text inputs through its IE polyfill, and a
 * plain `input` event fires no `onChange`. Measured at 0 calls before the fix.
 */
describe("dom.ts", () => {
	it("fires onChange once for one plain input event on a text input", async () => {
		const seen: string[] = [];
		function Field() {
			const [value, setValue] = useState("");
			return (
				<input
					id="dom-test-field"
					value={value}
					onChange={(e) => {
						seen.push(e.target.value);
						setValue(e.target.value);
					}}
				/>
			);
		}

		const mounted = await mount(<Field />);
		try {
			const input = document.getElementById("dom-test-field");
			if (!(input instanceof HTMLInputElement)) {
				throw new Error("expected the mounted input");
			}
			const setter = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set;
			if (!setter) throw new Error("expected the value setter");

			await act(async () => {
				setter.call(input, "abc");
				input.dispatchEvent(new Event("input", { bubbles: true }));
			});

			expect(seen).toEqual(["abc"]);
			expect(input.value).toBe("abc");
		} finally {
			await mounted.unmount();
		}
	});
});
