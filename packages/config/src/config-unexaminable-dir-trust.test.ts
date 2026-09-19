import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logBus } from "@better-ccflare/logger";
import type { LogEvent } from "@better-ccflare/types";
import { Config } from "./index";

function captureLogs(fn: () => void): LogEvent[] {
	const captured: LogEvent[] = [];
	const handler = (event: LogEvent) => captured.push(event);
	logBus.on("log", handler);
	try {
		fn();
	} finally {
		logBus.off("log", handler);
	}
	return captured;
}

/**
 * The `statSync(dirname(entry))` catch inside entryIsTrusted() (SB23-2380).
 *
 * That catch had zero coverage. Mutating its `return "directory"` to
 * `"sticky-entry"` survived the whole config suite, so either reason could come
 * out of the branch and nothing noticed. The reason is not cosmetic: it selects
 * which refusal text the operator reads, and this family has now shipped four
 * messages asserting something the code never checked. The `directory` text
 * opens with "could not be examined", which is exactly what this branch read;
 * the `sticky-entry` text instead claims the walk lstatted an entry and found
 * its link count or uid wrong, and nothing here lstatted anything.
 *
 * Reaching the catch is the work, and the constraint is that loadConfig() calls
 * writeTarget() on two disjoint paths. A path whose own directory cannot be
 * statted cannot reach the walk at all: existsSync() is false for it, so the
 * constructor takes the mkdirSync branch and throws out of mkdirSync before any
 * trust check runs. The reachable shape is therefore a LATER hop. The configured
 * path is a symlink in a directory this process owns, so hop 0 is trusted, and
 * the link points into a directory that does not exist, so hop 1 stats a
 * dirname that throws. Same harness as the sticky landing-name test next door.
 *
 * Two error numbers, deliberately, because the branch is about examinability
 * rather than absence: ENOENT from a directory that was never created, and
 * ENOTDIR from a path component that is a regular file. Both are produced by
 * any uid, on darwin and on Linux, with no chmod and nothing restored between
 * constructing the Config and reading the message. EACCES is NOT used: it would
 * need a chmod on a grandparent, mode bits do not stop root, and restoring the
 * precondition afterwards is the artifact this family has already shipped once.
 * stickyFixture() is not used either; the catch needs a directory that cannot be
 * examined, which is the opposite of the precondition that helper manufactures.
 *
 * The ENOTDIR case needs TWO components below the regular file. statSync on a
 * regular file succeeds, so `<file>/config.json` has a dirname that stats fine;
 * it is `<file>/sub/config.json` whose dirname throws.
 */

const posixOnly = process.platform === "win32" ? describe.skip : describe;

posixOnly("a config hop whose directory cannot be examined", () => {
	it("names the directory branch, not the sticky one, when the directory is absent", () => {
		const home = mkdtempSync(
			join(tmpdir(), "better-ccflare-unexaminable-home-"),
		);
		const away = mkdtempSync(
			join(tmpdir(), "better-ccflare-unexaminable-away-"),
		);
		try {
			// Never created, so statSync(dirname(landing)) raises ENOENT and the
			// catch is the only way this hop can be decided.
			const landing = join(away, "never-created", "config.json");
			const link = join(home, "config.json");
			symlinkSync(landing, link);

			const logs = captureLogs(() => {
				new Config(link);
			});
			// Filtered, because saveConfig() logs a second ERROR of its own once the
			// walk refuses ("Config not saved"), and an unfiltered count would be
			// two whichever reason the branch returned.
			const refusals = logs.filter(
				(event) =>
					event.level === "ERROR" &&
					event.msg.includes("Refusing the config path"),
			);
			expect(refusals).toHaveLength(1);
			const msg = refusals[0].msg;

			// The hop named is the landing, not the configured link, which is what
			// proves the walk reached the second iteration and refused there.
			expect(msg).toContain(
				`${landing} sits in a directory that could not be examined`,
			);
			expect(msg).toContain(
				"Move the config somewhere only you can write, or replace the link with a regular file.",
			);
			expect(msg).toContain("regenerates local_control_secret");

			// The neighbouring branch's sentences. Nothing here lstatted the entry,
			// so a message claiming a link count or a uid was read would be stating
			// something the code did not check. This pair is what the surviving
			// mutation changed.
			expect(msg).not.toContain("sits in a sticky directory");
			expect(msg).not.toContain("has exactly one hard link");
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(away, { recursive: true, force: true });
		}
	});

	it("takes the same branch when a path component is a regular file", () => {
		const home = mkdtempSync(join(tmpdir(), "better-ccflare-notdir-home-"));
		const away = mkdtempSync(join(tmpdir(), "better-ccflare-notdir-away-"));
		try {
			const blocker = join(away, "regular-file");
			writeFileSync(blocker, "not a directory\n", { mode: 0o600 });
			// Two components below the regular file: dirname(landing) is
			// `<blocker>/sub`, and statting that raises ENOTDIR.
			const landing = join(blocker, "sub", "config.json");
			const link = join(home, "config.json");
			symlinkSync(landing, link);

			const logs = captureLogs(() => {
				new Config(link);
			});
			const refusals = logs.filter(
				(event) =>
					event.level === "ERROR" &&
					event.msg.includes("Refusing the config path"),
			);
			expect(refusals).toHaveLength(1);
			const msg = refusals[0].msg;

			expect(msg).toContain(
				`${landing} sits in a directory that could not be examined`,
			);
			expect(msg).not.toContain("sits in a sticky directory");
			expect(msg).not.toContain("has exactly one hard link");
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(away, { recursive: true, force: true });
		}
	});
});
