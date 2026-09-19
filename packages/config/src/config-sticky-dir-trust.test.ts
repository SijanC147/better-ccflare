import { describe, expect, it } from "bun:test";
import {
	chmodSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Config } from "./index";

/**
 * A sticky directory is trusted when the entry at the config path is ours
 * (SB23-2267).
 *
 * os.tmpdir() is one of the validator's allowed base paths and on Linux that is
 * /tmp at 1777, where the old rule refused a legitimate config outright: not
 * only its writes but its reads, so the process silently ran on defaults. In a
 * sticky directory only the entry's owner, the directory's owner and root may
 * unlink or rename an entry, and only root may chown a symlink, so an entry
 * whose uid is ours was created by us and no other local user can substitute it.
 *
 * What these do NOT prove: the POSIX guarantee itself. That needs a second local
 * account, which this host does not have, so the sticky semantics stay an
 * argument at the same rung as the ownership check PR #145 shipped. Disclosed
 * rather than counted.
 *
 * One mutation survives here and is disclosed rather than buried: deleting the
 * `lstatSync(entry).uid === uid` comparison and returning true. Killing it needs
 * a sticky directory that passes the directory-ownership test while an entry
 * inside it reads as another user's, and neither half is reachable from a test on
 * this host. A test-created sticky directory is owned by the test process, so
 * stubbing `process.getuid` to a stranger, the technique
 * config-untrusted-link-replace.test.ts uses, is refused by the
 * directory-ownership test one line earlier and never evaluates the comparison.
 * The one root-owned sticky directory, /tmp, cannot be used either: Config's
 * constructor calls validatePathOrThrow with hardcoded options, and on macOS
 * os.tmpdir() is a private /var/folders path, so /tmp is rejected as outside the
 * allowed base directories before any trust check runs. Measured, not argued:
 * `Path outside allowed directories in config file: /tmp/...`. On Linux
 * os.tmpdir() IS /tmp, so the fixture exists there and not here, and a test that
 * passes only in CI is one this lane cannot verify. Filed as the follow-up that
 * SB23-2267's "second account first" precondition was really asking for.
 */

/**
 * A sticky directory inside an allowed base path, owned by this process.
 *
 * Explicit chmod, never mkdtemp's mode: mkdtemp gives 0700, which is trusted by
 * the ordinary rule, so every assertion below would pass against reverted
 * source. Asserted after the chmod for the same reason.
 */
function stickyDir(label: string): string {
	const dir = mkdtempSync(join(tmpdir(), `better-ccflare-${label}-`));
	chmodSync(dir, 0o1777);
	const info = statSync(dir);
	expect(info.mode & 0o1000).not.toBe(0);
	expect(info.mode & 0o022).not.toBe(0);
	return dir;
}

describe("a config symlink in a sticky directory", () => {
	it("is followed for read and write when the link is ours", () => {
		// The link is created by this process, so it is ours, and in a sticky
		// directory nobody else could have put it there or replaced it. Before
		// this rule the whole config was refused: the read returned nothing and
		// the process ran on defaults with a fresh local_control_secret.
		const shared = stickyDir("sticky-ours");
		const target = mkdtempSync(join(tmpdir(), "better-ccflare-sticky-tgt-"));
		try {
			const link = join(shared, "config.json");
			const real = join(target, "config.json");
			writeFileSync(real, JSON.stringify({ lb_strategy: "session" }), {
				mode: 0o600,
			});
			symlinkSync(real, link);

			const config = new Config(link);

			// The read is the half that used to fail silently.
			expect(config.get("lb_strategy")).toBe("session");

			config.set("pg_password", "hunter2");

			// Written through the link, into the private target, not over the link.
			expect(readFileSync(real, "utf8")).toContain("hunter2");
			expect(lstatSync(link).isSymbolicLink()).toBe(true);
			expect(statSync(real).mode & 0o777).toBe(0o600);
		} finally {
			rmSync(shared, { recursive: true, force: true });
			rmSync(target, { recursive: true, force: true });
		}
	});

	it("is refused when the chain lands on a name nothing owns yet", () => {
		// The landing path does not exist, so there is no entry whose ownership
		// could be compared, and the sticky bit does not stop another user
		// creating one. A rule that read an absent entry as ours would write the
		// secrets to a name an attacker can claim first.
		const shared = stickyDir("sticky-land");
		const home = mkdtempSync(join(tmpdir(), "better-ccflare-sticky-home-"));
		try {
			const landing = join(shared, "landed.json");
			const link = join(home, "config.json");
			symlinkSync(landing, link);
			expect(dirname(landing)).toBe(shared);

			const config = new Config(link);
			config.set("pg_password", "hunter2");

			expect(() => statSync(landing)).toThrow();
		} finally {
			rmSync(shared, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});
});
