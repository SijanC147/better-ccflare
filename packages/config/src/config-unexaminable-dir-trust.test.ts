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
 * The whole refusal text the `directory` reason selects, rebuilt here rather
 * than sampled with substrings.
 *
 * Written as an equality on purpose. The first version of this file asserted
 * three substrings and denied two, and review killed it with a mutation that
 * ADDED a sentence: "The entry at that path was read and found to be owned by
 * another local user." Every substring assertion still passed, both denials
 * still passed, and the message now claimed the walk had lstatted an entry in
 * the one branch that never lstats anything, which is the exact defect this
 * file exists to catch. A blocklist of two strings cannot catch a sentence
 * nobody thought to list.
 *
 * Duplicating the production text is the cost, and it buys a test that cannot
 * express that mistake: any edit to the `directory` message has to be made here
 * too, deliberately, and an addition fails as loudly as a deletion.
 */
function expectedDirectoryRefusal(configPath: string, hop: string): string {
	return (
		`Refusing the config path ${configPath}: ${hop} sits in a directory that ` +
		`could not be examined, or is owned by another user, or is writable by other ` +
		`local users without the sticky bit, so ` +
		`another local user can plant or replace what is at ${hop} and it cannot be ` +
		`trusted with secrets. Move the config somewhere only you can write, or replace ` +
		`the link with a regular file. ` +
		`If this line appears at startup then the config was not read and this process ` +
		`is running on defaults, which regenerates local_control_secret, so anything ` +
		`holding the previous one stops authenticating against the local control endpoint.`
	);
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
 * writeTarget() only when existsSync(configPath) is true. So hop 0 cannot be the
 * refused hop for this branch, and the reason is not that the constructor fails:
 * measured, `new Config("<tmp>/absent/config.json")` does NOT throw. It takes the
 * else branch, mkdirSync with recursive:true CREATES the missing directory at
 * 0700, and the config is written there. The directory exists by the time
 * anything walks it. An earlier version of this comment said that path threw out
 * of mkdirSync, which was wrong and would have told a reader that a config path
 * under a missing directory is a hard startup error when it silently materialises
 * the tree instead. Found by review.
 *
 * The reachable shape is therefore a LATER hop. The configured path is a symlink
 * in a directory this process owns, so hop 0 is trusted, and the link points into
 * a directory that cannot be examined, so hop 1 stats a dirname that throws.
 * Nothing creates that directory, because mkdirSync only ever runs against
 * dirname(configPath), which is the link's own directory. Same harness as the
 * sticky landing-name test next door.
 *
 * Two error numbers, deliberately, because the branch is about examinability
 * rather than absence: ENOENT from a directory that was never created, and
 * ENOTDIR from a path component that is a regular file. Both are measured on
 * darwin and on Linux, produced by any uid, with no chmod, and nothing is
 * restored between constructing the Config and reading the message. The code has
 * one catch and never reads `.code`, so these are the reason for the fixture
 * shape rather than something asserted below.
 *
 * EACCES is NOT used: it would need a chmod on a grandparent, mode bits do not
 * stop root, and restoring the precondition afterwards is the artifact this
 * family has already shipped once. stickyFixture() is not used either; the catch
 * needs a directory that cannot be examined, which is the opposite of the
 * precondition that helper manufactures.
 *
 * The ENOTDIR case needs TWO components below the regular file. statSync on a
 * regular file succeeds, so `<file>/config.json` has a dirname that stats fine;
 * it is `<file>/sub/config.json` whose dirname throws.
 */

const posixOnly = process.platform === "win32" ? describe.skip : describe;

posixOnly("a config hop whose directory cannot be examined", () => {
	it("gives the whole directory-branch refusal when the directory is absent", () => {
		const home = mkdtempSync(
			join(tmpdir(), "better-ccflare-unexaminable-home-"),
		);
		const away = mkdtempSync(
			join(tmpdir(), "better-ccflare-unexaminable-away-"),
		);
		try {
			// Never created, and nothing creates it: mkdirSync runs against
			// dirname(configPath), which is `home`. So statSync(dirname(landing))
			// raises ENOENT and the catch is the only way this hop can be decided.
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

			// Equality, not substrings. The hop named is the landing and not the
			// configured link, which is what proves the walk reached its second
			// iteration and refused there, and the rest of the sentence is fixed
			// word for word so that neither a changed clause nor an added one can
			// pass.
			expect(refusals[0].msg).toBe(expectedDirectoryRefusal(link, landing));
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(away, { recursive: true, force: true });
		}
	});

	it("gives the same refusal when a path component is a regular file", () => {
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
			expect(refusals[0].msg).toBe(expectedDirectoryRefusal(link, landing));
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(away, { recursive: true, force: true });
		}
	});
});
