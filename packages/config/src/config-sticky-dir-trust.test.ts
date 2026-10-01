import { describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
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
import { logBus } from "@better-ccflare/logger";
import { stickyFixture } from "@better-ccflare/security/testing";
import type { LogEvent } from "@better-ccflare/types";
import { __setEntryLstatForTest, lstatEntryForTrust } from "./entry-lstat-seam";
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
 * The `own.uid === uid` comparison is reached through a gated lstat seam
 * (SB23-2316), in the "whose entry reads as another user's" block below. It was
 * the one mutation that survived this file when SB23-2267 shipped: on macOS a
 * sticky directory a test creates is owned by the test process, so every entry
 * in it reads as ours, and stubbing `process.getuid` to a stranger instead is
 * refused one line earlier by the directory-ownership test. On Linux the
 * fixture is the root-owned /tmp, which that check admits, but the seam works
 * on both platforms. Pointing TMPDIR at the
 * root-owned /private/tmp was tried and measured: it made the comparison
 * reachable, then failed inside the full suite, because the path validator
 * memoises its allowed base paths on first use and exports no reset for them.
 * The seam swaps only the entry's lstat, and only its uid and nlink, so the
 * directory checks run for real.
 *
 * The nlink conjunct is separately covered, by the hardlink test below.
 */

/**
 * The sticky directory these tests need is built by the shared fixture in
 * @better-ccflare/security/testing. Two routes, because Bun's chmodSync silently
 * drops S_ISVTX on Linux and os.tmpdir() is 0700 on macOS; the helper's own doc
 * comment carries the measurement (SB23-2319).
 */

describe("a config symlink in a sticky directory", () => {
	it("is followed for read and write when the link is ours", () => {
		// The link is created by this process, so it is ours, and in a sticky
		// directory nobody else could have put it there or replaced it. Before
		// this rule the whole config was refused: the read returned nothing and
		// the process ran on defaults with a fresh local_control_secret.
		const fx = stickyFixture("sticky-ours");
		const target = mkdtempSync(join(tmpdir(), "better-ccflare-sticky-tgt-"));
		try {
			const link = fx.entry("config.json");
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
			fx.cleanup();
			rmSync(target, { recursive: true, force: true });
		}
	});

	it("names the missing entry, not the directory, when the landing name is absent", () => {
		// SB23-2318. The message used to say the directory was owned by another
		// user or writable by others and to tell the operator to move the config.
		// In a sticky directory that is the case the rule from SB23-2267 exists to
		// ALLOW, so the sentence was false about the directory and the instruction
		// did not fix the condition: moving the file does not create an entry at
		// the name the walk checks.
		//
		// Asserted on the text, not the level. A test in this family pinned the
		// level and the file mode and never read the message, so it stayed green
		// while the message contradicted the mode asserted two lines above it.
		const fx = stickyFixture("sticky-msg");
		const home = mkdtempSync(join(tmpdir(), "better-ccflare-sticky-msghome-"));
		try {
			const landing = fx.entry("absent.json");
			const link = join(home, "config.json");
			symlinkSync(landing, link);
			expect(existsSync(landing)).toBe(false);

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

			// What the code actually read: lstat of the entry, for existence, its
			// link count and its uid. Stated as a disjunction because those three
			// share one catch and this branch does not know which one it hit.
			expect(msg).toContain("sits in a sticky directory");
			expect(msg).toContain("has exactly one hard link");
			expect(msg).toContain(
				"Moving the config to another name in the same shared directory does not satisfy this.",
			);
			// And the consequence the operator otherwise reads as an intermittent
			// auth bug.
			expect(msg).toContain("regenerates local_control_secret");

			// The neighbouring branch's instruction must NOT appear. This is the
			// whole defect: that sentence was what shipped here.
			expect(msg).not.toContain(
				"Move the config somewhere only you can write, or replace the link with a regular file.",
			);
			expect(msg).not.toContain(
				"is owned by another user, or is writable by other",
			);
		} finally {
			fx.cleanup();
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("names the directory when the directory is the untrusted part", () => {
		// The other half of the same split, so neither message can drift into the
		// other's case without a failure here. A world-writable directory WITHOUT
		// the sticky bit is the `directory` reason: nothing restricts who may
		// replace the link, so the entry's ownership is not what is wrong.
		const shared = mkdtempSync(join(tmpdir(), "better-ccflare-nonsticky-"));
		const home = mkdtempSync(join(tmpdir(), "better-ccflare-nonsticky-home-"));
		try {
			chmodSync(shared, 0o777);
			// The premise, measured rather than assumed: writable by others and not
			// sticky. Bun's chmodSync drops S_ISVTX on Linux (SB23-2319), which is
			// why this direction is the one that is reliable on both platforms.
			const dirMode = statSync(shared).mode;
			expect(dirMode & 0o022).not.toBe(0);
			expect(dirMode & 0o1000).toBe(0);

			const landing = join(shared, "landed.json");
			writeFileSync(landing, JSON.stringify({ lb_strategy: "session" }), {
				mode: 0o600,
			});
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
			expect(refusals.length).toBeGreaterThan(0);
			const msg = refusals[0].msg;

			expect(msg).toContain(
				"is owned by another user, or is writable by other",
			);
			expect(msg).toContain(
				"Move the config somewhere only you can write, or replace the link with a regular file.",
			);
			expect(msg).toContain("regenerates local_control_secret");

			// And not the sticky branch's text, whose instruction would be wrong
			// here: creating the entry changes nothing when anyone may replace it.
			expect(msg).not.toContain("sits in a sticky directory");
			expect(msg).not.toContain(
				"Moving the config to another name in the same shared directory does not satisfy this.",
			);
		} finally {
			rmSync(shared, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("is refused when the chain lands on a name nothing owns yet", () => {
		// The landing path does not exist, so there is no entry whose ownership
		// could be compared, and the sticky bit does not stop another user
		// creating one. A rule that read an absent entry as ours would write the
		// secrets to a name an attacker can claim first.
		const fx = stickyFixture("sticky-land");
		const home = mkdtempSync(join(tmpdir(), "better-ccflare-sticky-home-"));
		try {
			const landing = fx.entry("landed.json");
			const link = join(home, "config.json");
			symlinkSync(landing, link);
			expect(dirname(landing)).toBe(fx.dir);
			// The name must be absent, which is the whole premise. A leftover from an
			// earlier run would make this pass for the wrong reason.
			expect(existsSync(landing)).toBe(false);

			const config = new Config(link);
			config.set("pg_password", "hunter2");

			expect(() => statSync(landing)).toThrow();
		} finally {
			fx.cleanup();
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
		const fx = stickyFixture("sticky-hardlink");
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
			const landing = fx.entry("landed.json");
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
			fx.cleanup();
			rmSync(other, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});
});

/**
 * Make one entry read as owned by `reportedUid(realUid)`, with its real link
 * count, for the duration of `fn`, and return how many times the trust check
 * read that entry. Every other path passes through to the real lstat.
 *
 * Restored in a `finally`: `bun test` shares one process across files, and a
 * stub left installed would decide every later sticky-directory trust check in
 * it.
 */
function withEntryOwner(
	entry: string,
	reportedUid: (realUid: number) => number,
	fn: () => void,
): number {
	let reached = 0;
	__setEntryLstatForTest((path) => {
		const real = lstatSync(path);
		if (path !== entry) return real;
		reached++;
		return { uid: reportedUid(real.uid), nlink: real.nlink };
	});
	try {
		fn();
	} finally {
		__setEntryLstatForTest(null);
	}
	return reached;
}

describe("a config symlink in a sticky directory whose entry reads as another user's", () => {
	// SB23-2316. The fixture is "is followed for read and write when the link is
	// ours" above, unchanged except that the trust check's lstat of the link
	// reports a different uid. The directory is ours and sticky, the link is a
	// symlink with one name, so the only line in entryIsTrusted() that can tell
	// the two cases below apart is the uid comparison.
	function linkFixture(
		label: string,
		fn: (link: string, real: string) => void,
	) {
		const fx = stickyFixture(label);
		const target = mkdtempSync(join(tmpdir(), "better-ccflare-sticky-own-"));
		try {
			const link = fx.entry("config.json");
			const real = join(target, "config.json");
			writeFileSync(real, JSON.stringify({ lb_strategy: "session" }), {
				mode: 0o600,
			});
			symlinkSync(real, link);
			// The premise, measured: the link really is ours and has one name, so a
			// refusal below cannot come from the nlink conjunct or from a real
			// stranger's entry.
			expect(lstatSync(link).uid).toBe(process.getuid?.() ?? -1);
			expect(lstatSync(link).nlink).toBe(1);
			fn(link, real);
		} finally {
			fx.cleanup();
			rmSync(target, { recursive: true, force: true });
		}
	}

	// Three foreign uids, not one (PR #293 review, F3). With only uid+1, both
	// `own.uid <= uid` and `own.uid === uid || own.uid === 0` survived the whole
	// config suite: the first trusts any lower uid's planted link, the second is
	// the plausible "consistency" edit, since the directory check and
	// trustedRegularPath() both accept root. Root is refused here on purpose: a
	// root-owned entry in a sticky directory is not one we created. A value equal
	// to our own uid is dropped, which only happens for 0 when the suite runs as
	// root.
	const ownUid = process.getuid?.() ?? -1;
	const strangers: Array<[string, (uid: number) => number]> = [
		["a higher uid", (uid) => uid + 1],
		["a lower uid", (uid) => uid - 1],
		["root", () => 0],
	];
	for (const [label, stranger] of strangers.filter(
		([, pick]) => pick(ownUid) !== ownUid,
	)) {
		it(`is refused, for read and write, when the entry's uid is ${label}`, () => {
			linkFixture(
				`sticky-stranger-${label.replace(/ /g, "-")}`,
				(link, real) => {
					let config: Config | undefined;
					let logs: LogEvent[] = [];
					const reached = withEntryOwner(link, stranger, () => {
						logs = captureLogs(() => {
							config = new Config(link);
							config.set("pg_password", "hunter2");
						});
					});
					// The stub was consulted for this entry. Without this a call site that
					// bypassed the seam would leave the comparison reading our real uid, and
					// the assertions below would fail for a reason that says nothing about
					// the comparison.
					expect(reached).toBeGreaterThan(0);

					// Not read: the process runs on defaults rather than the link's target.
					expect(config?.get("lb_strategy")).toBeUndefined();
					// Not written through.
					expect(readFileSync(real, "utf8")).not.toContain("hunter2");
					expect(lstatSync(link).isSymbolicLink()).toBe(true);

					// Refused by the sticky-entry branch, naming the entry, and nothing
					// else. Whole message: the directory branch's text would mean the
					// refusal came from a check this test is not about.
					const uid = process.getuid?.() ?? "unknown";
					const refusals = logs.filter(
						(event) =>
							event.level === "ERROR" &&
							event.msg.startsWith("Refusing the config path"),
					);
					expect(refusals).toHaveLength(1);
					expect(refusals[0].msg).toBe(
						`Refusing the config path ${link}: ${link} sits in a sticky ` +
							"directory, where this path is trusted only when an entry already exists at " +
							"that exact name, has exactly one hard link, and is owned by uid " +
							`${uid}. One of those is not true of ${link}. A sticky bit ` +
							"restricts who may remove an entry, never who may create one, so a name that " +
							"does not exist yet is another local user's to claim first, and a name with a " +
							"second hard link was not written as our config. Create that entry yourself " +
							"before starting, or point the config at a directory no other local user can " +
							"write. Moving the config to another name in the same shared directory does " +
							"not satisfy this. If this line appears at startup then the config was not " +
							"read and this process is running on defaults, which regenerates " +
							"local_control_secret, so anything holding the previous one stops " +
							"authenticating against the local control endpoint.",
					);
				},
			);
		});
	}

	it("is followed when the same stub reports our own uid", () => {
		// The control. Same fixture, same stub, same pass-through of nlink; only
		// the reported uid differs. Without it, a stub that broke the trust check
		// some other way would make the test above pass for the wrong reason.
		linkFixture("sticky-self", (link, real) => {
			let config: Config | undefined;
			let logs: LogEvent[] = [];
			const reached = withEntryOwner(
				link,
				(uid) => uid,
				() => {
					logs = captureLogs(() => {
						config = new Config(link);
						config.set("pg_password", "hunter2");
					});
				},
			);
			expect(reached).toBeGreaterThan(0);
			expect(config?.get("lb_strategy")).toBe("session");
			expect(readFileSync(real, "utf8")).toContain("hunter2");
			expect(
				logs.filter((event) =>
					event.msg.startsWith("Refusing the config path"),
				),
			).toHaveLength(0);
		});
	});
});

describe("the entry-lstat seam's NODE_ENV gate", () => {
	const GATE_REFUSAL =
		"__setEntryLstatForTest is available only while NODE_ENV=test. " +
		"Swapping the lstat this package's config trust check calls outside a " +
		"test run would let a caller choose who owns the config entry, which " +
		"decides whether local_control_secret is read through a link in a " +
		"shared directory.";

	it("refuses to swap the lstat when NODE_ENV is not test, and always restores", () => {
		const saved = process.env.NODE_ENV;
		try {
			for (const value of ["production", undefined]) {
				if (value === undefined) delete process.env.NODE_ENV;
				else process.env.NODE_ENV = value;
				let thrown: unknown;
				try {
					__setEntryLstatForTest(() => ({ uid: 0, nlink: 1 }));
				} catch (error) {
					thrown = error;
				}
				// Whole message with toBe. toThrow(string) is a substring match.
				expect(thrown).toBeInstanceOf(Error);
				expect((thrown as Error).message).toBe(GATE_REFUSAL);
				expect(() => __setEntryLstatForTest(null)).not.toThrow();
			}
		} finally {
			process.env.NODE_ENV = saved;
			__setEntryLstatForTest(null);
		}
	});
});

describe("the entry-lstat seam's production default", () => {
	it("reads the entry itself, not what a symlink points at", () => {
		// PR #293 review, F1. index.ts calls lstat-not-stat load-bearing: a link
		// read through stat substitutes the uid of whatever it points at, which is
		// the attacker's choice. No stubbed test can see the default, so this one
		// installs nothing. The link is ours with one name; its target is ours
		// with TWO names, so stat would report nlink 2 and the hardlink conjunct
		// would refuse a config that lstat correctly follows.
		const fx = stickyFixture("lstat-default");
		const target = mkdtempSync(join(tmpdir(), "better-ccflare-lstat-tgt-"));
		const second = mkdtempSync(join(tmpdir(), "better-ccflare-lstat-2nd-"));
		try {
			const real = join(target, "config.json");
			writeFileSync(real, JSON.stringify({ lb_strategy: "session" }), {
				mode: 0o600,
			});
			linkSync(real, join(second, "other-name.json"));
			const link = fx.entry("config.json");
			symlinkSync(real, link);
			// The premise: the two reads disagree on this entry.
			expect(lstatSync(link).nlink).toBe(1);
			expect(statSync(link).nlink).toBe(2);

			// The default, directly, and through the trust decision.
			expect(lstatEntryForTrust(link).nlink).toBe(1);
			const config = new Config(link);
			expect(config.get("lb_strategy")).toBe("session");
		} finally {
			fx.cleanup();
			rmSync(target, { recursive: true, force: true });
			rmSync(second, { recursive: true, force: true });
		}
	});

	it("is left in place by a refused install, and put back by null", () => {
		// PR #293 review, F4. The gate test checks the refusal text and then
		// restores, which hides whether a refused install moved the reference
		// anyway, and whether null restores at all: both mutations survived the
		// whole config suite, because withEntryOwner's stub passes every other path
		// through to the real lstat.
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-lstat-restore-"));
		const saved = process.env.NODE_ENV;
		try {
			const file = join(dir, "f");
			writeFileSync(file, "x");
			const real = lstatSync(file);
			const bogus = () => ({ uid: real.uid + 7, nlink: 42 });

			process.env.NODE_ENV = "production";
			expect(() => __setEntryLstatForTest(bogus)).toThrow();
			expect(lstatEntryForTrust(file).nlink).toBe(real.nlink);
			expect(lstatEntryForTrust(file).uid).toBe(real.uid);

			process.env.NODE_ENV = saved;
			__setEntryLstatForTest(bogus);
			expect(lstatEntryForTrust(file).nlink).toBe(42);
			__setEntryLstatForTest(null);
			expect(lstatEntryForTrust(file).nlink).toBe(real.nlink);
			expect(lstatEntryForTrust(file).uid).toBe(real.uid);
		} finally {
			process.env.NODE_ENV = saved;
			__setEntryLstatForTest(null);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
