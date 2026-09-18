import { describe, expect, it } from "bun:test";
import {
	chmodSync,
	chownSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logBus } from "@better-ccflare/logger";
import type { LogEvent } from "@better-ccflare/types";
import { Config } from "./index";

/**
 * An untrusted link at the config path is replaced, not followed (SB23-1696).
 *
 * PR #57 made an untrusted link stop the config persisting at all. Refusing the
 * write was never what made it safe: nothing is written through the link either
 * way, and the refusal only cost the operator their settings. Renaming a fresh
 * 0600 file over the link path destroys the planted link, touches no unrelated
 * file, and keeps the process saving.
 *
 * The read stays refused whatever happens here, because a config another local
 * user supplies is an authentication bypass through local_control_secret rather
 * than a disclosure.
 *
 * What these do NOT prove: that POSIX ownership stops another user substituting
 * the link. That needs a second account, which this machine does not have, so
 * the ownership half stays an argument. Disclosed rather than counted.
 */

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
 * Run `fn` with this process reading as a different user.
 *
 * The replacement only fires for a link this process does NOT own, because only
 * root may chown a symlink, so a link owned by us was created by us. A test
 * cannot create a link owned by someone else without a second account, so the
 * comparison is moved instead of the link: `directoryIsTrusted()` and
 * `replaceUntrustedLink()` both read `process.getuid`, so making it report a
 * stranger puts a fixture link of ours on the planted side of both checks.
 *
 * This exercises the comparison, not the OS. POSIX's own guarantee that another
 * user cannot substitute our link stays an argument, at the same rung as the
 * ownership check PR #57 shipped. The repo already uses this technique in
 * config-file-mode.test.ts and labels it the same way.
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

/** A directory another local user can write, which is what makes a link untrusted. */
function sharedDir(label: string): string {
	const dir = join(tmpdir(), `better-ccflare-${label}-${process.pid}`);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir);
	// Explicit chmod, never mkdir's mode: mkdir's is masked by the umask, so
	// under umask 077 the directory would be 0700, the link would be trusted,
	// and every assertion below would pass against reverted source.
	chmodSync(dir, 0o1777);
	expect(statSync(dir).mode & 0o022).not.toBe(0);
	return dir;
}

