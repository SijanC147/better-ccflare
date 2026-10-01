import type { Config } from "@better-ccflare/config";

/**
 * What became of one local-control notification (SB23-4035).
 *
 * - "not-sent": the server that published the secret has exited, so nothing
 *   was sent anywhere. Its port is free for any local user to bind, and the
 *   secret it published is usually still the one the next server holds.
 * - "unreachable": sent to `target` and the connection failed.
 * - "answered": `target` answered with `response`.
 */
export type LocalControlNotifyOutcome =
	| { kind: "not-sent"; reason: string }
	| { kind: "unreachable"; target: string }
	| { kind: "answered"; target: string; response: Response };

/**
 * POST a local-control notification (`--reauthenticate`,
 * `--force-reset-rate-limit`) to the one server this config names, carrying
 * its local_control_secret (issue #216).
 *
 * Exactly one request, or none. Before SB23-4035 these calls went to
 * localhost:8080 and localhost:8081 whichever the server listened on, so a
 * local user who bound the other one received the secret. The address comes
 * from Config#getLocalControlTarget(): the listener the server published
 * beside the secret while its pid still runs, otherwise the configured port
 * alone.
 *
 * `path` starts with `/api/`.
 */
export async function postLocalControl(
	config: Config,
	path: string,
): Promise<LocalControlNotifyOutcome> {
	const target = config.getLocalControlTarget();
	if (target.kind === "stale") {
		return {
			kind: "not-sent",
			reason: `the server that published ${config.getLocalControlSidecarPath()} (pid ${target.pid}) is no longer running, so its port may now belong to anyone and the secret is not sent there`,
		};
	}
	if (target.kind === "unaddressed") {
		return {
			kind: "not-sent",
			reason: `BETTER_CCFLARE_HOST is the name "${target.bindHost}" and no running server has published the address it bound, so there is no literal address to send the secret to`,
		};
	}
	const url = `${target.baseUrl}${path}`;
	try {
		const response = await fetch(url, {
			method: "POST",
			// A redirect would carry the secret header to wherever it points.
			redirect: "manual",
			headers: {
				"Content-Type": "application/json",
				"x-better-ccflare-local-control-secret": target.secret,
			},
		});
		return { kind: "answered", target: target.baseUrl, response };
	} catch {
		return { kind: "unreachable", target: target.baseUrl };
	}
}

/**
 * Tell the running server to reload an account's tokens, and print what
 * happened. Best effort: a CLI change is already saved whether or not a
 * server hears about it.
 */
export async function notifyServerToReload(
	config: Config,
	accountId: string,
): Promise<void> {
	const outcome = await postLocalControl(
		config,
		`/api/accounts/${accountId}/reload`,
	);
	switch (outcome.kind) {
		case "not-sent":
			console.log(`✗ Not notified: ${outcome.reason}`);
			return;
		case "unreachable":
			console.log(`✗ No server running at ${outcome.target}`);
			return;
		case "answered":
			console.log(
				outcome.response.ok
					? `✓ Token reload successful at ${outcome.target}`
					: `✗ Server at ${outcome.target} did not accept the reload (${outcome.response.status})`,
			);
	}
}
