import { join } from "node:path";
import { getPlatformConfigDir } from "./paths-common";

/**
 * Names of the environment variables that redirect the config path away from
 * the operator's home directory. Any one of them being set means the caller
 * has said where the config lives, so the fall-through below never runs.
 */
const REDIRECT_ENV_VARS = [
	"BETTER_CCFLARE_CONFIG_PATH",
	"ccflare_CONFIG_PATH",
	"XDG_CONFIG_HOME",
] as const;

/**
 * Refuse the home-directory fall-through under `bun test`.
 *
 * Three read-only sub-agents have written through a fixture whose path
 * resolved wrong, and one of them wrote a key into the operator's real
 * ~/.config/better-ccflare/better-ccflare.json. Every time the cause was the
 * same: a `Config` constructed with no path argument, falling through to here,
 * which silently resolved to the live file. The remedy is a resolver that
 * refuses rather than a stricter brief, because the failing call never
 * intended to name a path at all.
 *
 * The refusal is narrow on purpose. It fires only when the process is under
 * test AND no redirect is set, which is exactly "defaulted to the home
 * directory during a test run". The 18 production call sites that construct
 * `new Config()` with no argument are untouched, because NODE_ENV is not
 * "test" when the server or the CLI runs for real. A test that already
 * redirects, by any of the three variables above, keeps working unchanged.
 *
 * NODE_ENV is the marker because it is the one `bun test` actually sets;
 * measured 2026-09-18, BUN_ENV and BUN_TEST are both unset inside a test, so a
 * guard keyed on either would never fire.
 *
 * On Windows the platform directory comes from LOCALAPPDATA or APPDATA rather
 * than XDG_CONFIG_HOME, so this guard is inert there. That is left alone: the
 * incident it exists for happened on POSIX and the repository's suite runs on
 * macOS and Linux.
 */
function refuseHomeDirectoryFallThrough(resolved: string): never {
	throw new Error(
		`Refusing to resolve the config path to ${resolved} while NODE_ENV=test. ` +
			"A Config constructed with no path argument falls through to the operator's real config file, " +
			"which is how a test has previously written to it. " +
			"Pass an explicit path to the Config constructor, or set one of " +
			`${REDIRECT_ENV_VARS.join(", ")} to a temporary directory.`,
	);
}

export function resolveConfigPath(): string {
	// Check for explicit config path from environment (support both old and new env var names)
	const explicitPath =
		process.env.BETTER_CCFLARE_CONFIG_PATH || process.env.ccflare_CONFIG_PATH;
	if (explicitPath) {
		return explicitPath;
	}

	// Use common platform config directory
	const configDir = getPlatformConfigDir();
	const resolved = join(configDir, "better-ccflare.json");

	if (
		process.env.NODE_ENV === "test" &&
		REDIRECT_ENV_VARS.every((name) => !process.env[name])
	) {
		refuseHomeDirectoryFallThrough(resolved);
	}

	return resolved;
}
