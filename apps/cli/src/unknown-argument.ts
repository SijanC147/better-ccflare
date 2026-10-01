import { levenshteinDistance } from "@better-ccflare/core";

/**
 * The largest edit distance at which a near miss is still suggested. Shared
 * with `getModeSuggestions` in main.ts, so a mistyped flag and a mistyped
 * `--mode` value are held to the same rule.
 */
export const SUGGESTION_MAX_DISTANCE = 2;

/**
 * Every flag `parseArgs` in main.ts accepts, in the order its `switch` lists
 * them. Only used to suggest a near miss for an argument it does not know:
 * the `switch` is what accepts a flag, and a test reads main.ts to fail if
 * the two lists ever disagree.
 */
export const KNOWN_FLAGS = [
	"--version",
	"-v",
	"--help",
	"-h",
	"--serve",
	"--smol",
	"--port",
	"--ssl-key",
	"--ssl-cert",
	"--stats",
	"--add-account",
	"--mode",
	"--priority",
	"--profile",
	"--cross-region-mode",
	"--list",
	"--remove",
	"--pause",
	"--resume",
	"--set-priority",
	"--set-usage-pause-thresholds",
	"--analyze",
	"--repair-db",
	"--doctor",
	"--doctor-full",
	"--doctor-recover",
	"--reset-stats",
	"--clear-history",
	"--compact",
	"--get-model",
	"--set-model",
	"--generate-api-key",
	"--admin",
	"--list-api-keys",
	"--disable-api-key",
	"--enable-api-key",
	"--delete-api-key",
	"--reauthenticate",
	"--force-reset-rate-limit",
	"--show-config",
] as const;

/** The positional subcommands; each is only recognised as the first argument. */
export const SUBCOMMANDS = ["tui"] as const;

/**
 * The nearest long flag or subcommand to `arg`, or null when none is within
 * SUGGESTION_MAX_DISTANCE. Compared case-insensitively, so `--LIST` suggests
 * `--list`. The one-letter short flags are left out: every unknown one-letter
 * flag is within distance 1 of `-v` and `-h`, so suggesting them would name a
 * flag for every typo and mean nothing.
 */
export function nearestKnownArgument(arg: string): string | null {
	const input = arg.toLowerCase();
	let best: string | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const candidate of [...KNOWN_FLAGS, ...SUBCOMMANDS]) {
		if (!candidate.startsWith("--") && candidate.startsWith("-")) continue;
		const distance = levenshteinDistance(input, candidate);
		if (distance < bestDistance) {
			best = candidate;
			bestDistance = distance;
		}
	}
	return bestDistance <= SUGGESTION_MAX_DISTANCE ? best : null;
}

/**
 * The lines to print to stderr for an argument `parseArgs` does not
 * recognise, before exiting 1. Before this existed an unknown argument was
 * skipped and the no-argument path started the server, so a typo such as
 * `--lsit` booted a proxy on the default port (SB23-3729).
 */
export function unknownArgumentLines(arg: string): string[] {
	const shown = arg === "" ? '""' : arg;
	const lines = [`❌ unknown argument: ${shown}`];

	const equals = arg.indexOf("=");
	const name = equals > 0 ? arg.slice(0, equals) : null;
	if ((SUBCOMMANDS as readonly string[]).includes(arg)) {
		lines.push(
			`${arg} is a subcommand and must be the first argument: better-ccflare ${arg} --help`,
		);
	} else if (name && (KNOWN_FLAGS as readonly string[]).includes(name)) {
		lines.push(
			`${name} takes its value as the next argument: ${name} ${arg.slice(equals + 1)}`,
		);
	} else {
		const suggestion = nearestKnownArgument(arg);
		if (suggestion) lines.push(`Did you mean: ${suggestion}?`);
	}

	lines.push("Run better-ccflare --help to see every option.");
	return lines;
}
