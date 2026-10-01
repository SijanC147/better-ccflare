import { describe, expect, it } from "bun:test";
import {
	type ComboSlot,
	MAX_MIN_RESET_REMAINING_MS,
	MAX_RESET_HOURS,
} from "@better-ccflare/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { byText, click, mount } from "../../../test/dom";
import {
	SlotSettingsForm,
	SlotSettingsFormView,
	type SlotSettingsFormViewProps,
} from "../SlotSettingsPopover";
import {
	draftFromSlot,
	type SlotThrottleDraft,
} from "../slot-throttle-helpers";

function must<T>(value: T | null | undefined, what: string): T {
	if (value === null || value === undefined) {
		throw new Error(`expected ${what} to be present`);
	}
	return value;
}

function slot(overrides: Partial<ComboSlot> = {}): ComboSlot {
	return {
		id: "slot-1",
		combo_id: "combo-1",
		account_id: "account-1",
		model: "claude-opus-5",
		priority: 0,
		enabled: true,
		max_utilization_percent: null,
		min_reset_remaining_ms: null,
		...overrides,
	};
}

// The form's two zero warnings. Each test that expects one asserts the other
// is absent, because the #131 defect class is exactly a hint keyed on the
// wrong field: a reset of 0 disabled the slot with no warning at all.
const ZERO_PERCENT_HINT = "0 percent matches any usage";
const ZERO_HOURS_HINT = "0 hours matches any reset that is still ahead";
const INVALID_PERCENT = "Enter a whole number from 0 to 100";
const INVALID_HOURS = "Enter a number of hours between 0 and";

// ---------------------------------------------------------------------------
// The form body, rendered to a string. Never inside the Popover: a Radix
// portal does not mount after another test file has loaded Radix in the same
// process (mem:radix-portal-unmountable-after-ssr-tests).
// ---------------------------------------------------------------------------

function render(
	draft: Partial<SlotThrottleDraft> = {},
	overrides: Partial<SlotSettingsFormViewProps> = {},
): string {
	const base = overrides.slot ?? slot();
	const props: SlotSettingsFormViewProps = {
		slot: base,
		draft: { ...draftFromSlot(base), ...draft },
		onDraftChange: () => {},
		onSave: () => {},
		isPending: false,
		isError: false,
		error: null,
		...overrides,
	};
	return renderToStaticMarkup(<SlotSettingsFormView {...props} />);
}

