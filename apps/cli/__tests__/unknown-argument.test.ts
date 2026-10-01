import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	KNOWN_FLAGS,
	nearestKnownArgument,
	unknownArgumentLines,
} from "../src/unknown-argument";

const HELP_LINE = "Run better-ccflare --help to see every option.";

describe("unknownArgumentLines", () => {
	it("suggests the nearest flag for a typo", () => {
		expect(unknownArgumentLines("--lsit")).toEqual([
			"❌ unknown argument: --lsit",
			"Did you mean: --list?",
			HELP_LINE,
		]);
	});

	it("suggests a flag for a positional that is a flag without its dashes", () => {
		// Distance 2 exactly, the edge of the threshold.
		expect(unknownArgumentLines("serve")).toEqual([
			"❌ unknown argument: serve",
			"Did you mean: --serve?",
			HELP_LINE,
		]);
	});

	it("suggests nothing beyond the threshold", () => {
		expect(unknownArgumentLines("--bogus")).toEqual([
			"❌ unknown argument: --bogus",
			HELP_LINE,
		]);
	});

	it("compares case-insensitively", () => {
		expect(unknownArgumentLines("--LIST")).toEqual([
			"❌ unknown argument: --LIST",
			"Did you mean: --list?",
			HELP_LINE,
		]);
	});

	it("suggests the subcommand for a near miss", () => {
		expect(unknownArgumentLines("tiu")).toEqual([
			"❌ unknown argument: tiu",
			"Did you mean: tui?",
			HELP_LINE,
		]);
	});

	it("says a subcommand must come first rather than suggesting itself", () => {
		expect(unknownArgumentLines("tui")).toEqual([
			"❌ unknown argument: tui",
			"tui is a subcommand and must be the first argument: better-ccflare tui --help",
			HELP_LINE,
		]);
	});

	it("names the next-argument form for --flag=value", () => {
		expect(unknownArgumentLines("--port=8081")).toEqual([
			"❌ unknown argument: --port=8081",
			"--port takes its value as the next argument: --port 8081",
			HELP_LINE,
		]);
	});

	it("falls back to a suggestion when the name before = is not a flag", () => {
		expect(unknownArgumentLines("--lsit=1")).toEqual([
			"❌ unknown argument: --lsit=1",
			HELP_LINE,
		]);
	});

	it("shows an empty argument as a quoted empty string", () => {
		expect(unknownArgumentLines("")).toEqual([
			'❌ unknown argument: ""',
			HELP_LINE,
		]);
	});
});

describe("nearestKnownArgument", () => {
	it("never suggests a one-letter flag", () => {
		// -x is distance 1 from both -v and -h.
		expect(nearestKnownArgument("-x")).toBeNull();
	});

	it("suggests a long flag for a single-dash spelling", () => {
		expect(nearestKnownArgument("-port")).toBe("--port");
	});
});

describe("KNOWN_FLAGS", () => {
	// The switch in parseArgs is what accepts a flag; KNOWN_FLAGS only feeds
	// the suggestion. Read the switch's case labels so the two cannot drift:
	// a flag added to one and not the other fails here.
	it("lists exactly the flags parseArgs' switch accepts", () => {
		const source = readFileSync(
			join(import.meta.dir, "../src/main.ts"),
			"utf8",
		);
		const start = source.indexOf("function parseArgs(");
		const end = source.indexOf("async function main()", start);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const cases = [
			...source.slice(start, end).matchAll(/case "(-[^"]*)":/g),
		].map((match) => match[1]);
		expect(cases.length).toBeGreaterThan(30);
		expect([...cases].sort()).toEqual([...KNOWN_FLAGS].sort());
	});
});