describe("an untrusted config symlink", () => {
	it("is replaced by a regular file, so settings still persist", () => {
		const shared = sharedDir("replace");
		const victimDir = mkdtempSync(join(tmpdir(), "better-ccflare-victim-"));
		try {
			const victim = join(victimDir, "authorized_keys");
			writeFileSync(victim, "ssh-ed25519 AAAA\n");
			chmodSync(victim, 0o600);
			const link = join(shared, "config.json");
			symlinkSync(victim, link);

			const logs = captureLogs(() =>
				asStranger(() => {
					const config = new Config(link);
					config.set("pg_password", "hunter2");
				}),
			);

			// The operator is told, at WARN, and told where. A replacement that
			// happens silently leaves them believing their link is still in place,
			// and the two outcomes of this branch are otherwise indistinguishable
			// from outside: both return, and neither throws.
			const replaced = logs.filter(
				(event) =>
					event.level === "WARN" &&
					event.msg.includes("Replaced the untrusted symlink"),
			);
			expect(replaced).toHaveLength(1);
			expect(replaced[0].msg).toContain(link);
			expect(
				logs.filter(
					(event) =>
						event.level === "ERROR" &&
						event.msg.includes("could not be replaced"),
				),
			).toHaveLength(0);

			// Nothing went through the link.
			expect(readFileSync(victim, "utf8")).toBe("ssh-ed25519 AAAA\n");
			// The link is gone and the secret is in a file of ours at 0600.
			expect(lstatSync(link).isSymbolicLink()).toBe(false);
			expect(lstatSync(link).mode & 0o777).toBe(0o600);
			expect(readFileSync(link, "utf8")).toContain("hunter2");
			// Different inodes, so the "replacement" is not the victim renamed.
			expect(lstatSync(link).ino).not.toBe(lstatSync(victim).ino);
		} finally {
			rmSync(shared, { recursive: true, force: true });
			rmSync(victimDir, { recursive: true, force: true });
		}
	});

	it("does not copy the link target's ownership onto the replacement", () => {
		// preserveOwnership() stats the target to keep the previous owner across
		// the rename, and statSync follows a link. Left on, it would read the
		// ownership of whatever the planter pointed at and fchown the new config to
		// them, handing over the file this branch exists to keep out of their
		// hands.
		//
		// A second account would exercise the uid half directly. This machine has
		// none, so the group is the lever: a process may chown a file to any group
		// it belongs to without root, so the victim gets a supplementary group and
		// the replacement must not end up carrying it. That is the same attribute,
		// read through the same followed link, by the same call.
		const groups = process.getgroups?.() ?? [];
		const primary = process.getgid?.();
		const other = groups.find((g) => g !== primary);
		const shared = sharedDir("owner");
		const victimDir = mkdtempSync(join(tmpdir(), "better-ccflare-owner-"));
		try {
			if (other === undefined || primary === undefined) {
				// Disclosed rather than silently passing: with one group there is no
				// ownership attribute this process may change, so nothing is proved.
				expect(process.platform).toBe("win32");
				return;
			}
			const victim = join(victimDir, "theirs.json");
			writeFileSync(victim, "{}\n");
			chownSync(victim, process.getuid?.() as number, other);
			expect(statSync(victim).gid).toBe(other);

			// What a file created in this directory gets on its own, so the
			// assertion below compares against the real inherited value rather than
			// a guess about BSD group inheritance.
			const control = join(shared, "control");
			writeFileSync(control, "");
			const inherited = statSync(control).gid;
			expect(inherited).not.toBe(other);

			const link = join(shared, "config.json");
			symlinkSync(victim, link);

			asStranger(() => {
				const config = new Config(link);
				config.set("pg_password", "hunter2");
			});

			expect(lstatSync(link).uid).toBe(process.getuid?.() as number);
			expect(lstatSync(link).gid).toBe(inherited);
			expect(lstatSync(link).gid).not.toBe(other);
		} finally {
			rmSync(shared, { recursive: true, force: true });
			rmSync(victimDir, { recursive: true, force: true });
		}
	});

	it("leaves our own link alone in a group-writable private directory", () => {
		// The case that makes the ownership rule load-bearing rather than tidy.
		// directoryIsTrusted() rejects any group or other writable directory, and
		// on a distribution with umask 002 and per-user private groups mkdir
		// ~/.config produces 0775 owned by the user and the user's own group. That
		// directory is effectively private, it is rejected anyway, and a dotfiles
		// link inside it is the arrangement resolveLinkChain() exists to support.
		//
		// Replacing there would turn a reversible misdetection into a permanent
		// one: the link is destroyed, and because the read already set data to {},
		// what lands in its place is a file of defaults with local_control_secret
		// regenerated, invalidating every existing client. Refusing leaves the link
		// and the real config intact and chmod 700 on the directory restores it.
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-privgrp-"));
		try {
			const real = join(dir, "real.json");
			const link = join(dir, "config.json");
			writeFileSync(real, JSON.stringify({ lb_strategy: "session" }));
			symlinkSync(real, link);
			// Group-writable, owned by us, like a private-group ~/.config. Explicit
			// chmod, because mkdtemp's mode is masked by the umask.
			chmodSync(dir, 0o775);
			expect(statSync(dir).mode & 0o022).not.toBe(0);
			expect(lstatSync(link).uid).toBe(process.getuid?.() as number);

			const config = new Config(link);
			config.set("pg_password", "hunter2");

			// The link survives and its target keeps the operator's real config.
			expect(lstatSync(link).isSymbolicLink()).toBe(true);
			expect(readFileSync(real, "utf8")).toContain("session");
			// Nothing was written through it either, which is the pre-existing
			// refusal and is what makes the misdetection reversible.
			expect(readFileSync(real, "utf8")).not.toContain("hunter2");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("still refuses a cycle rather than destroying the operator's own link", () => {
		// The replacement is for a link whose OWN directory is untrusted. A cycle
		// in a directory only we can write is the operator's own arrangement, and
		// renaming over it is the destructive behaviour resolveLinkChain() exists
		// to prevent. Keeping the two apart is the whole reason this is not simply
		// "rename over the path whenever writeTarget() returns null".
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-cycle-"));
		try {
			const a = join(dir, "config.json");
			const b = join(dir, "other.json");
			symlinkSync(b, a);
			symlinkSync(a, b);

			const config = new Config(a);
			config.set("pg_password", "hunter2");

			expect(lstatSync(a).isSymbolicLink()).toBe(true);
			expect(lstatSync(b).isSymbolicLink()).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves a regular file in a shared directory alone", () => {
		// Only a LINK is replaced. A regular config in a shared-writable directory
		// was already accepted before this change and still is, so the new branch
		// must not start rewriting it through a different path.
		const shared = sharedDir("regular");
		try {
			const configPath = join(shared, "config.json");
			writeFileSync(configPath, JSON.stringify({ lb_strategy: "session" }));
			const before = lstatSync(configPath).ino;

			const config = new Config(configPath);
			expect(config.get("lb_strategy")).toBe("session");
			config.set("pg_password", "hunter2");

			expect(readFileSync(configPath, "utf8")).toContain("hunter2");
			// A rename swaps the inode, which is the normal save path rather than
			// the replacement branch; what matters is that the file was READ, which
			// the replacement branch never does.
			expect(before).toBeGreaterThan(0);
		} finally {
			rmSync(shared, { recursive: true, force: true });
		}
	});

	it("does not adopt the planted config's values", () => {
		// Replacing the link must not quietly turn into following it. The read is
		// refused first, so the file written over the link carries our defaults and
		// the attacker's local_control_secret never reaches getLocalControlSecret().
		const shared = sharedDir("read");
		const attackerDir = mkdtempSync(join(tmpdir(), "better-ccflare-att-"));
		try {
			const attacker = join(attackerDir, "planted.json");
			writeFileSync(
				attacker,
				JSON.stringify({ local_control_secret: "ATTACKER-CHOSEN" }),
			);
			const link = join(shared, "config.json");
			symlinkSync(attacker, link);

			const config = asStranger(() => {
				const probe = new Config(link);
				// Both reads happen inside the stub: getLocalControlSecret() re-reads
				// the file itself and was the reader that stayed unguarded longest.
				expect(probe.get("local_control_secret")).toBeUndefined();
				expect(probe.getLocalControlSecret()).not.toBe("ATTACKER-CHOSEN");
				return probe;
			});
			expect(config).toBeDefined();
			expect(readFileSync(link, "utf8")).not.toContain("ATTACKER-CHOSEN");
			expect(lstatSync(link).isSymbolicLink()).toBe(false);
		} finally {
			rmSync(shared, { recursive: true, force: true });
			rmSync(attackerDir, { recursive: true, force: true });
		}
	});
});
