/**
 * A stand-in for the `claude` CLI: a bun script written into a temp dir that
 * prints canned stream-json and records how it was invoked. The real binary is
 * never run from tests.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type FakeMode =
	| "ok"
	| "hang"
	| "hang-after-text"
	| "ignore-term"
	| "exit3"
	| "is-error"
	/** `--resume` fails at once with no output; a fresh session is "ok". */
	| "resume-missing"
	/** `--resume` fails after a tool call; a fresh session is "ok". */
	| "resume-fail-after-tool"
	/** A tool call, then `delayMs` of silence, then the answer. */
	| "slow-start"
	/** A subagent's text (parent_tool_use_id set) before the answer. */
	| "subagent";

export interface FakeInvocation {
	argv: string[];
	cwd: string;
	stdin: string;
	pid: number;
	/** Pid of a `sleep` grandchild, present in the hang modes. */
	childPid: number | null;
	/** What `--append-system-prompt-file` named, read at invocation time. */
	systemPromptFile: {
		path: string;
		content: string;
		mode: number;
		dirMode: number;
	} | null;
}

export interface FakeClaude {
	dir: string;
	bin: string;
	/** A directory to use as the endpoint's project directory. */
	projectDir: string;
	invocations(): FakeInvocation[];
	cleanup(): void;
}

export function makeFakeClaude(options: {
	mode: FakeMode;
	textDeltas?: string[];
	resultText?: string;
	delayMs?: number;
}): FakeClaude {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
	if (!dir || dir === os.tmpdir()) throw new Error("bad fixture directory");
	const projectDir = path.join(dir, "project");
	fs.mkdirSync(projectDir);
	const log = path.join(dir, "invocations.jsonl");
	const bin = path.join(dir, "claude");
	const config = {
		mode: options.mode,
		textDeltas: options.textDeltas ?? ["Hello", " world"],
		resultText:
			options.resultText ??
			(options.textDeltas ?? ["Hello", " world"]).join(""),
		log,
		delayMs: options.delayMs ?? 0,
	};
	const script = `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const cfg = ${JSON.stringify(config)};
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const sessionId = flag("--resume") ?? flag("--session-id") ?? "no-session";
const stdin = await Bun.stdin.text();
const promptPath = flag("--append-system-prompt-file");
let systemPromptFile = null;
if (promptPath) {
  const path = require("node:path");
  systemPromptFile = {
    path: promptPath,
    content: fs.readFileSync(promptPath, "utf8"),
    mode: fs.statSync(promptPath).mode & 0o777,
    dirMode: fs.statSync(path.dirname(promptPath)).mode & 0o777,
  };
}
const resuming = argv.includes("--resume");
let childPid = null;
if (cfg.mode === "hang" || cfg.mode === "hang-after-text" || cfg.mode === "ignore-term") {
  childPid = spawn("sleep", ["300"], { stdio: "ignore" }).pid;
}
fs.appendFileSync(cfg.log, JSON.stringify({ argv, cwd: process.cwd(), stdin, pid: process.pid, childPid, systemPromptFile }) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (cfg.mode === "resume-missing" && resuming) { process.stderr.write("No conversation found with session ID: " + sessionId + "\\n"); process.exit(1); }
out({ type: "system", subtype: "init", session_id: sessionId });
const toolCall = () => out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Bash", input: {} } } });
if (cfg.mode === "resume-fail-after-tool" && resuming) { toolCall(); process.exit(1); }
if (cfg.mode === "slow-start") { toolCall(); await new Promise((r) => setTimeout(r, cfg.delayMs)); }
if (cfg.mode === "subagent") {
  out({ type: "stream_event", parent_tool_use_id: "toolu_sub", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
  out({ type: "stream_event", parent_tool_use_id: "toolu_sub", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "SUBAGENT-SECRET" } } });
  out({ type: "assistant", parent_tool_use_id: "toolu_sub", message: { content: [{ type: "text", text: "SUBAGENT-SECRET" }] } });
}
if (cfg.mode === "exit3") { process.stderr.write("boom: something broke\\n"); process.exit(3); }
if (cfg.mode === "ignore-term") { process.on("SIGTERM", () => {}); }
if (cfg.mode === "hang" || cfg.mode === "ignore-term") { setInterval(() => {}, 1000); await new Promise(() => {}); }
out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
for (const t of cfg.textDeltas) {
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } } });
}
if (cfg.mode === "hang-after-text") { setInterval(() => {}, 1000); await new Promise(() => {}); }
out({ type: "assistant", message: { content: [{ type: "text", text: cfg.textDeltas.join("") }] } });
out({
  type: "result",
  subtype: cfg.mode === "is-error" ? "error_during_execution" : "success",
  is_error: cfg.mode === "is-error",
  result: cfg.mode === "is-error" ? "model overloaded" : cfg.resultText,
  session_id: sessionId,
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
});
process.exit(cfg.mode === "is-error" ? 1 : 0);
`;
	fs.writeFileSync(bin, script, { mode: 0o755 });
	return {
		dir,
		bin,
		projectDir,
		invocations() {
			if (!fs.existsSync(log)) return [];
			return fs
				.readFileSync(log, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as FakeInvocation);
		},
		cleanup() {
			// `dir` came from mkdtemp above, so removing it cannot touch anything
			// else. `trash` is macOS-only; the CI runner is Linux.
			if (Bun.which("trash")) Bun.spawnSync(["trash", dir]);
			else fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	// A zombie still answers signal 0; ps shows its state.
	const ps = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
	const stat = ps.stdout.toString().trim();
	return stat !== "" && !stat.startsWith("Z");
}

export async function waitFor(
	predicate: () => boolean,
	timeoutMs = 5000,
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 25));
	}
}
