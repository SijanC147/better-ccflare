import { describe, expect, it } from "bun:test";
import {
	ANTHROPIC_OAUTH_PROVIDER_KEY,
	type OpenAIGatewayListing,
} from "@better-ccflare/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { byText, click, mount } from "../../../test/dom";
import {
	emptyGatewayForm,
	excludeProviderOptions,
	formToGatewayConfig,
	GatewayForm,
	type GatewayFormState,
	type GatewayModelRow,
	GatewayRow,
	gatewayBaseUrls,
	gatewayComboOptions,
	listingToGatewayForm,
	OpenAIGatewaysCard,
} from "../OpenAIGatewaysCard";

function must<T>(value: T | null | undefined, what: string): T {
	if (value === null || value === undefined) {
		throw new Error(`expected ${what} to be present`);
	}
	return value;
}

let rowId = 1000;
function row(overrides: Partial<GatewayModelRow> = {}): GatewayModelRow {
	rowId += 1;
	return { id: rowId, name: "", model: "", combo: "", ...overrides };
}

function form(overrides: Partial<GatewayFormState> = {}): GatewayFormState {
	return { ...emptyGatewayForm(), name: "work", ...overrides };
}

function listing(
	overrides: Partial<OpenAIGatewayListing> = {},
): OpenAIGatewayListing {
	const name = overrides.name ?? "work";
	return {
		name,
		base_path: `/v1/gateways/${name}`,
		exclude_providers: [],
		description: null,
		models: [],
		...overrides,
	};
}

describe("formToGatewayConfig", () => {
	it("sends an empty body for a passthrough gateway, with no models key", () => {
		const result = formToGatewayConfig(form());
		expect(result).toEqual({ ok: true, name: "work", config: {} });
		if (result.ok) expect("models" in result.config).toBe(false);
	});

	it("includes every field that was set, in the wire shape", () => {
		const result = formToGatewayConfig(
			form({
				name: "  work  ",
				description: "  Work apps  ",
				excludeProviders: ["codex", ANTHROPIC_OAUTH_PROVIDER_KEY, "codex"],
				models: [
					row({ name: " gpt-5.5 ", model: "", combo: "gpt-ladder" }),
					row({ name: "fast", model: " gpt-5.6-luna " }),
				],
			}),
		);
		expect(result).toEqual({
			ok: true,
			name: "work",
			config: {
				description: "Work apps",
				exclude_providers: ["codex", ANTHROPIC_OAUTH_PROVIDER_KEY],
				models: [
					{ name: "gpt-5.5", model: "gpt-5.5", combo: "gpt-ladder" },
					{ name: "fast", model: "gpt-5.6-luna" },
				],
			},
		});
	});

	it("drops fully blank model rows, leaving a passthrough gateway", () => {
		const result = formToGatewayConfig(form({ models: [row(), row()] }));
		expect(result).toEqual({ ok: true, name: "work", config: {} });
	});

	it("refuses a model row that has a model or combo but no name", () => {
		for (const bad of [row({ model: "gpt-5.5" }), row({ combo: "ladder" })]) {
			const result = formToGatewayConfig(
				form({ models: [row({ name: "ok" }), bad] }),
			);
			expect(result).toEqual({
				ok: false,
				error: "Model row 2 needs a name.",
			});
		}
	});

	it("refuses names the server would refuse", () => {
		for (const name of [
			"",
			"Work",
			"has space",
			"-lead",
			"a/b",
			"a".repeat(65),
		]) {
			const result = formToGatewayConfig(form({ name }));
			expect(result.ok).toBe(false);
		}
		expect(formToGatewayConfig(form({ name: "a".repeat(64) })).ok).toBe(true);
	});
});

describe("listingToGatewayForm", () => {
	it("round trips a listing into the same document", () => {
		const row = listing({
			description: "desc",
			exclude_providers: ["codex"],
			models: [
				{ name: "a", model: "up-a", combo: "ladder" },
				{ name: "b", model: "b" },
			],
		});
		expect(formToGatewayConfig(listingToGatewayForm(row))).toEqual({
			ok: true,
			name: "work",
			config: {
				description: "desc",
				exclude_providers: ["codex"],
				models: [
					{ name: "a", model: "up-a", combo: "ladder" },
					{ name: "b", model: "b" },
				],
			},
		});
	});

	it("gives every model row a distinct key", () => {
		const state = listingToGatewayForm(
			listing({
				models: [
					{ name: "a", model: "a" },
					{ name: "b", model: "b" },
				],
			}),
		);
		expect(new Set(state.models.map((m) => m.id)).size).toBe(2);
	});
});

