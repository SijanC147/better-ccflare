import { describe, expect, it } from "bun:test";
import {
	chmodSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

/**
 * A regular file already at the config path is trusted only when it is ours and
 * has one name (SB23-2317).
 *
 * Until this rule, `writeTarget()` returned the configured path unconditionally
 * for anything that was not a symlink, so a regular file was the one route into
 * the config that was never checked. Everything SB23-1696 and SB23-2267 built
 * governs the symlink case. An attacker who pre-creates a regular file at the
 * config path before first boot chose the whole config: `local_control_secret`,
 * which is an authentication bypass on the local control endpoint rather than a
 * disclosure, and `pg_host` with `pg_password` pointing at a database of theirs.
 *
 * The rule reads nothing about the containing directory, on purpose. A symlink is
 * dangerous because it redirects the write; a regular file redirects nothing, so
 * requiring a private directory would refuse the shared-directory install that
 * `config-file-mode.test.ts:589` exists to protect. That test is the positive case
 * for this rule and is deliberately not duplicated here.
 *
 * What these do NOT prove: that POSIX stops another user substituting the file.
 * That needs a second local account, which this host does not have, so ownership
 * stays an argument at the rung PR #145 shipped it at, and `asStranger()` moves
 * the comparison rather than the file. Same technique and same label as
 * config-untrusted-link-replace.test.ts.
 */

/**
 * Run `fn` with this process reading as a different user, so a fixture file of
 * ours lands on the stranger side of the ownership test.
 *
 * Reachable here, unlike in the sticky-directory tests, because this rule consults
 * no directory: there is no directory-ownership check in front of the comparison
 * to refuse the stub one line earlier.
 */
function asStranger<T>(fn: () => T): T {
	const real = process.getuid;
	process.getuid = () => 999999;
	try {
		return fn();
	} finally {
		process.getuid = real;
	}
}

describe("a regular file at the config path", () => {
	it("is refused when it belongs to another user", () => {
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-regular-"));
		try {
			const configPath = join(dir, "config.json");
			// A config an attacker planted before we ever booted. Its
			// local_control_secret is the sharp field: adopting it authenticates
			// whoever chose it against the local control endpoint.
			writeFileSync(
				configPath,
				JSON.stringify({
					local_control_secret: "ATTACKER-CHOSEN",
					lb_strategy: "session",
				}),
				{ mode: 0o600 },
			);

			// Every read inside the stub, not just the construction. Each reader
			// re-runs the trust check, so leaving getLocalControlSecret() outside
			// measured the honest answer to a different question: out there the
			// file really is ours, so trusting it is correct. That cost one round
			// here and it is the same mistake as asserting on a fixture whose
			// premise has lapsed.
			asStranger(() => {
				const config = new Config(configPath);

				// Neither the initial load nor getLocalControlSecret()'s own re-read
				// may adopt it. The second is a separate reader and was the one
				// still returning an attacker value when only the first was gated
				// in PR #57.
				expect(config.get("local_control_secret")).toBeUndefined();
				expect(config.get("lb_strategy")).toBeUndefined();
				expect(config.getLocalControlSecret()).not.toBe("ATTACKER-CHOSEN");
			});
			// Refused, not replaced: replaceUntrustedLink() only ever acts on a
			// symlink, so a regular file we do not own is left exactly as it was
			// rather than renamed over, which would destroy a file of theirs.
			expect(readFileSync(configPath, "utf8")).toContain("ATTACKER-CHOSEN");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("is refused when it is a hardlink, whatever uid it reports", () => {
		// The "or root" half of the ownership test is why one name is required. A
		// hardlink carries the inode's owner to a new name, and macOS has no
		// fs.protected_hardlinks, so an ordinary user can run `ln /etc/hosts .`
		// and produce an entry that lstats as uid 0 with two names. Measured in
		// PR #169's review.
		//
		// 0o777 on the directory, and nothing sticky: this rule consults no
		// directory, and chmodSync cannot set the sticky bit on Linux anyway
		// (SB23-2319), so a sticky fixture would pass here and fail in CI.
		const dir = join(tmpdir(), `better-ccflare-regular-hl-${process.pid}`);
		const other = mkdtempSync(join(tmpdir(), "better-ccflare-regular-oth-"));
		try {
			rmSync(dir, { recursive: true, force: true });
			mkdirSync(dir);
			chmodSync(dir, 0o777);
			const victim = join(other, "some-script.sh");
			writeFileSync(
				victim,
				JSON.stringify({ local_control_secret: "CONTENT-OF-ANOTHER-FILE" }),
			);
			chmodSync(victim, 0o755);

			const configPath = join(dir, "config.json");
			linkSync(victim, configPath);
			// The plant reads as ours. Only the link count separates it from a
			// config file we wrote, which is what this test pins.
			expect(lstatSync(configPath).uid).toBe(process.getuid?.() ?? -1);
			expect(lstatSync(configPath).nlink).toBe(2);

			const config = new Config(configPath);

			// Not adopted as config.
			expect(config.get("local_control_secret")).toBeUndefined();
			// Not chmodded through the link by restrictConfigFile(), and not
			// written through by a save.
			config.set("pg_password", "hunter2");
			expect(statSync(victim).mode & 0o777).toBe(0o755);
			expect(readFileSync(victim, "utf8")).not.toContain("hunter2");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(other, { recursive: true, force: true });
		}
	});
});
