import { describe, expect, it } from "bun:test";
import {
	parseTuiArgs,
	resolveApiKey,
	resolveBaseUrl,
	runTui,
	type TuiDeps,
	type TuiOptions,
} from "../tui";

function ok(args: string[]): TuiOptions {
	const result = parseTuiArgs(args);
	if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
	return result.options;
}

function err(args: string[]): string {
	const result = parseTuiArgs(args);
	if (result.ok) throw new Error(`expected an error for ${args.join(" ")}`);
	return result.message;
}

describe("parseTuiArgs", () => {
	it("defaults to the overview dashboard, so `tui` and `tui overview` agree", () => {
		expect(ok([])).toEqual(ok(["overview"]));
		expect(ok([]).dashboard).toBe("overview");
	});

	it("exits on an unknown dashboard, naming overview as the only one", () => {
		expect(err(["nosuch"])).toBe(
			"Unknown dashboard: nosuch. Known dashboards: overview",
		);
	});

	it("reads --port as the server to query", () => {
		expect(ok(["overview", "--port", "8081"]).port).toBe(8081);
		expect(ok(["--port=8081"]).port).toBe(8081);
		expect(err(["--port", "0"])).toContain("Invalid port");
		expect(err(["--port"])).toBe("--port requires a value");
	});

	it("reads --url, --api-key, --interval and --once", () => {
		const options = ok([
			"--url",
			"https://ccflare.example:9443/",
			"--api-key",
			"k-1",
			"--interval",
			"2",
			"--once",
		]);
		expect(options.url).toBe("https://ccflare.example:9443");
		expect(options.apiKey).toBe("k-1");
		expect(options.intervalSeconds).toBe(2);
		expect(options.once).toBe(true);
		expect(err(["--url", "ftp://x"])).toContain("Invalid --url");
		expect(err(["--interval", "0"])).toContain("Invalid --interval");
	});

	it("refuses unknown flags and stray positionals instead of ignoring them", () => {
		expect(err(["--serve"])).toBe(
			"Unknown option for tui: --serve. See better-ccflare tui --help",
		);
		expect(err(["overview", "extra"])).toBe("Unexpected argument: extra");
	});
});

describe("resolveBaseUrl and resolveApiKey", () => {
	it("prefers --url, then --port, then PORT, then 8080", () => {
		expect(resolveBaseUrl({ url: "http://h:1", port: 2 }, { PORT: "3" })).toBe(
			"http://h:1",
		);
		expect(resolveBaseUrl({ url: null, port: 2 }, { PORT: "3" })).toBe(
			"http://127.0.0.1:2",
		);
		expect(resolveBaseUrl({ url: null, port: null }, { PORT: "3" })).toBe(
			"http://127.0.0.1:3",
		);
		expect(resolveBaseUrl({ url: null, port: null }, {})).toBe(
			"http://127.0.0.1:8080",
		);
		expect(resolveBaseUrl({ url: null, port: null }, { PORT: "x" })).toBe(
			"http://127.0.0.1:8080",
		);
	});

	it("prefers --api-key over BETTER_CCFLARE_API_KEY and treats empty as none", () => {
		expect(
			resolveApiKey({ apiKey: "a" }, { BETTER_CCFLARE_API_KEY: "b" }),
		).toBe("a");
		expect(
			resolveApiKey({ apiKey: null }, { BETTER_CCFLARE_API_KEY: "b" }),
		).toBe("b");
		expect(
			resolveApiKey({ apiKey: null }, { BETTER_CCFLARE_API_KEY: "" }),
		).toBeNull();
	});
});

function capture(isTTY: boolean) {
	const out: string[] = [];
	const errOut: string[] = [];
	const deps: TuiDeps = {
		env: {},
		stdout: { write: (t: string) => out.push(t), isTTY, columns: 80 },
		stderr: { write: (t: string) => errOut.push(t) },
		now: () => Date.parse("2026-10-01T08:00:00Z"),
	};
	return { out, errOut, deps };
}

describe("runTui one-shot", () => {
	it("prints the table once with no escape bytes when piped", async () => {
		const { out, deps } = capture(false);
		deps.fetch = async () => new Response("[]", { status: 200 });
		const code = await runTui(ok(["overview"]), deps);
		expect(code).toBe(0);
		expect(out.join("")).toContain("better-ccflare overview");
		expect(out.join("").includes("\x1b")).toBe(false);
	});

	it("exits 1 naming the URL when no server answers", async () => {
		const { out, errOut, deps } = capture(false);
		deps.env = { PORT: "65531" };
		deps.fetch = async () => {
			throw new Error("Unable to connect");
		};
		const code = await runTui(ok([]), deps);
		expect(code).toBe(1);
		expect(errOut.join("")).toBe(
			"❌ server not running on http://127.0.0.1:65531\n",
		);
		expect(out).toEqual([]);
	});
});