describe("gatewayBaseUrls", () => {
	it("builds the full and the short base URL from the origin", () => {
		expect(gatewayBaseUrls("http://host:8080", listing())).toEqual({
			full: "http://host:8080/v1/gateways/work",
			short: "http://host:8080/work/v1",
		});
	});

	it("offers no short URL for a reserved first segment", () => {
		const urls = gatewayBaseUrls("http://host:8080", listing({ name: "api" }));
		expect(urls).toEqual({
			full: "http://host:8080/v1/gateways/api",
			short: null,
		});
	});
});

describe("excludeProviderOptions", () => {
	it("offers each pool provider once, plus anthropic-oauth when Anthropic is present", () => {
		const options = excludeProviderOptions(
			["codex", "anthropic", null, "anthropic", "zai", undefined, ""],
			[],
		);
		expect(options.map((o) => o.value)).toEqual([
			ANTHROPIC_OAUTH_PROVIDER_KEY,
			"anthropic",
			"codex",
			"zai",
		]);
		expect(options.every((o) => o.inPool)).toBe(true);
		const oauth = must(
			options.find((o) => o.value === ANTHROPIC_OAUTH_PROVIDER_KEY),
			"anthropic-oauth option",
		);
		expect(oauth.label).toBe("Anthropic OAuth accounts");
	});

	it("does not offer anthropic-oauth without an Anthropic account", () => {
		const options = excludeProviderOptions(["codex"], []);
		expect(options.map((o) => o.value)).toEqual(["codex"]);
	});

	it("keeps a stored value the pool lacks, marked as not in the pool", () => {
		const options = excludeProviderOptions(["codex"], ["legacy", "codex"]);
		expect(options).toEqual([
			{ value: "codex", label: "codex", inPool: true },
			{ value: "legacy", label: "legacy", inPool: false },
		]);
	});
});

describe("gatewayComboOptions", () => {
	it("keeps a stored combo that no longer exists, and ignores none", () => {
		const options = gatewayComboOptions(
			[{ name: "ladder", enabled: true }],
			["", "gone", "ladder"],
		);
		expect(options).toEqual([
			{ name: "ladder", exists: true, enabled: true },
			{ name: "gone", exists: false, enabled: false },
		]);
	});
});

describe("GatewayRow", () => {
	function render(gateway: OpenAIGatewayListing): string {
		return renderToStaticMarkup(
			<GatewayRow
				gateway={gateway}
				origin="http://host:8080"
				onEdit={() => {}}
				onDelete={() => {}}
			/>,
		);
	}

	it("shows both base URLs, the exclusions and the model set", () => {
		const html = render(
			listing({
				description: "Work apps",
				exclude_providers: [ANTHROPIC_OAUTH_PROVIDER_KEY],
				models: [
					{ name: "gpt-5.5", model: "gpt-5.5-up", combo: "ladder" },
					{ name: "fast", model: "fast" },
				],
			}),
		);
		expect(html).toContain("http://host:8080/v1/gateways/work");
		expect(html).toContain("http://host:8080/work/v1");
		expect(html).toContain("Work apps");
		expect(html).toContain("Anthropic OAuth accounts");
		expect(html).toContain("gpt-5.5-up");
		expect(html).toContain("combo ladder");
		expect(html).not.toContain("passthrough");
	});

	it("says a gateway without models passes the model through", () => {
		const html = render(listing());
		expect(html).toContain("passthrough");
		expect(html).toContain("none");
	});

	it("explains the missing short URL for a reserved name", () => {
		const html = render(listing({ name: "api" }));
		expect(html).toContain("http://host:8080/v1/gateways/api");
		expect(html).not.toContain("http://host:8080/api/v1");
		expect(html).toContain("No short URL");
	});

	it("names the gateway on each icon button for assistive technology", () => {
		const html = render(listing());
		expect(html).toContain('aria-label="Edit gateway work"');
		expect(html).toContain('title="Edit gateway work"');
		expect(html).toContain('aria-label="Delete gateway work"');
		expect(html).toContain('title="Delete gateway work"');
	});
});