/** The opening tag of the element with this id. */
function tagWithId(html: string, id: string): string {
	const match = new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`).exec(html);
	return must(match, `an element with id ${id}`)[0];
}

// The attribute, never the bare word: the button's Tailwind classes carry
// "disabled:opacity-50" on every render, so the word is always present.
const DISABLED = 'disabled=""';

/** The Save button's opening tag and its label. */
function saveButton(html: string): { tag: string; label: string } {
	const match = /(<button[^>]*>)(Save|Saving\.\.\.)<\/button>/.exec(html);
	const found = must(match, "the save button");
	return { tag: must(found[1], "tag"), label: must(found[2], "label") };
}

describe("SlotSettingsFormView, zero thresholds", () => {
	it("warns that 0 hours disables the slot, on the hours field alone", () => {
		const html = render({ minResetRemainingHours: "0" });
		expect(html).toContain(ZERO_HOURS_HINT);
		expect(html).not.toContain(ZERO_PERCENT_HINT);
		expect(html).toContain('id="slot-min-reset-hint-slot-1"');
		expect(html).not.toContain('id="slot-max-util-hint-slot-1"');
	});

	it("warns that 0 percent disables the slot, on the percent field alone", () => {
		const html = render({ maxUtilizationPercent: "0" });
		expect(html).toContain(ZERO_PERCENT_HINT);
		expect(html).not.toContain(ZERO_HOURS_HINT);
		expect(html).toContain('id="slot-max-util-hint-slot-1"');
		expect(html).not.toContain('id="slot-min-reset-hint-slot-1"');
	});

	it("shows both warnings when both are zero, and neither when both are blank", () => {
		const both = render({
			maxUtilizationPercent: "0",
			minResetRemainingHours: "0",
		});
		expect(both).toContain(ZERO_PERCENT_HINT);
		expect(both).toContain(ZERO_HOURS_HINT);

		const blank = render({
			maxUtilizationPercent: "",
			minResetRemainingHours: "",
		});
		expect(blank).not.toContain(ZERO_PERCENT_HINT);
		expect(blank).not.toContain(ZERO_HOURS_HINT);
	});

	// A blank field is "ignore this condition", not zero. Number("") is 0, so a
	// coercion before the blank check would turn clearing into disabling.
	it("does not treat whitespace as zero", () => {
		const html = render({
			maxUtilizationPercent: "  ",
			minResetRemainingHours: "  ",
		});
		expect(html).not.toContain(ZERO_PERCENT_HINT);
		expect(html).not.toContain(ZERO_HOURS_HINT);
		expect(html).not.toContain(INVALID_PERCENT);
		expect(html).not.toContain(INVALID_HOURS);
	});

	it("keeps Save available for a zero, which is a real setting", () => {
		const { tag } = saveButton(render({ minResetRemainingHours: "0" }));
		expect(tag).not.toContain(DISABLED);
	});
});

describe("SlotSettingsFormView, the hours bound", () => {
	it("accepts exactly MAX_RESET_HOURS, the handler's inclusive maximum", () => {
		const html = render({ minResetRemainingHours: String(MAX_RESET_HOURS) });
		expect(html).not.toContain(INVALID_HOURS);
		expect(tagWithId(html, "slot-min-reset-slot-1")).toContain(
			'aria-invalid="false"',
		);
		expect(saveButton(html).tag).not.toContain(DISABLED);
	});

	// SB23-4018: half an hour past the maximum was still a safe integer, so the
	// form accepted it and the handler then refused it with a 400.
	it("refuses half an hour past it, which the handler refuses", () => {
		const html = render({
			minResetRemainingHours: String(MAX_RESET_HOURS + 0.5),
		});
		expect(html).toContain(
			`${INVALID_HOURS} ${MAX_RESET_HOURS.toLocaleString()}, or clear`,
		);
		expect(tagWithId(html, "slot-min-reset-slot-1")).toContain(
			'aria-invalid="true"',
		);
		expect(saveButton(html).tag).toContain(DISABLED);
	});

	it("refuses a negative and a non-number", () => {
		for (const raw of ["-1", "abc", "1e20"]) {
			const html = render({ minResetRemainingHours: raw });
			expect(html).toContain(INVALID_HOURS);
			expect(saveButton(html).tag).toContain(DISABLED);
		}
	});

	it("names the hours field's message in its own aria-describedby", () => {
		const html = render({ minResetRemainingHours: "-1" });
		expect(tagWithId(html, "slot-min-reset-slot-1")).toContain(
			'aria-describedby="slot-min-reset-hint-slot-1"',
		);
		expect(html).toContain('id="slot-min-reset-hint-slot-1"');
		expect(html).not.toContain(INVALID_PERCENT);
	});
});

describe("SlotSettingsFormView, the percent bound", () => {
	it("refuses a value above 100 on the percent field alone", () => {
		const html = render({ maxUtilizationPercent: "101" });
		expect(html).toContain(INVALID_PERCENT);
		expect(html).not.toContain(INVALID_HOURS);
		expect(tagWithId(html, "slot-max-util-slot-1")).toContain(
			'aria-invalid="true"',
		);
		expect(tagWithId(html, "slot-min-reset-slot-1")).toContain(
			'aria-invalid="false"',
		);
		expect(saveButton(html).tag).toContain(DISABLED);
	});
});

describe("SlotSettingsFormView, the Save button", () => {
	it("is disabled while nothing has changed", () => {
		const button = saveButton(render());
		expect(button.label).toBe("Save");
		expect(button.tag).toContain(DISABLED);
	});

	it("is enabled once one field changes, with the other left alone", () => {
		expect(
			saveButton(render({ maxUtilizationPercent: "80" })).tag,
		).not.toContain(DISABLED);
		expect(
			saveButton(render({ minResetRemainingHours: "2" })).tag,
		).not.toContain(DISABLED);
	});

	it("is disabled and relabelled while a save is in flight", () => {
		const html = render({ maxUtilizationPercent: "80" }, { isPending: true });
		const button = saveButton(html);
		expect(button.label).toBe("Saving...");
		expect(button.tag).toContain(DISABLED);
	});
});

describe("SlotSettingsFormView, a failed save", () => {
	it("announces the server's message", () => {
		const html = render(
			{},
			{ isError: true, error: new Error("slot refused") },
		);
		expect(html).toContain('role="alert"');
		expect(html).toContain("slot refused");
	});

	it("falls back to a generic message for a non-Error", () => {
		const html = render({}, { isError: true, error: "boom" });
		expect(html).toContain("Could not save the slot.");
	});

	it("says nothing while the last save did not fail", () => {
		expect(render()).not.toContain('role="alert"');
	});
});

// ---------------------------------------------------------------------------
// The form mounted without its Popover, against a stubbed fetch, so these
// assert the PUT the container actually sends: the helpers are covered in
// slot-throttle-helpers.test.ts, and these cover the call site that hands
// them the draft. Only the two plain inputs and the plain Save button are
// driven; the enabled Switch is Radix (see the note above).
// ---------------------------------------------------------------------------

interface Call {
	method: string;
	url: string;
	body: unknown;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function settle(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 5));
	});
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (predicate()) return;
		await settle();
	}
	throw new Error(`timed out waiting for ${what}`);
}

async function typeInto(element: Element, text: string): Promise<void> {
	const setter = must(
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value"),
		"value descriptor",
	).set;
	await act(async () => {
		must(setter, "value setter").call(element, text);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function input(id: string): HTMLInputElement {
	const element = must(document.getElementById(id), `#${id}`);
	if (!(element instanceof HTMLInputElement)) {
		throw new Error(`#${id} is not an input`);
	}
	return element;
}

