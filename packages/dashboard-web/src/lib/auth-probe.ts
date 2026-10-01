import { HttpError } from "@better-ccflare/http-common";

/**
 * What the dashboard does when its load-time auth probe (`GET /api/stats`)
 * fails.
 *
 * 401: no key, or a key the server does not recognise. Ask for one.
 * 403: a valid key the server will not let use the dashboard, such as an
 * api-only key. Ask for another, saying why: the /api router answered this
 * with 401 until SB23-3746, and without this branch a stored api-only key
 * left the dashboard on an empty shell with no dialog and no way out.
 *
 * Only the probe treats 403 this way. The global query and mutation handlers
 * must not: four other /api handlers answer 403 for reasons no key can fix
 * (self-update disabled, heap snapshots disabled, a Claude Code endpoint
 * reached through a host not in `claude_code_allowed_hosts`, a plugin-managed
 * agent), and opening the key dialog for those would be wrong.
 */
export function authProbeFailure(
	error: unknown,
): { reprompt: false } | { reprompt: true; message: string | null } {
	if (!(error instanceof HttpError)) return { reprompt: false };
	if (error.status === 401) return { reprompt: true, message: null };
	if (error.status === 403) return { reprompt: true, message: error.message };
	return { reprompt: false };
}