describe("GatewayForm", () => {
	function render(state: GatewayFormState, editing = false): string {
		return renderToStaticMarkup(
			<GatewayForm
				form={state}
				onChange={() => {}}
				editing={editing}
				providerOptions={excludeProviderOptions(
					["codex"],
					state.excludeProviders,
				)}
				comboOptions={gatewayComboOptions([], [])}
			/>,
		);
	}

	it("disables the name field while editing and not while adding", () => {
		const nameInput = (html: string) =>
			html.slice(
				html.indexOf('id="oag-name"') - 200,
				html.indexOf('id="oag-name"') + 200,
			);
		expect(nameInput(render(form(), true))).toContain('disabled=""');
		expect(nameInput(render(form(), false))).not.toContain('disabled=""');
	});

	it("says an empty model list means passthrough", () => {
		expect(render(form())).toContain("passes through whatever model");
	});

	it("shows a stored exclusion the pool lacks as checked", () => {
		const html = render(form({ excludeProviders: ["legacy"] }));
		const tag = (id: string) =>
			must(
				new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html),
				`input ${id}`,
			)[0];
		expect(tag("oag-exclude-legacy")).toContain('checked=""');
		expect(tag("oag-exclude-codex")).not.toContain('checked=""');
		expect(html).toContain("(not in pool)");
	});
});

// ---------------------------------------------------------------------------
// The live card, mounted against a stubbed fetch. Every request the card makes
// is recorded, so each test asserts what was sent rather than what rendered.
// ---------------------------------------------------------------------------

interface Call {
	method: string;
	url: string;
	body: unknown;
}

interface Backend {
	gateways?: OpenAIGatewayListing[];
	errors?: string[];
	accounts?: { provider: string }[];
	combos?: { name: string; enabled: boolean }[];
	/** Answers PUT; the default echoes a listing for the body. */
	put?: (name: string, body: unknown) => Response;
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

/**
 * Sets a controlled field the way a user would, so React sees a change.
 *
 * A `<select>` takes a plain `change` event. A text input does not, in this
 * harness: `src/test/dom.ts` imports `react-dom/client`, and an ES module's
 * imports evaluate before its body, so react-dom loads before happy-dom is
 * registered. It then reads `canUseDOM` as false, sets `isInputEventSupported`
 * to false at load, and handles text inputs with its old IE polyfill, which
 * ignores `input` events and instead watches the focused element (`focusin`,
 * then `keyup`), calling the IE-only `attachEvent` on it. Measured: an `input`
 * event alone, with the value set through the prototype setter, fired no
 * `onChange`.
 *
 * So this sends both shapes. Whichever path react-dom took, exactly one of
 * `input` and `keyup` produces the change, measured as one `onChange` call per
 * `typeInto`. The `attachEvent` and `detachEvent` stubs exist only so the
 * polyfill does not throw on a DOM that never had them.
 */
async function typeInto(element: Element, text: string): Promise<void> {
	if (element instanceof HTMLSelectElement) {
		const setter = must(
			Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value"),
			"select value descriptor",
		).set;
		await act(async () => {
			must(setter, "select value setter").call(element, text);
			element.dispatchEvent(new Event("change", { bubbles: true }));
		});
		return;
	}
	const setter = must(
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value"),
		"input value descriptor",
	).set;
	const legacy = element as Element & {
		attachEvent?: () => void;
		detachEvent?: () => void;
	};
	legacy.attachEvent = () => {};
	legacy.detachEvent = () => {};
	await act(async () => {
		element.dispatchEvent(new Event("focusin", { bubbles: true }));
		must(setter, "input value setter").call(element, text);
		element.dispatchEvent(new Event("input", { bubbles: true }));
		element.dispatchEvent(new Event("keyup", { bubbles: true }));
		element.dispatchEvent(new Event("focusout", { bubbles: true }));
	});
}

function byId(id: string): HTMLElement {
	return must(document.getElementById(id), `#${id}`);
}

function buttonByLabel(label: string): Element {
	return must(
		document.body.querySelector(`button[aria-label="${label}"]`),
		`button ${label}`,
	);
}

function onlyButton(text: string): Element {
	const found = byText(document.body, "button", text);
	expect(found.length).toBe(1);
	return found[0];
}

function all<T extends Element>(selector: string): T[] {
	return Array.from(document.body.querySelectorAll<T>(selector));
}

async function withCard(
	backend: Backend,
	run: (calls: Call[]) => Promise<void>,
): Promise<void> {
	const calls: Call[] = [];
	const unexpected: string[] = [];
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

		if (method === "GET" && url === "/api/openai-gateways") {
			return json({
				gateways: backend.gateways ?? [],
				errors: backend.errors ?? [],
			});
		}
		if (method === "GET" && url === "/api/accounts") {
			return json(backend.accounts ?? []);
		}
		if (method === "GET" && url === "/api/combos") {
			return json({ success: true, data: backend.combos ?? [] });
		}
		const match = /^\/api\/openai-gateways\/([^/]+)$/.exec(url);
		if (match && method === "PUT") {
			const name = decodeURIComponent(match[1]);
			return backend.put
				? backend.put(name, body)
				: json(listing({ name, ...(body as object) }));
		}
		if (match && method === "DELETE") {
			return new Response(null, { status: 204 });
		}
		unexpected.push(`${method} ${url}`);
		return json({ error: `unexpected ${method} ${url}` }, 404);
	};
	globalThis.fetch = stub as unknown as typeof fetch;

	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const mounted = await mount(
		<QueryClientProvider client={client}>
			<OpenAIGatewaysCard />
		</QueryClientProvider>,
	);
	try {
		await waitFor(
			() =>
				!client.isFetching() &&
				calls.some((c) => c.url === "/api/openai-gateways"),
			"the initial queries",
		);
		// react-query has the data now but notifies React on a 0ms timer, so
		// one more tick lets the card render it.
		await settle();
		await run(calls);
		expect(unexpected).toEqual([]);
	} finally {
		await mounted.unmount();
		client.clear();
		globalThis.fetch = original;
	}
}