function saveElement(): HTMLButtonElement {
	const found = byText(document.body, "button", "Save");
	expect(found.length).toBe(1);
	const button = must(found[0], "the Save button");
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error("Save is not a button");
	}
	return button;
}

const PERCENT = "slot-max-util-slot-1";
const HOURS = "slot-min-reset-slot-1";
const SLOT_URL = "/api/combos/combo-1/slots/slot-1";

async function withForm(
	seeded: ComboSlot,
	run: (calls: Call[], saved: () => number) => Promise<void>,
	putStatus = 200,
): Promise<void> {
	const calls: Call[] = [];
	const unexpected: string[] = [];
	let savedCount = 0;
	const original = globalThis.fetch;
	const stub = async (input: unknown, init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: (input as Request).url;
		const method = (init?.method ?? "GET").toUpperCase();
		const body =
			typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({ method, url, body });
		if (url === SLOT_URL && method === "PUT") {
			return putStatus === 200
				? json({ success: true, data: { ...seeded, ...(body as object) } })
				: json({ error: "slot refused" }, putStatus);
		}
		// The success path invalidates the combo queries; nothing here is
		// subscribed to them, so a refetch would be unexpected.
		unexpected.push(`${method} ${url}`);
		return json({ error: `unexpected ${method} ${url}` }, 404);
	};
	globalThis.fetch = stub as unknown as typeof fetch;

	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const mounted = await mount(
		<QueryClientProvider client={client}>
			<SlotSettingsForm
				slot={seeded}
				comboId="combo-1"
				onSaved={() => {
					savedCount += 1;
				}}
			/>
		</QueryClientProvider>,
	);
	try {
		await run(calls, () => savedCount);
		expect(unexpected).toEqual([]);
	} finally {
		await mounted.unmount();
		client.clear();
		globalThis.fetch = original;
	}
}

