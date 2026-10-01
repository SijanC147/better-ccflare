import { describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OpenObserveConfig } from "../../../api";
import { byText, click, mount } from "../../../test/dom";
import {
	buildOpenObserveClearToken,
	buildOpenObserveSave,
	buildOpenObserveUpdate,
	formFromConfig,
	INITIAL_OPENOBSERVE_FORM,
	OpenObserveCard,
	OpenObserveCardView,
	type OpenObserveCardViewProps,
	type OpenObserveFormState,
} from "../OpenObserveCard";

function must<T>(value: T | null | undefined, what: string): T {
	if (value === null || value === undefined) {
		throw new Error(`expected ${what} to be present`);
	}
	return value;
}

/**
 * A server read where every field differs from the card's placeholder, so a
 * body that fell back to a placeholder cannot match the server's value by
 * coincidence.
 */
function config(overrides: Partial<OpenObserveConfig> = {}): OpenObserveConfig {
	return {
		enabled: true,
		url: "http://o2.example:5080",
		org: "acme",
		user: "ingest@example.com",
		logStream: "custom_logs",
		requestStream: "custom_requests",
		metricsStream: "custom_metrics",
		shipPayloads: true,
		logMinLevel: "WARN",
		tokenSet: false,
		tokenFromEnvironment: false,
		endpointFromEnvironment: false,
		...overrides,
	};
}

function form(
	overrides: Partial<OpenObserveFormState> = {},
): OpenObserveFormState {
	return { ...formFromConfig(config()), ...overrides };
}

// ---------------------------------------------------------------------------
// The payload builders. Every assertion is a whole-object toEqual, so an extra
// key fails as loudly as a missing one: an extra `token: ""` would clear the
// stored token on every save.
// ---------------------------------------------------------------------------

describe("formFromConfig", () => {
	it("copies every editable field and none of the read-only flags", () => {
		expect(formFromConfig(config())).toEqual({
			url: "http://o2.example:5080",
			org: "acme",
			user: "ingest@example.com",
			logStream: "custom_logs",
			requestStream: "custom_requests",
			metricsStream: "custom_metrics",
			shipPayloads: true,
			logMinLevel: "WARN",
		});
	});
});

describe("buildOpenObserveUpdate", () => {
	it("sends every field once the server's values have been read", () => {
		expect(buildOpenObserveUpdate(form(), true)).toEqual({
			url: "http://o2.example:5080",
			org: "acme",
			user: "ingest@example.com",
			logStream: "custom_logs",
			requestStream: "custom_requests",
			metricsStream: "custom_metrics",
			shipPayloads: true,
			logMinLevel: "WARN",
		});
	});

	// #305: a save before the read must not overwrite a configured metrics
	// stream with the placeholder, and an unread level must not be sent at all.
	it("omits the metrics stream and the level before the read", () => {
		const body = buildOpenObserveUpdate(INITIAL_OPENOBSERVE_FORM, false);
		expect(body).toEqual({
			url: "",
			org: "default",
			user: "",
			logStream: "better_ccflare_logs",
			requestStream: "better_ccflare_requests",
			shipPayloads: false,
		});
		expect("metricsStream" in body).toBe(false);
		expect("logMinLevel" in body).toBe(false);
		expect("token" in body).toBe(false);
	});

	it("sends an emptied metrics stream as empty once read, which the server reads as the default", () => {
		expect(
			buildOpenObserveUpdate(form({ metricsStream: "" }), true).metricsStream,
		).toBe("");
	});

	it("omits the level while it is unread, even after the rest was read", () => {
		const body = buildOpenObserveUpdate(form({ logMinLevel: "" }), true);
		expect("logMinLevel" in body).toBe(false);
		expect(body.metricsStream).toBe("custom_metrics");
	});

	// One field at a time, so a builder that wires one form field to another
	// key cannot pass by every field happening to hold the same value.
	const edits: [keyof OpenObserveFormState, string | boolean][] = [
		["url", "http://other:5080"],
		["org", "other-org"],
		["user", "other-user"],
		["logStream", "other_logs"],
		["requestStream", "other_requests"],
		["metricsStream", "other_metrics"],
		["shipPayloads", false],
		["logMinLevel", "ERROR"],
	];
	for (const [field, value] of edits) {
		it(`changes only ${field} when only ${field} changed`, () => {
			const before = buildOpenObserveUpdate(form(), true);
			const after = buildOpenObserveUpdate(form({ [field]: value }), true);
			expect(after).toEqual({ ...before, [field]: value });
		});
	}
});

describe("buildOpenObserveSave", () => {
	it("leaves the token out when the field is empty", () => {
		const body = buildOpenObserveSave(form(), true, "");
		expect("token" in body).toBe(false);
		expect(body).toEqual(buildOpenObserveUpdate(form(), true));
	});

	it("sends a typed token alongside the whole card", () => {
		expect(buildOpenObserveSave(form(), true, "s3cret")).toEqual({
			...buildOpenObserveUpdate(form(), true),
			token: "s3cret",
		});
	});
});

