import { describe, expect, it } from "bun:test";
import type { ClaudeCodeEndpointListing } from "@better-ccflare/types";
import {
	DEFAULT_CLAUDE_CODE_MODELS,
	MAX_CLAUDE_CODE_CONCURRENCY,
	MAX_CLAUDE_CODE_EXTRA_ARGS,
	MAX_CLAUDE_CODE_MODELS,
} from "@better-ccflare/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { byText, click, mount } from "../../../test/dom";
import {
	BYPASS_PERMISSIONS_WARNING,
	ClaudeCodeEndpointsCard,
	EndpointForm,
	type EndpointFormState,
	EndpointRow,
	emptyEndpointForm,
	endpointBaseUrl,
	formToEndpointConfig,
	listingToForm,
} from "../ClaudeCodeEndpointsCard";
import { unattachedErrors } from "../SkippedConfigEntries";

function form(overrides: Partial<EndpointFormState> = {}): EndpointFormState {
	return {
		...emptyEndpointForm(),
		name: "myproject",
		directory: "/srv/myproject",
		...overrides,
	};
}

function listing(
	overrides: Partial<ClaudeCodeEndpointListing> = {},
): ClaudeCodeEndpointListing {
	return {
		name: "myproject",
		directory: "/srv/myproject",
		description: null,
		models: [...DEFAULT_CLAUDE_CODE_MODELS],
		permission_mode: "bypassPermissions",
		extra_args: [],
		max_concurrency: 2,
		timeout_ms: 600_000,
		base_path: "/myproject/v1",
		directory_exists: true,
		...overrides,
	};
}