async function save(calls: Call[]): Promise<Call> {
	const before = calls.length;
	expect(saveElement().disabled).toBe(false);
	await click(saveElement());
	await waitFor(() => calls.length === before + 1, "the PUT");
	await settle();
	const call = must(calls.at(-1), "the PUT");
	expect(call.method).toBe("PUT");
	expect(call.url).toBe(SLOT_URL);
	return call;
}

describe("SlotSettingsForm, mounted", () => {
	it("sends the utilization threshold alone when only it was set", async () => {
		await withForm(slot(), async (calls, saved) => {
			await typeInto(input(PERCENT), "50");
			const put = await save(calls);
			expect(put.body).toEqual({ max_utilization_percent: 50 });
			await waitFor(() => saved() === 1, "onSaved");
		});
	});

	it("sends the reset threshold alone, in milliseconds, when only it was set", async () => {
		await withForm(slot(), async (calls) => {
			await typeInto(input(HOURS), "2");
			const put = await save(calls);
			expect(put.body).toEqual({ min_reset_remaining_ms: 7_200_000 });
		});
	});

	it("sends a typed 0 as 0, not as a cleared field", async () => {
		await withForm(slot(), async (calls) => {
			await typeInto(input(PERCENT), "0");
			const put = await save(calls);
			expect(put.body).toEqual({ max_utilization_percent: 0 });
		});
	});

	it("sends 0 hours as 0 milliseconds, not as a cleared field", async () => {
		await withForm(slot(), async (calls) => {
			await typeInto(input(HOURS), "0");
			const put = await save(calls);
			expect(put.body).toEqual({ min_reset_remaining_ms: 0 });
		});
	});

	it("clears the reset threshold alone, leaving a set utilization threshold untouched", async () => {
		const seeded = slot({
			max_utilization_percent: 80,
			min_reset_remaining_ms: 3_600_000,
		});
		await withForm(seeded, async (calls) => {
			expect(input(PERCENT).value).toBe("80");
			expect(input(HOURS).value).toBe("1");
			await typeInto(input(HOURS), "");
			const put = await save(calls);
			expect(put.body).toEqual({ min_reset_remaining_ms: null });
		});
	});

	it("clears the utilization threshold alone, leaving a set reset threshold untouched", async () => {
		const seeded = slot({
			max_utilization_percent: 80,
			min_reset_remaining_ms: 3_600_000,
		});
		await withForm(seeded, async (calls) => {
			await typeInto(input(PERCENT), "");
			const put = await save(calls);
			expect(put.body).toEqual({ max_utilization_percent: null });
		});
	});

	it("sends both when both changed", async () => {
		await withForm(slot(), async (calls) => {
			await typeInto(input(PERCENT), "90");
			await typeInto(input(HOURS), "1.5");
			const put = await save(calls);
			expect(put.body).toEqual({
				max_utilization_percent: 90,
				min_reset_remaining_ms: 5_400_000,
			});
		});
	});

	it("sends exactly the handler's maximum, and nothing for half an hour past it", async () => {
		await withForm(slot(), async (calls) => {
			await typeInto(input(HOURS), String(MAX_RESET_HOURS + 0.5));
			expect(saveElement().disabled).toBe(true);
			await click(saveElement());
			await settle();
			expect(calls).toEqual([]);

			await typeInto(input(HOURS), String(MAX_RESET_HOURS));
			const put = await save(calls);
			expect(put.body).toEqual({
				min_reset_remaining_ms: MAX_MIN_RESET_REMAINING_MS,
			});
		});
	});

	it("announces a refused save and does not report it as saved", async () => {
		await withForm(
			slot(),
			async (calls, saved) => {
				await typeInto(input(PERCENT), "50");
				await save(calls);
				await waitFor(
					() => document.body.querySelector('[role="alert"]') !== null,
					"the alert",
				);
				expect(saved()).toBe(0);
				expect(calls.length).toBe(1);
			},
			400,
		);
	});
});
