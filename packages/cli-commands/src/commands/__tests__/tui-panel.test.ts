import { describe, expect, it } from "bun:test";
import { parseTuiArgs, runTui, type TuiDeps } from "../tui";
import {
	buildPanelCommand,
	detectKittyPanelHost,
	launchInPanel,
	type PanelDeps,
	panelSocketPath,
	resolvePanelEdge,
	resolvePanelMode,
	resolveSelfCommand,
} from "../tui-panel";

const onPath = (found: boolean) => (command: string) =>
	found && command === "kitten" ? "/opt/homebrew/bin/kitten" : null;

describe("detectKittyPanelHost", () => {
	it("passes with KITTY_WINDOW_ID, kitten on PATH and a TTY", () => {
		expect(
			detectKittyPanelHost({ KITTY_WINDOW_ID: "3" }, onPath(true), true),
		).toEqual({ ok: true, kitten: "/opt/homebrew/bin/kitten" });
	});

	it("fails on TERM=xterm-kitty alone, which kitten ssh carries to remote hosts", () => {
		const result = detectKittyPanelHost(
			{ TERM: "xterm-kitty", KITTY_LISTEN_ON: "unix:/tmp/kty-1" },
			onPath(true),
			true,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("KITTY_WINDOW_ID");
	});

	it("fails with KITTY_WINDOW_ID but no kitten on PATH", () => {
		expect(
			detectKittyPanelHost({ KITTY_WINDOW_ID: "3" }, onPath(false), true),
		).toEqual({ ok: false, reason: "kitten is not on PATH" });
	});

	it("fails when stdout is not a terminal", () => {
		expect(
			detectKittyPanelHost({ KITTY_WINDOW_ID: "3" }, onPath(true), false),
		).toEqual({ ok: false, reason: "stdout is not a terminal" });
	});
});

describe("panel options", () => {
	it("lets the flag win over BETTER_CCFLARE_TUI_PANEL", () => {
		expect(resolvePanelMode(null, {})).toBe("auto");
		expect(resolvePanelMode(null, { BETTER_CCFLARE_TUI_PANEL: "0" })).toBe(
			"off",
		);
		expect(resolvePanelMode(null, { BETTER_CCFLARE_TUI_PANEL: "1" })).toBe(
			"auto",
		);
		expect(resolvePanelMode("force", { BETTER_CCFLARE_TUI_PANEL: "0" })).toBe(
			"force",
		);
		expect(resolvePanelMode("off", {})).toBe("off");
	});

	it("lets --panel-edge win over BETTER_CCFLARE_TUI_PANEL_EDGE, default right", () => {
		expect(resolvePanelEdge(null, {})).toEqual({ ok: true, edge: "right" });
		expect(
			resolvePanelEdge(null, { BETTER_CCFLARE_TUI_PANEL_EDGE: "left" }),
		).toEqual({ ok: true, edge: "left" });
		expect(
			resolvePanelEdge("top", { BETTER_CCFLARE_TUI_PANEL_EDGE: "left" }),
		).toEqual({ ok: true, edge: "top" });
		expect(resolvePanelEdge("center", {}).ok).toBe(false);
	});

	it("parses --panel, --no-panel and --panel-edge, refusing contradictions", () => {
		const parsed = parseTuiArgs(["--panel", "--panel-edge", "left"]);
		expect(parsed.ok && parsed.options.panel).toBe("force");
		expect(parsed.ok && parsed.options.panelEdge).toBe("left");
		const off = parseTuiArgs(["--no-panel"]);
		expect(off.ok && off.options.panel).toBe("off");
		expect(parseTuiArgs(["--panel", "--no-panel"]).ok).toBe(false);
		expect(parseTuiArgs(["--panel", "--once"]).ok).toBe(false);
	});
});

describe("resolveSelfCommand", () => {
	it("re-runs the compiled binary alone", () => {
		expect(
			resolveSelfCommand(
				["bun", "/$bunfs/root/better-ccflare", "tui"],
				"/opt/homebrew/bin/better-ccflare",
			),
		).toEqual(["/opt/homebrew/bin/better-ccflare"]);
	});

	it("re-runs bun with the script in development", () => {
		expect(
			resolveSelfCommand(
				["/opt/homebrew/bin/bun", "/repo/apps/cli/src/main.ts", "tui"],
				"/opt/homebrew/bin/bun",
			),
		).toEqual(["/opt/homebrew/bin/bun", "/repo/apps/cli/src/main.ts"]);
	});
});

describe("buildPanelCommand", () => {
	const command = buildPanelCommand({
		kitten: "/opt/homebrew/bin/kitten",
		edge: "right",
		socket: "/tmp/better-ccflare-tui-501.sock",
		self: ["/opt/homebrew/bin/better-ccflare"],
		dashboard: "overview",
		baseUrl: "http://127.0.0.1:8080",
		intervalSeconds: 5,
	});

	it("is exactly the panel invocation the issue specifies", () => {
		expect(command).toEqual([
			"/opt/homebrew/bin/kitten",
			"panel",
			"--edge=right",
			"--columns=60",
			"--layer=top",
			"--single-instance",
			"--instance-group",
			"better-ccflare-tui",
			"-o",
			"allow_remote_control=socket-only",
			"--listen-on=unix:/tmp/better-ccflare-tui-501.sock",
			"/opt/homebrew/bin/better-ccflare",
			"tui",
			"overview",
			"--no-panel",
			"--url",
			"http://127.0.0.1:8080",
			"--interval",
			"5",
		]);
	});

	it("never detaches and never names the parent's socket", () => {
		expect(command).not.toContain("--detach");
		expect(command.some((a) => a.includes("kty-"))).toBe(false);
	});

	it("sizes by lines on a top or bottom edge", () => {
		const top = buildPanelCommand({
			kitten: "kitten",
			edge: "top",
			socket: "/tmp/s.sock",
			self: ["b"],
			dashboard: "overview",
			baseUrl: "http://127.0.0.1:8080",
			intervalSeconds: 5,
		});
		expect(top).toContain("--lines=20");
		expect(top.some((a) => a.startsWith("--columns"))).toBe(false);
	});
});

describe("panelSocketPath", () => {
	it("is per user and stays under the unix socket path limit", () => {
		expect(panelSocketPath("/var/folders/ab/T", 501)).toBe(
			"/var/folders/ab/T/better-ccflare-tui-501.sock",
		);
		expect(panelSocketPath(`/${"x".repeat(120)}`, 501)).toBe(
			"/tmp/better-ccflare-tui-501.sock",
		);
	});
});

function fakePanel(overrides: Partial<PanelDeps> = {}) {
	const spawned: Array<{
		argv: string[];
		env: Record<string, string | undefined>;
	}> = [];
	let socketUp = false;
	const deps: PanelDeps = {
		which: onPath(true),
		spawnDetached(argv, env) {
			spawned.push({ argv, env });
			socketUp = true;
			return { exited: () => null, error: () => null };
		},
		socketExists: () => socketUp,
		probeSocket: async () => true,
		removeStaleSocket: () => {
			socketUp = false;
		},
		sleep: async () => {},
		tmpdir: "/var/folders/ab/T",
		uid: 501,
		argv: ["bun", "/$bunfs/root/better-ccflare"],
		execPath: "/opt/homebrew/bin/better-ccflare",
		...overrides,
	};
	return {
		deps,
		spawned,
		setSocket: (up: boolean) => {
			socketUp = up;
		},
	};
}

const launch = {
	kitten: "/opt/homebrew/bin/kitten",
	edge: "right" as const,
	dashboard: "overview",
	baseUrl: "http://127.0.0.1:8080",
	intervalSeconds: 5,
};

describe("launchInPanel", () => {
	it("starts the panel with --no-panel and the key in the environment only", async () => {
		const f = fakePanel();
		const result = await launchInPanel(launch, "k-secret", {}, f.deps);
		expect(result).toEqual({
			ok: true,
			socket: "/var/folders/ab/T/better-ccflare-tui-501.sock",
			alreadyRunning: false,
		});
		expect(f.spawned).toHaveLength(1);
		expect(f.spawned[0].argv).toContain("--no-panel");
		expect(f.spawned[0].argv.join(" ")).not.toContain("k-secret");
		expect(f.spawned[0].env.BETTER_CCFLARE_API_KEY).toBe("k-secret");
		expect(f.spawned[0].env.BETTER_CCFLARE_TUI_PANEL_SOCKET).toBe(
			"/var/folders/ab/T/better-ccflare-tui-501.sock",
		);
	});

	it("does not open a second panel when one already answers on the socket", async () => {
		const f = fakePanel();
		f.setSocket(true);
		const result = await launchInPanel(launch, null, {}, f.deps);
		expect(result).toEqual({
			ok: true,
			socket: "/var/folders/ab/T/better-ccflare-tui-501.sock",
			alreadyRunning: true,
		});
		expect(f.spawned).toHaveLength(0);
	});

	it("replaces a stale socket nobody answers on", async () => {
		const f = fakePanel({ probeSocket: async () => false });
		f.setSocket(true);
		const result = await launchInPanel(launch, null, {}, f.deps);
		expect(result.ok && result.alreadyRunning).toBe(false);
		expect(f.spawned).toHaveLength(1);
	});

	it("reports a panel that never opens its socket", async () => {
		const f = fakePanel({
			spawnDetached: () => ({ exited: () => null, error: () => null }),
		});
		const result = await launchInPanel(launch, null, {}, f.deps, 300);
		expect(result.ok).toBe(false);
	});
});

describe("runTui panel mode", () => {
	function deps(env: Record<string, string | undefined>, panel: PanelDeps) {
		const out: string[] = [];
		const err: string[] = [];
		let liveStarted = 0;
		const d: TuiDeps = {
			env,
			stdout: {
				isTTY: true,
				columns: 80,
				write: (t: string, cb?: () => void) => {
					out.push(t);
					cb?.();
					return true;
				},
			},
			stderr: { write: (t: string) => err.push(t) },
			now: () => Date.parse("2026-10-01T08:00:00Z"),
			fetch: async () => new Response("[]", { status: 200 }),
			panel,
			onLiveStart: () => {
				liveStarted++;
			},
		};
		return { d, out, err, liveStarted: () => liveStarted };
	}
	const opts = (args: string[]) => {
		const r = parseTuiArgs(args);
		if (!r.ok) throw new Error(r.message);
		return r.options;
	};

	it("opens a panel in a kitty window and prints how to close it", async () => {
		const f = fakePanel();
		const { d, out } = deps({ KITTY_WINDOW_ID: "3" }, f.deps);
		expect(await runTui(opts([]), d)).toBe(0);
		expect(out.join("")).toBe(
			"Opened the overview in a kitty panel.\n" +
				"Socket: unix:/var/folders/ab/T/better-ccflare-tui-501.sock\n" +
				"Close it: kitten @ --to unix:/var/folders/ab/T/better-ccflare-tui-501.sock close-window\n",
		);
	});

	it("stays in the window with --no-panel or BETTER_CCFLARE_TUI_PANEL=0", async () => {
		for (const [env, args] of [
			[{ KITTY_WINDOW_ID: "3" }, ["--no-panel", "--once"]],
			[{ KITTY_WINDOW_ID: "3", BETTER_CCFLARE_TUI_PANEL: "0" }, ["--once"]],
		] as const) {
			const f = fakePanel();
			const { d } = deps({ ...env }, f.deps);
			expect(await runTui(opts([...args]), d)).toBe(0);
			expect(f.spawned).toHaveLength(0);
		}
	});

	it("never spawns a panel without KITTY_WINDOW_ID", async () => {
		const f = fakePanel();
		const { d } = deps({ TERM: "xterm-kitty" }, f.deps);
		expect(await runTui(opts(["--once"]), d)).toBe(0);
		expect(f.spawned).toHaveLength(0);
	});

	it("--panel outside kitty exits 1 naming the missing signal", async () => {
		const f = fakePanel();
		const { d, err } = deps({ TERM: "xterm-256color" }, f.deps);
		expect(await runTui(opts(["--panel"]), d)).toBe(1);
		expect(err.join("")).toContain("❌ --panel: KITTY_WINDOW_ID is not set");
		expect(f.spawned).toHaveLength(0);
	});
});