describe("formToEndpointConfig", () => {
	it("sends only the directory when nothing else was set", () => {
		const result = formToEndpointConfig(form());
		expect(result).toEqual({
			ok: true,
			name: "myproject",
			config: { directory: "/srv/myproject" },
		});
	});

	it("leaves a default permission mode out so the server default applies", () => {
		const result = formToEndpointConfig(
			form({ permissionMode: "bypassPermissions" }),
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect("permission_mode" in result.config).toBe(false);
	});

	it("includes every field that was set, converted to the wire shape", () => {
		const result = formToEndpointConfig(
			form({
				description: "  My project  ",
				models: "opus, sonnet ,, haiku",
				permissionMode: "plan",
				extraArgs: "--allowedTools\n Read \n\n--bare\n",
				maxConcurrency: "4",
				timeoutSeconds: "90",
			}),
		);
		expect(result).toEqual({
			ok: true,
			name: "myproject",
			config: {
				directory: "/srv/myproject",
				description: "My project",
				models: ["opus", "sonnet", "haiku"],
				permission_mode: "plan",
				extra_args: ["--allowedTools", "Read", "--bare"],
				max_concurrency: 4,
				timeout_ms: 90_000,
			},
		});
	});

	it("trims the name and directory", () => {
		const result = formToEndpointConfig(
			form({ name: "  proj  ", directory: "  /srv/p  " }),
		);
		expect(result).toEqual({
			ok: true,
			name: "proj",
			config: { directory: "/srv/p" },
		});
	});

	it("rejects a missing directory", () => {
		const result = formToEndpointConfig(form({ directory: "   " }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("Directory is required");
	});

	it("rejects a relative directory", () => {
		const result = formToEndpointConfig(form({ directory: "code/project" }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("absolute");
	});

	it("accepts a Windows drive path as absolute", () => {
		const result = formToEndpointConfig(form({ directory: "C:\\code\\p" }));
		expect(result.ok).toBe(true);
	});

	it("rejects names that are not a valid URL segment or are reserved", () => {
		for (const name of ["", "has space", "a/b", "v1", "api"]) {
			const result = formToEndpointConfig(form({ name }));
			expect(result.ok).toBe(false);
		}
	});

	it("rejects a concurrency outside 1 to the maximum, or not a whole number", () => {
		for (const maxConcurrency of [
			"0",
			String(MAX_CLAUDE_CODE_CONCURRENCY + 1),
			"1.5",
			"-1",
			"two",
		]) {
			const result = formToEndpointConfig(form({ maxConcurrency }));
			expect(result.ok).toBe(false);
		}
		const edge = formToEndpointConfig(
			form({ maxConcurrency: String(MAX_CLAUDE_CODE_CONCURRENCY) }),
		);
		expect(edge.ok).toBe(true);
	});

	it("rejects a timeout outside the server bounds, in seconds", () => {
		for (const timeoutSeconds of ["9", "3601", "0", "1.5", "soon"]) {
			const result = formToEndpointConfig(form({ timeoutSeconds }));
			expect(result.ok).toBe(false);
		}
		const low = formToEndpointConfig(form({ timeoutSeconds: "10" }));
		const high = formToEndpointConfig(form({ timeoutSeconds: "3600" }));
		expect(low.ok).toBe(true);
		expect(high.ok).toBe(true);
		if (low.ok) expect(low.config.timeout_ms).toBe(10_000);
		if (high.ok) expect(high.config.timeout_ms).toBe(3_600_000);
	});

	it("rejects more models or extra arguments than the server accepts", () => {
		const tooManyModels = Array.from(
			{ length: MAX_CLAUDE_CODE_MODELS + 1 },
			(_, i) => `m${i}`,
		).join(",");
		expect(formToEndpointConfig(form({ models: tooManyModels })).ok).toBe(
			false,
		);
		const tooManyArgs = Array.from(
			{ length: MAX_CLAUDE_CODE_EXTRA_ARGS + 1 },
			(_, i) => `--a${i}`,
		).join("\n");
		expect(formToEndpointConfig(form({ extraArgs: tooManyArgs })).ok).toBe(
			false,
		);
	});
});

describe("listingToForm", () => {
	it("shows server defaults as unset, so a round trip sends the same document", () => {
		const back = formToEndpointConfig(listingToForm(listing()));
		expect(back).toEqual({
			ok: true,
			name: "myproject",
			config: { directory: "/srv/myproject" },
		});
	});

	it("carries non-default values into the form and back", () => {
		const row = listing({
			description: "desc",
			models: ["opus"],
			permission_mode: "acceptEdits",
			extra_args: ["--bare"],
			max_concurrency: 3,
			timeout_ms: 120_000,
		});
		const state = listingToForm(row);
		expect(state.models).toBe("opus");
		expect(state.maxConcurrency).toBe("3");
		expect(state.timeoutSeconds).toBe("120");
		expect(formToEndpointConfig(state)).toEqual({
			ok: true,
			name: "myproject",
			config: {
				directory: "/srv/myproject",
				description: "desc",
				models: ["opus"],
				permission_mode: "acceptEdits",
				extra_args: ["--bare"],
				max_concurrency: 3,
				timeout_ms: 120_000,
			},
		});
	});
});

describe("endpointBaseUrl", () => {
	it("joins the origin and the short base path", () => {
		expect(endpointBaseUrl("http://host:8080", "/myproject/v1")).toBe(
			"http://host:8080/myproject/v1",
		);
	});
});

describe("EndpointForm", () => {
	function render(state: EndpointFormState, editing = false): string {
		return renderToStaticMarkup(
			<EndpointForm form={state} onChange={() => {}} editing={editing} />,
		);
	}

	it("warns when bypassPermissions is selected", () => {
		const html = render(form({ permissionMode: "bypassPermissions" }));
		expect(html).toContain(BYPASS_PERMISSIONS_WARNING);
	});

	it("shows no warning for another permission mode", () => {
		const html = render(form({ permissionMode: "plan" }));
		expect(html).not.toContain(BYPASS_PERMISSIONS_WARNING);
	});

	it("disables the name field while editing and not while adding", () => {
		const nameInput = (html: string) =>
			html.slice(
				html.indexOf('id="cce-name"') - 200,
				html.indexOf('id="cce-name"') + 200,
			);
		expect(nameInput(render(form(), true))).toContain('disabled=""');
		expect(nameInput(render(form(), false))).not.toContain('disabled=""');
	});
});

describe("EndpointRow", () => {
	function render(row: ClaudeCodeEndpointListing): string {
		return renderToStaticMarkup(
			<EndpointRow
				endpoint={row}
				origin="http://host:8080"
				onEdit={() => {}}
				onDelete={() => {}}
			/>,
		);
	}

	it("shows the full base URL, the directory, concurrency and timeout in seconds", () => {
		const html = render(listing());
		expect(html).toContain("http://host:8080/myproject/v1");
		expect(html).toContain("/srv/myproject");
		expect(html).toContain("600 s");
	});

	it("flags a directory that no longer exists", () => {
		expect(render(listing({ directory_exists: false }))).toContain(
			"directory missing",
		);
		expect(render(listing({ directory_exists: true }))).not.toContain(
			"directory missing",
		);
	});

	it("names the endpoint on each icon button for assistive technology", () => {
		const html = render(listing());
		expect(html).toContain('aria-label="Edit endpoint myproject"');
		expect(html).toContain('title="Edit endpoint myproject"');
		expect(html).toContain('aria-label="Delete endpoint myproject"');
		expect(html).toContain('title="Delete endpoint myproject"');
	});
});

// ---------------------------------------------------------------------------
// The live card against a stubbed fetch, for the skipped-entry delete control
// (SB23-3557). Every request is recorded and anything unexpected fails.
// ---------------------------------------------------------------------------

interface Call {
	method: string;
	url: string;
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

async function withCard(
	listed: {
		endpoints: ClaudeCodeEndpointListing[];
		errors: string[];
		invalid: { name: string; error: string }[];
	},
	run: (calls: Call[]) => Promise<void>,
): Promise<void> {
	const calls: Call[] = [];
	const unexpected: string[] = [];
	const original = globalThis.fetch;
	const stub = async (input: unknown, init?: RequestInit) => {
		const url = typeof input === "string" ? input : (input as Request).url;
		const method = (init?.method ?? "GET").toUpperCase();
		calls.push({ method, url });
		if (method === "GET" && url === "/api/claude-code-endpoints") {
			return new Response(JSON.stringify(listed), {
				headers: { "content-type": "application/json" },
			});
		}
		if (
			method === "DELETE" &&
			/^\/api\/claude-code-endpoints\/[^/]+$/.test(url)
		) {
			return new Response(null, { status: 204 });
		}
		unexpected.push(`${method} ${url}`);
		return new Response(JSON.stringify({ error: "unexpected" }), {
			status: 404,
		});
	};
	globalThis.fetch = stub as unknown as typeof fetch;

	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const mounted = await mount(
		<QueryClientProvider client={client}>
			<ClaudeCodeEndpointsCard />
		</QueryClientProvider>,
	);
	try {
		await waitFor(
			() =>
				!client.isFetching() &&
				calls.some((c) => c.url === "/api/claude-code-endpoints"),
			"the initial query",
		);
		await settle();
		await run(calls);
		expect(unexpected).toEqual([]);
	} finally {
		await mounted.unmount();
		client.clear();
		globalThis.fetch = original;
	}
}

describe("ClaudeCodeEndpointsCard skipped entries", () => {
	it("deletes a skipped entry from the card by its stored key", async () => {
		const escaped =
			"endpoint escaped: directory is outside claude_code_directory_roots";
		const hosts = "claude_code_allowed_hosts must be an array of host names";
		await withCard(
			{
				endpoints: [listing()],
				errors: [escaped, hosts],
				invalid: [{ name: "escaped", error: escaped }],
			},
			async (calls) => {
				const text = document.body.textContent ?? "";
				expect(text.split(escaped).length - 1).toBe(1);
				expect(text).toContain(hosts);
				const controls = Array.from(
					document.body.querySelectorAll(
						'button[aria-label^="Delete skipped endpoint"]',
					),
				).map((b) => b.getAttribute("aria-label"));
				expect(controls).toEqual(["Delete skipped endpoint escaped"]);

				const control = document.body.querySelector(
					'button[aria-label="Delete skipped endpoint escaped"]',
				);
				if (!control) throw new Error("expected the delete control");
				await click(control);
				expect(document.body.textContent ?? "").toContain(
					"Remove the skipped entry escaped from the config file?",
				);
				expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);

				const confirm = byText(document.body, "button", "Delete");
				expect(confirm.length).toBe(1);
				await click(confirm[0]);
				await waitFor(
					() => calls.some((c) => c.method === "DELETE"),
					"the DELETE",
				);
				expect(calls.filter((c) => c.method === "DELETE")).toEqual([
					{ method: "DELETE", url: "/api/claude-code-endpoints/escaped" },
				]);
			},
		);
	});
});

describe("unattachedErrors", () => {
	it("drops each entry's own line and shows a repeated line once", () => {
		const bad = 'claude_code_allowed_hosts entry "x:1" is not a host name';
		expect(
			unattachedErrors(
				["endpoint a: broken", bad, bad, "roots problem"],
				[{ name: "a", error: "endpoint a: broken" }],
			),
		).toEqual([bad, "roots problem"]);
	});
});