const puts = (calls: Call[]) => calls.filter((c) => c.method === "PUT");
const deletes = (calls: Call[]) => calls.filter((c) => c.method === "DELETE");

describe("OpenAIGatewaysCard", () => {
	it("lists each gateway with both base URLs and shows skipped entries", async () => {
		await withCard(
			{
				gateways: [
					listing({
						name: "work",
						models: [{ name: "gpt-5.5", model: "gpt-5.5" }],
					}),
				],
				errors: ["gateway broken: unknown gateway field: exclude_provider"],
			},
			async () => {
				const text = document.body.textContent ?? "";
				expect(text).toContain("/v1/gateways/work");
				expect(text).toContain("/work/v1");
				expect(text).toContain("Skipped config entries");
				expect(text).toContain(
					"gateway broken: unknown gateway field: exclude_provider",
				);
			},
		);
	});

	it("creates a gateway with the PUT body the form describes", async () => {
		await withCard(
			{
				accounts: [
					{ provider: "anthropic" },
					{ provider: "codex" },
					{ provider: "anthropic" },
				],
				combos: [{ name: "gpt-ladder", enabled: true }],
			},
			async (calls) => {
				await click(buttonByLabel("Add gateway"));
				await typeInto(byId("oag-name"), "work");
				await typeInto(byId("oag-description"), "  Work apps ");
				await click(byId(`oag-exclude-${ANTHROPIC_OAUTH_PROVIDER_KEY}`));
				await click(byId("oag-exclude-codex"));
				await click(onlyButton("Add model"));
				await click(onlyButton("Add model"));

				const names = all<HTMLInputElement>('input[id^="oag-model-name-"]');
				const models = all<HTMLInputElement>('input[id^="oag-model-model-"]');
				const combos = all<HTMLSelectElement>('select[id^="oag-model-combo-"]');
				expect([names.length, models.length, combos.length]).toEqual([2, 2, 2]);
				await typeInto(names[0], "gpt-5.5");
				await typeInto(combos[0], "gpt-ladder");
				await typeInto(names[1], "fast");
				await typeInto(models[1], "gpt-5.6-luna");

				await click(onlyButton("Save"));
				await waitFor(() => puts(calls).length > 0, "the PUT");
				await settle();

				const sent = puts(calls);
				expect(sent.length).toBe(1);
				expect(sent[0].url).toBe("/api/openai-gateways/work");
				expect(sent[0].body).toEqual({
					description: "Work apps",
					exclude_providers: [ANTHROPIC_OAUTH_PROVIDER_KEY, "codex"],
					models: [
						{ name: "gpt-5.5", model: "gpt-5.5", combo: "gpt-ladder" },
						{ name: "fast", model: "gpt-5.6-luna" },
					],
				});
				// Success closes the form.
				await waitFor(
					() => byText(document.body, "button", "Save").length === 0,
					"the form to close",
				);
			},
		);
	});

	it("keeps a stored exclusion and combo the pool no longer has when editing", async () => {
		await withCard(
			{
				gateways: [
					listing({
						exclude_providers: ["legacy"],
						models: [{ name: "m", model: "up", combo: "gone" }],
					}),
				],
				accounts: [{ provider: "codex" }],
				combos: [],
			},
			async (calls) => {
				await click(buttonByLabel("Edit gateway work"));
				expect((byId("oag-exclude-legacy") as HTMLInputElement).checked).toBe(
					true,
				);
				await click(onlyButton("Save"));
				await waitFor(() => puts(calls).length > 0, "the PUT");

				const sent = puts(calls);
				expect(sent.length).toBe(1);
				expect(sent[0].url).toBe("/api/openai-gateways/work");
				expect(sent[0].body).toEqual({
					exclude_providers: ["legacy"],
					models: [{ name: "m", model: "up", combo: "gone" }],
				});
			},
		);
	});

	for (const [status, message] of [
		[
			409,
			'"work" is already a Claude Code endpoint; both are served at /work/v1, so the name can belong to only one',
		],
		[400, "models entry gpt-5.5 is listed twice"],
	] as const) {
		it(`shows a ${status} from the server verbatim and keeps the form open`, async () => {
			await withCard(
				{ put: () => json({ error: message }, status) },
				async (calls) => {
					await click(buttonByLabel("Add gateway"));
					await typeInto(byId("oag-name"), "work");
					await click(onlyButton("Save"));
					await waitFor(
						() => (document.body.textContent ?? "").includes(message),
						"the error message",
					);
					expect(puts(calls).length).toBe(1);
					expect(byText(document.body, "button", "Save").length).toBe(1);
				},
			);
		});
	}

	it("blocks an invalid name before any request is made", async () => {
		await withCard({}, async (calls) => {
			await click(buttonByLabel("Add gateway"));
			await typeInto(byId("oag-name"), "Bad Name");
			await click(onlyButton("Save"));
			await settle();
			expect(document.body.textContent ?? "").toContain("Name must be");
			expect(puts(calls).length).toBe(0);
		});
	});

	it("refuses to add over an existing gateway", async () => {
		await withCard({ gateways: [listing()] }, async (calls) => {
			await click(buttonByLabel("Add gateway"));
			await typeInto(byId("oag-name"), "work");
			await click(onlyButton("Save"));
			await settle();
			expect(document.body.textContent ?? "").toContain(
				"A gateway named work already exists",
			);
			expect(puts(calls).length).toBe(0);
		});
	});

	it("deletes only after the confirm step", async () => {
		await withCard({ gateways: [listing()] }, async (calls) => {
			await click(buttonByLabel("Delete gateway work"));
			await settle();
			expect(deletes(calls).length).toBe(0);

			await click(onlyButton("Delete"));
			await waitFor(() => deletes(calls).length > 0, "the DELETE");
			await settle();
			const sent = deletes(calls);
			expect(sent.length).toBe(1);
			expect(sent[0].url).toBe("/api/openai-gateways/work");
		});
	});

	it("sends nothing when the delete is cancelled", async () => {
		await withCard({ gateways: [listing()] }, async (calls) => {
			await click(buttonByLabel("Delete gateway work"));
			await click(onlyButton("Cancel"));
			await settle();
			expect(deletes(calls).length).toBe(0);
			expect(byText(document.body, "button", "Delete").length).toBe(0);
		});
	});
});
