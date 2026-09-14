/**
 * SB23-1988. A project's primary key is derived from the path string it was
 * stored with (see projectIdFromPath in repositories/project.repository.ts),
 * and PROJECTS_CASE_SENSITIVE decides at scan time whether that path is
 * lowercased first. The two are therefore coupled: changing the setting on a
 * database that already holds projects changes the id every row hashes to.
 *
 * Nothing rejects the result. The rows are re-created under new ids on the
 * next scan, `requests.project_id` has no foreign key to `projects.id`, so
 * every historical request keeps pointing at an id no project has any more.
 * No migration runs, no error is raised and no log line says it happened.
 *
 * This module is the decision that stops it. It is deliberately pure: the
 * marker recording which mode the projects table was populated under lives in
 * the config file, not in the database, so the guard needs no schema change
 * and no migrations-pg.ts mirror.
 */

export interface ProjectsCaseModeInput {
	/**
	 * The mode the projects table was last populated under, as recorded in the
	 * config file. Undefined on any install that predates this guard.
	 */
	recorded: boolean | undefined;
	/** The mode this boot resolved, from env, then config file, then platform. */
	current: boolean;
	/** How many rows the projects table holds right now. */
	projectCount: number;
	/**
	 * Whether any stored `canonical_path` carries an uppercase character.
	 *
	 * The exact predicate the caller supplies is `p !== p.toLowerCase()`, not
	 * a character-class test, and that is deliberate: the question is whether
	 * a case-insensitive scan would have stored something different, which is
	 * that comparison and nothing else. It therefore stays correct for paths
	 * the word "uppercase" does not obviously cover. Measured: the Kelvin sign
	 * `K` and Turkish `İ` both answer true and both genuinely fold, while
	 * Greek final sigma `ς` and dotless `ı` answer false and genuinely do not.
	 *
	 * This is the one thing the database can prove about which key space its
	 * rows live in, and the asymmetry is the whole subtlety of this guard, so
	 * do not "simplify" it away:
	 *
	 *  - Uppercase present is PROOF the ids are real-case hashes, because a
	 *    case-insensitive scan could not have written them. It also proves a
	 *    case-insensitive scan would re-key them.
	 *  - All lowercase proves nothing. It does NOT mean both modes agree: the
	 *    comparison that decides a re-key is the rows against the NEXT scan's
	 *    output, and a case-sensitive scan reads real case off the filesystem
	 *    rather than echoing the rows back. All-lowercase rows are equally
	 *    consistent with a case-insensitive install whose directories carry
	 *    uppercase, where a flip does re-key. Separating those needs the
	 *    filesystem, so this module takes no position on them.
	 */
	rowsHaveUppercase: boolean;
}

export type ProjectsCaseModeDecision =
	| { action: "ok" }
	/** Write `record` to the config marker and carry on. */
	| { action: "record"; record: boolean }
	/** Write `record` to the config marker and log `message`. */
	| { action: "adopt"; record: boolean; message: string }
	/** Abort the boot with `message`. */
	| { action: "refuse"; message: string };

function refusal(recorded: boolean, current: boolean, count: number): string {
	const from = recorded ? "case-sensitive" : "case-insensitive";
	const to = current ? "case-sensitive" : "case-insensitive";
	return [
		`Refusing to start: PROJECTS_CASE_SENSITIVE has changed from ${from} to ${to}, and this database already holds ${count} project${count === 1 ? "" : "s"}.`,
		"",
		"A project's id is sha1(canonical_path) truncated to 16 characters, and this setting decides whether that path is stored lowercased. Starting with the new setting would re-key every one of those rows on the next discovery scan. Because requests.project_id has no foreign key to projects.id, nothing would reject the result: every request already attributed would keep pointing at an id no project has any more, and the attribution history would detach with no error and no log line.",
		"",
		`The setting is resolved from the PROJECTS_CASE_SENSITIVE environment variable, then projects_case_sensitive in the config file, then the platform default, so check all three rather than only the environment.`,
		"",
		`To go ahead anyway and accept that detachment, set projects_case_sensitive_stored to ${current} in the config file. To keep the existing history, make that resolution produce ${recorded} again.`,
	].join("\n");
}

/**
 * Compute `rowsHaveUppercase` from the projects table.
 *
 * DISCOVERED rows only. A manual project is stored exactly as
 * `POST /api/projects` was given it, with no lowercasing whatever the setting
 * says (`http-api/src/handlers/projects.ts:92`), so an uppercase manual path
 * is normal on a case-insensitive install and says nothing about which mode
 * wrote the discovered rows. Counting it would refuse a boot that is fine.
 * Manual rows are also not at risk from a flip in the first place: the scan
 * never rewrites their paths, so their ids do not move.
 */
export function hasUppercaseDiscoveredPath(
	rows: ReadonlyArray<{ source: string; canonical_path: string }>,
): boolean {
	return rows.some(
		(r) =>
			r.source === "discovered" &&
			r.canonical_path !== r.canonical_path.toLowerCase(),
	);
}

/**
 * Decide what a boot should do about the projects case mode.
 *
 * States:
 *  - empty table: nothing to detach, so record the current mode and proceed.
 *  - no marker, populated table: every install upgrading into this guard lands
 *    here, so the mode is derived from the rows rather than from the setting,
 *    which would otherwise agree with itself. Uppercase rows under a
 *    case-insensitive setting refuse; anything else adopts and logs.
 *  - marker matches: proceed.
 *  - marker differs, populated table: refuse.
 */
export function decideProjectsCaseMode(
	input: ProjectsCaseModeInput,
): ProjectsCaseModeDecision {
	const { recorded, current, projectCount, rowsHaveUppercase } = input;

	if (projectCount === 0) {
		return recorded === current
			? { action: "ok" }
			: { action: "record", record: current };
	}

	if (recorded === undefined) {
		// Derived from the rows, not from `current`. Adopting the setting's
		// current value would agree with itself, so an operator who flips
		// PROJECTS_CASE_SENSITIVE and only THEN upgrades into this guard would
		// get a marker matching the new setting, a silent guard, and the
		// re-key anyway. An uppercase path settles it; all lowercase does not,
		// and falls back to `current`, which leaves that quadrant exactly as
		// unguarded as it was before this existed and no worse.
		const derived = rowsHaveUppercase ? true : current;
		if (derived !== current) {
			return {
				action: "refuse",
				message: refusal(derived, current, projectCount),
			};
		}
		return {
			action: "adopt",
			record: derived,
			message: `Adopted the projects path case mode this install's ${projectCount} existing projects were stored under (${derived ? "case-sensitive" : "case-insensitive"}). Changing PROJECTS_CASE_SENSITIVE from now on re-keys those rows, so it is refused while any project exists.`,
		};
	}

	if (recorded === current) return { action: "ok" };

	return {
		action: "refuse",
		message: refusal(recorded, current, projectCount),
	};
}
