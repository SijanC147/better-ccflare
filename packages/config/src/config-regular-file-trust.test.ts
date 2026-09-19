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

			const strangerFileUid = statSync(configPath).uid;

			// Every read inside the stub, not just the construction. Each reader
			// re-runs the trust check, so leaving getLocalControlSecret() outside
			// measured the honest answer to a different question: out there the
			// file really is ours, so trusting it is correct. That cost one round
			// here and it is the same mistake as asserting on a fixture whose
			// premise has lapsed.
			const logs = captureLogs(() => {
				asStranger(() => {
					const config = new Config(configPath);

					// Neither the initial load nor getLocalControlSecret()'s own
					// re-read may adopt it. The second is a separate reader and was
					// the one still returning an attacker value when only the first
					// was gated in PR #57.
					expect(config.get("local_control_secret")).toBeUndefined();
					expect(config.get("lb_strategy")).toBeUndefined();
					expect(config.getLocalControlSecret()).not.toBe("ATTACKER-CHOSEN");
				});
			});
			// Refused, not replaced: replaceUntrustedLink() only ever acts on a
			// symlink, so a regular file we do not own is left exactly as it was
			// rather than renamed over, which would destroy a file of theirs.
			expect(readFileSync(configPath, "utf8")).toContain("ATTACKER-CHOSEN");

			// The refusal has to be diagnosable from the log alone, because the
			// case an operator actually hits is a container with the config
			// bind-mounted from the host, where the file carries its host owner and
			// the image's chown does not reach it. Measured on Linux for SB23-2339:
			// process uid 1001 against file uid 501 refuses, which is exactly the
			// compose layout docs/deployment.md documents. Without the hint the
			// operator sees a uid mismatch and no reason for it.
			const refusals = logs.filter(
				(event) =>
					event.level === "ERROR" && event.msg.includes("not by us (uid "),
			);
			// Three, measured, and the number is the point rather than incidental.
			// Each reader re-runs writeTarget() and refuses independently: the
			// initial load, then each getLocalControlSecret(), which cannot short
			// out on this.data because the refusal left it empty. So unlike the
			// writable-config warning added in PR #176, this refusal is NOT
			// deduplicated per path. Asserting the exact count rather than "at
			// least one" means adding or removing a reader fails here and whoever
			// did it reads this comment. The asymmetry between the two messages is
			// recorded as a follow-up, not fixed in this change.
			expect(refusals).toHaveLength(3);
			// Both uids, so the operator can act without reproducing anything.
			expect(refusals[0].msg).toContain(`owned by uid ${strangerFileUid}`);
			expect(refusals[0].msg).toContain("bind-mounted from the host");
			expect(refusals[0].msg).toContain("named volume");
			// And what the failure looks like from the outside, which is the part
			// that otherwise reads as an intermittent auth bug.
			expect(refusals[0].msg).toContain("regenerated on every restart");
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

	it("is loaded but reported when other local users can write it", () => {
		// The file is OURS, so trustedRegularPath() passes it: uid matches, one name.
		// Nothing else looks at the file's own mode, so before this it was adopted in
		// silence. Measured by PR #172's review, where local_control_secret came back
		// reading a value written by somebody else (SB23-2338).
		//
		// The decision this pins is that the config is still LOADED. Refusing was
		// rejected: loadConfig() assigns this.data before restrictConfigFile() runs,
		// so a refusal that self-heals would find 0600 on the next boot and adopt the
		// identical bytes, and a refusal that does not self-heal is a permanent outage
		// on the filesystems where chmod is a no-op, which is where the standing
		// exposure actually lives. The middle assertion below is the decision.
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-regular-mode-"));
		try {
			const configPath = join(dir, "config.json");
			writeFileSync(configPath, JSON.stringify({ lb_strategy: "session" }));
			// Explicit chmod, never writeFileSync's mode option: under umask 022 a
			// requested 0o666 lands 0644, which has no group or other WRITE bit, so
			// the condition under test would not hold and this test would fail
			// without saying why.
			chmodSync(configPath, 0o666);
			expect(statSync(configPath).mode & 0o022).not.toBe(0);

			const logs = captureLogs(() => {
				const config = new Config(configPath);
				// Loaded, not refused. This is the decision.
				expect(config.get("lb_strategy")).toBe("session");
			});

			const reported = logs.filter(
				(event) =>
					event.level === "ERROR" &&
					event.msg.includes("its contents may not be yours"),
			);
			expect(reported).toHaveLength(1);
			expect(reported[0].msg).toContain(configPath);
			// The field that makes this an authentication bypass rather than a
			// disclosure has to be named, because chmodAndVerify()'s existing warning
			// already covers readability and an operator who has seen that one will
			// read this as the same thing.
			expect(reported[0].msg).toContain("local_control_secret");
			// And the window is closed on the way out, by the existing chmod.
			expect(statSync(configPath).mode & 0o777).toBe(0o600);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("is NOT reported for a config only we can write", () => {
		// The negative half, and every other test here is positive. Without it a
		// mutation widening the mask from 0o022 to 0o222 survives the entire config
		// security suite, ten files and 216 assertions, because every existing test
		// asserts the line IS emitted and none asserts it is not. Measured under that
		// mutation: a 0600 config emits the line. So the warning would fire on every
		// install on every boot and nothing would go red. Found by PR #176's review.
		//
		// 0644 is the more valuable of the two cases. That is what versions before
		// PR #57 wrote, so it is what an upgrading install actually has on disk, and
		// the message would be false about it: 0644 is world-READABLE, which
		// chmodAndVerify() already reports, and not world-writable.
		for (const mode of [0o600, 0o644]) {
			const dir = mkdtempSync(join(tmpdir(), "better-ccflare-regular-ok-"));
			try {
				const configPath = join(dir, "config.json");
				writeFileSync(configPath, JSON.stringify({ lb_strategy: "session" }));
				chmodSync(configPath, mode);
				// The premise: no group or other WRITE bit.
				expect(statSync(configPath).mode & 0o022).toBe(0);

				const logs = captureLogs(() => {
					const config = new Config(configPath);
					expect(config.get("lb_strategy")).toBe("session");
				});

				expect(
					logs.filter((event) =>
						event.msg.includes("its contents may not be yours"),
					),
				).toHaveLength(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	it("is reported when only the GROUP can write it, not just other", () => {
		// Kills a mask narrowed from 0o022 to 0o002. The case above uses 0666, which
		// has both the group and the other write bit, so it survives that narrowing
		// and says nothing about which bits are checked. Found by mutation, not by
		// reading: the narrowed mask passed the whole file.
		//
		// A group-writable config is the realistic shape of the two. A shared group
		// is how an operator gives a service account access, and 0660 is what a
		// umask of 007 produces, so this is the mode a real install arrives at
		// without anybody choosing it.
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-regular-grp-"));
		try {
			const configPath = join(dir, "config.json");
			writeFileSync(configPath, JSON.stringify({ lb_strategy: "session" }));
			chmodSync(configPath, 0o660);
			// The point of this fixture: group write set, other write clear.
			expect(statSync(configPath).mode & 0o020).not.toBe(0);
			expect(statSync(configPath).mode & 0o002).toBe(0);

			const logs = captureLogs(() => {
				const config = new Config(configPath);
				expect(config.get("lb_strategy")).toBe("session");
			});

			const reportedGroup = logs.filter(
				(event) =>
					event.level === "ERROR" &&
					event.msg.includes("its contents may not be yours"),
			);
			expect(reportedGroup).toHaveLength(1);
			// The bit that was found is named, because "group-writable (gid N)" and
			// "world-writable" call for different actions from an operator.
			expect(reportedGroup[0].msg).toContain("group-writable (gid ");
			expect(reportedGroup[0].msg).not.toContain("world-writable");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports a writable config once per path, not once per reader", () => {
		// getLocalControlSecret() re-reads the file itself, so without the module
		// Set the same boot emits the line more than once and an operator learns to
		// scroll past it.
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-regular-dedup-"));
		try {
			const configPath = join(dir, "config.json");
			writeFileSync(configPath, JSON.stringify({ lb_strategy: "session" }));
			chmodSync(configPath, 0o666);
			expect(statSync(configPath).mode & 0o022).not.toBe(0);

			const logs = captureLogs(() => {
				const config = new Config(configPath);
				// Put the mode back before the next reader. Without this the test
				// proves nothing and a mutation deleting the dedupe survives it,
				// which is how this fixture was found: restrictConfigFile() lands
				// 0600 during construction, so on a mode-enforcing filesystem no
				// later read can meet the condition again and the Set is never
				// consulted twice.
				//
				// Restoring it models the case the Set exists for, a filesystem
				// where chmod is a no-op so every read sees a writable file. Docker
				// bind mounts from a macOS or Windows host, and FAT or exFAT, which
				// this host cannot mount for a test.
				chmodSync(configPath, 0o666);
				config.getLocalControlSecret();
				chmodSync(configPath, 0o666);
				config.getLocalControlSecret();
			});

			expect(
				logs.filter(
					(event) =>
						event.level === "ERROR" &&
						event.msg.includes("its contents may not be yours"),
				),
			).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("is diagnosed as a directory, not as a hardlink, when it is one", () => {
		// A directory has nlink >= 2 and is owned by us, so it reached the hardlink
		// branch and was told it was "a regular file with 2 names", advising the
		// operator to delete it. One holding subdirectories read "with 17 names".
		// readRegularFile() already has the message that is true, so the fix is for
		// trustedRegularPath() to say nothing about a non-regular entry.
		//
		// Found by PR #172's review, and it slipped because nothing pinned this
		// message. That is what this test is for.
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-regular-dir-"));
		try {
			const configPath = join(dir, "config.json");
			mkdirSync(configPath);
			// Raise the link count the way a real directory tree would, so a
			// regression cannot pass by reporting a plausible-looking "2 names".
			mkdirSync(join(configPath, "sub"));
			expect(lstatSync(configPath).nlink).toBeGreaterThanOrEqual(3);

			const logs = captureLogs(() => {
				const config = new Config(configPath);
				expect(config.get("lb_strategy")).toBeUndefined();
			});
			const messages = logs.map((event) => event.msg).join("\n");

			expect(messages).toContain("is not a regular file");
			// The wrong diagnosis, in either of its shapes.
			expect(messages).not.toContain("names");
			expect(messages).not.toContain("hardlink");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
