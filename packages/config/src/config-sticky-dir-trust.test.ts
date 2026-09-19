import { describe, expect, it } from "bun:test";
import {
	chmodSync,
	linkSync,
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
 * One mutation still survives: deleting the `uid === uid` comparison while keeping
 * the nlink conjunct. Killing it needs a sticky directory that passes the
 * directory-ownership test while an entry inside it reads as another user's, and a
 * test-created sticky directory is owned by the test process, so stubbing
 * `process.getuid` to a stranger is refused one line earlier by the
 * directory-ownership test and never reaches the comparison.
 *
 * An earlier version of this header said that was the end of it, because the one
 * root-owned sticky directory, /tmp, is rejected by validatePathOrThrow. Review
 * falsified that: the validator builds its default allowed base paths from
 * `tmpdir()` (packages/security/src/path-validator.ts:267-276), so TMPDIR pointed
 * at /private/tmp, which is uid 0 and mode 1777, makes a root-owned sticky
 * directory an allowed base and the stub then reaches the comparison. Measured
 * here, and it is still not shippable: `cachedDefaultAllowedPaths` is memoised on
 * first use and the only exported reset, `clearValidationCache()`, clears the
 * results cache and not that one. So the fixture works when its file runs first
 * and fails inside the full suite, measured as `Path outside allowed directories
 * in config file: /private/tmp/...` with the allowed list still naming
 * /var/folders. Giving the validator an exported way to reset it is a change to a
 * security module and is SB23-2316, not this commit.
 *
 * The nlink conjunct is separately covered, by the hardlink test below.
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

	it("is refused when the entry is a hardlink, whatever uid it reports", () => {
		// A uid of ours does not mean we created the entry. A hardlink carries the
		// inode's owner to a new name, so another local user can manufacture an
		// entry that lstats as ours. Measured on macOS, which has no
		// fs.protected_hardlinks: `ln /etc/hosts ./hosts-hl` as an ordinary user
		// succeeds and the new entry lstats as uid 0.
		//
		// The damage is not only a write. The trust decision gates the READ, so the
		// victim file's contents are adopted as config, and an attacker who can
		// influence any file of ours chooses local_control_secret. restrictConfigFile()
		// then chmods the victim to 0600 through the link.
		//
		// linkSync stands in for the plant: this process owns the victim, so the
		// entry reads as ours exactly as an attacker's hardlink to a file of ours
		// would, and nlink is what tells them apart.
		const shared = stickyDir("sticky-hardlink");
		const other = mkdtempSync(join(tmpdir(), "better-ccflare-sticky-oth-"));
		const home = mkdtempSync(join(tmpdir(), "better-ccflare-sticky-hhome-"));
		try {
			const victim = join(other, "some-script.sh");
			writeFileSync(
				victim,
				JSON.stringify({
					local_control_secret: "CONTENT-OF-AN-UNRELATED-FILE",
				}),
			);
			chmodSync(victim, 0o755);
			const landing = join(shared, "landed.json");
			linkSync(victim, landing);
			// The plant reads as ours, which is the whole point: only nlink separates
			// it from a config file we made.
			expect(lstatSync(landing).uid).toBe(process.getuid?.() ?? -1);
			expect(lstatSync(landing).nlink).toBe(2);

			const link = join(home, "config.json");
			symlinkSync(landing, link);

			const config = new Config(link);
			config.set("pg_password", "hunter2");

			// Not adopted as config.
			expect(config.get("local_control_secret")).toBeUndefined();
			// Not chmodded through the link, and not written through it.
			expect(statSync(victim).mode & 0o777).toBe(0o755);
			expect(readFileSync(victim, "utf8")).not.toContain("hunter2");
		} finally {
			rmSync(shared, { recursive: true, force: true });
			rmSync(other, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});
});
