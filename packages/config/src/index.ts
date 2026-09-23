import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	closeSync,
	existsSync,
	fchmodSync,
	fchownSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
	DEFAULT_AGENT_MODEL,
	DEFAULT_STRATEGY,
	isValidStrategy,
	NETWORK,
	RETRY_DEFAULTS,
	type StrategyName,
	TIME_CONSTANTS,
	ValidationError,
	validateEndpointUrl,
	validateNumber,
	validateString,
} from "@better-ccflare/core";
import { Logger, type OpenObserveSettings } from "@better-ccflare/logger";
import { validatePathOrThrow } from "@better-ccflare/security";
import { chmodForConfig } from "./chmod-seam";
import { resolveConfigPath } from "./paths";
import { getPlatformConfigDir } from "./paths-common";
import {
	validateRuntimeRetry,
	validateRuntimeSessionDuration,
} from "./runtime-validation";

const log = new Logger("Config");

/**
 * How old a leftover save temp file must be before a sweep removes it. A newer
 * one may be a save in flight in another process; deleting it would only force
 * that process onto the in-place write path.
 */
const TEMP_FILE_STALE_AFTER_MS = 60_000;

/**
 * 0600 for the config file and 0700 for the directory holding it. The file
 * holds pg_password, local_control_secret and upstream_maintainer_token, which
 * is a GitHub PAT, and the directory holds the database beside it.
 */
const CONFIG_FILE_MODE = 0o600;
const CONFIG_DIR_MODE = 0o700;

/**
 * Paths already reported as unenforceable, so the warning below lands once per
 * process rather than once per load.
 *
 * Module-scoped because the condition is a property of the filesystem, not of a
 * Config instance, and more than one Config can be constructed in a process.
 * Keyed by path rather than a single boolean so a process holding two configs
 * on different filesystems still hears about both; the set is bounded by the
 * number of distinct config paths, which is one or two.
 *
 * Private. It was exported for tests until SB23-2365, and that export was the
 * problem rather than the fix: readRegularFile() branches on this Set to decide
 * whether a writable config is reported at ERROR or WARN, so a test that
 * pre-seeded the Set selected the branch WITHOUT running the chmod, re-stat and
 * compare the branch depends on. A mutation deleting the chmodAndVerify() call
 * at the report site therefore survived the whole config suite, 187 pass and 0
 * fail at head 5ba29b23. Tests now swap the chmod itself, through
 * __setChmodForTest() in ./chmod-seam, which makes the compare run for real on a
 * real 0666 file and fills this Set the way a bind mount would.
 */
const unenforceableModes = new Set<string>();

/**
 * Config paths already reported as writable by other local users, so the warning
 * lands once per process rather than once per reader.
 *
 * getLocalControlSecret() re-reads the file on its own, so without this the line
 * appears more than once per boot. Same technique and same reason as
 * unenforceableModes above. Deliberately never cleared: on a filesystem that
 * cannot enforce modes, or where the chmod is refused, the condition is
 * permanent and repeating it every boot is
 * the point, while repeating it three times in one boot is noise.
 */
const contentsNotOurs = new Set<string>();

/**
 * Whether other local users could write a config path, as observed on the FIRST
 * read any Config in this process performed of it, before anything chmodded it
 * (SB23-2366).
 *
 * Captured once and reused rather than re-derived, because the mode changes
 * underneath every later reader. readConfigData() brings a writable file to 0600
 * at its own report site, a few lines below the stat, and restrictConfigFile()
 * runs again after loadConfig() returns. So a later read stats 0600, concludes
 * the file is trustworthy, strips nothing, and adopts a planted
 * local_control_secret, which is an authentication bypass against the local
 * control endpoint rather than a disclosure.
 *
 * Module-scoped and keyed by path, beside contentsNotOurs and unenforceableModes
 * and for the same reason: the condition is a property of the FILE, and every
 * Config in the process shares that file. A per-instance version of this shipped
 * in the first draft of SB23-2366 and was wrong in a way its own docstring
 * argued for. It fixed the second read within one instance and left the instance
 * boundary open, which is worse than it sounds, because the FIRST instance is
 * what chmods the file to 0600. So a second Config built microseconds later
 * stats a file this process just made look clean, strips nothing, adopts the
 * plant, and has an empty strippedFields, so its saveConfig() does not refuse
 * and writes the attacker's values back into a 0600 file. That is precisely the
 * laundering saveConfig() declines to do deliberately one method away.
 *
 * Measured by this PR's reviewer at 6217144c: with a per-instance memo, a second
 * Config on the same path returned the planted secret, returned the attacker's
 * DSN from buildPgConnectionUrl(), and persisted a set() beside both. Three
 * reachable second-instance sites exist in the long-lived server:
 * packages/http-api/src/handlers/oauth.ts:878 and :971, and
 * packages/database/src/database-operations.ts:389, which calls
 * buildPgConnectionUrl() itself. loadConfig()'s own comment names the oauth pair
 * as the reason a second Config exists at all.
 *
 * An absent key is not the same as false: it means no read has happened yet, and
 * a config file that did not exist at construction is created at 0600 by
 * saveConfig(), so a later read of it should stat fresh.
 *
 * Never cleared, matching its neighbours. A NEW process re-stats and gets a
 * fresh answer, which is what lets an operator fix the mode and recover. What
 * this refuses to do is let the process forget a change it made itself.
 *
 * This does NOT close the next-boot window, and saying so plainly because it
 * will otherwise be read as closed: the file still holds the attacker's bytes at
 * 0600, and the next process adopts them. That is the acknowledged SB23-2338
 * trade, already recorded below at the writable-config report.
 */
const writableAtFirstRead = new Map<string, boolean>();

/** Config paths whose stripped fields have already been named, once per process. */
const strippedFieldsReported = new Set<string>();

/**
 * Whole families that are an endpoint or a credential, stripped from a config
 * another local user can write (SB23-2351).
 *
 * `pg_` is the family and not just `pg_password`, because `pg_enabled` is the gate
 * that makes the rest take effect: apps/server bridges these into DATABASE_URL when
 * it is unset, so an attacker who sets the whole family points every credential
 * this process later persists at a database they own, and the accounts table stores
 * api_key, refresh_token and access_token as plaintext. `openobserve_` likewise:
 * the stream names are harmless alone, but the family is an outbound destination.
 *
 * `alert_` is deliberately NOT here. Those are numeric thresholds and keeping them
 * costs nothing; only alert_webhook_url is an endpoint, and it is named below.
 */
const UNTRUSTED_FIELD_PREFIXES = ["pg_", "openobserve_"] as const;

/** Individually named endpoints and credentials that no prefix or suffix catches. */
const UNTRUSTED_FIELDS = new Set([
	"alert_webhook_url",
	"outbound_proxy",
	"claude_projects_dir",
	"github_read_token",
	"upstream_maintainer_token",
	// Not a credential, and included anyway. An attacker-set client_id points the
	// OAuth authorization flow at an app registration they control, which is a
	// trust decision rather than a setting. Found by this PR's reviewer; declared
	// at ConfigData and read into defaults.clientId, and caught by no prefix,
	// name or suffix before this.
	"client_id",
	"local_control_secret",
]);

/**
 * Anything whose name ends this way, whether or not it was listed.
 *
 * This is the half that answers the acceptance criterion's actual reason. It asked
 * for a positive allowlist because ConfigData carries an index signature, so a
 * credential field added later would be adopted by default with nobody having to
 * forget anything. A suffix rule closes that without enumerating the roughly fifty
 * safe fields, whose own failure mode is worse: a legitimate setting missed from an
 * allowlist silently stops loading, with nothing to say why, which is the
 * looks-fine-but-does-nothing shape this family keeps producing.
 */
const UNTRUSTED_FIELD_SUFFIX = /(?:token|secret|password)$/;

function isUntrustedField(key: string): boolean {
	return (
		UNTRUSTED_FIELD_SUFFIX.test(key) ||
		UNTRUSTED_FIELDS.has(key) ||
		UNTRUSTED_FIELD_PREFIXES.some((prefix) => key.startsWith(prefix))
	);
}

/**
 * Why a hop failed the walk's trust check, rather than whether it failed
 * (SB23-2318).
 *
 * A boolean could not carry this, and the single message it forced named the
 * directory in both cases. `directory` and `sticky-entry` call for opposite
 * actions: the first says move the config out of a directory others can write,
 * the second says the directory is fine and the entry inside it is what is
 * missing or is not ours.
 *
 * `sticky-entry` deliberately does not distinguish absent, multi-linked and
 * foreign-owned, because those three share one `lstatSync` and one catch and the
 * caller genuinely does not know which one it hit.
 *
 * Two things the messages state more narrowly than the branches can, disclosed
 * rather than branched on:
 *
 * `directory` is also returned when `statSync(dirname)` THREW, where nothing
 * about ownership or mode was read. The message leads with "could not be
 * examined" for that reason. Reachable through a dangling link into a directory
 * that does not exist.
 *
 * `sticky-entry` is also returned when `process.getuid` is unavailable, before
 * any `lstat` runs, so the message's "one of those is not true" describes an
 * entry nothing looked at. Unreachable from both callers, which return earlier
 * on an undefined uid (`writeTarget()` on win32, `replaceUntrustedLink()`
 * explicitly), so a branch for it would be untestable code rather than a fix.
 */
/**
 * What a reader of the config file does when it cannot turn the bytes into
 * config data (SB23-2469, F1 from this PR's review).
 *
 * "refuse-saves" belongs to the reader whose result BECOMES `this.data`. Its
 * failure means the instance is running on an empty config, so writing that
 * config back would replace the file with it.
 *
 * "report-only" belongs to readLocalControlSecretFromDisk(), which reads one
 * field and discards the rest. It runs on an instance whose load ALREADY
 * SUCCEEDED and whose `this.data` is complete, so its failure says nothing about
 * whether a save would lose anything, and it already has a correct answer for
 * failure: return undefined and let the caller generate a fresh secret.
 *
 * A parameter rather than a flag set inside readConfigData(), which is where the
 * first draft put it and was wrong. That draft's docstring argued "there are two
 * readers and a flag set by one is a flag the other can miss", which assumes the
 * two readers fail under the same condition. They do not. Measured on that
 * draft: a valid 0600 config, an instance that loaded it cleanly with
 * pg_password live in memory, the file transiently unparseable for the duration
 * of one getLocalControlSecret() call, then valid again. Every later set() from
 * that instance was refused for the life of the process, the file kept
 * lb_strategy "session" while memory held "round-robin", and the refusal printed
 * "this process is running on defaults" while pg_password sat in this.data. A
 * long-lived server that silently never persists another setting.
 *
 * Reachable without an attacker: an operator hand-editing the config, which is a
 * documented workflow, or the zero-byte window of the in-place writeFileSync
 * fallback that the CLI-versus-server race readLocalControlSecretFromDisk()
 * exists for.
 */
type ReadFailureHandling = "refuse-saves" | "report-only";

type RefusedTrust = "directory" | "sticky-entry";
type EntryTrust = "trusted" | RefusedTrust;

/**
 * Refusal diagnoses already emitted, so each distinct one lands once per
 * process rather than once per reader (SB23-2357).
 *
 * Three readers re-run the trust check on one boot: loadConfig(),
 * readLocalControlSecretFromDisk(), and the saveConfig() that
 * getLocalControlSecret() performs after generating a replacement secret. Each
 * printed the same multi-sentence paragraph, while the writable-config warning
 * beside it deduplicated through contentsNotOurs. The asymmetry was the issue;
 * this is the side it was settled on, because the condition is one fact about
 * one path and repeating the explanation three times is what trains an operator
 * to scroll past it.
 *
 * What is NOT deduplicated, deliberately: saveConfig()'s "Config not saved"
 * line. That one reports an OPERATION, and each refused save is a separate lost
 * write, so suppressing the second would hide a settings change that did not
 * persist. The split is diagnosis once, outcome every time.
 *
 * Keyed on the message rather than on the path, so a hop that starts failing
 * for a different reason mid-process still says so. Bounded by the number of
 * distinct refusal texts, which is the number of distinct (path, hop, reason)
 * triples a process can produce.
 *
 * Never cleared, matching unenforceableModes and contentsNotOurs: the condition
 * is a fact about the filesystem, so it persists for the process's lifetime and
 * repeating it on the next boot is the point.
 */
const refusalsEmitted = new Set<string>();

/**
 * chmod a path and then read the mode back, returning whether it actually
 * changed.
 *
 * chmodSync reports success and changes nothing on Docker Desktop bind mounts
 * from a macOS or Windows host and on FAT and exFAT volumes.
 * docs/deployment.md:304 documents the config on a Docker volume, so that is a
 * real layout, and the result was a guard that came out true on every load
 * while the file stayed world-readable and nothing said so. Catching a chmod
 * that throws was never enough (SB23-1686).
 *
 * Skipped entirely on Windows, and the skip is the load-bearing half. There
 * statSync().mode & 0o777 reports 0666 for any writable file and 0444 for a
 * read-only one, because Node derives st_mode from FILE_ATTRIBUTE_READONLY and
 * there is no POSIX mode to read back. A re-stat without this branch would
 * conclude the chmod did not take on every Windows start, trading a silent
 * failure on bind mounts for a false alarm across a whole platform. Unverified
 * on Windows, which neither author nor reviewer has: argued from libuv, the
 * same rung as the win32 branch in writeTarget().
 *
 * Warns rather than throws, and the caller does not branch on the result.
 * chmod fails legitimately on a bind-mounted volume and on a file owned by
 * another user, and neither means the config is unusable, which is the
 * convention packages/database/src/file-modes.ts already sets for the database
 * files.
 */
function chmodAndVerify(path: string, mode: number, what: string): void {
	chmodForConfig(path, mode);
	if (process.platform === "win32") {
		log.info(`Restricted ${what} permissions to ${modeText(mode)}`);
		return;
	}
	const after = statSync(path).mode & 0o777;
	if (after === mode) {
		log.info(`Restricted ${what} permissions to ${modeText(mode)}`);
		return;
	}
	if (unenforceableModes.has(path)) return;
	unenforceableModes.add(path);
	log.warn(
		`chmod on the ${what} ${path} reported success but the mode is still ` +
			`${modeText(after)} rather than ${modeText(mode)}, so it may be readable ` +
			`by other local users. Filesystems without Unix modes behave this way, ` +
			`including Docker bind mounts from a macOS or Windows host and FAT or ` +
			`exFAT volumes. Move the config onto a filesystem that enforces modes, ` +
			`or mount it so only this user can read it.`,
	);
}

/** `0o600` for a log line, so a mode is never printed as the decimal 384. */
function modeText(mode: number): string {
	return `0${mode.toString(8).padStart(3, "0")}`;
}

/**
 * Name what a config file parsed to when it was not an object, for the refusal
 * that follows (SB23-2469).
 *
 * `typeof null` is "object", which is the whole reason the caller tests for null
 * separately, so this would print "an object" for the one shape most likely to
 * be there: a file holding the four bytes `null`.
 *
 * Arrays are named as arrays rather than as objects for the same reason. An
 * operator told "it is an object" about `[1,2]` has been told the file is fine.
 *
 * No value is printed, only its shape. A config file is where pg_password,
 * local_control_secret and upstream_maintainer_token live, and a string at the
 * top level of a malformed one is as likely to be a secret as anything else.
 */
/**
 * Say that a config file did not parse, WITHOUT quoting the parser's message
 * (SB23-2469, F2 from this PR's review).
 *
 * JSC names the offending token for one malformed shape out of five measured,
 * and for a config file that token is as likely as not to be a credential:
 *
 *   {"pg_password": SUPERSECRETVALUE}
 *   SyntaxError: JSON Parse error: Unexpected identifier "SUPERSECRETVALUE"
 *
 * That line is ERROR, which is at or above the default INFO floor of the
 * OpenObserve exporter, so on a host shipping logs it puts the plaintext value
 * in better_ccflare_logs. It fires twice per boot on the reachable path, once
 * from loadConfig() and once from readLocalControlSecretFromDisk(). The other
 * four shapes measured (trailing comma, unterminated string, missing comma,
 * single-quoted value) name no token and would have been safe, which is exactly
 * why interpolating the message looked fine.
 *
 * Pre-existing on `origin/main`, which had the bare `Failed to ${what}:
 * ${error}`. Fixed here rather than deferred because this PR rewrote that line
 * and because describeJsonShape() one function below already states the rule
 * this broke: print the shape, never the value.
 *
 * The position is lost with the message, and that is the accepted cost. An
 * operator who needs it can run any JSON validator over the file, which the
 * message tells them to do, and no validator ships their config to a log
 * collector.
 */
function describeParseError(error: unknown): string {
	return error instanceof Error ? error.name : "a parse error";
}

function describeJsonShape(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	return `a ${typeof value}`;
}

/**
 * Escape a literal for use inside a RegExp. The config's basename is
 * user-supplied via BETTER_CCFLARE_CONFIG_PATH and normally contains a dot, so
 * it cannot go into a pattern unescaped.
 */
