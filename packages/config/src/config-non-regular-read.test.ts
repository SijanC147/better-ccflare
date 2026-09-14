import { describe, expect, it } from "bun:test";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
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
 *
 * The subprocess is the reader under test, not a writer keeping the FIFO open,
 * so it cannot be removed: a FIFO with no writer is what makes the reader
 * block, and the reader is the thing being asserted about. What can be removed
 * is its ability to outlive the test. A child of this suite spent five hours
 * forty-four minutes at ppid 1 blocked opening one of these FIFOs, and its
 * fixture directory was still on disk. Three things below exist for that:
 * every child is killed and confirmed dead before its test returns, every
 * fixture directory is removed on the failure path as well as the success
 * path, and both also happen when the suite is interrupted rather than
 * finishing.
 */

/**
 * Children and directories this file has created and not yet cleaned up. A
 * `finally` covers a failing assertion and a throw; it does not cover SIGINT
 * from a terminal or SIGTERM from a `timeout` wrapper, which is how the
 * five-hour orphan happened. These two sets plus the handlers below cover
 * that case.
 */
const livePids = new Set<number>();
const liveDirs = new Set<string>();
let handlersInstalled = false;

function reapAll(): void {
	for (const pid of livePids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone. Nothing to do.
		}
	}
	livePids.clear();
	for (const dir of liveDirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Best effort: an exit handler that throws loses the rest of the list.
		}
	}
	liveDirs.clear();
}

function installCleanupHandlers(): void {
	if (handlersInstalled) {
		return;
	}
	handlersInstalled = true;
	process.on("exit", reapAll);
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.on(signal, () => {
			reapAll();
			process.exit(1);
		});
	}
}

function makeFixtureDir(prefix: string): string {
	installCleanupHandlers();
	const dir = mkdtempSync(join(tmpdir(), prefix));
	liveDirs.add(dir);
	return dir;
}

function removeFixtureDir(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
	liveDirs.delete(dir);
}

function mkfifo(path: string): void {
	// Guard against inheriting a leaked FIFO from an earlier run rather than
	// blocking on one this run created. lstatSync().isFIFO() and not
	// existsSync(): existsSync() returning true for a FIFO is the exact defect
	// this file documents, so it is the one predicate that must not appear here.
	const existing = lstatSync(path, { throwIfNoEntry: false });
	if (existing?.isFIFO()) {
		unlinkSync(path);
	}
	const made = Bun.spawnSync({ cmd: ["mkfifo", path] });
	if (made.exitCode !== 0) {
		throw new Error(`mkfifo ${path} failed: ${made.stderr.toString()}`);
	}
}

/**
 * True when no process holds `pid`, treating a zombie as gone: the child has
 * stopped running and is waiting to be reaped, which is what the caller cares
 * about. `ps` rather than `process.kill(pid, 0)` because kill(0) succeeds
 * against a zombie and so cannot tell the two apart.
 */
function processIsGone(pid: number): boolean {
	const probe = Bun.spawnSync({
		cmd: ["ps", "-o", "stat=", "-p", String(pid)],
	});
	const state = probe.stdout.toString().trim();
	return state.length === 0 || state.startsWith("Z");
}

/**
 * Construct a Config against `configPath` in a subprocess and return what it
 * printed. `body` runs with `config` in scope and must produce a string.
 *
 * Async, and the kill is ours rather than Bun.spawnSync's `timeout` option: a
 * synchronous spawn cannot run a timer, so a child blocked in open() on a FIFO
 * outlives the timeout it was given. The child here is killed on every path,
 * and the kill is verified from a later call rather than assumed from having
 * sent the signal.
 */
async function inSubprocess(
	dir: string,
	configPath: string,
	body: string,
): Promise<{
	killed: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
}> {
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
	const proc = Bun.spawn({
		cmd: [process.execPath, "run", script, configPath],
		stdout: "pipe",
		stderr: "pipe",
	});
	const pid = proc.pid;
	livePids.add(pid);
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGKILL");
	}, 15_000);
	let survived = false;
	let result: {
		killed: boolean;
		exitCode: number | null;
		stdout: string;
		stderr: string;
	};
	try {
		// Draining both pipes is what waits for a stalled child: a blocked reader
		// never closes stdout, so this resolves only once the timer above kills it.
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		// A signal is the evidence of a stall. exitCode is reported separately
		// rather than folded in, so a script that throws fails as a script that
		// threw and not as a hang.
		result = {
			killed: timedOut || Boolean(proc.signalCode),
			exitCode: proc.exitCode,
			stdout,
			stderr,
		};
	} finally {
		clearTimeout(timer);
		proc.kill("SIGKILL");
		await proc.exited;
		livePids.delete(pid);
		survived = !processIsGone(pid);
	}
	// Outside the `finally` on purpose: a throw in there would swallow a real
	// assertion failure from the body. The kill itself already happened above,
	// so this only reports, and it reports from a call made after the kill
	// rather than from having sent the signal.
	if (survived) {
		throw new Error(
			`fixture subprocess ${pid} survived the test that created it`,
		);
	}
	return result;
}

describe("a config path that is not a regular file", () => {
	it("does not hang the constructor on a FIFO", async () => {
		const dir = makeFixtureDir("better-ccflare-fifo-");
		try {
			const configPath = join(dir, "config.json");
			mkfifo(configPath);
			const run = await inSubprocess(dir, configPath, `config.getStrategy()`);
			expect(run.killed).toBe(false);
			expect(run.exitCode).toBe(0);
			// Defaults, because nothing was read.
			expect(run.stdout.length).toBeGreaterThan(0);
		} finally {
			removeFixtureDir(dir);
		}
	});

	it("does not hang getLocalControlSecret() on a FIFO", async () => {
		const dir = makeFixtureDir("better-ccflare-fifo-");
		try {
			const configPath = join(dir, "config.json");
			mkfifo(configPath);
			// The second reader. getLocalControlSecret() re-reads the file from
			// disk when this.data holds no secret, which is exactly the state a
			// refused load leaves behind, so an unguarded reader stalls here even
			// with the constructor guarded.
			const run = await inSubprocess(
				dir,
				configPath,
				`config.getLocalControlSecret()`,
			);
			expect(run.killed).toBe(false);
			expect(run.exitCode).toBe(0);
			// A fresh secret rather than an attacker's or a stall.
			expect(run.stdout.trim().length).toBeGreaterThan(0);
		} finally {
			removeFixtureDir(dir);
		}
	});

	it("treats a directory at the config path as no config", () => {
		const dir = makeFixtureDir("better-ccflare-dirpath-");
		try {
			// A directory does not block the way a FIFO does, so this one can run
			// in process. It shares the guard, and it is the shape an operator
			// actually hits by pointing BETTER_CCFLARE_CONFIG_PATH at a folder.
			const configPath = join(dir, "config.d");
			mkdirSync(configPath);
			const config = new Config(configPath);
			expect(typeof config.getStrategy()).toBe("string");
		} finally {
			removeFixtureDir(dir);
		}
	});
});
