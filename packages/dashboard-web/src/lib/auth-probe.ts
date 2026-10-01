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

export interface AuthProbeDeps {
	/** The probe request; any authenticated /api read. App uses GET /api/stats. */
	probe: () => Promise<unknown>;
	hasStoredKey: () => boolean;
	clearApiKey: () => void;
	setIsAuthenticated: (value: boolean) => void;
	setAuthRequired: (value: boolean) => void;
	setAuthError: (value: string | null) => void;
	setShowAuthDialog: (value: boolean) => void;
}

/**
 * The dashboard's load-time auth check: the body of App's `checkAuth` effect,
 * kept here so it runs under test without mounting App. App imports every tab
 * and renders the key dialog through a Radix portal, which stops rendering
 * once another test file in the same process has loaded Radix, so a mounted
 * App test would pass alone and fail in the full suite.
 */
export async function runAuthProbe(deps: AuthProbeDeps): Promise<void> {
	try {
		await deps.probe();
		// Authenticated: either auth is off, or the stored key is valid
		deps.setIsAuthenticated(true);
		// Auth is required only if we got here with a stored key
		deps.setAuthRequired(deps.hasStoredKey());
	} catch (error) {
		const failure = authProbeFailure(error);
		if (failure.reprompt) {
			// Clear the stored key that was refused
			deps.clearApiKey();
			deps.setAuthError(failure.message);
			deps.setAuthRequired(true);
			deps.setShowAuthDialog(true);
		}
	}
}
