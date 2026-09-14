import { describe, expect, it } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateFromCcflare } from "./migrate-from-ccflare";

/**
 * migrateFromCcflare() runs from the database factory, so it executes on
 * database creation at startup. It used to reach copyFileSync() after an
 * existsSync() check, and existsSync() returns true for a FIFO while
 * copyFileSync() on one blocks forever waiting for a writer that never
 * arrives. No timeout, no log line, no error: the process never finishes
 * starting. The legacy path is environment-influenced through
 * XDG_CONFIG_HOME, and this repository's own suite creates FIFOs, so a
 * leftover one at the legacy location is not purely hypothetical.
 *
 * Same hazard as packages/config/src/config-non-regular-read.test.ts covers
 * for the config file, in a path PR #78 did not reach. The fixture discipline
 * below is that file's, as amended by PR #102, and is deliberate rather than
 * incidental: a blocking copyFileSync() holds the thread, so an in-process
 * assertion could not fail. It would hang this suite the way it hung startup,
 * and bun's per-test timeout cannot interrupt a synchronous syscall. The
 * subprocess is the reader under test, not a writer holding the FIFO open, so
 * it cannot be removed. What is removed is its ability to outlive the test:
 * every child is killed and confirmed dead from a later call, and every
 * fixture directory is removed on the failure path and on interruption as
 * well as on success.
 *
 * What the mutation measured, stated rather than assumed: with the guard
 * removed, these tests fail on macOS with ENOTSUP from copyfile() rather than
 * by hanging, because macOS copyFileSync() goes through fcopyfile() and
 * refuses a FIFO. The hang is the Linux behaviour, where the copy blocks in
 * open() on a FIFO with no writer, which is also what CI runs. So the
 * subprocess and its timer are not decoration for the platform this was
 * written on: they are the only thing that keeps the Linux failure mode from
 * wedging the suite. Both failure modes are caught here, because the
 * assertions are on the return value and the stderr line as well as on
 * `killed`.
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
	// lstatSync().isFIFO() and not existsSync(): existsSync() returning true for
	// a FIFO is the exact defect this file documents, so it is the one predicate
	// that must not appear here. This guards against inheriting a leaked FIFO
	// from an earlier run rather than blocking on one this run created.
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
 * Lay out a legacy tree under a fresh fixture directory and return the paths.
 * XDG_CONFIG_HOME points at the fixture, so getLegacyConfigDir() resolves to
 * <fixture>/ccflare and the migration target to <fixture>/better-ccflare.
 */
function makeLegacyTree(): {
	dir: string;
	legacyDbPath: string;
	newDbPath: string;
} {
	const dir = makeFixtureDir("better-ccflare-legacy-fifo-");
	const legacyDir = join(dir, "ccflare");
	mkdirSync(legacyDir, { recursive: true });
	return {
		dir,
		legacyDbPath: join(legacyDir, "ccflare.db"),
		newDbPath: join(dir, "better-ccflare", "better-ccflare.db"),
	};
}

/**
 * Run migrateFromCcflare() in a subprocess against `dir` as XDG_CONFIG_HOME.
 *
 * Async, and the kill is ours rather than Bun.spawnSync's `timeout` option: a
 * synchronous spawn runs no event loop, so a child blocked in open() on a FIFO
 * outlives the timeout it was given. The child here is killed on every path,
 * and its death is verified from a later call rather than assumed from having
 * sent the signal.
 */
