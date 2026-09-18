import { describe, expect, it } from "bun:test";
import {
	chmodSync,
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StrategyName } from "@better-ccflare/core";
import { Config } from "./index";

/**
 * The config file holds pg_password, local_control_secret and
 * upstream_maintainer_token, so it must not be readable by other local users.
 *
 * Config#saveConfig() writes a 0600 temp file and renames it over the config,
 * and falls back to an in-place write when the rename cannot work. loadConfig()
 * chmods an existing file, because an upgraded install may never write again.
 */
function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

describe("config file permissions", () => {
	it("creates a new config file as 0600", () => {
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-mode-"));
		try {
			const configPath = join(dir, "config.json");
			// A brand-new Config seeds the file with lb_strategy and saves it.
			new Config(configPath);
			expect(mode(configPath)).toBe(0o600);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("tightens a pre-existing 0644 file on the next save", () => {
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-mode-"));
		try {
			const configPath = join(dir, "config.json");
			writeFileSync(
				configPath,
				JSON.stringify({ lb_strategy: "session" }),
				"utf8",
			);
			// chmod rather than writeFileSync's mode option: that option is masked
			// by umask, so the setup itself would land below 0644 under umask 027
			// or 077 and the precondition below would fail for the wrong reason.
			chmodSync(configPath, 0o644);
			expect(mode(configPath)).toBe(0o644);

			// Loading is enough: an upgrade may never write a setting again.
			const config = new Config(configPath);
			expect(mode(configPath)).toBe(0o600);

			// And a later save keeps it there.
			config.setStrategy(StrategyName.LeastUsed);
			expect(mode(configPath)).toBe(0o600);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("replaces the inode on save, so an old descriptor stops seeing writes", () => {
		// writeFileSync truncates in place, which keeps the inode and lets a
		// descriptor opened while the file was 0644 read every later secret.
		// saveConfig() writes a temp file and renames, so the reader is left
		// holding the unlinked old inode.
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-mode-"));
		try {
			const configPath = join(dir, "config.json");
			const config = new Config(configPath);
			const before = statSync(configPath).ino;

			const fd = openSync(configPath, "r");
			try {
				config.set("pg_password", "hunter2");
				expect(statSync(configPath).ino).not.toBe(before);

				// The descriptor still points at the old inode, which never gains
				// the new secret.
				const viaOldFd = readFileSync(fd, "utf8");
				expect(viaOldFd).not.toContain("hunter2");
				expect(readFileSync(configPath, "utf8")).toContain("hunter2");
			} finally {
				closeSync(fd);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("is 0600 even under a umask that would mask the write's mode", () => {
		// writeFileSync's mode option is masked by umask. Measured: under umask
		// 0277 it produces 0400, which a rename would carry onto the config and
		// make every later write fail. saveConfig() chmods the temp file for this.
		const previous = process.umask(0o277);
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-mode-"));
		try {
			// mkdtemp is masked too, and a dir without owner-execute cannot be
			// traversed, so restore that before touching anything inside it.
			chmodSync(dir, 0o700);
			const configPath = join(dir, "config.json");
			new Config(configPath);
			expect(mode(configPath)).toBe(0o600);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			process.umask(previous);
		}
	});

	it("still saves when the directory is not writable but the file is", () => {
		// A root-owned directory holding a config chmodded for the service user is
		// a documented layout (docs/configuration.md:113 advertises
		// better-ccflare_CONFIG_PATH=/etc/better-ccflare.json). The temp file
		// cannot be created there, so saveConfig() must write in place rather than
		// silently keep the config in memory only.
		const root = mkdtempSync(join(tmpdir(), "better-ccflare-mode-"));
		const dir = join(root, "conf");
		try {
			mkdirSync(dir);
			const configPath = join(dir, "config.json");
			writeFileSync(configPath, JSON.stringify({ lb_strategy: "session" }));
			chmodSync(configPath, 0o600);
			const config = new Config(configPath);

			chmodSync(dir, 0o500); // r-x: no new entries, existing file writable
			config.set("pg_password", "hunter2");
			chmodSync(dir, 0o700);

			expect(readFileSync(configPath, "utf8")).toContain("hunter2");
			expect(mode(configPath)).toBe(0o600);
		} finally {
			chmodSync(dir, 0o700);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("writes through a symlinked config path instead of replacing the link", () => {
		// The dotfiles arrangement. Renaming over the link would turn it into a
		// regular file and orphan the real target.
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-mode-"));
		try {
			const real = join(dir, "real.json");
			const link = join(dir, "config.json");
			writeFileSync(real, JSON.stringify({ lb_strategy: "session" }));
			symlinkSync(real, link);

			const config = new Config(link);
			config.set("pg_password", "hunter2");

			expect(lstatSync(link).isSymbolicLink()).toBe(true);
			expect(readFileSync(real, "utf8")).toContain("hunter2");
			expect(mode(real)).toBe(0o600);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("sweeps an old temp file but leaves a recent one alone", () => {
		// A leftover is 0600, so not a disclosure, but it holds pg_password and
		// the maintainer PAT and nothing else would ever remove it. A recent one
		// may be a save in flight in another process.
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-mode-"));
		try {
			const configPath = join(dir, "config.json");
			new Config(configPath);
			const old = `${configPath}.tmp-aaaaaaaa-0000-0000-0000-000000000000`;
			const recent = `${configPath}.tmp-bbbbbbbb-0000-0000-0000-000000000000`;
			writeFileSync(old, "stale", { mode: 0o600 });
			writeFileSync(recent, "in flight", { mode: 0o600 });
			const twoMinutesAgo = new Date(Date.now() - 120_000);
			utimesSync(old, twoMinutesAgo, twoMinutesAgo);

			new Config(configPath);

			expect(existsSync(old)).toBe(false);
			expect(existsSync(recent)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("sweeps temp files beside the target of a symlinked config", () => {
		// saveByRename() creates the temp next to the resolved target, so a sweep
		// keyed off the configured path would scan the wrong directory for the
		// wrong basename and never see them. Probed before the fix: the stale temp
		// beside the target survived every load.
		const root = mkdtempSync(join(tmpdir(), "better-ccflare-mode-"));
		try {
			const realDir = join(root, "dotfiles");
			mkdirSync(realDir);
			const real = join(realDir, "ccflare.json");
			const link = join(root, "config.json");
			writeFileSync(real, JSON.stringify({ lb_strategy: "session" }));
			symlinkSync(real, link);

			const stale = `${real}.tmp-aaaaaaaa-0000-0000-0000-000000000000`;
			writeFileSync(stale, "stale", { mode: 0o600 });
			const twoMinutesAgo = new Date(Date.now() - 120_000);
			utimesSync(stale, twoMinutesAgo, twoMinutesAgo);

			new Config(link);

			expect(existsSync(stale)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("sweeps only names it could have produced, not everything with the prefix", () => {
		// For a symlinked config the swept directory belongs to the user, not to
		// this application, so a bare prefix test destroys their files. Measured
		// before the UUID constraint: real.json.tmp-manual-backup-do-not-delete
		// was unlinked. Pre-upgrade pid-era names are left alone too, because a
		// directory we do not own is no place to guess.
		const root = mkdtempSync(join(tmpdir(), "better-ccflare-mode-"));
		try {
			const dots = join(root, "dotfiles");
			mkdirSync(dots);
			const real = join(dots, "real.json");
			const link = join(root, "config.json");
			writeFileSync(real, JSON.stringify({ lb_strategy: "session" }));
			symlinkSync(real, link);

			const keep = [
				"real.json.tmp-manual-backup-do-not-delete",
				"real.json.tmp-2026-09-01",
				"real.json.tmp-424242",
				"real.json.bak",
			];
			const remove = "real.json.tmp-aaaaaaaa-0000-0000-0000-000000000000";
			const twoMinutesAgo = new Date(Date.now() - 120_000);
			for (const name of [...keep, remove]) {
				const path = join(dots, name);
				writeFileSync(path, "content", { mode: 0o600 });
				utimesSync(path, twoMinutesAgo, twoMinutesAgo);
			}

			new Config(link);

			for (const name of keep) {
				expect(existsSync(join(dots, name))).toBe(true);
			}
			expect(existsSync(join(dots, remove))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("creates the target of a symlink whose target does not exist yet", () => {
		// Before this, existsSync() on a dangling link sent init down the new-file
		// branch, realpathSync() failed, and the rename replaced the link with a
		// regular file: the link was destroyed and the intended target never
		// appeared. Measured: link still a symlink false, target created false.
		const root = mkdtempSync(join(tmpdir(), "better-ccflare-mode-"));
		try {
			const dots = join(root, "dotfiles");
			mkdirSync(dots);
			const target = join(dots, "ccflare.json");
			const link = join(root, "config.json");
			symlinkSync(target, link);

			new Config(link);

			expect(lstatSync(link).isSymbolicLink()).toBe(true);
			expect(existsSync(target)).toBe(true);
			expect(mode(target)).toBe(0o600);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses to follow a config symlink in a directory others can write", () => {
		// os.tmpdir() is one of the validator's allowed base directories, and on
		// Linux that is /tmp at mode 1777, so another local user can plant a link
		// there. Following it would write the secrets into a file they chose, and
		// chmod follows links too: measured before the guard, an unrelated 0755
		// file became 0600 simply because the link pointed at it.
		//
		// The link here belongs to the test process, which is what keeps it in
		// place. A link of our own is never replaced, because only root may chown
		// a symlink, so one owned by us was created by us and is the operator's
		// arrangement rather than a planted one. The replacement path and the
		// ownership rule that bounds it live in config-untrusted-link-replace.test.ts.
		const shared = join(tmpdir(), `better-ccflare-shared-${process.pid}`);
		const victim = mkdtempSync(join(tmpdir(), "better-ccflare-victim-"));
		try {
			mkdirSync(shared);
			chmodSync(shared, 0o1777);
			const unrelated = join(victim, "some-binary");
			writeFileSync(unrelated, "#!/bin/sh\n");
			chmodSync(unrelated, 0o755);

			const link = join(shared, "config.json");
			symlinkSync(unrelated, link);

			const config = new Config(link);
			config.set("pg_password", "hunter2");

			expect(mode(unrelated)).toBe(0o755);
			expect(readFileSync(unrelated, "utf8")).toBe("#!/bin/sh\n");
			expect(lstatSync(link).isSymbolicLink()).toBe(true);
		} finally {
			rmSync(shared, { recursive: true, force: true });
			rmSync(victim, { recursive: true, force: true });
		}
	});

	it("escapes the basename, so a dot in it does not match any character", () => {
		// The matcher interpolates basename(target). Unescaped, the dot in
		// config.json matches any character, so configXjson.tmp-<uuid> becomes a
		// match and is deleted: the widening this matcher exists to prevent,
		// reintroduced through the one line meant to prevent it.
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-mode-"));
		try {
			const configPath = join(dir, "config.json");
			new Config(configPath);

			const decoy = join(
				dir,
				"configXjson.tmp-cccccccc-0000-0000-0000-000000000000",
			);
			const real = `${configPath}.tmp-dddddddd-0000-0000-0000-000000000000`;
			const twoMinutesAgo = new Date(Date.now() - 120_000);
			for (const path of [decoy, real]) {
				writeFileSync(path, "content", { mode: 0o600 });
				utimesSync(path, twoMinutesAgo, twoMinutesAgo);
			}

			new Config(configPath);

			expect(existsSync(decoy)).toBe(true);
			expect(existsSync(real)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not read a config through an untrusted symlink", () => {
		// Refusing only the write is the worst of both: the process keeps running
		// on a config an attacker supplied. local_control_secret is the sharpest
		// case, because choosing it is an authentication bypass on the local
		// control endpoint rather than a disclosure.
		const shared = join(tmpdir(), `better-ccflare-shared-read-${process.pid}`);
		const attacker = join(tmpdir(), `better-ccflare-att-${process.pid}.json`);
		try {
			mkdirSync(shared);
			chmodSync(shared, 0o1777);
			writeFileSync(
				attacker,
				JSON.stringify({ local_control_secret: "ATTACKER-CHOSEN" }),
			);
			const link = join(shared, "config.json");
			symlinkSync(attacker, link);

			const config = new Config(link);

			// Neither the initial load nor getLocalControlSecret()'s own re-read of
			// the file may adopt it. The second one is a separate reader and was
			// still returning the attacker's value when only the first was gated.
			expect(config.get("local_control_secret")).toBeUndefined();
			expect(config.getLocalControlSecret()).not.toBe("ATTACKER-CHOSEN");
		} finally {
			rmSync(shared, { recursive: true, force: true });
			rmSync(attacker, { force: true });
		}
	});

	it("does not follow a config symlink in a directory owned by another user", () => {
		// Two things this does and does not do, easy to conflate. It observes
		// behaviour rather than asserting a call, which is what makes it real, but
		// it reaches into process to get there. And it exercises the comparison,
		// not the OS: it proves the code refuses when the uid differs, while
		// POSIX's own ownership guarantee stays an argument rather than a
		// measurement, because that would need a second user account.
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-mode-"));
		const control = mkdtempSync(join(tmpdir(), "better-ccflare-ctl-"));
		const realGetuid = process.getuid;
		try {
			const target = join(dir, "real.json");
			const link = join(dir, "config.json");
			writeFileSync(target, JSON.stringify({ lb_strategy: "session" }));
			symlinkSync(target, link);

			// The directory is ours and 0700 from mkdtemp, so only ownership can
			// decide this. Make our own directory read as someone else's.
			process.getuid = () => 999999;
			const config = new Config(link);
			config.set("pg_password", "hunter2");

			// The link's target never sees the secret, which is the property. The
			// link itself is replaced rather than followed (SB23-1696), so what is
			// left at the config path is a regular file of ours.
			expect(readFileSync(target, "utf8")).not.toContain("hunter2");
			expect(lstatSync(link).isSymbolicLink()).toBe(false);
			expect(mode(link)).toBe(0o600);

			// Control, in its own directory because the link above is gone: with the
			// real uid the same layout is followed and the target does see the write.
			process.getuid = realGetuid;
			const allowedTarget = join(control, "real.json");
			const allowedLink = join(control, "config.json");
			writeFileSync(allowedTarget, JSON.stringify({ lb_strategy: "session" }));
			symlinkSync(allowedTarget, allowedLink);
			const allowed = new Config(allowedLink);
			allowed.set("pg_password", "hunter2");
			expect(readFileSync(allowedTarget, "utf8")).toContain("hunter2");
			expect(lstatSync(allowedLink).isSymbolicLink()).toBe(true);
		} finally {
			process.getuid = realGetuid;
			rmSync(dir, { recursive: true, force: true });
			rmSync(control, { recursive: true, force: true });
		}
	});

	it("does not chmod a config path that names a directory", () => {
		// Measured before the isFile() check: the directory went 0755 to 0600, the
		// better-ccflare.db beside it became unreachable, and even removing the
		// directory afterwards failed with ENOTEMPTY. The database lives in the
		// same directory as the config, so this locks the operator out of it.
		const root = mkdtempSync(join(tmpdir(), "better-ccflare-mode-"));
		try {
			const asDir = join(root, "config.json");
			mkdirSync(asDir);
			const sibling = join(asDir, "better-ccflare.db");
			writeFileSync(sibling, "db");

			new Config(asDir);

			expect(mode(asDir)).toBe(0o755);
			expect(existsSync(sibling)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves a whole dangling link chain, not just the first hop", () => {
		// config.json -> current.json -> missing.json is an ordinary rotation
		// arrangement. Stopping at the first hop renamed over current.json,
		// destroying the intermediate link the user manages while still leaving
		// missing.json absent.
		const root = mkdtempSync(join(tmpdir(), "better-ccflare-mode-"));
		try {
			const missing = join(root, "missing.json");
			const current = join(root, "current.json");
			const link = join(root, "config.json");
			symlinkSync(missing, current);
			symlinkSync(current, link);

			new Config(link);

			expect(lstatSync(link).isSymbolicLink()).toBe(true);
			expect(lstatSync(current).isSymbolicLink()).toBe(true);
			expect(existsSync(missing)).toBe(true);
			expect(mode(missing)).toBe(0o600);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a link that lands in a directory others can write", () => {
		// The first directory is not the one that receives the secret. Measured
		// before this check: first directory 0700 and trusted, final directory
		// 1777, and the secret was written there. The 0600 on the result is not
		// protection, because in a world-writable directory the attacker creates
		// the landing path themselves and can make it a link before we write.
		const home = mkdtempSync(join(tmpdir(), "better-ccflare-home-"));
		const shared = join(tmpdir(), `better-ccflare-land-${process.pid}`);
		try {
			mkdirSync(shared);
			chmodSync(shared, 0o1777);
			const landing = join(shared, "landed.json");
			const link = join(home, "config.json");
			symlinkSync(landing, link);

			const config = new Config(link);
			config.set("pg_password", "hunter2");

			expect(existsSync(landing)).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(shared, { recursive: true, force: true });
		}
	});

	it("refuses a symlink cycle instead of destroying the first link", () => {
		// Falling back to the configured path would rename over the first link and
		// destroy a link the operator manages, which is the behaviour the chain
		// walk exists to prevent, relocated to the cycle case.
		const root = mkdtempSync(join(tmpdir(), "better-ccflare-cycle-"));
		try {
			const a = join(root, "config.json");
			const b = join(root, "other.json");
			symlinkSync(b, a);
			symlinkSync(a, b);

			const config = new Config(a);
			config.set("pg_password", "hunter2");

			expect(lstatSync(a).isSymbolicLink()).toBe(true);
			expect(lstatSync(b).isSymbolicLink()).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a chain passing through a directory others can write", () => {
		// Both ends can be private while an intermediate hop is not, and whoever
		// controls that hop controls the destination. Measured before the per-hop
		// check, with safe/config.json (0700) -> shared/mid.json (1777) ->
		// private/authorized_keys (0700 and ours): both checked directories passed
		// and the victim file was overwritten with the config, destroying the key.
		// No disclosure, since the result is 0600 and ours, but an arbitrary file
		// overwrite anywhere we can write, with a target of their choosing.
		const safe = mkdtempSync(join(tmpdir(), "better-ccflare-safe-"));
		const priv = mkdtempSync(join(tmpdir(), "better-ccflare-priv-"));
		const shared = join(tmpdir(), `better-ccflare-mid-${process.pid}`);
		try {
			mkdirSync(shared);
			chmodSync(shared, 0o1777);
			const victim = join(priv, "authorized_keys");
			writeFileSync(victim, "ssh-ed25519 AAAA-REAL-KEY user@host\n");
			const mid = join(shared, "mid.json");
			const link = join(safe, "config.json");
			symlinkSync(victim, mid);
			symlinkSync(mid, link);

			const config = new Config(link);
			config.set("pg_password", "hunter2");

			expect(readFileSync(victim, "utf8")).toBe(
				"ssh-ed25519 AAAA-REAL-KEY user@host\n",
			);
		} finally {
			rmSync(safe, { recursive: true, force: true });
			rmSync(priv, { recursive: true, force: true });
			rmSync(shared, { recursive: true, force: true });
		}
	});

	it("still follows a private multi-hop chain", () => {
		// The per-hop check must not refuse a legitimate chain: every directory
		// here is ours and 0700, so all three hops pass.
		const root = mkdtempSync(join(tmpdir(), "better-ccflare-hops-"));
		try {
			const final = join(root, "final.json");
			const mid = join(root, "mid.json");
			const link = join(root, "config.json");
			writeFileSync(final, JSON.stringify({ lb_strategy: "session" }));
			symlinkSync(final, mid);
			symlinkSync(mid, link);

			const config = new Config(link);
			config.set("pg_password", "hunter2");

			expect(readFileSync(final, "utf8")).toContain("hunter2");
			expect(lstatSync(link).isSymbolicLink()).toBe(true);
			expect(lstatSync(mid).isSymbolicLink()).toBe(true);
			expect(mode(final)).toBe(0o600);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("still saves a regular config file in a directory others can write", () => {
		// The refusal is about a symlink redirecting the write, not about the
		// directory itself. A regular file in a 1777 directory has nothing to
		// redirect, so it must keep working: refusing there would break any
		// install that legitimately keeps its config in a shared directory.
		const shared = join(tmpdir(), `better-ccflare-shared-reg-${process.pid}`);
		try {
			mkdirSync(shared);
			chmodSync(shared, 0o1777);
			const configPath = join(shared, "config.json");

			const config = new Config(configPath);
			config.set("pg_password", "hunter2");

			expect(readFileSync(configPath, "utf8")).toContain("hunter2");
			expect(mode(configPath)).toBe(0o600);
		} finally {
			rmSync(shared, { recursive: true, force: true });
		}
	});

	it("will not write the config through a symlink planted at a temp path", () => {
		// The config's own directory can be writable by another local user. A
		// predictable temp name plus writeFileSync, which follows an existing
		// symlink, would put pg_password and the PAT in a file the attacker chose.
		// saveConfig() uses a random name opened with O_EXCL, so a planted link is
		// neither guessable nor followable.
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-mode-"));
		try {
			const configPath = join(dir, "config.json");
			const config = new Config(configPath);

			// The name the old predictable scheme would have used.
			const victim = join(dir, "victim.txt");
			writeFileSync(victim, "untouched", { mode: 0o600 });
			symlinkSync(victim, `${configPath}.tmp-${process.pid}`);

			config.set("pg_password", "hunter2");

			expect(readFileSync(victim, "utf8")).toBe("untouched");
			expect(readFileSync(configPath, "utf8")).toContain("hunter2");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves no temp file behind", () => {
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-mode-"));
		try {
			const configPath = join(dir, "config.json");
			const config = new Config(configPath);
			config.setStrategy(StrategyName.LeastUsed);
			expect(readdirSync(dir)).toEqual(["config.json"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