function escapeForRegExp(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseEnabledEnvFlag(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	return value === "true" || value === "1";
}

/**
 * "off": never skip an account on account-scoped (weekly_scoped) exhaustion.
 * "exhausted": skip an account for a request's model family when its
 * weekly_scoped cap for that family is at/above 100% with a future reset
 * (see model-capacity.ts). Defaults to "off" — the filter must be
 * explicitly opted into.
 */
export type ModelScopedCapacityRoutingMode = "off" | "exhausted";

function isValidModelScopedCapacityRoutingMode(
	value: unknown,
): value is ModelScopedCapacityRoutingMode {
	return value === "off" || value === "exhausted";
}

export interface RuntimeConfig {
	clientId: string;
	retry: { attempts: number; delayMs: number; backoff: number };
	sessionDurationMs: number;
	port: number;
	database?: {
		walMode?: boolean;
		busyTimeoutMs?: number;
		cacheSize?: number;
		synchronous?: "OFF" | "NORMAL" | "FULL";
		mmapSize?: number;
		pageSize?: number;
		retry?: {
			attempts?: number;
			delayMs?: number;
			backoff?: number;
			maxDelayMs?: number;
		};
	};
}

export type ProviderModelDefaultOverrides = Record<
	string,
	Record<string, string>
>;

/**
 * Env var that expands which providers accept editable model-default
 * overrides (via the config file, the API, and the dashboard tab).
 * Absent or empty => only "codex" is editable. This gates only the
 * override SURFACE (listing, accepting POSTs, showing a dashboard
 * tab) — the built-in factory maps for every provider (xai, qwen,
 * ...) keep translating models exactly as before; nothing here
 * touches model resolution itself.
 */
export const PROVIDER_MODEL_DEFAULTS_ENV_VAR =
	"CCFLARE_MODEL_DEFAULTS_PROVIDERS";

const DEFAULT_PROVIDER_MODEL_DEFAULTS_PROVIDERS: readonly string[] = ["codex"];

/**
 * Drops overrides for providers outside `enabledProviders` without
 * mutating the input. Callers pass in the full, persisted overrides
 * map and push the filtered result into the in-memory registry (see
 * setProviderModelDefaultOverrides in @better-ccflare/providers) at
 * boot and after a successful POST. The persisted file always keeps
 * the full map — a disabled provider's stored override is never
 * erased, just excluded here, so it re-applies automatically once
 * CCFLARE_MODEL_DEFAULTS_PROVIDERS re-enables that provider.
 */
export function filterEnabledProviderModelDefaultOverrides(
	enabledProviders: Iterable<string>,
	overrides: ProviderModelDefaultOverrides,
): ProviderModelDefaultOverrides {
	const enabled = new Set(enabledProviders);
	const filtered: ProviderModelDefaultOverrides = {};
	for (const [provider, families] of Object.entries(overrides)) {
		if (enabled.has(provider)) filtered[provider] = families;
	}
	return filtered;
}

export interface ConfigData {
	lb_strategy?: StrategyName;
	client_id?: string;
	retry_attempts?: number;
	retry_delay_ms?: number;
	retry_backoff?: number;
	session_duration_ms?: number;
	port?: number;
	default_agent_model?: string;
	data_retention_days?: number;
	request_retention_days?: number;
	usage_history_retention_days?: number;
	store_payloads?: boolean;
	request_storage_headers_only?: boolean;
	auto_vacuum_enabled?: boolean;
	usage_poll_interval_ms?: number;
	cache_keepalive_ttl_minutes?: number;
	system_prompt_cache_ttl_1h?: boolean;
	usage_throttling_five_hour_enabled?: boolean;
	usage_throttling_weekly_enabled?: boolean;
	codex_five_hour_window_enabled?: boolean;
	model_scoped_capacity_routing?: ModelScopedCapacityRoutingMode;
	combos_enabled?: boolean;
	combo_session_fallback?: boolean;
	force_account_model?: boolean;
	provider_model_default_overrides?: ProviderModelDefaultOverrides;
	agent_frontmatter_model_fallback?: boolean;
	model_catalog_oauth_refresh_enabled?: boolean;
	health_detail_enabled?: boolean;
	// PostgreSQL backend configuration
	pg_enabled?: boolean;
	pg_host?: string;
	pg_port?: number;
	pg_database?: string;
	pg_user?: string;
	pg_password?: string;
	pg_ssl_mode?: "disable" | "require" | "verify-ca" | "verify-full";
	alert_daily_spend_usd?: number;
	alert_tokens_per_hour?: number;
	alert_request_tokens?: number;
	alert_anomaly_enabled?: boolean;
	alert_anomaly_interval_minutes?: number;
	alert_anomaly_baseline_window_minutes?: number;
	alert_anomaly_loop_min_requests?: number;
	alert_cooldown_minutes?: number;
	alert_webhook_url?: string;
	outbound_proxy?: string;
	// Local-control secret: shared between the CLI and the server process it
	// controls, used to authorize a small set of idempotent CLI->server
	// notify calls (token reload, force-reset-rate-limit) when API-key auth
	// is enabled. See AuthService#isLocalControlRequest. Generated once on
	// first access and persisted — unlike ProxyContext.internalProbeSecret,
	// which is intentionally re-minted every server process start.
	local_control_secret?: string;
	// Token used to ask the upstream maintainer controller to open a sync PR
	// (see docs/version-status-widget.md). Its presence is the feature's only
	// switch: with no token set, POST /api/upstream/sync-dispatch answers 404 and
	// the dashboard offers no button. Sensitive — handled like pg_password: never
	// returned by an endpoint, never logged, and excluded from getAllSettings().
	upstream_maintainer_token?: string;
	// Raises GitHub's API rate limit for the version widget from 60 requests an
	// hour to 5,000. Needs no scopes: it only reads public releases and commits.
	// Sensitive all the same, excluded from getAllSettings() with the others.
	github_read_token?: string;
	// OpenObserve log and request shipping. The endpoint being set is the
	// feature's switch: with no base URL, nothing is shipped and no connection
	// is made. openobserve_ship_payloads is a second, independent switch,
	// because shipping request and response bodies off the box is a different
	// decision from shipping log lines.
	openobserve_url?: string;
	openobserve_org?: string;
	openobserve_user?: string;
	// Sensitive — handled like pg_password: never returned by an endpoint,
	// never logged, and excluded from getAllSettings().
	openobserve_token?: string;
	openobserve_log_stream?: string;
	openobserve_request_stream?: string;
	openobserve_ship_payloads?: boolean;
	// Lowest level shipped to the log stream, by name. Defaults to INFO: the
	// exporter's buffers drop the oldest under pressure, so a DEBUG burst
	// evicts the ERROR records that were the reason for shipping at all.
	// Affects the log stream only; request records carry no level.
	openobserve_log_min_level?: string;
	// Database configuration
	db_wal_mode?: boolean;
	db_busy_timeout_ms?: number;
	db_cache_size?: number;
	db_synchronous?: "OFF" | "NORMAL" | "FULL";
	db_mmap_size?: number;
	db_page_size?: number;
	db_retry_attempts?: number;
	db_retry_delay_ms?: number;
	db_retry_backoff?: number;
	db_retry_max_delay_ms?: number;
	// Discovery configuration
	claude_projects_dir?: string;
	projects_case_sensitive?: boolean;
	// The mode the projects table was actually populated under, as opposed to
	// projects_case_sensitive above, which is the mode the operator is asking
	// for. They diverge exactly when someone changes the setting on a database
	// that already holds projects, which re-keys every row (SB23-1988).
	projects_case_sensitive_stored?: boolean;
	[key: string]:
		| string
		| number
		| boolean
		| ProviderModelDefaultOverrides
		| undefined;
}

/**
 * Validates database configuration parameters
 */
function validateDatabaseConfig(
	config: Partial<RuntimeConfig["database"]>,
): void {
	if (!config) return;

	// Validate synchronous mode
	if (config.synchronous !== undefined) {
		validateString(config.synchronous, "db_synchronous", {
			allowedValues: ["OFF", "NORMAL", "FULL"],
		});
	}

	// Validate numeric parameters with reasonable bounds
	if (config.busyTimeoutMs !== undefined) {
		validateNumber(config.busyTimeoutMs, "db_busy_timeout_ms", {
			min: 0,
			max: 300000, // 5 minutes max
			integer: true,
		});
	}

	if (config.cacheSize !== undefined) {
		validateNumber(config.cacheSize, "db_cache_size", {
			min: -2000000, // -2GB max negative (KB)
			max: 1000000, // 1M pages max positive
			integer: true,
		});
	}

	if (config.mmapSize !== undefined) {
		validateNumber(config.mmapSize, "db_mmap_size", {
			min: 0,
			max: 1073741824, // 1GB max
			integer: true,
		});
	}

	// Validate retry configuration consistency
	if (config.retry) {
		const retry = config.retry;

		if (retry.attempts !== undefined) {
			validateNumber(retry.attempts, "db_retry_attempts", {
				min: 1,
				max: 10,
				integer: true,
			});
		}

		if (retry.delayMs !== undefined) {
			validateNumber(retry.delayMs, "db_retry_delay_ms", {
				min: 1,
				max: 60000, // 1 minute max
				integer: true,
			});
		}

		if (retry.backoff !== undefined) {
			validateNumber(retry.backoff, "db_retry_backoff", {
				min: 1,
				max: 10,
			});
		}

		if (retry.maxDelayMs !== undefined) {
			validateNumber(retry.maxDelayMs, "db_retry_max_delay_ms", {
				min: 1,
				max: 300000, // 5 minutes max
				integer: true,
			});
		}

		// Ensure maxDelayMs is greater than delayMs if both are specified
		if (retry.delayMs !== undefined && retry.maxDelayMs !== undefined) {
			if (retry.maxDelayMs < retry.delayMs) {
				throw new ValidationError(
					"db_retry_max_delay_ms must be greater than or equal to db_retry_delay_ms",
					"db_retry_max_delay_ms",
				);
			}
		}
	}
}

export class Config extends EventEmitter {
	private configPath: string;
	private data: ConfigData = {};

	/**
	 * Credential and endpoint fields dropped from this instance's reads, so
	 * saveConfig() can refuse rather than write a file that is missing them
	 * (SB23-2366).
	 *
	 * Without this, the strip is a data-loss bug rather than a defence.
	 * saveConfig() serialises this.data wholesale, so the first set() after a
	 * filtered load writes the file back without the stripped fields, and that
	 * fires on the SAME boot: getLocalControlSecret() finds no secret, generates
	 * one and calls set(). Measured on this branch at dca5c7ea against a 13-key
	 * config: 5 keys on disk afterwards, 4 of the operator's own plus the freshly
	 * generated local_control_secret, with pg_enabled, pg_host, pg_password,
	 * openobserve_url, openobserve_token, alert_webhook_url, claude_projects_dir,
	 * github_read_token and outbound_proxy deleted. buildPgConnectionUrl() then
	 * returns null and the process runs against SQLite instead of the operator's
	 * Postgres, with no error line.
	 *
	 * A Set of names rather than a boolean, so the refusal can say how many
	 * fields are at stake, and so a second read that strips something new is
	 * recorded rather than folded into a flag that is already true.
	 */
	private readonly strippedFields = new Set<string>();

	/** The resolved path the stripped fields came from, named in the refusal. */
	private strippedFrom: string | undefined;

	/**
	 * The resolved path whose contents this instance could not turn into config
	 * data, so saveConfig() can refuse rather than replace a file it never read
	 * (SB23-2469).
	 *
	 * Same shape as strippedFrom above and the same reason: this.data does not
	 * match the file, and saveConfig() serialises this.data wholesale. What
	 * differs is the trigger. The strip needs another local user able to write
	 * the config; this needs one trailing comma, in a file at 0600 that nobody
	 * else can touch, and hand-editing this file is a documented workflow.
	 *
	 * Measured at eaa5859a on the issue's own five-key fixture, mode 0600, whose
	 * only defect is a trailing comma: after one construction plus
	 * getLocalControlSecret(), the file read exactly
	 * `{ "local_control_secret": "<uuid>" }`. lb_strategy, pg_enabled, pg_host,
	 * pg_password and openobserve_token were gone, and nothing in the log said a
	 * file had been replaced. getLocalControlSecret() is what reaches it on the
	 * first boot: it finds no secret in the empty data, generates one, and calls
	 * set().
	 *
	 * PER-INSTANCE, and that is the deliberate difference from
	 * writableAtFirstRead, which is module-scoped and keyed by path. That memo
	 * exists because the FIRST instance changes what a later one measures:
	 * readConfigData() brings a writable file to 0600 at its own report site, so
	 * a second Config stats a clean file and strips nothing. Nothing on this
	 * path writes the config file. restrictConfigFile() chmods it,
	 * restrictConfigDir() chmods the directory, sweepStaleTempFiles() removes
	 * temp siblings, and none of them touch the bytes. So a second Config
	 * re-reads the same bytes, fails the same parse, and records this for
	 * itself, which the two-instance test measures rather than assumes.
	 *
	 * That covers two of the three outcomes and not the third, which is stated
	 * rather than glossed (F4 from this PR's review). For the READ failure,
	 * instance 1 does change what instance 2 measures: restrictConfigFile()
	 * brings a 0000 file to 0600 during instance 1's load, so instance 2 reads
	 * it successfully and records nothing. The direction is benign, because
	 * instance 2 genuinely read the file and its this.data is complete, so its
	 * save is lossless; no ordering was found that replaces the file with an
	 * incomplete config. But the sentence above describes the parse and
	 * non-object outcomes, not that one.
	 *
	 * A module-scoped version was considered and is worse here, in the direction
	 * that matters. Its neighbours are never cleared, because the conditions they
	 * hold are facts about a filesystem that a new process re-measures. This one
	 * is a fact about BYTES, which an operator fixes with an editor. Never
	 * clearing it means an instance built afterwards, whose own load succeeded
	 * and whose data is complete, refuses to save and prints a refusal naming a
	 * condition that is no longer true.
	 *
	 * A string rather than a boolean so the refusal can name the file, which may
	 * be a symlink target rather than the configured path.
	 */
	private unparseableFrom: string | undefined;

	constructor(configPath?: string) {
		super();
		const rawPath = configPath ?? resolveConfigPath();
		// Validate config path for security
		this.configPath = validatePathOrThrow(rawPath, {
			description: "config file",
		});
		this.loadConfig();
	}

	private loadConfig(): void {
		if (existsSync(this.configPath)) {
			// Gate the READ on the same trust check as the write. A refused path is
			// one another local user controls, so parsing it adopts their values:
			// measured, an attacker-supplied local_control_secret came back from
			// getLocalControlSecret(), which is an authentication bypass on the local
			// control endpoint rather than a disclosure. pg_host and pg_password
			// pointing at a database they own are the same shape. Refusing the write
			// alone is the worst of both, because the process keeps running on a
			// config an attacker supplied.
			const trusted = this.writeTarget();
			if (trusted === null) {
				// writeTarget() has said WHY, at error level, and says it once per
				// process. This line is the OUTCOME, and it is deliberately not routed
				// through refuse() (SB23-2379).
				//
				// Without it this branch reported nothing of its own and relied
				// entirely on the diagnosis above. Once SB23-2357 deduplicated that
				// diagnosis, the SECOND and later Config built for the same path in one
				// process fell back to defaults in total silence, which is a worse log
				// than the duplicate paragraph the dedup removed. Not hypothetical:
				// packages/http-api/src/handlers/oauth.ts:878 and :971 construct a
				// fresh Config inside request-handling bodies, and apps/server and
				// packages/cli-commands build their own.
				//
				// So the rule this file now follows everywhere is diagnosis once,
				// outcome every time. saveConfig() and readLocalControlSecretFromDisk()
				// already had their outcome lines; loadConfig() was the one refusal
				// path with none. Found by PR #190's review.
				//
				// It names the consequence rather than repeating the cause, because the
				// cause may be thousands of lines back in the log, or absent from this
				// process's output entirely if the operator started reading late.
				log.error(
					`Config not loaded: ${this.configPath} cannot be trusted, so this process is running on defaults. local_control_secret is regenerated, which presents as clients intermittently failing to authenticate. The reason was logged once, above.`,
				);
				this.data = {};
				// Harden the directory anyway. Everything else in this branch is
				// about the file we refused to read, but the directory holds the
				// database and its plaintext credentials, and it is no less ours
				// because the config beside it is untrustworthy. Before this, a
				// refusal skipped the chmod and left the directory at whatever it
				// was: measured at 0755 with the config a hardlink, where a normal
				// config took it to 0700. Found by PR #172's review. The call gates
				// on the path being the default config directory and warns rather
				// than throwing, so it is safe on a refusal path.
				this.restrictConfigDir();
				return;
			}
			// readConfigData() returns null for anything that is not a regular
			// file, which keeps a FIFO at the config path from stalling startup
			// forever. It has already said why, at error level. Fall through
			// rather than returning, so the directory is still brought to 0700
			// and stale temp files are still swept.
			// readConfigData() reads, parses AND strips credential or endpoint fields
			// when other local users can write the file, so there is no way to reach
			// parsed config data without the filter having run (SB23-2351).
			this.data =
				this.readConfigData(trusted, "parse config file", "refuse-saves") ?? {};
			// An upgrade from a version that wrote 0644 may never write a setting
			// again, because getLocalControlSecret() returns early once the secret
			// exists, so the file would stay world-readable indefinitely if the
			// permission migration only ran from saveConfig(). Do it on load.
			this.restrictConfigFile();
			this.restrictConfigDir();
			this.sweepStaleTempFiles();
		} else {
			// Create config directory if it doesn't exist.
			//
			// mode applies only to directories this call actually creates, and it is
			// masked by the umask, so it is not a chmod: a directory that already
			// exists at 0755 keeps 0755. restrictConfigDir() covers that case.
			//
			// With recursive: true the mode also lands on intermediate directories
			// this call creates, so on a machine with no ~/.config yet that directory
			// is created 0700 as well. It belongs to the same user either way.
			const dir = dirname(this.configPath);
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			this.restrictConfigDir();

			// Initialize with default config
			this.data = {
				lb_strategy: DEFAULT_STRATEGY,
			};
			this.saveConfig();
		}
	}

	/**
	 * Read a config file, but only when it really is a regular file.
	 *
	 * existsSync() returns true for a FIFO, and a FIFO is not a symlink, so
	 * writeTarget() hands it back as a trusted path and readFileSync() then
	 * blocks forever waiting for a writer that never arrives. Measured during the
	 * review of PR #57: the log reached "about to construct" and never reached
	 * the next line, and the process had to be killed. An unconditional permanent
	 * stall in the constructor with no log line explaining it is harder to
	 * diagnose than a wrong value, so the stat comes first. Character devices are
	 * the same shape: /dev/zero would read forever instead.
	 *
	 * statSync() does not open the file, so it does not block on a FIFO the way
	 * readFileSync() does. It follows links deliberately: writeTarget() has
	 * already walked and trusted the chain, so what matters here is the type of
	 * what the chain lands on.
	 *
	 * Returns null on a non-regular file and on a stat failure, having logged the
	 * reason. Callers treat that as "no config", exactly as they treat a parse
	 * failure. This is the same isFile() guard restrictConfigFile() applies
	 * before chmod, applied to the read.
	 */
	private readConfigData(
		target: string,
		what: string,
		onFailure: ReadFailureHandling,
	): ConfigData | null {
		try {
			const info = statSync(target);
			if (!info.isFile()) {
				log.error(
					`The config path ${target} is not a regular file, so it was not read. Point BETTER_CCFLARE_CONFIG_PATH at a file.`,
				);
				return null;
			}
			// Its own try, separate from the outer one, because the two failures it
			// separates need opposite handling and folding them together left a
			// reachable hole (SB23-2469, found by this PR's own mutation (g)).
			//
			// statSync above has just said this is a regular file that exists, so a
			// read that fails here is a file WITH CONTENTS this process could not
			// see, and replacing it destroys them. Reachable without an attacker: a
			// config at mode 0000, owned by us, stats fine and throws EACCES on the
			// read. Measured as uid 501 against a 0000 file: stat succeeds,
			// open() raises errno 13.
			//
			// The outer catch is the other case and deliberately does NOT set the
			// flag. It covers statSync, including a file that vanished between the
			// caller's existsSync and that stat, where nothing was read and there
			// are no contents a save could destroy. Refusing there would turn a
			// transient race into a process that never persists anything again.
			//
			// One flag with one meaning would have collapsed these, which is
			// mem:a-boolean-cannot-hold-three-outcomes: absent file, unreadable
			// file and unparseable file are three outcomes, and only the last two
			// refuse.
			let content: string;
			try {
				content = readFileSync(target, "utf8");
			} catch (error) {
				if (onFailure === "refuse-saves") this.unparseableFrom = target;
				log.error(
					`Failed to read the config file: ${target} exists and is a regular file but could not be read: ${error}. Its contents are left exactly as they are and no setting is written back to it, because writing this process's config over a file it could not read would delete whatever is in it. This process runs on defaults until it is fixed: local_control_secret is regenerated and never persisted, which presents as local control clients failing to authenticate after a restart. Check the file's permissions, or move it aside so a fresh one is created, then restart.`,
				);
				return null;
			}
			// Say so when another local user could have written these bytes. Read first
			// and report after, deliberately (SB23-2338).
			//
			// Nothing else covers this. trustedRegularPath() reads the file's uid and
			// link count, entryIsTrusted() reads directories, and neither looks at the
			// file's own mode, so a config of OURS at 0666 was adopted without comment:
			// measured by PR #172's review, where local_control_secret came back reading
			// "WRITTEN-BY-ANOTHER-USER".
			//
			// Below readFileSync rather than above it, because log.error() emits on
			// logBus synchronously and a listener that throws would land in this
			// method's own catch and return null, turning a warning into a silently
			// empty config. Both current listeners are guarded, so that was
			// unreachable, but ordering it this way means no listener can ever change
			// whether the config loads. Found by PR #176's review.
			//
			// Here rather than in trustedRegularPath() for two reasons. The statSync and
			// the isFile() test are already done above, so no syscall is added. And this
			// sees the file the symlink chain LANDS on, so a chain ending on a 0666 file
			// in a shared sticky directory is covered by the same check.
			//
			// win32 is excluded, and this is not caution. Node derives st_mode from
			// FILE_ATTRIBUTE_READONLY there, so statSync reports 0666 for ANY writable
			// file and 0o666 & 0o022 is 0o022: without the guard this fires on every
			// boot for every Windows operator, about nothing, with no way to silence it.
			// The same premise already gates chmodAndVerify(), writeTarget() and
			// trustedRegularPath(). Found by PR #176's review, which noted this was the
			// only mode read in the file without the guard.
			//
			// Warned and not refused, which is the whole decision on this issue, so the
			// reasoning lives here rather than only in the commit. The issue calls a
			// mode-enforcing filesystem a one-time window because restrictConfigFile()
			// then lands 0600. The window is one-time; its effect is not. loadConfig()
			// assigns this.data from the parse BEFORE that chmod runs, and the next
			// set() writes this.data straight back out, so an injected
			// local_control_secret persists in a file that now looks correct. Refusing
			// and self-healing would be theatre against that, because the next boot
			// finds 0600 and adopts the identical bytes. Refusing and leaving it is the
			// permanent outage chmodAndVerify() already declines, and the standing
			// exposure is exactly where that outage would bite: Docker bind mounts from
			// a macOS or Windows host, and FAT or exFAT, where chmod is a no-op. So the
			// operator is told, precisely, and the process keeps running.
			//
			// Not adopting credential and endpoint fields from a writable config was
			// considered and is deferred as new mechanism, not dismissed. It is a bigger
			// job than "everything except local_control_secret": pg_enabled with pg_host
			// and pg_password redirect every credential this process later persists,
			// openobserve_* ships payloads, outbound_proxy redirects traffic, and
			// ConfigData carries an index signature so an allowlist cannot be written as
			// a subtraction.
			//
			// Captured on the first read and reused on every later one, rather than
			// re-derived from a mode this method itself is about to change. The
			// chmodAndVerify() below brings a writable file to 0600 before
			// readLocalControlSecretFromDisk() re-reads it on the same boot, so a
			// fresh reading there is false and the strip does not run on the one
			// read where a planted local_control_secret would be adopted
			// (SB23-2366). The dedupe on the report is unaffected: contentsNotOurs
			// already holds the target by then, so the branch below still fires
			// once, and chmodAndVerify() still runs once.
			const writableByOthers =
				writableAtFirstRead.get(target) ??
				(process.platform !== "win32" && (info.mode & 0o022) !== 0);
			writableAtFirstRead.set(target, writableByOthers);
			if (writableByOthers && !contentsNotOurs.has(target)) {
				contentsNotOurs.add(target);
				// Name the bit that was found. "group-writable (gid 20)" and
				// "world-writable" call for different actions, and on macOS the default
				// gid is staff, which every local account belongs to, while on a Linux
				// using per-user groups the same bit is usually harmless.
				const writers =
					(info.mode & 0o020) !== 0
						? (info.mode & 0o002) !== 0
							? "group- and world-writable"
							: `group-writable (gid ${info.gid})`
						: "world-writable";
				// Close the window here rather than waiting for restrictConfigFile()
				// a few lines up the caller, because WHETHER THE CHMOD TAKES decides
				// the level of the report below and the report has to go out now
				// (SB23-2350).
				//
				// Its own try/catch, and that is not defensive tidiness. This block
				// sits inside readRegularFile()'s try, so a chmodSync that throws
				// would land in the outer catch, return null, and turn a warning
				// about a writable config into a silently empty config. That is the
				// shape PR #176's review found one line down from here.
				//
				// A chmod that throws is treated as enforcing, so the report stays at
				// ERROR. The reachable throwing cases are a read-only mount and a
				// macOS uchg flag, both on filesystems that do enforce modes, where
				// the mode read above is real evidence. A file owned by another user
				// cannot reach here at all: trustedRegularPath() refuses on uid before
				// readRegularFile() is called.
				//
				// restrictConfigFile() still runs afterwards and is not redundant. It
				// covers the modes this branch never sees, and on a mode-enforcing
				// filesystem it early-returns on the 0600 this call just landed, while
				// on a mode-ignoring one chmodAndVerify() silences its own second
				// warning through the same Set.
				// Three outcomes, not two, and the third is why. A chmod that THREW
				// leaves the file exactly as writable as it was found, so the
				// "brought to 0600, does not repeat" sentences the took branch ends
				// on would both be false, in a security message, in the one case a
				// test covers. A uchg flag survives a reboot, so that line does
				// repeat. Found by review before the verdict, on the first draft,
				// which reported the throw at the took branch's text.
				let chmodOutcome: "took" | "noop" | "threw" = "took";
				try {
					chmodAndVerify(target, CONFIG_FILE_MODE, "config file");
					if (unenforceableModes.has(target)) chmodOutcome = "noop";
				} catch (error) {
					chmodOutcome = "threw";
					log.warn(`Could not restrict config file permissions: ${error}`);
				}
				if (chmodOutcome === "took") {
					log.error(
						`The config file ${target} was mode ${modeText(info.mode & 0o777)}, ${writers}, so another local user could write it and its contents may not be yours. It has been brought to 0600. Its ordinary settings were loaded and are in effect; credential and endpoint fields were NOT adopted from it, and any it contained are named in a separate line below. That is what stops an attacker who wrote this file supplying local_control_secret, which would authenticate them against the local control endpoint rather than merely disclosing anything; pg_enabled with pg_host and pg_password, which would point every credential this process persists at a database they control; and openobserve_url with openobserve_token, which would ship request and response bodies to a collector of theirs. If any were ignored, no setting is written back either, because saveConfig() refuses rather than persist a config it knows is incomplete. Inspect the file, or delete it so a fresh one is created. This line does not repeat on the next boot, because the file is 0600 now, but the bytes in it are still whatever was written, and the next boot adopts them.`,
					);
				} else if (chmodOutcome === "threw") {
					// ERROR, and the level is right for the same reason the took
					// branch's is: a filesystem that REFUSES a chmod is one that
					// enforces modes, so the mode read above is evidence. What differs
					// is that nothing was fixed, so the operator has to fix it.
					log.error(
						`The config file ${target} is mode ${modeText(info.mode & 0o777)}, ${writers}, so another local user can write it and its contents may not be yours. The chmod to 0600 FAILED, reported just above, so it is still ${modeText(info.mode & 0o777)} and this line repeats on every boot until that is fixed. Its ordinary settings have been loaded and are in effect; credential and endpoint fields have NOT been adopted from it, and any it contained are named in a separate line below. That is what stops an attacker who writes this file supplying local_control_secret, which would authenticate them against the local control endpoint rather than merely disclosing anything; pg_enabled with pg_host and pg_password, which would point every credential this process persists at a database they control; and openobserve_url with openobserve_token, which would ship request and response bodies to a collector of theirs. If any were ignored, no setting is written back either, because saveConfig() refuses rather than persist a config it knows is incomplete. A read-only mount and a macOS uchg flag are the usual causes. Inspect the file, clear whatever refuses the chmod, or delete it so a fresh one is created.`,
					);
				} else {
					// The whole point of SB23-2350. chmod reported success and changed
					// nothing, so this filesystem has no Unix modes to set, and a mode
					// it cannot enforce is not evidence about who can write the file in
					// either direction. Docker Desktop bind mounts from a macOS or
					// Windows host present every file 0777 and are the realistic case;
					// FAT and exFAT are the other.
					//
					// ERROR here would fire on every boot forever with nothing the
					// operator can do, and ship to OpenObserve each time. An alarm that
					// cannot be cleared trains its reader to ignore alarms, which costs
					// more than this warning buys. So the level says what is true: we
					// could not measure this, and the answer is at the mount.
					//
					// Not silenced by a config key or an environment variable, which
					// was the other candidate. The same switch that silences an
					// unfixable alarm silences a real exposure on a filesystem that
					// does enforce modes, and it would be set by exactly the operator
					// who is tired of the line rather than the one who checked. The
					// measurement is free here, so nothing is bought by asking.
					log.warn(
						`The config file ${target} reads mode ${modeText(info.mode & 0o777)}, but chmod on it reported success and did not land 0600, reported just above, so this filesystem does not enforce Unix modes and that reading says nothing about who can write the file. Docker bind mounts from a macOS or Windows host and FAT or exFAT volumes behave this way. Whether another local user can write ${target} is decided at the mount or on the host, not by these bits, and this process cannot see it. This file is where local_control_secret, pg_password and upstream_maintainer_token are stored, so check the access rules where the volume is mounted, or move the config onto a filesystem that enforces modes. Because the mode reads writable, credential and endpoint fields were NOT adopted from it, and any it contained are named in a separate line below; no setting is written back while that holds. On this kind of filesystem that applies on every boot rather than once, so a config here loads its settings and never its credentials until the mount is fixed.`,
					);
				}
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(content);
			} catch (error) {
				// Record WHICH file could not be turned into config data, so
				// saveConfig() refuses instead of replacing it (SB23-2469). Without
				// this the caller's `?? {}` produces an empty config and the first
				// set() writes that empty config over the operator's file, which
				// getLocalControlSecret() reaches on the very first boot.
				//
				// Set here and not at the caller, for the same reason
				// stripUntrustedFields() records its own names here rather than
				// returning a flag: there are two readers of this method
				// (loadConfig() and readLocalControlSecretFromDisk()) and a flag set
				// by one of them is a flag the other can miss.
				if (onFailure === "refuse-saves") this.unparseableFrom = target;
				log.error(
					`Failed to ${what}: ${target} is not valid JSON (${describeParseError(error)}). Its contents are left exactly as they are and no setting is written back to it, because writing this process's config over a file it could not understand would delete whatever is in it. This process runs on defaults until it is fixed: local_control_secret is regenerated and never persisted, which presents as local control clients failing to authenticate after a restart. Fix the syntax in ${target}, or move it aside so a fresh one is created, then restart.`,
				);
				return null;
			}
			// JSON.parse SUCCEEDS on null, true, 7, "str" and [1,2], so the catch
			// above never sees them and the cast to ConfigData was the only thing
			// calling them an object (SB23-2469).
			//
			// `null` is the one that matters and it is not a curiosity: a file
			// containing the four bytes `null` parses, returns null from this
			// method, and the caller's `?? {}` cannot tell that apart from a parse
			// failure, so it produces the identical empty config and the identical
			// wholesale overwrite, reached with no syntax error anywhere. The
			// others are worse in a different direction: `true` becomes this.data,
			// and the next set() assigns a property to a boolean, which throws a
			// TypeError in strict mode rather than saving.
			//
			// Arrays are excluded deliberately. An array IS an object and would
			// pass a bare typeof test, and JSON.stringify of one drops every named
			// property a set() adds, so a config that is an array loses each write
			// silently rather than noisily.
			//
			// Second site of this shape in this repository: mem:a-successful-parse-
			// can-yield-null, where a literal `null` body threw out of
			// processResponse() and walked the whole account pool.
			if (
				parsed === null ||
				typeof parsed !== "object" ||
				Array.isArray(parsed)
			) {
				if (onFailure === "refuse-saves") this.unparseableFrom = target;
				log.error(
					`Failed to ${what}: ${target} holds valid JSON that is not an object, it is ${describeJsonShape(parsed)}. A config file must be a JSON object such as {"lb_strategy":"session"}. Its contents are left exactly as they are and no setting is written back to it, because writing this process's config over it would delete whatever is in it. This process runs on defaults until it is fixed: local_control_secret is regenerated and never persisted, which presents as local control clients failing to authenticate after a restart. Fix the file, or move it aside so a fresh one is created, then restart.`,
				);
				return null;
			}
			return this.stripUntrustedFields(
				parsed as ConfigData,
				target,
				writableByOthers,
			);
		} catch (error) {
			// Deliberately does NOT set unparseableFrom, and after the read got its
			// own try above, this catch covers only the statSync.
			//
			// A stat that throws is a path nothing was read from: the file vanished
			// between the caller's existsSync and here, or its directory stopped
			// being traversable. There are no contents a save could destroy, and
			// refusing every later save on a transient race would leave a process
			// that never persists anything again.
			//
			// Not reachable from either caller in practice, and that is stated
			// rather than guessed at: both gate on existsSync(), and loadConfig()
			// additionally passes a target writeTarget() has already lstat-walked,
			// so a dangling or untrusted path is refused before this method runs.
			// It is left unflagged because a branch nothing can reach is the wrong
			// place to put a refusal that would be permanent if it ever did.
			//
			// The non-regular-file guard earlier in this method is the same case and
			// likewise does not set it: writeTarget() and restrictConfigFile()
			// already refuse to write through a FIFO or a directory, so nothing
			// reaches a save that would replace one.
			log.error(`Failed to read config file: ${error}`);
			return null;
		}
	}

	/**
	 * Drop credential and endpoint fields from a config another local user can write
	 * (SB23-2351).
	 *
	 * SB23-2338 decided to warn and load the whole config, because refusing is a
	 * permanent outage where chmod is a no-op. This keeps the loading and removes the
	 * part that is not a setting. An attacker who can write the file still changes
	 * behaviour; they no longer supply authentication material or an outbound
	 * destination.
	 *
	 * Inside the only method that produces parsed config data, deliberately, rather
	 * than applied by each caller from a flag. The obvious design returns the content
	 * alongside "this file was writable" and filters at each parse site, and it fails
	 * on its own terms: the warning is deduplicated per path through a module Set, so
	 * a flag derived near that dedupe reads false on the second read of the same
	 * file, and the filter would be bypassed exactly where the mode is still
	 * writable. There is no flag to forget here, and no second parse site to miss.
	 * The warning stays deduplicated; the filtering does not.
	 *
	 * Skipped on win32 along with the writability test itself, because Stats.mode
	 * there reports 0666 for any writable file, so filtering would strip credentials
	 * from every Windows config.
	 *
	 * Bounded honestly: the file is brought to 0600 during this same read, at the
	 * report site above, so on a filesystem that enforces modes this is a defence
	 * for the boot that follows a plant, and the operator's own fields come back on
	 * the next boot. Where chmod is a no-op, Docker bind mounts from a macOS or
	 * Windows host and FAT or exFAT, it applies on every boot.
	 *
	 * The stripped names are recorded on the instance, and saveConfig() refuses
	 * while any are recorded. Without that the strip is a data-loss bug rather than
	 * a defence: this.data no longer matches the file, and saveConfig() serialises
	 * this.data wholesale (SB23-2366).
	 */
	private stripUntrustedFields(
		parsed: ConfigData,
		target: string,
		writableByOthers: boolean,
	): ConfigData {
		if (!writableByOthers) return parsed;
		const kept: ConfigData = {};
		const stripped: string[] = [];
		for (const key of Object.keys(parsed)) {
			if (isUntrustedField(key)) {
				stripped.push(key);
			} else {
				kept[key] = parsed[key];
			}
		}
		// Recorded before the report, and outside its dedupe. The report is a
		// diagnosis and lands once per path per process; this is the state
		// saveConfig() reads to decide whether writing would destroy the
		// operator's fields, and it has to be true on every read that strips,
		// including the second one (SB23-2366).
		for (const key of stripped) this.strippedFields.add(key);
		if (stripped.length > 0) this.strippedFrom = target;
		if (stripped.length > 0 && !strippedFieldsReported.has(target)) {
			strippedFieldsReported.add(target);
			// Name the fields. Without this the process behaves as though the operator
			// never set them, which is indistinguishable from a config that does not
			// contain them, and that is the report this whole change would otherwise
			// turn into.
			log.error(
				`Ignored ${stripped.length} credential or endpoint field(s) from ${target} because other local users can write it: ${stripped.sort().join(", ")}. The process behaves as though these were never set. Settings from that file are still applied.`,
			);
		}
		return kept;
	}

	/**
	 * Bring an existing config file to 0600. The file holds pg_password,
	 * local_control_secret and upstream_maintainer_token, so it must not be
	 * readable by other local users, and versions before this wrote it 0644.
	 *
	 * Only chmods when the mode is actually wrong, and warns rather than errors:
	 * chmod fails legitimately on a bind-mounted volume (docs/deployment.md
	 * documents the config on a Docker volume) or on a file owned by another
	 * user, and neither case means the config is unusable.
	 *
	 * chmodAndVerify() reads the mode back afterwards, because a chmod that
	 * reports success and changes nothing was the worst available shape here: the
	 * guard came out true on every load while the file stayed world-readable.
	 *
	 * Acts on writeTarget(), which refuses to follow a symlink whose directory
	 * another local user can write. chmod follows links, so without that refusal
	 * a planted link turns this into a tool for changing an unrelated file's mode:
	 * measured, an 0755 file the link pointed at became 0600.
	 */
	private restrictConfigFile(): void {
		const target = this.writeTarget();
		if (target === null) return;
		try {
			const info = statSync(target);
			// Regular files only. A config path that names a directory by mistake
			// would otherwise have its execute bits stripped, which locks the
			// operator out of the directory and everything under it: measured, a
			// directory at the config path went 0755 to 0600 and the
			// better-ccflare.db beside it became unreachable, to the point that
			// removing the directory afterwards failed with ENOTEMPTY.
			if (!info.isFile()) {
				log.error(
					`The config path ${target} is not a regular file, so its permissions were left alone. Point BETTER_CCFLARE_CONFIG_PATH at a file.`,
				);
				return;
			}
			if ((info.mode & 0o777) === CONFIG_FILE_MODE) return;
			chmodAndVerify(target, CONFIG_FILE_MODE, "config file");
		} catch (error) {
			log.warn(`Could not restrict config file permissions: ${error}`);
		}
	}

	/**
	 * Bring the configuration directory to 0700.
	 *
	 * PR #57 restricted the config file itself, but the directory holding it was
	 * 0755 and the SQLite database beside it 0644, and that database stores
	 * api_key, refresh_token and access_token as plaintext TEXT
	 * (packages/database/src/migrations.ts:116-118). 0700 on the directory is the
	 * one change that covers the database, its WAL and every .backup.* at once,
	 * because it stops another local user traversing in at all.
	 *
	 * Only for the application's own directory. dirname() of a configured path can
	 * be a directory the application does not own: with
	 * BETTER_CCFLARE_CONFIG_PATH=/etc/better-ccflare.json it is /etc, and taking
	 * that to 0700 locks every other user out of the machine. The gate is a string
	 * comparison against getPlatformConfigDir() and deliberately nothing more —
	 * an ownership check or a path resolver here is the shape that turned #57 into
	 * fourteen rounds.
	 *
	 * A custom directory is left alone with an info log, so the operator who chose
	 * it can set 0700 themselves.
	 *
	 * Warns rather than throws. chmod fails legitimately on a bind-mounted volume
	 * or a directory owned by another user, and neither means the config is
	 * unusable. It can also report success and change nothing, on Docker bind
	 * mounts and FAT/exFAT, which chmodAndVerify() reads back and reports: the
	 * directory is the one change that covers the database, so a silent no-op
	 * here leaves the plaintext tokens traversable.
	 */
	private restrictConfigDir(): void {
		const dir = dirname(this.configPath);
		if (dir !== getPlatformConfigDir()) {
			log.info(
				`Config directory ${dir} is not the default location, so its permissions were left alone. It holds the database and its plaintext credentials; set it to 0700 yourself.`,
			);
			return;
		}
		try {
			const info = statSync(dir);
			// Directories only. A non-directory here means something is badly wrong
			// with the path; changing its mode would not help.
			if (!info.isDirectory()) return;
			if ((info.mode & 0o777) === CONFIG_DIR_MODE) return;
			chmodAndVerify(dir, CONFIG_DIR_MODE, "config directory");
		} catch (error) {
			log.warn(`Could not restrict config directory permissions: ${error}`);
		}
	}

	/**
	 * Remove temp files left by a crashed save. They are 0600, so this is not a
	 * disclosure, but they hold pg_password and the maintainer PAT and nothing
	 * else would ever delete them.
	 *
	 * Only plain files matching our own prefix, and only ones older than a
	 * minute: a newer one may be a save in flight in another process, and
	 * deleting it would cost that process only the atomic rename, because its
	 * rename then fails ENOENT and it writes in place instead.
	 *
	 * Derived from writeTarget(), not from configPath: saveByRename() creates the
	 * temp beside the resolved target, so for a symlinked config both the
	 * directory and the basename differ from the configured path.
	 *
	 * That is also why the name must match the full UUID shape and not merely the
	 * prefix. For a symlinked config the directory being swept belongs to the
	 * user, not to this application, and a prefix test deletes their own files:
	 * measured, `real.json.tmp-manual-backup-do-not-delete` was unlinked. Only
	 * names this code can actually have produced are removed. Names from the
	 * earlier pid-based scheme are deliberately left behind for the same reason,
	 * since a directory we do not own is no place to guess.
	 */
	private sweepStaleTempFiles(): void {
		const target = this.writeTarget();
		if (target === null) return;
		const dir = dirname(target);
		// Lowercase hex only, because that is what randomUUID() produces. If the
		// generator in saveByRename() ever changes, this must change with it. The
		// failure direction is safe: a mismatch leaves clutter, never deletes.
		const ours = new RegExp(
			`^${escapeForRegExp(basename(target))}\\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
		);
		const cutoff = Date.now() - TEMP_FILE_STALE_AFTER_MS;
		try {
			for (const entry of readdirSync(dir)) {
				if (!ours.test(entry)) continue;
				const stale = join(dir, entry);
				try {
					const info = lstatSync(stale);
					if (!info.isFile()) continue;
					if (info.mtimeMs > cutoff) continue;
					unlinkSync(stale);
				} catch {
					// Gone already, or not ours to remove. Either way, nothing to do.
				}
			}
		} catch (error) {
			log.warn(`Could not sweep stale config temp files: ${error}`);
		}
	}

	/**
	 * Resolve the path to write. A symlinked config is the normal dotfiles
	 * arrangement, and renaming over the link would replace it with a regular
	 * file and orphan the real target, so write through it instead. Measured
	 * before this existed: the link became a regular file on the first save and
	 * the target never saw another write.
	 *
	 * The resolved path is deliberately NOT passed back through
	 * validatePathOrThrow. Re-validating would reject a link into a dotfiles
	 * directory, which is the arrangement this exists to support. Do not "harden"
	 * this without replacing the dotfiles support.
	 *
	 * Returns null when the configured path is a symlink and its directory is
	 * writable by group or other. Planting a link then needs no privilege and no
	 * race, and following it would write every secret to a file the planter chose
	 * and let a chmod change an unrelated file's mode. That is the only case where
	 * a link is refused, so an ordinary dotfiles link in a 0755 home directory
	 * still works. A caller seeing null must not read, write or chmod anything.
	 */
	/**
	 * Walk the link chain by hand and check the trust of every directory it
	 * passes through, returning what a save should write or null to refuse.
	 *
	 * This walk is the only resolver, deliberately. realpathSync resolves the
	 * whole chain and never says what it passed through, so delegating to it for
	 * the common case would leave the intermediate hops unexamined. It also fails
	 * outright when the final target is missing, which is the case that most needs
	 * resolving.
	 *
	 * Every hop, not just the first and the last. An attacker who controls one
	 * intermediate link controls the destination, including destinations that pass
	 * a check on the landing directory: measured with
	 * safe/config.json (0700) -> shared/mid.json (1777) -> private/authorized_keys
	 * (0700 and ours), both of those directories passed and the victim file was
	 * overwritten with the config, destroying the key. There is no disclosure,
	 * since the result is 0600 and ours, but it is an arbitrary file overwrite
	 * anywhere we can write, with a target of their choosing. Which link they
	 * control makes no difference, so every one is checked.
	 *
	 * Every exit returns the `current` whose directory that same iteration
	 * checked, and that invariant is what makes the walk a trust check rather
	 * than decoration. It holds because no exit returns a path derived after the
	 * check: the last statement of the loop body assigns
	 * `resolve(dirname(current), readlinkSync(current))`, and `readlinkSync`
	 * is evaluated first, so a throw leaves `current` untouched and the next
	 * iteration re-checks whatever it does assign. Do not add an exit that
	 * computes a return value from `readlinkSync` output and returns it without
	 * looping: that path would be returned unchecked and the refusal would stop
	 * working silently, with no test failing.
	 *
	 * Bounded at 40 hops. Beyond that it is a cycle and is refused rather than
	 * falling back to the configured path, because that fallback would rename over
	 * the first link and destroy a link the operator manages, which is the
	 * destructive behaviour this walk exists to prevent, just relocated. The bound
	 * refuses nothing the kernel would have resolved: Linux gives up at 40 nested
	 * links and macOS at 32.
	 */
	private resolveLinkChain(): string | null {
		let current: string = this.configPath;
		for (let hop = 0; hop < 40; hop++) {
			// One message per refusal, naming the hop that failed, rather than one
			// per directory examined: the predicate itself stays silent.
			const trust = this.entryIsTrusted(current);
			if (trust !== "trusted") {
				this.refuse(this.refusalMessage(current, trust));
				return null;
			}
			let info: ReturnType<typeof lstatSync>;
			try {
				info = lstatSync(current);
			} catch {
				// Does not exist: this is the end of the chain and what to create.
				return current;
			}
			if (!info.isSymbolicLink()) return current;
			try {
				current = resolve(dirname(current), readlinkSync(current));
			} catch (error) {
				// lstat said this is a link and readlink then failed, so where it
				// points is unknown. Returning `current` would hand back the link
				// itself as the write target, and saveByRename() would rename over
				// it and destroy a link the operator manages: the same destructive
				// behaviour PR #57 removed from the cycle case. Nothing is disclosed
				// by refusing, since the trust check has already passed.
				this.refuse(
					`The config path ${this.configPath} passes through the symlink ${current}, which could not be read (${error}); refusing to read or write it`,
				);
				return null;
			}
		}
		// Refuse, rather than falling back to the configured path. Falling back
		// would rename over the first link and destroy a link the operator manages,
		// which is the destructive behaviour the chain walk exists to prevent, just
		// relocated to the cycle case. A cycle has no valid target. The bound
		// refuses nothing the kernel would have resolved: Linux gives up at 40
		// nested links and macOS at 32.
		this.refuse(
			`The config path ${this.configPath} has more than 40 symlink hops, which is a cycle; refusing to read or write it`,
		);
		return null;
	}

	/**
	 * Trust a regular file already sitting at the configured path, or refuse it.
	 *
	 * Until SB23-2317 this was an unconditional `return this.configPath`, so a
	 * regular file was the one route into the config that was never checked at
	 * all. Every ownership and sticky-bit rule from SB23-1696 and SB23-2267
	 * governs the symlink case. An attacker who pre-creates a regular file at the
	 * config path before the process first boots therefore chose our entire
	 * config: `local_control_secret`, which is an authentication bypass on the
	 * local control endpoint rather than a disclosure, and `pg_host` with
	 * `pg_password` pointing at a database they own. They also own the file, so
	 * the 0600 that restrictConfigFile() applies is theirs to undo.
	 *
	 * Deliberately blind to the containing directory, which is the opposite of the
	 * symlink rule and of this issue's own original acceptance criterion. Three
	 * reasons, in increasing order of how hard they are to argue with:
	 *
	 * A symlink is dangerous because it REDIRECTS the write to a file somebody
	 * else chose. A regular file redirects nothing; the write lands where we were
	 * told. So the directory's writability is not what makes it dangerous, and
	 * requiring a private directory would refuse the case
	 * config-file-mode.test.ts:589 exists to protect, where an install
	 * legitimately keeps its config in a shared directory.
	 *
	 * A directory-conditioned rule would also be wrong on its own terms. An
	 * attacker who OWNS a 0755 directory can hardlink a file into it, and 0755 is
	 * not group or other writable, so a gate conditioned on writability skips
	 * precisely that case.
	 *
	 * A third reason used to stand here and it was wrong, so it is corrected
	 * rather than deleted (SB23-2340). It read: `chmodSync` cannot set the sticky
	 * bit on Linux (SB23-2319), so any rule reading the directory's sticky bit
	 * passes on macOS and fails in CI. That conflates a fact about `chmodSync`
	 * with a claim about the rule's testability, and the second does not follow:
	 * `/tmp` is already 1777 on Linux, and `stickyFixture()` in
	 * @better-ccflare/security/testing uses exactly that when the chmod route
	 * fails, so a directory-conditioned rule IS testable on both platforms today.
	 *
	 * Measured while correcting it, docker, 2026-09-19, Bun 1.3.14 and Node 22 on
	 * the same alpine kernel, mode read back from statSync:
	 *
	 *                                        Bun      Node
	 *   mkdirSync(0o1777), umask 022         0755     1755
	 *   mkdirSync(0o1777), umask 0           0777     1777
	 *   mkdirSync(0o777) then chmod 0o1777   0777     1777
	 *   os.tmpdir()                          1777     1777
	 *
	 * So `mkdirSync` with an explicit mode is NOT the alternate route SB23-2340
	 * proposed: Bun drops S_ISVTX there too, the umask row rules out masking as
	 * the cause, and Node keeping the bit on the same kernel confirms it is Bun.
	 * A pre-built sticky directory, which is the fixture that shipped, is the
	 * route that works.
	 *
	 * The rule is unchanged. It never rested on this reason, and the two above it
	 * are each sufficient on their own.
	 *
	 * The single-name requirement is not redundant with the ownership test, and it
	 * is the "or root" half that needs it. A hardlink carries the inode's owner to
	 * a new name, and macOS has no fs.protected_hardlinks, so an ordinary user can
	 * run `ln /etc/hosts ./hosts-hl` and produce an entry that lstats as uid 0
	 * with two names. Measured during PR #169's review. Without nlink, that entry
	 * is accepted as root-owned.
	 *
	 * Measured on Linux in a container, 2026-09-19, which SB23-2339 was filed to
	 * settle because it was argued and not run (process uid, file uid, outcome):
	 * 1001/1001 loads, 1001/501 refuses, 0/501 refuses. The middle case is the
	 * documented compose layout in docs/deployment.md, which bind-mounts ./config
	 * from the host, so a file the host operator seeds carries the host uid and the
	 * image's chown does not reach it. Kept refusing rather than relaxed: from
	 * inside the container that really is a config another uid controls, which is
	 * the exposure this method exists for, so the remedy is documentation and a
	 * message that names the case. The third case, a root process against a
	 * service-account-owned config, is contemplated for writes at saveByRename and
	 * already given up for links in replaceUntrustedLink, and whether refusing the
	 * READ there is right is open as its own issue rather than settled here.
	 *
	 * Chowning the config to root is NOT the remedy, and it looks like one, so it
	 * is recorded here to stop it coming back. Measured in a container: root-owned
	 * at 0644 loads, because own.uid === 0 is accepted, and restrictConfigFile()
	 * then takes EPERM on its chmod, which only warns, so the file stays 0644 for
	 * the container's lifetime holding pg_password, local_control_secret and
	 * upstream_maintainer_token. That is the 0644-secrets class PR #57 and #140
	 * exist to close, reintroduced by the workaround. Root-owned at 0600 never
	 * reaches this method at all and fails with EACCES in readRegularFile(). Saves
	 * never persist either way. Found by PR #182's review, which falsified the
	 * author's own hypothesis that it was merely a partial remedy.
	 *
	 * Cost, disclosed: a config an operator deliberately hardlinked is refused,
	 * even in a directory only they can write. The sticky branch in entryIsTrusted()
	 * already made that trade, for the same reason and at the same rung.
	 *
	 * Returns the path when it is ours to use, or null having said why at error
	 * level, which every writeTarget() caller already handles.
	 */
	private trustedRegularPath(
		own: NonNullable<ReturnType<typeof lstatSync>>,
	): string | null {
		// POSIX ownership does not describe Windows ACLs and Stats.uid there is
		// synthesised, so this check cannot mean anything. Same rung and the same
		// reasoning as the win32 branch in writeTarget() below.
		if (process.platform === "win32") return this.configPath;
		// Anything that is not a regular file is not this method's to diagnose, and
		// saying nothing here is what keeps the accurate message. A directory has
		// nlink >= 2, so it used to reach the hardlink branch below and be told it
		// was "a regular file with 2 names", advising the operator to delete it; a
		// directory holding subdirectories read "with 17 names". readConfigData()
		// already refuses a non-regular path with the message that is true of it,
		// and restrictConfigFile() has its own isFile() guard, so handing the path
		// back is exactly the behaviour that shipped before this check existed.
		// Found by PR #172's review, which also noted why it slipped: no test pins
		// the message for a directory at the config path.
		if (!own.isFile()) return this.configPath;
		const uid = process.getuid?.();
		// An unreadable uid is treated as ours, matching entryIsTrusted(). Refusing
		// instead would make every regular config file on such a platform
		// unreadable, which trades a narrow exposure for a total outage.
		const ownedByUs = uid === undefined || own.uid === uid || own.uid === 0;
		if (!ownedByUs) {
			this.refuse(
				`Refusing the config path ${this.configPath}: it is a regular file owned by uid ${own.uid}, not by us (uid ${uid}), so another local user chose its contents. A config they control sets local_control_secret, which is an authentication bypass on the local control endpoint, along with pg_host and pg_password. The process starts on defaults instead, and local_control_secret is regenerated on every restart, which presents as clients intermittently failing to authenticate. If this is a container with the config bind-mounted from the host, the file carries its host owner and the image's chown does not apply to a bind mount: run chown -R ${uid}:${uid} on the mounted directories on the host, not just on the file, or use a named volume. See docs/deployment.md. Otherwise move the config somewhere only you can write, or remove that file so a fresh one is created.`,
			);
			return null;
		}
		if (own.nlink !== 1) {
			this.refuse(
				`Refusing the config path ${this.configPath}: it is a regular file with ${own.nlink} names, so it is a hardlink to a file elsewhere and its contents were not written as our config. A uid of ours does not prove we created the entry, because a hardlink carries the owner of the file it points at. Remove that name so a fresh config is created.`,
			);
			return null;
		}
		return this.configPath;
	}

	private writeTarget(): string | null {
		let link: ReturnType<typeof lstatSync>;
		try {
			link = lstatSync(this.configPath);
		} catch {
			// Nothing there yet. Write where we were told.
			return this.configPath;
		}
		if (!link.isSymbolicLink()) return this.trustedRegularPath(link);

		// POSIX mode bits do not describe Windows ACLs. Stats.mode there is
		// synthesised from the read-only attribute, and directories commonly
		// expose group and other write bits, so the trust check below would call
		// every private directory untrusted and refuse to persist anything through
		// a junction. Unverified on Windows, which neither author nor reviewer has:
		// argued from Node deriving st_mode from FILE_ATTRIBUTE_READONLY.
		if (process.platform === "win32") {
			try {
				return realpathSync(this.configPath);
			} catch {
				return this.configPath;
			}
		}

		// The walk checks the configured path's own directory, every hop, and the
		// directory the chain lands in, and refuses with one message naming the
		// offending hop.
		return this.resolveLinkChain();
	}

	/**
	 * A path is trusted when its containing directory is ours (or root's, so a
	 * root-owned /etc stays legitimate) and either that directory is not writable
	 * by group or other, or it is sticky and an entry of ours already exists at
	 * this exact path.
	 *
	 * Takes the entry rather than its directory, and derives the directory here.
	 * Both callers previously passed dirname() of the path they cared about, and
	 * the sticky exception needs that path: a signature taking a directory cannot
	 * express the check, and one taking an entry cannot omit it.
	 *
	 * Ownership as well as mode, because statSync follows links: the mode alone is
	 * the mode of whatever the component points at, so an attacker who can write a
	 * shared directory pre-creates an intermediate component as a link to a 0700
	 * directory of their own and the mode test passes on their behalf. Measured
	 * with /tmp/ccflare/config.json, the dirname mode read 700 and the link was
	 * followed.
	 *
	 * The sticky exception exists because os.tmpdir() is one of the validator's
	 * allowed base paths and on Linux that is /tmp at 1777, where the old rule
	 * refused a legitimate config outright: not only its writes, but its reads,
	 * so the process ran on defaults (SB23-2267). In a sticky directory only the
	 * entry's owner, the directory's owner and root may unlink or rename an entry,
	 * and only root may chown a symlink, so another local user cannot substitute a
	 * single-named entry of ours. The obvious objection does not hold: an attacker
	 * who plants a link before ours exists owns that link, and the uid comparison
	 * rejects it.
	 *
	 * "Single-named" is load-bearing and was missing from the first version of this
	 * check. A uid of ours does not by itself mean we created the entry, because a
	 * hardlink carries the inode's owner to a new name; the nlink conjunct below is
	 * what makes the sentence above true. Found by review, measured, not argued.
	 *
	 * Argued from POSIX, not measured against a second local account, which this
	 * host does not have. The same rung as the ownership check in
	 * replaceUntrustedLink(), which shipped on the same argument in PR #145. What
	 * the tests do reach is the comparison itself, through a root-owned sticky
	 * directory (/tmp is uid 0 and 1777 on both macOS and Linux) so that a stubbed
	 * uid is refused by this line rather than by the ownership test above it.
	 */
	private entryIsTrusted(entry: string): EntryTrust {
		let info: ReturnType<typeof statSync>;
		try {
			info = statSync(dirname(entry));
		} catch {
			// Silent: the walk reports one message naming the hop that failed.
			return "directory";
		}
		const uid = process.getuid?.();
		const ownedByUs = uid === undefined || info.uid === uid || info.uid === 0;
		if (!ownedByUs) return "directory";
		if ((info.mode & 0o022) === 0) return "trusted";
		// Sticky, so removal and renaming are restricted to the entry's owner, the
		// directory's owner and root (S_ISVTX, 0o1000).
		if ((info.mode & 0o1000) === 0) return "directory";
		// Ownership cannot be established without a uid to compare, so refuse.
		// Unreachable from the walk, which returns early on win32, but the sticky
		// exception is the one branch where an unknown uid would widen trust
		// rather than narrow it, so it does not rely on the caller.
		if (uid === undefined) return "sticky-entry";
		try {
			// lstat, not stat: the entry's own ownership is the claim, and a link
			// here would substitute the uid of whatever it points at, which is the
			// attacker's choice.
			const own = lstatSync(entry);
			// A uid of ours does NOT mean we created this entry, and the first
			// version of this check said it did. A hardlink carries the inode's
			// owner to a new name, so another local user can manufacture an entry
			// that lstats as ours: measured on macOS, which has no
			// fs.protected_hardlinks, `ln /etc/hosts ./hosts-hl` as an ordinary user
			// succeeds and the new entry lstats as uid 0. Pointed at a regular file
			// of ours it is worse than it sounds, because the trust decision gates
			// the READ as well: the file's contents are adopted as config, which is
			// a local_control_secret injection, and restrictConfigFile() then
			// chmods it to 0600 through the link.
			//
			// nlink, not a symlink test. Every entry we would legitimately trust
			// here has exactly one name: a symlink of ours, or a regular config
			// file. A planted hardlink has two, and the planter cannot get it back
			// to one, because the name they would have to remove is ours and lives
			// outside this directory. On Linux the same conjunct also covers a
			// hardlink to one of our symlinks, which is what an attacker gets on a
			// host running fs.protected_hardlinks=0.
			if (own.nlink !== 1) return "sticky-entry";
			return own.uid === uid ? "trusted" : "sticky-entry";
		} catch {
			// Nothing there. A sticky directory says who may remove an entry, never
			// who may create one, so an absent entry is the attacker's to plant and
			// there is no ownership to test. Refuse; the non-sticky rule above is
			// what a create in a shared directory still has to satisfy.
			return "sticky-entry";
		}
	}

	/**
	 * Emit a refusal diagnosis at most once per process (SB23-2357). See
	 * refusalsEmitted above for what this does not cover.
	 */
	private refuse(message: string): void {
		if (refusalsEmitted.has(message)) return;
		refusalsEmitted.add(message);
		log.error(message);
	}

	/**
	 * The refusal text for a hop the walk rejected, chosen from WHY it was
	 * rejected (SB23-2318).
	 *
	 * One message covered both reasons before this, and it named only the
	 * directory: "sits in a directory owned by another user or writable by other
	 * local users ... Move the config somewhere only you can write." That is true
	 * of the `directory` reason and false of the `sticky-entry` one, where the
	 * directory is exactly what the sticky exception permits and the failure is
	 * the entry at the end of the hop. An operator following it literally moves
	 * the file and the refusal follows it, because moving does not create an
	 * entry at the name the walk is checking.
	 *
	 * Each branch names only what its own predicate read. `directory` read
	 * `statSync(dirname)`; `sticky-entry` read `lstatSync(entry)` for existence,
	 * nlink and uid, and says so as a disjunction, because the three share one
	 * catch and one return and the code does not know which of them failed.
	 * Asserting the specific one would be the failure mode this family has shipped
	 * twice: a message stating something the code did not check.
	 *
	 * The defaults sentence is conditional, and that is not hedging. writeTarget()
	 * is reached from loadConfig(), readLocalControlSecretFromDisk(),
	 * restrictConfigFile(), sweepStaleTempFiles() and saveConfig(), so an
	 * unconditional "the process starts on defaults" would be false on every save
	 * refusal after boot. restrictConfigDir() is deliberately NOT in that list: it
	 * reads dirname(this.configPath) directly and never calls writeTarget(), which
	 * is why it still runs on a refusal path. An earlier version of this list named
	 * it and omitted the other two; corrected by PR #190's review.
	 */
	private refusalMessage(hop: string, reason: RefusedTrust): string {
		const uid = process.getuid?.();
		const fellBack =
			`If this line appears at startup then the config was not read and this process ` +
			`is running on defaults, which regenerates local_control_secret, so anything ` +
			`holding the previous one stops authenticating against the local control endpoint.`;
		if (reason === "sticky-entry") {
			return (
				`Refusing the config path ${this.configPath}: ${hop} sits in a sticky ` +
				`directory, where this path is trusted only when an entry already exists at ` +
				`that exact name, has exactly one hard link, and is owned by uid ` +
				`${uid ?? "unknown"}. One of those is not true of ${hop}. A sticky bit ` +
				`restricts who may remove an entry, never who may create one, so a name that ` +
				`does not exist yet is another local user's to claim first, and a name with a ` +
				`second hard link was not written as our config. Create that entry yourself ` +
				`before starting, or point the config at a directory no other local user can ` +
				`write. Moving the config to another name in the same shared directory does ` +
				`not satisfy this. ${fellBack}`
			);
		}
		return (
			`Refusing the config path ${this.configPath}: ${hop} sits in a directory that ` +
			`could not be examined, or is owned by another user, or is writable by other ` +
			`local users without the sticky bit, so ` +
			`another local user can plant or replace what is at ${hop} and it cannot be ` +
			`trusted with secrets. Move the config somewhere only you can write, or replace ` +
			`the link with a regular file. ${fellBack}`
		);
	}

	private saveConfig(): void {
		// Refuse rather than write a config this instance knows is incomplete
		// (SB23-2366, ruled by Sean 2026-09-21).
		//
		// this.data is missing whatever stripUntrustedFields() dropped, and
		// JSON.stringify(this.data) below is the whole file, so a save here
		// DELETES the operator's credentials from disk. Measured at dca5c7ea on a
		// 13-key config: 9 operator fields gone on the same boot, and
		// buildPgConnectionUrl() then falls back to SQLite silently.
		//
		// Refusing, not throwing, and not retaining the stripped values to write
		// back. Retaining them re-persists attacker-supplied values into a file
		// that restrictConfigFile() has since brought to 0600, which is the exact
		// laundering the strip exists to prevent. Throwing was rejected because
		// get(key, defaultValue) calls set() on every miss, so a throw would turn
		// every getter with a default into a crash, in a request handler as
		// readily as at boot; every other refusal in this method already returns
		// after an error line, and this matches them.
		//
		// Outcome every time, no dedupe. stripUntrustedFields() has already
		// diagnosed the cause once per path; each refused save is a separate lost
		// write, and suppressing the second would hide a settings change that did
		// not persist. That is the split this file already keeps (SB23-2379,
		// SB23-2357), and it is why the "Config not saved" line below is not
		// deduplicated either.
		if (this.strippedFields.size > 0) {
			log.error(
				`Config not saved: ${this.strippedFrom} was loaded from a file other local users can write, with ${this.strippedFields.size} credential or endpoint field(s) ignored, and writing it back would delete them from disk. The setting is held in memory for this process only. local_control_secret is regenerated on every boot while this lasts and is never written, so local control clients holding an earlier secret fail to authenticate. Make the file writable only by its owner, or move it to a directory no other local user can write, then restart.`,
			);
			return;
		}
		// Refuse rather than replace a file this process could not read
		// (SB23-2469). Same reason as the strip refusal above and a different
		// trigger: that one needs another local user able to write the config,
		// this one needs a trailing comma.
		//
		// ABOVE writeTarget() and above `content`, and that placement is
		// load-bearing rather than tidy. writeTarget() returning null falls
		// through to replaceUntrustedLink(content), which WRITES. A check below
		// that line refuses the two ordinary write paths and leaves the third
		// open, which is worse than no check at all, because the case it would
		// miss is the one where the config path is already attacker-influenced.
		// Mutation (c) on this PR moves it there.
		//
		// Not deduplicated, matching the refusal above it and saveConfig()'s other
		// outcome lines. The diagnosis landed once, in readConfigData(); each
		// refused save is a separate setting that did not persist, and suppressing
		// the second would hide one. That is this file's standing split, diagnosis
		// once and outcome every time (SB23-2379, SB23-2357).
		//
		// Returns rather than throws, for the reason the strip refusal gives:
		// get(key, defaultValue) calls set() on every miss, so a throw here would
		// turn every getter carrying a default into a crash, in a request handler
		// as readily as at boot.
		if (this.unparseableFrom !== undefined) {
			log.error(
				`Config not saved: ${this.unparseableFrom} could not be read as config data, reported above, so this process is running on defaults and writing them back would replace that file's contents with them. The setting is held in memory for this process only. local_control_secret is regenerated on every boot while this lasts and is never written, so local control clients holding an earlier secret fail to authenticate. Fix the file, or move it aside so a fresh one is created, then restart.`,
			);
			return;
		}
		const content = JSON.stringify(this.data, null, 2);
		const target = this.writeTarget();
		if (target === null) {
			// An untrusted link at the configured path is replaced rather than
			// followed, so settings keep persisting. Every other refusal still
			// refuses; writeTarget() has already said why at error level.
			if (this.replaceUntrustedLink(content)) return;
			log.error("Config not saved: the configured path cannot be trusted");
			return;
		}
		if (this.saveByRename(target, content)) return;
		// The rename path needs a writable *directory*. A root-owned directory
		// holding a config chmodded for the service user is a documented layout
		// (docs/configuration.md:113, docs/troubleshooting.md:836), and there the
		// temp file cannot be created at all. Fall back to writing in place so the
		// save still happens, and say so: the in-place write is the weaker path.
		//
		// This is not a hole in the 0600 goal, and the reason is not local. An
		// in-place write cannot set the mode of a file that already exists, so it
		// would ordinarily republish the secret at whatever mode the file had.
		// restrictConfigFile() on the load path has already brought the file to
		// 0600 before any save runs, so it inherits 0600. The 0644 window returns
		// only if that load-time chmod also failed, and that warns.
		try {
			writeFileSync(target, content, { encoding: "utf8", mode: 0o600 });
		} catch (error) {
			log.error(`Failed to save config file: ${error}`);
			return;
		}
		this.restrictConfigFile();
		log.warn(
			"Saved the config by writing in place because the atomic replace failed; " +
				"a reader holding the file open from before this save can still see it",
		);
	}

	/**
	 * Write a new 0600 file and rename it over the config rather than truncating
	 * in place. Three reasons, all about secrets:
	 *   - writeFileSync's mode applies only on creation, so an in-place write to
	 *     an existing 0644 file publishes the NEW secret at 0644 until a chmod
	 *     lands, and a crash in between leaves it exposed for good.
	 *   - truncating keeps the inode, so a descriptor opened while the file was
	 *     0644 keeps reading every later save. Rename swaps the inode and leaves
	 *     that reader on the unlinked old file.
	 *   - rename is atomic, so a process crash mid-write cannot leave a partial
	 *     config. fsync before the rename buys integrity, not durability: it
	 *     removes the hazard of the rename becoming durable while the data blocks
	 *     are not, which would bring the config back zero-length or stale, and
	 *     ext4's flush on replace-via-rename is a heuristic rather than a
	 *     guarantee. The last save can still be lost to power loss, because the
	 *     containing directory is never synced. That is the safe direction: the
	 *     previous config comes back whole.
	 *
	 * The temp name is random and created with O_EXCL, never a predictable one
	 * overwritten with writeFileSync. A predictable sibling is attacker-plantable
	 * when the config's directory is writable by another local user: writeFileSync
	 * follows an existing symlink, so the secrets would be written to a file the
	 * attacker chose and can read. O_EXCL refuses to follow and refuses to reuse.
	 *
	 * Either defence alone closes that, which is why no test can exercise both:
	 * a test cannot pre-plant a file at a path it cannot predict, so the random
	 * name is what makes O_EXCL unobservable. Strengthening one hides the other.
	 *
	 * Returns false without logging an error when the caller should fall back.
	 */
	/**
	 * Give the temp file the existing config's owner, so a rename does not change
	 * who owns the config. Returns false when it cannot, which makes the caller
	 * fall back to an in-place write.
	 *
	 * True when there is nothing to preserve (no existing file, or it is already
	 * ours), and on Windows, where chown is meaningless and process.getuid does
	 * not exist.
	 */
	private preserveOwnership(fd: number, target: string): void {
		if (process.platform === "win32") return;
		let existing: ReturnType<typeof statSync>;
		try {
			existing = statSync(target);
		} catch {
			// First write: there is no previous owner to keep.
			return;
		}
		const uid = process.getuid?.();
		const gid = process.getgid?.();
		if (uid === undefined || gid === undefined) return;
		if (existing.uid === uid && existing.gid === gid) return;
		try {
			fchownSync(fd, existing.uid, existing.gid);
		} catch (error) {
			// One log for one cause: the caller reports the refused rename, so this
			// throws its reason rather than warning and letting the caller warn too.
			throw new Error(
				`cannot give the new config file its previous owner ${existing.uid}:${existing.gid}: ${error}`,
			);
		}
	}

	/**
	 * Replace an untrusted link at the configured path instead of following it,
	 * so settings still persist.
	 *
	 * Before this, an untrusted link meant nothing was ever saved again. Writing
	 * a fresh 0600 temp file and renaming it over the link path is no less safe
	 * than refusing, because nothing is written through the link either way, and
	 * it is strictly more useful: the planted link is destroyed rather than
	 * followed and no unrelated file is touched. The cost is that a link an
	 * operator placed deliberately in a shared-writable directory becomes a
	 * regular file, which is the right outcome when the directory cannot be
	 * trusted (SB23-1696).
	 *
	 * Only when the CONFIGURED path is itself a link whose own directory is
	 * untrusted. A refusal from deeper in the chain leaves the configured link in
	 * a directory only we can write, which makes it the operator's own link, and
	 * renaming over it is exactly the destructive behaviour resolveLinkChain()
	 * refuses in the cycle case. The same goes for a readlink failure and a
	 * cycle: both keep refusing.
	 *
	 * The read stays refused whatever this does. A config another local user
	 * controls is an authentication bypass through local_control_secret, not a
	 * disclosure, so this.data is already empty by the time a save runs and what
	 * lands on disk is ours.
	 *
	 * No in-place fallback, deliberately. saveByRename() opens with O_EXCL under
	 * a random name, which cannot follow a planted link; writeFileSync() on the
	 * configured path would follow one, and this branch runs precisely when
	 * another local user can plant it.
	 *
	 * Returns false when this is not that case, so the caller refuses as before.
	 */
	private replaceUntrustedLink(content: string): boolean {
		if (process.platform === "win32") return false;
		let link: ReturnType<typeof lstatSync>;
		try {
			link = lstatSync(this.configPath);
		} catch {
			return false;
		}
		if (!link.isSymbolicLink()) return false;
		// A link that belongs to us was created by us, because only root may chown
		// a symlink, so it is the operator's own arrangement and destroying it is
		// not this branch's business. That matters more than it looks:
		// entryIsTrusted() rejects any group or other writable directory that is not
		// sticky, and
		// on a distribution with umask 002 and per-user private groups mkdir
		// ~/.config produces 0775 owned by the user and the user's own group. That
		// directory is effectively private and is rejected anyway, and a dotfiles
		// link inside it is exactly the arrangement resolveLinkChain() says it
		// exists to support.
		//
		// Without this the misdetection turns from reversible into permanent.
		// Refusing left the link and the settings intact, and chmod 700 on the
		// directory restored everything. Replacing destroys the link, and since
		// the read has already set this.data to {}, what lands in its place is a
		// file of defaults: measured, 24 bytes, with local_control_secret
		// regenerated and every existing client's secret invalidated.
		//
		// It costs the fix nothing. In a directory another user can write without
		// the sticky bit they unlink ours and plant their own, which carries their
		// uid and is still replaced; with the sticky bit they cannot unlink ours
		// at all. The one case this gives up is a root process facing a link owned
		// by the service user, which now refuses rather than replaces, and
		// refusing is the safe direction.
		const uid = process.getuid?.();
		if (uid === undefined || link.uid === uid) return false;
		// === "trusted", never truthiness. entryIsTrusted() returns a reason
		// since SB23-2318 and every reason string is truthy, so a bare test here
		// made this method return false for a link it was supposed to replace.
		// TypeScript accepts a truthy union, so only the wider suite caught it.
		if (this.entryIsTrusted(this.configPath) === "trusted") return false;
		if (!this.saveByRename(this.configPath, content, false)) {
			log.error(
				`Config not saved: ${this.configPath} is an untrusted symlink and it could not be replaced`,
			);
			return true;
		}
		log.warn(
			`Replaced the untrusted symlink at ${this.configPath} with a regular config file rather than writing through it. Its directory is writable by other local users, so anyone could have planted that link; move the config somewhere only you can write.`,
		);
		return true;
	}

	private saveByRename(
		target: string,
		content: string,
		keepExistingOwner = true,
	): boolean {
		const tmpPath = `${target}.tmp-${randomUUID()}`;
		try {
			// "wx" is O_WRONLY|O_CREAT|O_EXCL: fails if the path exists at all,
			// including as a symlink, so neither a planted link nor a collision
			// can redirect this write.
			const fd = openSync(tmpPath, "wx", 0o600);
			try {
				writeFileSync(fd, content, "utf8");
				// The create mode above is masked by umask: measured, under umask 0277
				// it produces 0400, which the rename would carry onto the config and
				// break every later write. Set through the descriptor rather than the
				// path, because a path-based chmod follows a symlink and the window
				// between write and chmod is enough for one to appear in a directory
				// another user can write.
				fchmodSync(fd, 0o600);
				// The temp inode belongs to whoever is writing, and the rename
				// discards the old file's ownership. An administrator running the CLI
				// as root against a config owned by the service account would leave
				// it root-owned and 0600, so the service could no longer read it on
				// the next restart. The in-place write preserved ownership, so this
				// has to as well: copy the existing owner onto the descriptor, and if
				// that is not permitted, refuse the rename so the caller writes in
				// place rather than changing who owns the config.
				//
				// Skipped when the target is an untrusted link being replaced.
				// preserveOwnership() stats the target, which follows the link, so it
				// would read the uid of whatever the planter pointed at and fchown our
				// new config to them. That would hand over the file this branch exists
				// to keep out of their hands.
				if (keepExistingOwner) this.preserveOwnership(fd, target);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			renameSync(tmpPath, target);
			return true;
		} catch (error) {
			log.warn(`Could not replace the config file atomically: ${error}`);
			try {
				if (existsSync(tmpPath)) unlinkSync(tmpPath);
			} catch (cleanupError) {
				log.warn(`Failed to remove temporary config file: ${cleanupError}`);
			}
			return false;
		}
	}

	get(
		key: string,
		defaultValue?: string | number | boolean,
	): string | number | boolean | undefined {
		if (key in this.data) {
			const value = this.data[key];
			// Settings with an object value (e.g.
			// provider_model_default_overrides) have their own typed getter.
			// This generic accessor serves scalars only — returning the object
			// here would misrepresent the declared type.
			return typeof value === "object" ? undefined : value;
		}

		if (defaultValue !== undefined) {
			this.set(key, defaultValue);
			return defaultValue;
		}

		return undefined;
	}

	set(key: string, value: string | number | boolean): void {
		const oldValue = this.data[key];
		this.data[key] = value;
		this.saveConfig();

		// Emit change event
		this.emit("change", { key, oldValue, newValue: value });
	}

	getStrategy(): StrategyName {
		return this.resolveStrategy().value;
	}

	/**
	 * Report where the effective load-balancing strategy comes from, mirroring
	 * the precedence in getStrategy(): a valid LB_STRATEGY env value wins
	 * ("env"), else a valid config-file field ("file"), else the built-in
	 * default ("default"). The dashboard uses "env" to lock the strategy
	 * control, because a POST that writes the file field is ineffective while
	 * the env var overrides it.
	 */
	getStrategySource(): "env" | "file" | "default" {
		return this.resolveStrategy().source;
	}

	setStrategy(strategy: StrategyName): void {
		if (!isValidStrategy(strategy)) {
			throw new Error(`Invalid strategy: ${strategy}`);
		}
		this.set("lb_strategy", strategy);
	}

	getDefaultAgentModel(): string {
		// First check environment variable
		const envModel = process.env.DEFAULT_AGENT_MODEL;
		if (envModel) {
			return envModel;
		}

		// Then check config file
		const configModel = this.data.default_agent_model;
		if (configModel) {
			return configModel;
		}

		// Default to the centralized default agent model
		return DEFAULT_AGENT_MODEL;
	}

	setDefaultAgentModel(model: string): void {
		this.set("default_agent_model", model);
	}

	getOutboundProxy(): string | undefined {
		const candidate =
			process.env.BETTER_CCFLARE_OUTBOUND_PROXY ?? this.data.outbound_proxy;
		if (!candidate) {
			return undefined;
		}
		try {
			return validateEndpointUrl(candidate, "outbound_proxy");
		} catch (error) {
			log.warn("Invalid outbound proxy URL. Ignoring.", error);
			return undefined;
		}
	}

	private clamp(n: number, min: number, max: number): number {
		return Math.max(min, Math.min(max, n));
	}

	getDataRetentionDays(): number {
		const fromEnv = process.env.DATA_RETENTION_DAYS;
		if (fromEnv) {
			const n = parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 1, 365);
		}
		const fromFile = this.data.data_retention_days;
		if (typeof fromFile === "number") return this.clamp(fromFile, 1, 365);
		// Default payload retention reduced to 1 day to bound request_payloads
		// growth: each request stores up to ~4 MiB of conversation history, so
		// high-volume proxies otherwise reach tens of GB. Override via the
		// DATA_RETENTION_DAYS env var or the data_retention_days config key.
		return 1;
	}

	setDataRetentionDays(days: number): void {
		const clamped = this.clamp(days, 1, 365);
		this.set("data_retention_days", clamped);
	}

	getRequestRetentionDays(): number {
		const fromEnv = process.env.REQUEST_RETENTION_DAYS;
		if (fromEnv) {
			const n = parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 1, 3650);
		}
		const fromFile = this.data.request_retention_days;
		if (typeof fromFile === "number") return this.clamp(fromFile, 1, 3650);
		return 90; // default metadata retention (90 days for analytics and troubleshooting)
	}

	setRequestRetentionDays(days: number): void {
		const clamped = this.clamp(days, 1, 3650);
		this.set("request_retention_days", clamped);
	}

	getUsageHistoryRetentionDays(): number {
		const fromEnv = process.env.USAGE_HISTORY_RETENTION_DAYS;
		if (fromEnv) {
			const n = parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 1, 3650);
		}
		const fromFile = this.data.usage_history_retention_days;
		if (typeof fromFile === "number") return this.clamp(fromFile, 1, 3650);
		return 90; // default: keep 90 days of usage-window history
	}

	setUsageHistoryRetentionDays(days: number): void {
		const clamped = this.clamp(days, 1, 3650);
		this.set("usage_history_retention_days", clamped);
	}

	getStorePayloads(): boolean {
		const fromEnv = process.env.STORE_PAYLOADS;
		if (fromEnv) {
			return fromEnv !== "false" && fromEnv !== "0";
		}
		const fromFile = this.data.store_payloads;
		if (typeof fromFile === "boolean") return fromFile;
		return true; // default: store payloads
	}

	setStorePayloads(value: boolean): void {
		this.set("store_payloads", value);
	}

	getRequestStorageHeadersOnly(): boolean {
		const fromEnv = process.env.REQUEST_STORAGE_HEADERS_ONLY;
		if (fromEnv) {
			return fromEnv !== "false" && fromEnv !== "0";
		}
		const fromFile = this.data.request_storage_headers_only;
		if (typeof fromFile === "boolean") return fromFile;
		return false; // default: store full bodies
	}

	setRequestStorageHeadersOnly(value: boolean): void {
		this.set("request_storage_headers_only", value);
	}

	/**
	 * Which of the three retry keys are supplied by the environment.
	 *
	 * Reported so the dashboard can say what a saved value does to an
	 * environment variable. getRuntime() applies the config file AFTER the
	 * environment, so a value written here outranks RETRY_ATTEMPTS,
	 * RETRY_DELAY_MS and RETRY_BACKOFF rather than being shadowed by them.
	 * That is the opposite of the OpenObserve token, where the environment
	 * wins, and it is worth saying on the card rather than leaving an operator
	 * to discover which way round it goes.
	 */
	getRetryEnvironmentKeys(): string[] {
		return ["RETRY_ATTEMPTS", "RETRY_DELAY_MS", "RETRY_BACKOFF"].filter(
			(name) => process.env[name] !== undefined,
		);
	}

	/**
	 * The deprecated CCFLARE_OVERLOAD_RETRY_* variables that are in force.
	 *
	 * Reported SEPARATELY from getRetryEnvironmentKeys() because the two groups
	 * mean opposite things. The RETRY_* group loses to a value saved from the
	 * dashboard; this group beats it, inside getOverloadRetryConfig() in
	 * packages/core, for the in-place 529 loop and the ZAI 1305 loop. One
	 * undifferentiated list of "variables in force" would read as a single fact
	 * and mislead in both directions at once.
	 */
	getOverloadRetryEnvironmentKeys(): string[] {
		return [
			"CCFLARE_OVERLOAD_RETRY_ENABLED",
			"CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS",
			"CCFLARE_OVERLOAD_RETRY_BASE_MS",
		].filter((name) => process.env[name] !== undefined);
	}

	/**
	 * Writes the three documented retry keys.
	 *
	 * No clamping and no fallback here: the one caller is the API handler,
	 * which rejects an out-of-range value outright so the operator is told.
	 * The config file and the environment keep their own forgiving path
	 * through getRuntime(), because a boot-time value must not stop the proxy.
	 */
	setRetrySettings(settings: {
		attempts: number;
		delayMs: number;
		backoff: number;
	}): void {
		this.set("retry_attempts", settings.attempts);
		this.set("retry_delay_ms", settings.delayMs);
		this.set("retry_backoff", settings.backoff);
	}

	/**
	 * Whether the unattended incremental-vacuum backstop
	 * (`incrementalVacuumAdaptive`, driven by the hourly retention tick and the
	 * 5-minute catch-up tick) is allowed to run at all. Defaults to true so
	 * behaviour is unchanged for existing installs.
	 *
	 * Escape hatch for the scenario an earlier production incident needed a
	 * marker-file hotfix for: an operator running an external backup, a
	 * manual `--compact`, or another maintenance window wants zero automatic
	 * writer-slot contention from reclaim, without touching retention or
	 * payload cleanup (which keep running — this only gates the reclaim
	 * step). Also gates the one-time auto_vacuum-mode migration VACUUM that
	 * runs at startup on an upgraded install (`runVacuumBootstrap()` in
	 * apps/server/src/vacuum-scheduler.ts), for the same reason.
	 *
	 * **Takes effect immediately for the two periodic reclaim ticks, but not
	 * for the one-time startup migration.** `apps/server/src/vacuum-scheduler.ts`'s
	 * `runHourlyTick()` and `runCatchUpTick()` both call this getter live on
	 * every tick (they read `this.data` fresh via `get()`/`set()`'s shared
	 * in-memory snapshot, not a cached value), so an in-process call to
	 * `setAutoVacuumEnabled()` — or any `set("auto_vacuum_enabled", …)` call —
	 * is picked up on the very next tick, no restart needed. The one
	 * exception is `runVacuumBootstrap()`'s one-time auto_vacuum-mode
	 * migration: it reads this value once, at server startup before the HTTP
	 * listener binds, and never again — a switch flipped after boot cannot
	 * make a deferred migration run without a restart (see that function's
	 * doc comment). Separately, an *external* edit — hand-editing the config
	 * file on disk, or changing the env var from outside this process — has
	 * no effect on an already-running process, but the two halves of that
	 * claim hold for different reasons. The on-disk file really is read only
	 * once, in the constructor's `loadConfig()` call, and nothing here
	 * re-reads it afterward, so only an in-process caller of
	 * `set()`/`setAutoVacuumEnabled()` can change what `this.data` holds. The
	 * env var is different: this getter reads `process.env.BETTER_CCFLARE_AUTO_VACUUM`
	 * fresh on every single call (see the `fromEnv` check just below) — an
	 * *in-process* mutation of `process.env` would in principle take effect
	 * on the very next call, no `set()` involved — but no code path in this
	 * codebase ever writes to `process.env` after startup, and an external
	 * process or shell cannot push a changed environment variable into a
	 * process that is already running (the OS only hands a process its
	 * environment once, at exec time). So in practice an externally-edited
	 * env var behaves exactly like the file: fixed until restart. Set it (and
	 * restart) *before* the maintenance window starts if you're relying on an
	 * external edit rather than a live in-process call — today there is no
	 * API route or CLI flag that makes such a call, so a restart is in
	 * practice the only way to change this switch's effect from outside the
	 * process.
	 *
	 * Same env-parsing shape as `getStorePayloads()` (opt-out, default-on):
	 * only the literal values `"false"` and `"0"` disable it — any other set
	 * value (including `"off"`, `"no"`, `"disabled"`) is treated as enabled,
	 * matching that sibling storage toggle's parsing exactly (and its same
	 * gap: those common spellings are silently accepted as "on").
	 */
	getAutoVacuumEnabled(): boolean {
		const fromEnv = process.env.BETTER_CCFLARE_AUTO_VACUUM;
		if (fromEnv) {
			return fromEnv !== "false" && fromEnv !== "0";
		}
		const fromFile = this.data.auto_vacuum_enabled;
		if (typeof fromFile === "boolean") return fromFile;
		return true; // default: automatic reclaim enabled
	}

	/**
	 * Persists the switch to the config file AND updates the in-memory value
	 * immediately — `set()` mutates `this.data` synchronously before the
	 * write-to-disk, so the very next `getAutoVacuumEnabled()` call in this
	 * same process already reflects it (proven by
	 * `auto-vacuum-enabled.test.ts`'s "setAutoVacuumEnabled persists the
	 * value read back by the getter" case). Because the two periodic reclaim
	 * ticks read that getter live on every tick, calling this takes effect on
	 * their very next run, no restart needed; only the one-time startup
	 * migration (`runVacuumBootstrap()`) is unaffected by a call made after
	 * boot, since it only ever reads the value once (see
	 * `getAutoVacuumEnabled()`'s doc comment). No production caller exists
	 * yet (no API route or CLI flag writes this field); kept as
	 * forward-looking config-surface API, the same shape as e.g.
	 * `setUsagePollIntervalMs()` below, which has no caller at all,
	 * production or test.
	 */
	setAutoVacuumEnabled(value: boolean): void {
		this.set("auto_vacuum_enabled", value);
	}

	getUsagePollIntervalMs(): number {
		const fromEnv = process.env.USAGE_POLL_INTERVAL_MS;
		if (fromEnv) {
			const n = parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 10000, 3600000);
		}
		const fromFile = this.data.usage_poll_interval_ms;
		if (typeof fromFile === "number")
			return this.clamp(fromFile, 10000, 3600000);
		return 90000; // default: 90 seconds
	}

	setUsagePollIntervalMs(ms: number): void {
		const clamped = this.clamp(ms, 10000, 3600000);
		this.set("usage_poll_interval_ms", clamped);
	}

	getCacheKeepaliveTtlMinutes(): number {
		const fromEnv = process.env.CACHE_KEEPALIVE_TTL_MINUTES;
		if (fromEnv) {
			const n = parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 0, 60);
		}
		const fromFile = this.data.cache_keepalive_ttl_minutes;
		if (typeof fromFile === "number") return this.clamp(fromFile, 0, 60);
		return 0; // default: disabled
	}

	setCacheKeepaliveTtlMinutes(minutes: number): void {
		const clamped = this.clamp(minutes, 0, 60);
		this.set("cache_keepalive_ttl_minutes", clamped);
	}

	/**
	 * Returns the persisted local-control secret, generating and persisting
	 * one on first access. Both the server (via AuthService) and the CLI
	 * (via this same Config, backed by the same on-disk config file) resolve
	 * to the identical value, so the CLI can authorize its own notify calls
	 * to its own locally-running server without ever handling a real API
	 * key (issue #216).
	 */
	getLocalControlSecret(): string {
		const existing = this.data.local_control_secret;
		if (typeof existing === "string" && existing.length > 0) {
			return existing;
		}

		// Re-check the on-disk file before generating a new secret: another
		// process (e.g. a CLI invocation racing the server's first-ever boot)
		// may have already generated and persisted one after this instance's
		// `this.data` was loaded into memory. Adopting that value instead of
		// overwriting it avoids the two processes permanently disagreeing on
		// the secret for the lifetime of this server process (see comment on
		// the local_control_secret field above).
		const fromDisk = this.readLocalControlSecretFromDisk();
		if (typeof fromDisk === "string" && fromDisk.length > 0) {
			this.data.local_control_secret = fromDisk;
			return fromDisk;
		}

		const secret = randomUUID();
		this.set("local_control_secret", secret);
		return secret;
	}

	/**
	 * Best-effort fresh read of just the local_control_secret field from the
	 * on-disk config file, bypassing the in-memory `this.data` snapshot.
	 * Mirrors the existsSync/readFileSync/JSON.parse pattern used by
	 * loadConfig(), but never mutates `this.data` or writes to disk itself —
	 * callers decide what to do with the result. Returns undefined on any
	 * read/parse failure (matching loadConfig()'s log-and-continue behavior).
	 */
	private readLocalControlSecretFromDisk(): string | undefined {
		if (!existsSync(this.configPath)) {
			return undefined;
		}
		// Same trust gate as loadConfig(). This is a second reader of the same
		// path, and it is the sharper one: adopting an attacker's
		// local_control_secret is an authentication bypass on the local control
		// endpoint, not a disclosure. Measured while gating only loadConfig(),
		// getLocalControlSecret() still returned the attacker's value through here.
		const trusted = this.writeTarget();
		if (trusted === null) {
			// Say what the refusal costs, not just that it happened. The caller
			// generates a fresh secret, which keeps the endpoint authenticated with
			// a value the attacker does not know, but the save is refused too, so
			// the secret is ephemeral and rotates on every restart. Without this
			// line that presents as an intermittent auth bug rather than a security
			// refusal.
			log.error(
				"The local control secret cannot be persisted while the config path is untrusted, so it changes on every restart and clients must obtain it again after each one",
			);
			return undefined;
		}
		// Same non-regular-file guard as loadConfig(). Both readers need it: this
		// one runs from getLocalControlSecret(), which the server calls after
		// construction, so a FIFO planted at the config path would stall here
		// instead of at startup if only loadConfig() were guarded.
		// The site that matters for SB23-2351. This runs on the boot where the secret
		// is absent from this.data, so a filter applied only in loadConfig() would be
		// bypassed exactly when an attacker-supplied secret would be adopted.
		// local_control_secret is stripped from a writable config, so this returns
		// undefined and the caller generates a fresh one: the same path a refused read
		// already takes, which is why the filter costs nothing here.
		// "report-only": this instance's load already succeeded, so a failure here
		// is not evidence that saving would lose anything, and refusing on it
		// poisons a healthy instance permanently (F1).
		const parsed = this.readConfigData(
			trusted,
			"re-read config file for local_control_secret",
			"report-only",
		);
		if (parsed === null) return undefined;
		const value = parsed.local_control_secret;
		return typeof value === "string" && value.length > 0 ? value : undefined;
	}

	getSystemPromptCacheTtl1h(): boolean {
		const fromEnv = process.env.SYSTEM_PROMPT_CACHE_TTL_1H;
		if (fromEnv) {
			return fromEnv !== "false" && fromEnv !== "0";
		}
		const fromFile = this.data.system_prompt_cache_ttl_1h;
		if (typeof fromFile === "boolean") return fromFile;
		return false; // default: disabled
	}

	setSystemPromptCacheTtl1h(value: boolean): void {
		this.set("system_prompt_cache_ttl_1h", value);
	}

	getUsageThrottlingFiveHourEnabled(): boolean {
		const fromEnv = parseEnabledEnvFlag(
			process.env.USAGE_THROTTLING_FIVE_HOUR_ENABLED,
		);
		if (fromEnv !== undefined) {
			return fromEnv;
		}
		const fromFile = this.data.usage_throttling_five_hour_enabled;
		if (typeof fromFile === "boolean") return fromFile;
		return false;
	}

	getUsageThrottlingWeeklyEnabled(): boolean {
		const fromEnv = parseEnabledEnvFlag(
			process.env.USAGE_THROTTLING_WEEKLY_ENABLED,
		);
		if (fromEnv !== undefined) {
			return fromEnv;
		}
		const fromFile = this.data.usage_throttling_weekly_enabled;
		if (typeof fromFile === "boolean") return fromFile;
		return false;
	}

	/**
	 * Whether Codex accounts reachable by this install still report a 5-hour
	 * usage window. Defaults to false because OpenAI removed that window for
	 * Plus, Business, and Pro on 2026-07-12, announced only on X
	 * (https://x.com/thsottiaux/status/2076365965915467978) and never in the
	 * changelog, so the headers carry the weekly window alone; see
	 * https://github.com/openai/codex/issues/32791. The removal was framed as
	 * temporary, which is exactly why this is a flag rather than a new hardcoded
	 * assumption. Setting it to true restores the previous behavior of treating
	 * the 5-hour window as the one a session rides.
	 *
	 * Scope: this flag selects the window the rollover detector in
	 * response-processor watches. It does not reach the load-balancer's
	 * session expiry, which reads the single `rate_limit_reset` column and
	 * cannot tell which window wrote it — so with the flag on and no 5-hour
	 * window reported, a session still ends at the weekly boundary. Closing
	 * that gap needs the per-window data persisted, which is deliberately out
	 * of scope here.
	 */
	getCodexFiveHourWindowEnabled(): boolean {
		const fromEnv = parseEnabledEnvFlag(
			process.env.CODEX_FIVE_HOUR_WINDOW_ENABLED,
		);
		if (fromEnv !== undefined) {
			return fromEnv;
		}
		const fromFile = this.data.codex_five_hour_window_enabled;
		if (typeof fromFile === "boolean") return fromFile;
		return false;
	}

	/**
	 * Whether an agent's frontmatter `model` field should be used as a
	 * substitution fallback when no explicit DB preference is configured for
	 * that agent. Defaults to false: Claude Code already resolves frontmatter
	 * model aliases client-side, so the registry's copy of `agent.model` can
	 * go stale relative to what the client actually resolved and sent. With
	 * the flag off, only an explicit DB preference (set via the dashboard/CLI)
	 * triggers a rewrite; the frontmatter value is opt-in.
	 */
	getAgentFrontmatterModelFallback(): boolean {
		const fromEnv = parseEnabledEnvFlag(
			process.env.AGENT_FRONTMATTER_MODEL_FALLBACK,
		);
		if (fromEnv !== undefined) {
			return fromEnv;
		}
		const fromFile = this.data.agent_frontmatter_model_fallback;
		if (typeof fromFile === "boolean") return fromFile;
		return false;
	}

	/**
	 * Whether the automatic (non-manual) model catalog refresh is allowed to
	 * fall back to an OAuth account when no eligible API-key account exists.
	 * Defaults to false: recurring background traffic — and the proactive
	 * OAuth token refreshes it can trigger — on a consumer OAuth account is an
	 * atypical automation pattern that risks an account flag/ban, whereas
	 * API-key accounts are the sanctioned programmatic surface. A manual,
	 * human-triggered refresh always allows the OAuth fallback regardless of
	 * this flag.
	 */
	getModelCatalogOAuthRefreshEnabled(): boolean {
		const fromEnv = parseEnabledEnvFlag(
			process.env.BETTER_CCFLARE_MODELS_OAUTH_REFRESH,
		);
		if (fromEnv !== undefined) {
			return fromEnv;
		}
		const fromFile = this.data.model_catalog_oauth_refresh_enabled;
		if (typeof fromFile === "boolean") return fromFile;
		return false;
	}

	setUsageThrottlingFiveHourEnabled(value: boolean): void {
		this.set("usage_throttling_five_hour_enabled", value);
	}

	setUsageThrottlingWeeklyEnabled(value: boolean): void {
		this.set("usage_throttling_weekly_enabled", value);
	}

	setCodexFiveHourWindowEnabled(value: boolean): void {
		this.set("codex_five_hour_window_enabled", value);
	}

	/**
	 * Shared env > file > default precedence resolver: a valid environment
	 * value wins ("env"), else a valid config-file value ("file"), else
	 * `defaultValue` ("default"). Used by getModelScopedCapacityRouting() /
	 * getModelScopedCapacityRoutingSource() so the two can never drift, and
	 * is reusable for other env+file-backed string settings (e.g. a future
	 * getStrategySource() for LB_STRATEGY).
	 */
	private resolveEnvFileSetting<T extends string>(
		envValue: string | undefined,
		fileValue: T | undefined,
		isValid: (value: string) => value is T,
		defaultValue: T,
	): { value: T; source: "env" | "file" | "default" } {
		if (envValue !== undefined && isValid(envValue)) {
			return { value: envValue, source: "env" };
		}
		if (fileValue !== undefined && isValid(fileValue)) {
			return { value: fileValue, source: "file" };
		}
		return { value: defaultValue, source: "default" };
	}

	/**
	 * Resolves the routing switches the dashboard owns: file > default, with
	 * no environment layer at all.
	 *
	 * A switch on screen that an
	 * environment variable can override has to be drawn disabled, with an
	 * explanation, or it accepts a click and silently does nothing — and a
	 * control that lies is worse than no control. The legacy variables are
	 * still honoured, but once, as a migration into this file (see
	 * adoptLegacyRoutingSettings) rather than as a permanent veto.
	 */
	private resolveFlag(
		fileValue: boolean | undefined,
		defaultValue: boolean,
	): { value: boolean; source: "file" | "default" } {
		if (typeof fileValue === "boolean") {
			return { value: fileValue, source: "file" };
		}
		return { value: defaultValue, source: "default" };
	}

	/**
	 * One-time adoption of legacy combo routing behavior and the remaining
	 * disable-fallback variable, so upgrades preserve existing behavior.
	 *
	 * Runs at boot, only for fields absent from the config file, and writes
	 * what it decides — so it happens once and a later deliberate change is
	 * never undone. Returns one line per adoption for the caller to log:
	 * silently rewriting someone's routing config, even faithfully, is the
	 * kind of help nobody asked for.
	 *
	 * @param hasCombos whether any combo exists in the database
	 */
	adoptLegacyRoutingSettings(hasCombos: boolean): string[] {
		const notes: string[] = [];

		if (this.getCombosEnabledSource() === "default" && hasCombos) {
			this.setCombosEnabled(true);
			notes.push(
				"combos enabled: this install already has combos, so the routing it was already doing is kept. Turn it off in the dashboard Combos tab",
			);
		}

		if (this.getComboSessionFallbackSource() === "default") {
			const raw = process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK;
			if (raw !== undefined && raw !== "") {
				// The old variable is a DISABLE flag, so it inverts into the
				// positively-stored setting. Its permissive spelling is kept:
				// narrowing it here would misread a `yes` that someone is
				// relying on at the exact moment it is read for the last time.
				const allowed = !/^(1|true|yes|on)$/i.test(raw);
				this.setComboSessionFallback(allowed);
				notes.push(
					`combo session fallback ${allowed ? "allowed" : "blocked"}: adopted from CCFLARE_DISABLE_COMBO_SESSION_FALLBACK, which no longer takes effect on its own — the switch now lives in Settings → Advanced`,
				);
			} else if (hasCombos) {
				this.setComboSessionFallback(true);
				notes.push(
					"combo session fallback allowed: this install already has combos, so its historical fallthrough to the normal account pool is kept. Block it in Settings → Advanced if the combo must be exclusive",
				);
			}
		}

		return notes;
	}

	/**
	 * Resolve the effective load-balancing strategy plus its source, using the
	 * same env > file > default precedence getStrategy() has always used.
	 * Backs both getStrategy() and getStrategySource() so they cannot drift.
	 */
	private resolveStrategy(): {
		value: StrategyName;
		source: "env" | "file" | "default";
	} {
		return this.resolveEnvFileSetting(
			process.env.LB_STRATEGY,
			this.data.lb_strategy,
			isValidStrategy,
			DEFAULT_STRATEGY,
		);
	}

	private resolveModelScopedCapacityRouting(): {
		value: ModelScopedCapacityRoutingMode;
		source: "env" | "file" | "default";
	} {
		return this.resolveEnvFileSetting(
			process.env.MODEL_SCOPED_CAPACITY_ROUTING,
			this.data.model_scoped_capacity_routing,
			isValidModelScopedCapacityRoutingMode,
			"off",
		);
	}

	getModelScopedCapacityRouting(): ModelScopedCapacityRoutingMode {
		return this.resolveModelScopedCapacityRouting().value;
	}

	/**
	 * Report where the effective model-scoped capacity routing mode comes from,
	 * mirroring the precedence in getModelScopedCapacityRouting():
	 * a valid MODEL_SCOPED_CAPACITY_ROUTING env value wins ("env"), else a valid
	 * config-file field ("file"), else the built-in default ("default"). The
	 * dashboard uses "env" to lock the control, because a POST that writes the
	 * file field is ineffective while the env var overrides it.
	 */
	getModelScopedCapacityRoutingSource(): "env" | "file" | "default" {
		return this.resolveModelScopedCapacityRouting().source;
	}

	setModelScopedCapacityRouting(mode: ModelScopedCapacityRoutingMode): void {
		if (!isValidModelScopedCapacityRoutingMode(mode)) {
			throw new ValidationError(
				`Invalid model_scoped_capacity_routing mode: ${mode}`,
				"model_scoped_capacity_routing",
			);
		}
		this.set("model_scoped_capacity_routing", mode);
	}

	/**
	 * Whether combos take part in routing at all.
	 *
	 * The account selector reads this setting, while the dashboard keeps the
	 * Combos tab permanently visible so the operator can always change it.
	 *
	 * Defaults to false: combos are opt-in. An install that already has combos
	 * adopts true on boot, because upgrading must not silently change anyone's
	 * routing.
	 */
	getCombosEnabled(): boolean {
		return this.resolveFlag(this.data.combos_enabled, false).value;
	}

	/** "file" once anyone has set it, "default" while nobody has. */
	getCombosEnabledSource(): "file" | "default" {
		return this.resolveFlag(this.data.combos_enabled, false).source;
	}

	setCombosEnabled(value: boolean): void {
		this.set("combos_enabled", value);
	}

	/**
	 * Whether a combo-routed request may fall through to normal SessionStrategy
	 * routing once every slot in its combo has failed.
	 *
	 * Defaults to false — the fallthrough is blocked. Someone who built a combo
	 * named the accounts that may serve a family; spilling out of that list when
	 * they are all busy answers a question nobody asked, and it is how a request
	 * for one provider ends up served by another. Allowing it stays one click
	 * away for whoever wants the older, looser behaviour.
	 *
	 * Stored positively — the switch says whether the fallthrough is allowed —
	 * because a control labelled by what it permits beats a double negative on
	 * screen. The old CCFLARE_DISABLE_COMBO_SESSION_FALLBACK inverts into it,
	 * once, at boot (adoptLegacyRoutingSettings).
	 */
	getComboSessionFallback(): boolean {
		return this.resolveFlag(this.data.combo_session_fallback, false).value;
	}

	/** "file" once anyone has set it, "default" while nobody has. */
	getComboSessionFallbackSource(): "file" | "default" {
		return this.resolveFlag(this.data.combo_session_fallback, false).source;
	}

	setComboSessionFallback(value: boolean): void {
		this.set("combo_session_fallback", value);
	}

	/**
	 * Whether the model a client asked for must be the model that is sent.
	 *
	 * On, nothing renames the request on its way out: combos are skipped, so no
	 * slot model is applied, and every mapping — the account's own, the global
	 * override and the provider's built-in default — is inert. Account
	 * selection instead keeps only accounts that can serve the requested model,
	 * and a request with no such account gets an error rather than a different
	 * model.
	 *
	 * Off by default: this changes what a Claude family name means for anyone
	 * who relies on mapping (asking for a Claude model no longer reaches an
	 * OpenAI account), so it must be chosen deliberately.
	 */
	getForceAccountModel(): boolean {
		return this.resolveFlag(this.data.force_account_model, false).value;
	}

	/** "file" once anyone has set it, "default" while nobody has. */
	getForceAccountModelSource(): "file" | "default" {
		return this.resolveFlag(this.data.force_account_model, false).source;
	}

	setForceAccountModel(value: boolean): void {
		this.set("force_account_model", value);
	}

	getProviderModelDefaultOverrides(): ProviderModelDefaultOverrides {
		const raw = this.data.provider_model_default_overrides;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		const overrides: ProviderModelDefaultOverrides = {};
		for (const [provider, families] of Object.entries(raw)) {
			if (!families || typeof families !== "object" || Array.isArray(families))
				continue;
			const values: Record<string, string> = {};
			for (const [family, model] of Object.entries(families)) {
				if (typeof model === "string" && model.trim())
					values[family] = model.trim();
			}
			if (Object.keys(values).length > 0) overrides[provider] = values;
		}
		return overrides;
	}

	setProviderModelDefaultOverrides(
		overrides: ProviderModelDefaultOverrides,
	): void {
		this.data.provider_model_default_overrides = overrides;
		this.saveConfig();
		this.emit("change", {
			key: "provider_model_default_overrides",
			newValue: overrides,
		});
	}

	/**
	 * An object-valued setting, returned exactly as stored and unvalidated.
	 * The caller owns the shape: `openai_gateways` is validated by
	 * `parseOpenAIGateways` in `@better-ccflare/types` (SB23-2720), which this
	 * package does not depend on. Never `get(key, default)` for these: `get`
	 * serves scalars only, and a default passed to it is persisted on a miss.
	 */
	getObjectSetting(key: string): unknown {
		return (this.data as Record<string, unknown>)[key];
	}

	/** Stores an object-valued setting whole. Validate before calling. */
	setObjectSetting(key: string, value: Record<string, unknown>): void {
		const oldValue = (this.data as Record<string, unknown>)[key];
		(this.data as Record<string, unknown>)[key] = value;
		this.saveConfig();
		this.emit("change", { key, oldValue, newValue: value });
	}

	/**
	 * Providers currently allowed to edit their model-default overrides:
	 * "codex" by default, or the exact CCFLARE_MODEL_DEFAULTS_PROVIDERS
	 * list when that env var is set (comma-separated, trimmed). Never
	 * affects which providers HAVE a built-in factory map — only which
	 * of them expose that map for override via the API/dashboard.
	 */
	getEnabledProviderModelDefaultProviders(): string[] {
		const fromEnv = process.env.CCFLARE_MODEL_DEFAULTS_PROVIDERS;
		if (fromEnv) {
			const parsed = fromEnv
				.split(",")
				.map((provider) => provider.trim())
				.filter(Boolean);
			if (parsed.length > 0) return parsed;
		}
		return [...DEFAULT_PROVIDER_MODEL_DEFAULTS_PROVIDERS];
	}

	getHealthDetailEnabled(): boolean {
		const fromEnv = parseEnabledEnvFlag(process.env.HEALTH_DETAIL_ENABLED);
		if (fromEnv !== undefined) {
			return fromEnv;
		}
		const fromFile = this.data.health_detail_enabled;
		if (typeof fromFile === "boolean") return fromFile;
		return false;
	}

	// ── PostgreSQL backend ──────────────────────────────────────────────────────

	getPgEnabled(): boolean {
		const fromEnv = parseEnabledEnvFlag(process.env.PG_ENABLED);
		if (fromEnv !== undefined) return fromEnv;
		// Also treat DATABASE_URL presence as implicit enablement
		if (process.env.DATABASE_URL) return true;
		const fromFile = this.data.pg_enabled;
		if (typeof fromFile === "boolean") return fromFile;
		return false;
	}

	setPgEnabled(value: boolean): void {
		this.set("pg_enabled", value);
	}

	getPgHost(): string {
		return (
			process.env.PGHOST ||
			(typeof this.data.pg_host === "string" ? this.data.pg_host : "localhost")
		);
	}

	setPgHost(host: string): void {
		this.set("pg_host", host);
	}

	getPgPort(): number {
		if (process.env.PGPORT) {
			const n = parseInt(process.env.PGPORT, 10);
			if (!Number.isNaN(n)) return n;
		}
		if (typeof this.data.pg_port === "number") return this.data.pg_port;
		return 5432;
	}

	setPgPort(port: number): void {
		this.set("pg_port", port);
	}

	getPgDatabase(): string {
		return (
			process.env.PGDATABASE ||
			(typeof this.data.pg_database === "string"
				? this.data.pg_database
				: "better_ccflare")
		);
	}

	setPgDatabase(db: string): void {
		this.set("pg_database", db);
	}

	getPgUser(): string {
		return (
			process.env.PGUSER ||
			(typeof this.data.pg_user === "string" ? this.data.pg_user : "postgres")
		);
	}

	setPgUser(user: string): void {
		this.set("pg_user", user);
	}

	getPgPassword(): string {
		return (
			process.env.PGPASSWORD ||
			(typeof this.data.pg_password === "string" ? this.data.pg_password : "")
		);
	}

	setPgPassword(password: string): void {
		this.set("pg_password", password);
	}

	/**
	 * Token for the upstream maintainer controller's repository_dispatch.
	 *
	 * Environment first, then the persisted config file, matching getPgPassword()
	 * and every other secret here. Returns "" when unset, which is what the
	 * dispatch endpoint reads as "feature off".
	 *
	 * The value is never returned by an API endpoint, never logged and never sent
	 * to the browser — the dashboard only ever learns the boolean from
	 * hasUpstreamMaintainerToken().
	 */
	getUpstreamMaintainerToken(): string {
		return (
			process.env.BETTER_CCFLARE_UPSTREAM_MAINTAINER_TOKEN ||
			(typeof this.data.upstream_maintainer_token === "string"
				? this.data.upstream_maintainer_token
				: "")
		);
	}

	/** Whether a token is configured, for reporting without revealing it. */
	hasUpstreamMaintainerToken(): boolean {
		return this.getUpstreamMaintainerToken().length > 0;
	}

	/**
	 * Token used only to raise GitHub's API rate limit for the version widget.
	 *
	 * Unauthenticated calls share 60 requests an hour per IP with everything else
	 * on the machine, which the sidebar exhausts and then reports as "Release
	 * check unavailable". With a token the limit is 5,000.
	 *
	 * Environment first, then the persisted config file, matching every other
	 * secret here. It exists separately from the maintainer token because the
	 * scopes differ: this one needs no scopes at all, since it only reads public
	 * releases and commits, while the maintainer token authorizes a workflow
	 * dispatch on another repository. Do not reuse one for the other.
	 *
	 * Never returned by an endpoint and never logged.
	 */
	getGithubReadToken(): string {
		return (
			process.env.BETTER_CCFLARE_GITHUB_TOKEN ||
			(typeof this.data.github_read_token === "string"
				? this.data.github_read_token
				: "")
		);
	}

	/** Whether a read token is configured, for reporting without revealing it. */
	hasGithubReadToken(): boolean {
		return this.getGithubReadToken().length > 0;
	}

	/**
	 * Unlike upstream_maintainer_token, this one HAS a write path, and the
	 * asymmetry is deliberate. A no-scope token that reads public releases is
	 * worth roughly nothing if an authenticated dashboard user installs one,
	 * while the maintainer token authorizes a workflow dispatch on another
	 * repository. pg_password is settable from the dashboard for the same
	 * reason: the value is already the operator's to choose.
	 *
	 * An empty string clears it.
	 */
	setGithubReadToken(token: string): void {
		this.set("github_read_token", token);
	}

	/** Whether the environment is supplying it, so the UI can say the stored value is inert. */
	githubReadTokenFromEnvironment(): boolean {
		return Boolean(process.env.BETTER_CCFLARE_GITHUB_TOKEN);
	}

	/**
	 * OpenObserve shipping. Environment first, then the persisted config file,
	 * matching every other external endpoint here.
	 *
	 * The base URL is the switch: empty means the exporter never runs and never
	 * opens a connection. Returns null in that case so callers cannot
	 * accidentally ship to a half-configured endpoint.
	 *
	 * The token is sensitive. It is excluded from getAllSettings(), never
	 * returned by an endpoint and never logged.
	 */
	getOpenObserveSettings(): OpenObserveSettings | null {
		const baseUrl = (
			process.env.BETTER_CCFLARE_OPENOBSERVE_URL ||
			(typeof this.data.openobserve_url === "string"
				? this.data.openobserve_url
				: "")
		).trim();
		if (!baseUrl) return null;

		const org = (
			process.env.BETTER_CCFLARE_OPENOBSERVE_ORG ||
			(typeof this.data.openobserve_org === "string"
				? this.data.openobserve_org
				: "") ||
			"default"
		).trim();
		if (!org) return null;

		const shipPayloadsEnv =
			process.env.BETTER_CCFLARE_OPENOBSERVE_SHIP_PAYLOADS;
		const shipPayloads =
			shipPayloadsEnv !== undefined
				? shipPayloadsEnv === "true" || shipPayloadsEnv === "1"
				: this.data.openobserve_ship_payloads === true;

		return {
			baseUrl,
			org,
			user: (
				process.env.BETTER_CCFLARE_OPENOBSERVE_USER ||
				(typeof this.data.openobserve_user === "string"
					? this.data.openobserve_user
					: "")
			).trim(),
			token:
				process.env.BETTER_CCFLARE_OPENOBSERVE_TOKEN ||
				(typeof this.data.openobserve_token === "string"
					? this.data.openobserve_token
					: ""),
			logStream: (
				process.env.BETTER_CCFLARE_OPENOBSERVE_LOG_STREAM ||
				(typeof this.data.openobserve_log_stream === "string"
					? this.data.openobserve_log_stream
					: "") ||
				"better_ccflare_logs"
			).trim(),
			requestStream: (
				process.env.BETTER_CCFLARE_OPENOBSERVE_REQUEST_STREAM ||
				(typeof this.data.openobserve_request_stream === "string"
					? this.data.openobserve_request_stream
					: "") ||
				"better_ccflare_requests"
			).trim(),
			shipPayloads,
			// Passed through unvalidated on purpose. The exporter parses it,
			// because the exporter is the only place that can report a bad value
			// without calling Logger and feeding itself. An empty value means
			// unset, which the exporter reads as the INFO default.
			logMinLevel: (
				process.env.BETTER_CCFLARE_OPENOBSERVE_LOG_MIN_LEVEL ||
				(typeof this.data.openobserve_log_min_level === "string"
					? this.data.openobserve_log_min_level
					: "") ||
				"INFO"
			).trim(),
		};
	}

	/** Whether a token is configured, for reporting without revealing it. */
	hasOpenObserveToken(): boolean {
		return this.getOpenObserveToken().length > 0;
	}

	private getOpenObserveToken(): string {
		return (
			process.env.BETTER_CCFLARE_OPENOBSERVE_TOKEN ||
			(typeof this.data.openobserve_token === "string"
				? this.data.openobserve_token
				: "")
		);
	}

	/** Whether the environment is supplying the token, so the UI can say a stored value is inert. */
	openObserveTokenFromEnvironment(): boolean {
		return Boolean(process.env.BETTER_CCFLARE_OPENOBSERVE_TOKEN);
	}

	/**
	 * Settable from the dashboard for the same reason pg_password is: the value
	 * is the operator's own to choose, and it authorizes nothing but writes into
	 * their own OpenObserve org. An empty string clears it.
	 */
	setOpenObserveToken(token: string): void {
		this.set("openobserve_token", token);
	}

	setOpenObserveEndpoint(settings: {
		url: string;
		org: string;
		user: string;
		logStream: string;
		requestStream: string;
		shipPayloads: boolean;
		logMinLevel: string;
	}): void {
		this.set("openobserve_url", settings.url);
		this.set("openobserve_org", settings.org);
		this.set("openobserve_user", settings.user);
		this.set("openobserve_log_stream", settings.logStream);
		this.set("openobserve_request_stream", settings.requestStream);
		this.set("openobserve_ship_payloads", settings.shipPayloads);
		this.set("openobserve_log_min_level", settings.logMinLevel);
	}

	// Deliberately no setter. Unlike pg_password, this value has no write path
	// at all: the operator edits the config file (or sets the environment
	// variable) and nothing reachable from the dashboard can set or overwrite it.
	// The asymmetry is the point — the token authorizes a workflow dispatch on
	// another repository, so it should not be installable by anything that can
	// reach the API.

	getPgSslMode(): "disable" | "require" | "verify-ca" | "verify-full" {
		const fromEnv = process.env.PGSSLMODE as
			| "disable"
			| "require"
			| "verify-ca"
			| "verify-full"
			| undefined;
		if (fromEnv) return fromEnv;
		const fromFile = this.data.pg_ssl_mode;
		if (typeof fromFile === "string")
			return fromFile as "disable" | "require" | "verify-ca" | "verify-full";
		return "disable";
	}

	setPgSslMode(
		mode: "disable" | "require" | "verify-ca" | "verify-full",
	): void {
		this.set("pg_ssl_mode", mode);
	}

	/**
	 * Build a PostgreSQL connection URL from stored config (excluding env overrides).
	 * Returns null when PG is not enabled.
	 */
	buildPgConnectionUrl(): string | null {
		if (!this.getPgEnabled()) return null;
		const user = encodeURIComponent(this.getPgUser());
		const password = encodeURIComponent(this.getPgPassword());
		const host = this.getPgHost();
		const port = this.getPgPort();
		const db = encodeURIComponent(this.getPgDatabase());
		const ssl = this.getPgSslMode();
		const sslParam = ssl !== "disable" ? `?sslmode=${ssl}` : "";
		return `postgresql://${user}:${password}@${host}:${port}/${db}${sslParam}`;
	}

	getAlertDailySpendUsd(): number {
		const fromEnv = process.env.ALERT_DAILY_SPEND_USD;
		if (fromEnv) {
			const n = Number.parseFloat(fromEnv);
			if (!Number.isNaN(n)) return this.clamp(n, 0, 1_000_000);
		}
		const fromFile = this.data.alert_daily_spend_usd;
		if (typeof fromFile === "number") return this.clamp(fromFile, 0, 1_000_000);
		return 0;
	}

	setAlertDailySpendUsd(value: number): void {
		this.set("alert_daily_spend_usd", this.clamp(value, 0, 1_000_000));
	}

	getAlertTokensPerHour(): number {
		const fromEnv = process.env.ALERT_TOKENS_PER_HOUR;
		if (fromEnv) {
			const n = Number.parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 0, 1_000_000_000);
		}
		const fromFile = this.data.alert_tokens_per_hour;
		if (typeof fromFile === "number") {
			return this.clamp(fromFile, 0, 1_000_000_000);
		}
		return 0;
	}

	setAlertTokensPerHour(value: number): void {
		this.set("alert_tokens_per_hour", this.clamp(value, 0, 1_000_000_000));
	}

	getAlertRequestTokens(): number {
		const fromEnv = process.env.ALERT_REQUEST_TOKENS;
		if (fromEnv) {
			const n = Number.parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 0, 1_000_000_000);
		}
		const fromFile = this.data.alert_request_tokens;
		if (typeof fromFile === "number") {
			return this.clamp(fromFile, 0, 1_000_000_000);
		}
		return 0;
	}

	setAlertRequestTokens(value: number): void {
		this.set("alert_request_tokens", this.clamp(value, 0, 1_000_000_000));
	}

	getAlertAnomalyEnabled(): boolean {
		const fromEnv = parseEnabledEnvFlag(process.env.ALERT_ANOMALY_ENABLED);
		if (fromEnv !== undefined) {
			return fromEnv;
		}
		const fromFile = this.data.alert_anomaly_enabled;
		if (typeof fromFile === "boolean") return fromFile;
		return false;
	}

	setAlertAnomalyEnabled(value: boolean): void {
		this.set("alert_anomaly_enabled", value);
	}

	getAlertAnomalyIntervalMinutes(): number {
		const fromEnv = process.env.ALERT_ANOMALY_INTERVAL_MINUTES;
		if (fromEnv) {
			const n = Number.parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 5, 1440);
		}
		const fromFile = this.data.alert_anomaly_interval_minutes;
		if (typeof fromFile === "number") return this.clamp(fromFile, 5, 1440);
		return 15;
	}

	setAlertAnomalyIntervalMinutes(value: number): void {
		this.set("alert_anomaly_interval_minutes", this.clamp(value, 5, 1440));
	}

	getAlertAnomalyBaselineWindowMinutes(): number {
		const fromEnv = process.env.ALERT_ANOMALY_BASELINE_WINDOW_MINUTES;
		if (fromEnv) {
			const n = Number.parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 60, 43200);
		}
		const fromFile = this.data.alert_anomaly_baseline_window_minutes;
		if (typeof fromFile === "number") return this.clamp(fromFile, 60, 43200);
		return 1440;
	}

	setAlertAnomalyBaselineWindowMinutes(value: number): void {
		this.set(
			"alert_anomaly_baseline_window_minutes",
			this.clamp(value, 60, 43200),
		);
	}

	getAlertAnomalyLoopMinRequests(): number {
		const fromEnv = process.env.ALERT_ANOMALY_LOOP_MIN_REQUESTS;
		if (fromEnv) {
			const n = Number.parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 5, 1000);
		}
		const fromFile = this.data.alert_anomaly_loop_min_requests;
		if (typeof fromFile === "number") return this.clamp(fromFile, 5, 1000);
		// Default 25 — above the per-agent request rate we expect from any
		// single legitimate worker in a 5-minute window, while still well
		// below the rate a true runaway loop reaches (50+ req/min).
		return 25;
	}

	setAlertAnomalyLoopMinRequests(value: number): void {
		this.set("alert_anomaly_loop_min_requests", this.clamp(value, 5, 1000));
	}

	getAlertCooldownMinutes(): number {
		const fromEnv = process.env.ALERT_COOLDOWN_MINUTES;
		if (fromEnv) {
			const n = Number.parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 1, 1440);
		}
		const fromFile = this.data.alert_cooldown_minutes;
		if (typeof fromFile === "number") return this.clamp(fromFile, 1, 1440);
		return 60;
	}

	setAlertCooldownMinutes(value: number): void {
		this.set("alert_cooldown_minutes", this.clamp(value, 1, 1440));
	}

	getAlertWebhookUrl(): string {
		const fromEnv = process.env.ALERT_WEBHOOK_URL;
		if (fromEnv !== undefined) return fromEnv;
		const fromFile = this.data.alert_webhook_url;
		if (typeof fromFile === "string") return fromFile;
		return "";
	}

	setAlertWebhookUrl(value: string): void {
		if (value !== "") {
			let parsed: URL;
			try {
				parsed = new URL(value);
			} catch (_error) {
				throw new ValidationError(
					"Invalid alert webhook URL",
					"alert_webhook_url",
				);
			}
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				throw new ValidationError(
					"Invalid alert webhook URL",
					"alert_webhook_url",
				);
			}
		}
		this.set("alert_webhook_url", value);
	}

	getAllSettings(): Record<
		string,
		string | number | boolean | ProviderModelDefaultOverrides | undefined
	> {
		// Secrets are stripped rather than spread. Today's only caller
		// (handlers/config.ts getConfig) copies named fields into an allowlisted
		// ConfigResponse, so nothing leaks yet — but the method is named as though
		// it were safe to serialize, and the next caller to hand the whole object
		// to a diagnostic or settings endpoint would ship pg_password and
		// local_control_secret with it. Each sensitive value has its own accessor
		// for the code that genuinely needs it.
		const {
			pg_password: _pgPassword,
			local_control_secret: _localControlSecret,
			upstream_maintainer_token: _upstreamMaintainerToken,
			github_read_token: _githubReadToken,
			openobserve_token: _openobserveToken,
			...safeData
		} = this.data;

		// Include current strategy (which might come from env)
		return {
			...safeData,
			lb_strategy: this.getStrategy(),
			default_agent_model: this.getDefaultAgentModel(),
			data_retention_days: this.getDataRetentionDays(),
			request_retention_days: this.getRequestRetentionDays(),
			usage_history_retention_days: this.getUsageHistoryRetentionDays(),
			store_payloads: this.getStorePayloads(),
			request_storage_headers_only: this.getRequestStorageHeadersOnly(),
			auto_vacuum_enabled: this.getAutoVacuumEnabled(),
			usage_poll_interval_ms: this.getUsagePollIntervalMs(),
			cache_keepalive_ttl_minutes: this.getCacheKeepaliveTtlMinutes(),
			system_prompt_cache_ttl_1h: this.getSystemPromptCacheTtl1h(),
			usage_throttling_five_hour_enabled:
				this.getUsageThrottlingFiveHourEnabled(),
			usage_throttling_weekly_enabled: this.getUsageThrottlingWeeklyEnabled(),
			codex_five_hour_window_enabled: this.getCodexFiveHourWindowEnabled(),
			model_scoped_capacity_routing: this.getModelScopedCapacityRouting(),
			combos_enabled: this.getCombosEnabled(),
			combo_session_fallback: this.getComboSessionFallback(),
			force_account_model: this.getForceAccountModel(),
			agent_frontmatter_model_fallback: this.getAgentFrontmatterModelFallback(),
			model_catalog_oauth_refresh_enabled:
				this.getModelCatalogOAuthRefreshEnabled(),
			health_detail_enabled: this.getHealthDetailEnabled(),
			alert_daily_spend_usd: this.getAlertDailySpendUsd(),
			alert_tokens_per_hour: this.getAlertTokensPerHour(),
			alert_request_tokens: this.getAlertRequestTokens(),
			alert_anomaly_enabled: this.getAlertAnomalyEnabled(),
			alert_anomaly_interval_minutes: this.getAlertAnomalyIntervalMinutes(),
			alert_anomaly_baseline_window_minutes:
				this.getAlertAnomalyBaselineWindowMinutes(),
			alert_anomaly_loop_min_requests: this.getAlertAnomalyLoopMinRequests(),
			alert_cooldown_minutes: this.getAlertCooldownMinutes(),
			alert_webhook_url: this.getAlertWebhookUrl(),
		};
	}

	// ── Discovery configuration ─────────────────────────────────────────────

	/**
	 * Root directory where Claude Code stores project session JSONL files.
	 * Env: CLAUDE_PROJECTS_DIR → persisted config → default (~/.claude/projects)
	 *
	 * UI persistence is a Phase 4.C concern — for now this is read-only
	 * (env var or hardcoded default).
	 * TODO(Phase 4.C): wire up a Settings UI toggle + setClaudeProjectsDir()
	 */
	getClaudeProjectsDir(): string | undefined {
		const fromEnv = process.env.CLAUDE_PROJECTS_DIR;
		if (fromEnv) return fromEnv;
		const fromFile = this.data.claude_projects_dir;
		if (typeof fromFile === "string" && fromFile.trim()) return fromFile;
		return undefined; // caller uses ClaudeCodeDiscovery default (~/.claude/projects)
	}

	/**
	 * Whether the host filesystem is case-sensitive.
	 * Env: PROJECTS_CASE_SENSITIVE=true|1 → persisted config → default false (darwin).
	 *
	 * TODO(Phase 4.C): wire up a Settings UI toggle + setProjectsCaseSensitive()
	 */
	isProjectsCaseSensitive(): boolean {
		const fromEnv = process.env.PROJECTS_CASE_SENSITIVE;
		if (fromEnv !== undefined) {
			return fromEnv === "true" || fromEnv === "1";
		}
		const fromFile = this.data.projects_case_sensitive;
		if (typeof fromFile === "boolean") return fromFile;
		// Default: darwin is case-insensitive; everything else is case-sensitive.
		return process.platform !== "darwin";
	}

	/**
	 * The projects path case mode this database's rows were populated under,
	 * or undefined on an install that predates the guard. Deliberately file
	 * only, with no env override: it records what happened, not what is
	 * wanted, and an env var would let the very flip it guards set its own
	 * marker. See decideProjectsCaseMode (SB23-1988).
	 */
	/**
	 * Where the config file actually is, for messages that ask an operator to
	 * edit it. Worth naming rather than saying "the config file": the path
	 * moves with BETTER_CCFLARE_CONFIG_PATH, and the message that needs it is
	 * printed at the moment the server refuses to start, so the operator
	 * cannot look it up in a running dashboard.
	 */
	getConfigPath(): string {
		return this.configPath;
	}

	/**
	 * Which of the three sources decided isProjectsCaseSensitive(). Reported
	 * in the refusal because `current` is read from the environment first: an
	 * operator whose service environment differs from their interactive shell
	 * would otherwise compute one value while reading the message and get
	 * another when the service boots, and hand-edit the marker to a value
	 * that refuses again.
	 */
	getProjectsCaseSensitiveSource(): "env" | "file" | "default" {
		if (process.env.PROJECTS_CASE_SENSITIVE !== undefined) return "env";
		if (typeof this.data.projects_case_sensitive === "boolean") return "file";
		return "default";
	}

	getStoredProjectsCaseSensitive(): boolean | undefined {
		const fromFile = this.data.projects_case_sensitive_stored;
		return typeof fromFile === "boolean" ? fromFile : undefined;
	}

	setStoredProjectsCaseSensitive(value: boolean): void {
		this.data.projects_case_sensitive_stored = value;
		this.saveConfig();
		this.emit("change", {
			key: "projects_case_sensitive_stored",
			newValue: value,
		});
	}

	getRuntime(): RuntimeConfig {
		// RETRY_DEFAULTS from @better-ccflare/core, the same object
		// getOverloadRetryConfig falls back to. An earlier version of this wrote
		// the three numbers out again with a comment saying a second literal
		// could drift; a second literal already existed one package over, which
		// is the thing the comment was warning about.
		const retryDefaults = { ...RETRY_DEFAULTS };
		// Default values
		const defaults: RuntimeConfig = {
			clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
			retry: { ...retryDefaults },
			sessionDurationMs: TIME_CONSTANTS.SESSION_DURATION_DEFAULT,
			port: NETWORK.DEFAULT_PORT,
			database: {
				walMode: true,
				busyTimeoutMs: 5000,
				cacheSize: -20000, // 20MB cache
				synchronous: "NORMAL",
				mmapSize: 268435456, // 256MB
				retry: {
					attempts: 3,
					delayMs: 100,
					backoff: 2,
					maxDelayMs: 5000,
				},
			},
		};

		// Override with environment variables if present
		if (process.env.CLIENT_ID) {
			defaults.clientId = process.env.CLIENT_ID;
		}
		if (process.env.RETRY_ATTEMPTS) {
			defaults.retry.attempts = parseInt(process.env.RETRY_ATTEMPTS, 10);
		}
		if (process.env.RETRY_DELAY_MS) {
			defaults.retry.delayMs = parseInt(process.env.RETRY_DELAY_MS, 10);
		}
		if (process.env.RETRY_BACKOFF) {
			defaults.retry.backoff = parseFloat(process.env.RETRY_BACKOFF);
		}
		if (process.env.SESSION_DURATION_MS) {
			defaults.sessionDurationMs = parseInt(
				process.env.SESSION_DURATION_MS,
				10,
			);
		}
		if (process.env.PORT) {
			defaults.port = parseInt(process.env.PORT, 10);
		}

		// Override with config file settings if present
		if (this.data.client_id) {
			defaults.clientId = this.data.client_id;
		}
		if (typeof this.data.retry_attempts === "number") {
			defaults.retry.attempts = this.data.retry_attempts;
		}
		if (typeof this.data.retry_delay_ms === "number") {
			defaults.retry.delayMs = this.data.retry_delay_ms;
		}
		if (typeof this.data.retry_backoff === "number") {
			defaults.retry.backoff = this.data.retry_backoff;
		}
		if (typeof this.data.session_duration_ms === "number") {
			defaults.sessionDurationMs = this.data.session_duration_ms;
		}
		if (typeof this.data.port === "number") {
			defaults.port = this.data.port;
		}

		// Database configuration overrides
		// Ensure database configuration object exists
		if (!defaults.database) {
			defaults.database = {
				walMode: true,
				busyTimeoutMs: 5000,
				cacheSize: -20000,
				synchronous: "NORMAL",
				mmapSize: 268435456,
				retry: {
					attempts: 3,
					delayMs: 100,
					backoff: 2,
					maxDelayMs: 5000,
				},
			};
		}

		// Ensure retry configuration object exists
		if (!defaults.database.retry) {
			defaults.database.retry = {
				attempts: 3,
				delayMs: 100,
				backoff: 2,
				maxDelayMs: 5000,
			};
		}

		if (typeof this.data.db_wal_mode === "boolean") {
			defaults.database.walMode = this.data.db_wal_mode;
		}
		if (typeof this.data.db_busy_timeout_ms === "number") {
			defaults.database.busyTimeoutMs = this.data.db_busy_timeout_ms;
		}
		if (typeof this.data.db_cache_size === "number") {
			defaults.database.cacheSize = this.data.db_cache_size;
		}
		if (typeof this.data.db_synchronous === "string") {
			defaults.database.synchronous = this.data.db_synchronous as
				| "OFF"
				| "NORMAL"
				| "FULL";
		}
		if (typeof this.data.db_mmap_size === "number") {
			defaults.database.mmapSize = this.data.db_mmap_size;
		}
		// Page size: default 2048 (2KB) for better memory efficiency, recommend 4096 (4KB)
		if (typeof this.data.db_page_size === "number") {
			defaults.database.pageSize = this.data.db_page_size;
		} else {
			defaults.database.pageSize = 2048;
		}
		if (typeof this.data.db_retry_attempts === "number") {
			defaults.database.retry.attempts = this.data.db_retry_attempts;
		}
		if (typeof this.data.db_retry_delay_ms === "number") {
			defaults.database.retry.delayMs = this.data.db_retry_delay_ms;
		}
		if (typeof this.data.db_retry_backoff === "number") {
			defaults.database.retry.backoff = this.data.db_retry_backoff;
		}
		if (typeof this.data.db_retry_max_delay_ms === "number") {
			defaults.database.retry.maxDelayMs = this.data.db_retry_max_delay_ms;
		}

		// Clamp the upstream retry family against RETRY_BOUNDS, the same bounds
		// POST /api/config/retry enforces. Runs after both the environment and
		// the config file have had their say, so one pass covers both sources.
		// Clamps rather than throwing, which is argued in the function
		// (SB23-1980).
		validateRuntimeRetry(defaults.retry, retryDefaults);

		// Same pass, same reasons, for session_duration_ms (SB23-2040). The
		// default is read back off the constant rather than repeated, so the
		// value the warning names is the value a caller with no setting gets.
		validateRuntimeSessionDuration(
			defaults,
			TIME_CONSTANTS.SESSION_DURATION_DEFAULT,
		);

		// Validate the final database configuration
		try {
			validateDatabaseConfig(defaults.database);
		} catch (error) {
			if (error instanceof ValidationError) {
				log.error(`Database configuration validation failed: ${error.message}`);
				throw error;
			}
			throw error;
		}

		return defaults;
	}
}

// Re-export types
export type { StrategyName } from "@better-ccflare/core";
export { resolveConfigPath } from "./paths";
export { getLegacyConfigDir, getPlatformConfigDir } from "./paths-common";
