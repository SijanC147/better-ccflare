import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

/**
 * existsSync() returns true for a FIFO, and a FIFO is not a symlink, so the
 * trust check hands it back as a write target and readFileSync() then blocks
 * forever waiting for a writer that never arrives. Measured during the review
 * of PR #57: startup reached "about to construct" and never reached the next
 * line, and the process had to be killed.
 *
 * The FIFO cases run in a subprocess with a hard timeout, deliberately. A
 * blocking readFileSync() holds the thread, so an in-process assertion could
 * not fail: it would hang this suite the same way it hung startup, and bun's
 * own per-test timeout cannot interrupt a synchronous syscall.
 */
function mkfifo(path: string): void {
	const made = Bun.spawnSync({ cmd: ["mkfifo", path] });
	if (made.exitCode !== 0) {
		throw new Error(`mkfifo ${path} failed: ${made.stderr.toString()}`);
	}
}

/**
 * Construct a Config against `configPath` in a subprocess and return what it
 * printed. `body` runs with `config` in scope and must produce a string.
 */
function inSubprocess(
	dir: string,
	configPath: string,
	body: string,
): { killed: boolean; exitCode: number | null; stdout: string; stderr: string } {
	const script = join(dir, "construct.ts");
	writeFileSync(
		script,
		[
			`import { Config } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};`,
			`const config = new Config(process.argv[2]);`,
			`process.stdout.write(String(${body}));`,
		].join("\n"),
		"utf8",
	);
	const run = Bun.spawnSync({
		cmd: [process.execPath, "run", script, configPath],
		timeout: 15_000,
		stdout: "pipe",
		stderr: "pipe",
	});
	// The timeout kills the child with a signal, so a signal is the evidence of
	// a stall. exitCode is reported separately rather than folded in, so a
	// script that throws fails as a script that threw and not as a hang.
	return {
		killed: Boolean(run.signalCode),
		exitCode: run.exitCode,
		stdout: run.stdout.toString(),
		stderr: run.stderr.toString(),
	};
}

describe("a config path that is not a regular file", () => {
	it("does not hang the constructor on a FIFO", () => {
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-fifo-"));
		try {
			const configPath = join(dir, "config.json");
			mkfifo(configPath);
			const run = inSubprocess(dir, configPath, `config.getStrategy()`);
			expect(run.killed).toBe(false);
			expect(run.exitCode).toBe(0);
			// Defaults, because nothing was read.
			expect(run.stdout.length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not hang getLocalControlSecret() on a FIFO", () => {
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-fifo-"));
		try {
			const configPath = join(dir, "config.json");
			mkfifo(configPath);
			// The second reader. getLocalControlSecret() re-reads the file from
			// disk when this.data holds no secret, which is exactly the state a
			// refused load leaves behind, so an unguarded reader stalls here even
			// with the constructor guarded.
			const run = inSubprocess(
				dir,
				configPath,
				`config.getLocalControlSecret()`,
			);
			expect(run.killed).toBe(false);
			expect(run.exitCode).toBe(0);
			// A fresh secret rather than an attacker's or a stall.
			expect(run.stdout.trim().length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("treats a directory at the config path as no config", () => {
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-dirpath-"));
		try {
			// A directory does not block the way a FIFO does, so this one can run
			// in process. It shares the guard, and it is the shape an operator
			// actually hits by pointing BETTER_CCFLARE_CONFIG_PATH at a folder.
			const configPath = join(dir, "config.d");
			mkdirSync(configPath);
			const config = new Config(configPath);
			expect(typeof config.getStrategy()).toBe("string");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