async function migrateInSubprocess(
	dir: string,
	newDbPath: string,
): Promise<{
	killed: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
}> {
	const script = join(dir, "migrate.ts");
	writeFileSync(
		script,
		[
			`import { migrateFromCcflare } from ${JSON.stringify(join(import.meta.dir, "migrate-from-ccflare.ts"))};`,
			// A marker, because migrateFromCcflare() itself writes progress lines to
			// stdout, so the return value is not the whole of it.
			`process.stdout.write("RESULT=" + String(migrateFromCcflare()));`,
		].join("\n"),
		"utf8",
	);
	const proc = Bun.spawn({
		cmd: [process.execPath, "run", script],
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			XDG_CONFIG_HOME: dir,
			BETTER_CCFLARE_DB_PATH: newDbPath,
		},
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
		// Draining both pipes is what waits for a stalled child: a blocked copier
		// never closes stdout, so this resolves only once the timer kills it.
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
	// assertion failure from the body.
	if (survived) {
		throw new Error(
			`fixture subprocess ${pid} survived the test that created it`,
		);
	}
	return result;
}

describe("a legacy database path that is not a regular file", () => {
	it("does not hang the migration on a FIFO at the legacy database", async () => {
		const { dir, legacyDbPath, newDbPath } = makeLegacyTree();
		try {
			mkfifo(legacyDbPath);
			const run = await migrateInSubprocess(dir, newDbPath);
			expect(run.killed).toBe(false);
			expect(run.exitCode).toBe(0);
			// Not migrated, and said so rather than skipped silently.
			expect(run.stdout).toContain("RESULT=false");
			expect(run.stderr).toContain("is not a regular file");
			expect(existsSync(newDbPath)).toBe(false);
		} finally {
			removeFixtureDir(dir);
		}
	});

	it("does not hang on a FIFO at the legacy WAL sidecar", async () => {
		const { dir, legacyDbPath, newDbPath } = makeLegacyTree();
		try {
			// A real database beside it, so the migration gets past the main copy
			// and reaches the sidecar. The sidecar blocks after the database has
			// already been copied, which is a hang with a half-finished migration
			// behind it.
			writeFileSync(legacyDbPath, "legacy", "utf8");
			mkfifo(`${legacyDbPath}-wal`);
			const run = await migrateInSubprocess(dir, newDbPath);
			expect(run.killed).toBe(false);
			expect(run.exitCode).toBe(0);
			expect(run.stdout).toContain("RESULT=true");
			expect(existsSync(newDbPath)).toBe(true);
			expect(existsSync(`${newDbPath}-wal`)).toBe(false);
		} finally {
			removeFixtureDir(dir);
		}
	});

	it("does not hang on a FIFO at the legacy SHM sidecar", async () => {
		const { dir, legacyDbPath, newDbPath } = makeLegacyTree();
		try {
			writeFileSync(legacyDbPath, "legacy", "utf8");
			mkfifo(`${legacyDbPath}-shm`);
			const run = await migrateInSubprocess(dir, newDbPath);
			expect(run.killed).toBe(false);
			expect(run.exitCode).toBe(0);
			expect(run.stdout).toContain("RESULT=true");
			expect(existsSync(newDbPath)).toBe(true);
			expect(existsSync(`${newDbPath}-shm`)).toBe(false);
		} finally {
			removeFixtureDir(dir);
		}
	});

	it("treats a directory at the legacy database path as no legacy database", () => {
		const { dir, legacyDbPath, newDbPath } = makeLegacyTree();
		const previousXdg = process.env.XDG_CONFIG_HOME;
		const previousDbPath = process.env.BETTER_CCFLARE_DB_PATH;
		try {
			// A directory does not block the way a FIFO does, so this one runs in
			// process. It shares the guard, and it is the shape an operator hits by
			// pointing XDG_CONFIG_HOME at a tree that holds a folder there.
			mkdirSync(legacyDbPath);
			process.env.XDG_CONFIG_HOME = dir;
			process.env.BETTER_CCFLARE_DB_PATH = newDbPath;
			expect(migrateFromCcflare()).toBe(false);
			expect(existsSync(newDbPath)).toBe(false);
		} finally {
			if (previousXdg === undefined) {
				delete process.env.XDG_CONFIG_HOME;
			} else {
				process.env.XDG_CONFIG_HOME = previousXdg;
			}
			if (previousDbPath === undefined) {
				delete process.env.BETTER_CCFLARE_DB_PATH;
			} else {
				process.env.BETTER_CCFLARE_DB_PATH = previousDbPath;
			}
			removeFixtureDir(dir);
		}
	});
});