describe("buildOpenObserveClearToken", () => {
	it("sends the whole card with an empty token", () => {
		expect(buildOpenObserveClearToken(form(), true)).toEqual({
			...buildOpenObserveUpdate(form(), true),
			token: "",
		});
	});

	it("keeps the before-read rule for the metrics stream", () => {
		const body = buildOpenObserveClearToken(INITIAL_OPENOBSERVE_FORM, false);
		expect(body.token).toBe("");
		expect("metricsStream" in body).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// The view, rendered to a string: every state the card can be in.
// ---------------------------------------------------------------------------

function render(overrides: Partial<OpenObserveCardViewProps> = {}): string {
	const props: OpenObserveCardViewProps = {
		data: config(),
		form: form(),
		token: "",
		busy: false,
		isError: false,
		onFieldChange: () => {},
		onTokenChange: () => {},
		onSave: () => {},
		onClearToken: () => {},
		...overrides,
	};
	return renderToStaticMarkup(<OpenObserveCardView {...props} />);
}

/** The opening tag of the element with this id. */
function tagWithId(html: string, id: string): string {
	const match = new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`).exec(html);
	return must(match, `an element with id ${id}`)[0];
}

const TEXT_INPUT_IDS = [
	"oo-url",
	"oo-org",
	"oo-user",
	"oo-log-stream",
	"oo-request-stream",
	"oo-metrics-stream",
	"oo-token",
] as const;

describe("OpenObserveCardView", () => {
	it("renders the unconfigured state before the read lands", () => {
		const html = render({
			data: undefined,
			form: INITIAL_OPENOBSERVE_FORM,
			busy: true,
		});
		expect(html).toContain("Shipping disabled");
		expect(html).not.toContain("Shipping enabled");
		expect(html).toContain("No token configured");
		expect(tagWithId(html, "oo-token")).toContain(
			'placeholder="Not configured"',
		);
		expect(byTextCount(html, "Clear stored token")).toBe(0);
		expect(html).not.toContain("overridden by environment");
		expect(html).not.toContain("Failed to save");
	});

	it("renders a configured card with a stored token", () => {
		const html = render({ data: config({ tokenSet: true }) });
		expect(html).toContain("Shipping enabled");
		expect(html).not.toContain("Shipping disabled");
		expect(html).toContain("Token configured");
		expect(html).not.toContain("No token configured");
		expect(tagWithId(html, "oo-token")).toContain(
			'placeholder="Replace token"',
		);
		expect(byTextCount(html, "Clear stored token")).toBe(1);
	});

	it("reports shipping disabled when the server says no base URL is set", () => {
		const html = render({ data: config({ enabled: false, url: "" }) });
		expect(html).toContain("Shipping disabled");
	});

	it("renders each form field into its own input, the #305 metrics stream included", () => {
		const html = render({
			form: form({
				url: "u-val",
				org: "o-val",
				user: "us-val",
				logStream: "l-val",
				requestStream: "r-val",
				metricsStream: "m-val",
			}),
			token: "t-val",
		});
		const expected: Record<(typeof TEXT_INPUT_IDS)[number], string> = {
			"oo-url": "u-val",
			"oo-org": "o-val",
			"oo-user": "us-val",
			"oo-log-stream": "l-val",
			"oo-request-stream": "r-val",
			"oo-metrics-stream": "m-val",
			"oo-token": "t-val",
		};
		for (const id of TEXT_INPUT_IDS) {
			expect(tagWithId(html, id)).toContain(`value="${expected[id]}"`);
		}
		expect(tagWithId(html, "oo-token")).toContain('type="password"');
	});

	it("disables every control while busy", () => {
		const html = render({ busy: true, data: config({ tokenSet: true }) });
		for (const id of TEXT_INPUT_IDS) {
			expect(tagWithId(html, id)).toContain('disabled=""');
		}
		expect(tagWithId(html, "oo-log-min-level")).toContain("data-disabled");
		// Save and Clear stored token.
		expect(
			countMatches(
				html,
				/<button[^>]*disabled=""[^>]*>(Save|Clear stored token)</g,
			),
		).toBe(2);
	});

	it("leaves every control enabled when idle", () => {
		const html = render({ busy: false, data: config({ tokenSet: true }) });
		for (const id of TEXT_INPUT_IDS) {
			expect(tagWithId(html, id)).not.toContain('disabled=""');
		}
		expect(html).not.toContain('disabled=""');
	});

	it("shows the save error only when the last save failed", () => {
		expect(render({ isError: true })).toContain("Failed to save");
		expect(render({ isError: false })).not.toContain("Failed to save");
	});

	it("says when the environment overrides the token", () => {
		const html = render({ data: config({ tokenFromEnvironment: true }) });
		expect(html).toContain("BETTER_CCFLARE_OPENOBSERVE_TOKEN is set");
		expect(html).not.toContain("BETTER_CCFLARE_OPENOBSERVE_URL is set");
		expect(html).not.toContain("overridden by environment");
	});

	it("says when the environment overrides the endpoint", () => {
		const html = render({ data: config({ endpointFromEnvironment: true }) });
		expect(html).toContain("overridden by environment");
		expect(html).toContain("BETTER_CCFLARE_OPENOBSERVE_URL is set");
		expect(html).not.toContain("BETTER_CCFLARE_OPENOBSERVE_TOKEN is set");
	});

	it("reflects the payload switch", () => {
		expect(render({ form: form({ shipPayloads: true }) })).toContain(
			'aria-checked="true"',
		);
		expect(render({ form: form({ shipPayloads: false }) })).toContain(
			'aria-checked="false"',
		);
	});
});

function countMatches(html: string, pattern: RegExp): number {
	return Array.from(html.matchAll(pattern)).length;
}

function byTextCount(html: string, text: string): number {
	return countMatches(html, new RegExp(`<button[^>]*>${text}</button>`, "g"));
}

// ---------------------------------------------------------------------------
// The live card, mounted against a stubbed fetch, so these assert what the
// container actually sends: the builders above are covered, and these cover
// the call sites that hand them their arguments.
//
// Only plain <input>s and <button>s are driven here. The level Select and the
// payload Switch are Radix, and Radix decides at load whether layout effects
// run, so a test file that loads it before happy-dom registers makes them
// order-dependent (mem:radix-portal-unmountable-after-ssr-tests).
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

/**
 * Sets a text input the way a user would, so React sees a change: the value
 * through the prototype setter, which React's value tracker reads, then an
 * `input` event.
 */
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

function onlyButton(text: string): Element {
	const found = byText(document.body, "button", text);
	expect(found.length).toBe(1);
	return must(found[0], `button ${text}`);
}

const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST");

async function withCard(
	server: OpenObserveConfig,
	run: (calls: Call[]) => Promise<void>,
	postStatus = 200,
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
		if (url === "/api/config/openobserve" && method === "GET") {
			return json(server);
		}
		if (url === "/api/config/openobserve" && method === "POST") {
			return postStatus === 200
				? json({ success: true })
				: json({ error: "refused" }, postStatus);
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
			<OpenObserveCard />
		</QueryClientProvider>,
	);
	try {
		await waitFor(
			() =>
				!client.isFetching() &&
				calls.some((c) => c.url === "/api/config/openobserve"),
			"the initial read",
		);
		// react-query notifies React on a 0ms timer, so one more tick lets the
		// card render the data and its effect seed the form.
		await settle();
		await waitFor(
			() => input("oo-url").value === server.url,
			"the form to seed from the read",
		);
		await run(calls);
		expect(unexpected).toEqual([]);
	} finally {
		await mounted.unmount();
		client.clear();
		globalThis.fetch = original;
	}
}

async function save(calls: Call[], button = "Save"): Promise<Call> {
	const before = posts(calls).length;
	await click(onlyButton(button));
	await waitFor(() => posts(calls).length === before + 1, "the POST");
	await settle();
	return must(posts(calls).at(-1), "the POST");
}

describe("OpenObserveCard, mounted", () => {
	// The issue's user story: saving one field never resets another. Every
	// server value differs from the card's placeholder, so a body built from a
	// form the read never seeded, or before the read was marked as landed,
	// fails here rather than matching by coincidence.
	const fields: [string, keyof OpenObserveFormState][] = [
		["oo-url", "url"],
		["oo-org", "org"],
		["oo-user", "user"],
		["oo-log-stream", "logStream"],
		["oo-request-stream", "requestStream"],
		["oo-metrics-stream", "metricsStream"],
	];
	for (const [id, field] of fields) {
		it(`sends the edited ${field} and every other field at the server's value`, async () => {
			await withCard(config(), async (calls) => {
				await typeInto(input(id), "edited-value");
				const post = await save(calls);
				expect(post.body).toEqual({
					...formFromConfig(config()),
					[field]: "edited-value",
				});
			});
		});
	}

	it("sends a typed token with Save and empties the field after the save lands", async () => {
		await withCard(config(), async (calls) => {
			await typeInto(input("oo-token"), "s3cret");
			const post = await save(calls);
			expect(post.body).toEqual({
				...formFromConfig(config()),
				token: "s3cret",
			});
			await waitFor(() => input("oo-token").value === "", "the token to clear");
		});
	});

	it("sends an empty token from Clear stored token, and never from Save", async () => {
		await withCard(config({ tokenSet: true }), async (calls) => {
			const saved = await save(calls);
			expect(saved.body).toEqual(formFromConfig(config()));
			expect("token" in (saved.body as object)).toBe(false);

			const cleared = await save(calls, "Clear stored token");
			expect(cleared.body).toEqual({
				...formFromConfig(config()),
				token: "",
			});
		});
	});

	// A 400, because the client retries a 5xx once after a second and the
	// handler refuses a bad config with a 4xx, which is not retried.
	it("keeps the typed token when the save is refused, and says the save failed", async () => {
		await withCard(
			config(),
			async (calls) => {
				await typeInto(input("oo-token"), "s3cret");
				await save(calls);
				await waitFor(
					() => (document.body.textContent ?? "").includes("Failed to save"),
					"the error line",
				);
				expect(input("oo-token").value).toBe("s3cret");
				expect(posts(calls).length).toBe(1);
			},
			400,
		);
	});
});
