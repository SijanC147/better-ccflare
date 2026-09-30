import { describe, expect, it } from "bun:test";
import type { ClaudeCodeEndpointListing } from "@better-ccflare/types";
import {
	DEFAULT_CLAUDE_CODE_MODELS,
	MAX_CLAUDE_CODE_CONCURRENCY,
	MAX_CLAUDE_CODE_EXTRA_ARGS,
	MAX_CLAUDE_CODE_MODELS,
} from "@better-ccflare/types";
import { renderToStaticMarkup } from "react-dom/server";
import {
	BYPASS_PERMISSIONS_WARNING,
	EndpointForm,
	type EndpointFormState,
	EndpointRow,
	emptyEndpointForm,
	endpointBaseUrl,
	formToEndpointConfig,
	listingToForm,
} from "../ClaudeCodeEndpointsCard";

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
