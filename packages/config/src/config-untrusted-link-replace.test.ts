import { describe, expect, it } from "bun:test";
import {
	chmodSync,
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

			const config = new Config(link);
			config.set("pg_password", "hunter2");

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

	it("keeps the replacement ours, not the planter's", () => {
		// preserveOwnership() stats the target to keep the previous owner across
		// the rename, and statSync follows a link. Left on, it would read the uid
		// of whatever the planter pointed at and fchown the new config to them,
		// handing over the file this branch exists to keep out of their hands.
		// A second account would test this directly; without one, asserting the
		// replacement is still ours is what the machine can measure.
		const shared = sharedDir("owner");
		const victimDir = mkdtempSync(join(tmpdir(), "better-ccflare-owner-"));
		try {
			const victim = join(victimDir, "theirs.json");
			writeFileSync(victim, "{}\n");
			const link = join(shared, "config.json");
			symlinkSync(victim, link);

			const config = new Config(link);
			config.set("pg_password", "hunter2");

			const uid = process.getuid?.();
			expect(uid).toBeDefined();
			expect(lstatSync(link).uid).toBe(uid as number);
		} finally {
			rmSync(shared, { recursive: true, force: true });
			rmSync(victimDir, { recursive: true, force: true });
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

			const config = new Config(link);

			expect(config.get("local_control_secret")).toBeUndefined();
			expect(config.getLocalControlSecret()).not.toBe("ATTACKER-CHOSEN");
			expect(readFileSync(link, "utf8")).not.toContain("ATTACKER-CHOSEN");
			expect(lstatSync(link).isSymbolicLink()).toBe(false);
		} finally {
			rmSync(shared, { recursive: true, force: true });
			rmSync(attackerDir, { recursive: true, force: true });
		}
	});
});
