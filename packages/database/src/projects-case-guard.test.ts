import { describe, expect, test } from "bun:test";
import { decideProjectsCaseMode } from "./projects-case-guard";

// SB23-1988. A project's primary key is sha1(canonical_path).slice(0, 16), and
// PROJECTS_CASE_SENSITIVE decides whether that path is stored lowercased. So
// flipping the setting on a populated database re-keys every projects row and
// detaches every requests.project_id that pointed at the old ids. These tests
// pin the four states of the guard that stops that happening silently.

describe("decideProjectsCaseMode", () => {
	test("refuses a flip from case-insensitive to case-sensitive on a populated table", () => {
		const decision = decideProjectsCaseMode({
			recorded: false,
			current: true,
			projectCount: 3,
			rowsHaveUppercase: false,
		});
		expect(decision.action).toBe("refuse");
		// The message must name the consequence, not just the condition: an
		// operator who is only told "cannot change the setting" learns nothing
		// about why, and reaches for the database by hand.
		expect(decision.message).toContain("sha1");
		expect(decision.message).toContain("re-key");
		expect(decision.message).toContain("requests.project_id");
		expect(decision.message).toContain("projects_case_sensitive_stored");
	});

	test("refuses a flip from case-sensitive to case-insensitive on a populated table", () => {
		const decision = decideProjectsCaseMode({
			recorded: true,
			current: false,
			projectCount: 3,
			rowsHaveUppercase: false,
		});
		expect(decision.action).toBe("refuse");
		expect(decision.message).toContain("requests.project_id");
	});

	test("records the current mode when the projects table is empty", () => {
		// No history exists to detach, so a flip is free and the marker simply
		// catches up.
		const decision = decideProjectsCaseMode({
			recorded: false,
			current: true,
			projectCount: 0,
			rowsHaveUppercase: false,
		});
		expect(decision.action).toBe("record");
		expect(decision.record).toBe(true);
	});

	test("records the current mode when no marker exists and the table is empty", () => {
		const decision = decideProjectsCaseMode({
			recorded: undefined,
			current: false,
			projectCount: 0,
			rowsHaveUppercase: false,
		});
		expect(decision.action).toBe("record");
		expect(decision.record).toBe(false);
	});

	test("adopts case-sensitive when the stored rows carry uppercase, whatever the setting says", () => {
		// The flip-then-upgrade hole. An operator flips the setting to
		// case-insensitive and only then upgrades into this guard. Adopting the
		// setting's current value would agree with itself, the guard would stay
		// silent, and the re-key would happen anyway. An uppercase character in
		// a stored path is proof those ids are real-case hashes, so the rows
		// decide, not the setting.
		const decision = decideProjectsCaseMode({
			recorded: undefined,
			current: false,
			projectCount: 12,
			rowsHaveUppercase: true,
		});
		expect(decision.action).toBe("refuse");
		expect(decision.message).toContain("requests.project_id");
	});

	test("adopts the current mode when no marker exists and projects already exist", () => {
		// All-lowercase rows prove nothing about which mode wrote them, so the
		// setting is the only evidence available and adopting it is the only
		// non-destructive answer. This is the quadrant the guard deliberately
		// leaves open, and every install that upgrades into the guard with
		// lowercase paths lands here: refusing would break their first boot.
		const decision = decideProjectsCaseMode({
			recorded: undefined,
			current: true,
			projectCount: 12,
			rowsHaveUppercase: false,
		});
		expect(decision.action).toBe("adopt");
		expect(decision.record).toBe(true);
		expect(decision.message).toContain("12");
	});

	test("proceeds when the marker already matches the current mode", () => {
		expect(
			decideProjectsCaseMode({
				recorded: true,
				current: true,
				projectCount: 12,
				rowsHaveUppercase: false,
			}).action,
		).toBe("ok");
		expect(
			decideProjectsCaseMode({
				recorded: false,
				current: false,
				projectCount: 12,
				rowsHaveUppercase: false,
			}).action,
		).toBe("ok");
	});
});
