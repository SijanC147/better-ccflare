import { describe, expect, it } from "bun:test";
import { HttpError } from "@better-ccflare/http-common";
import {
	type AuthProbeDeps,
	authProbeFailure,
	runAuthProbe,
} from "../auth-probe";

describe("authProbeFailure", () => {
	it("asks for a key on 401, with no message of its own", () => {
		expect(authProbeFailure(new HttpError(401, "Invalid API key"))).toEqual({
			reprompt: true,
			message: null,
		});
	});

	// SB23-3746 moved an api-only key's refusal from 401 to 403. Without this,
	// a stored api-only key left the dashboard with no dialog at all.
	it("asks for another key on 403, saying why", () => {
		expect(
			authProbeFailure(
				new HttpError(
					403,
					"Unauthorized: This API key does not have dashboard access",
				),
			),
		).toEqual({
			reprompt: true,
			message: "Unauthorized: This API key does not have dashboard access",
		});
	});

	it("leaves every other status alone", () => {
		for (const status of [400, 404, 408, 429, 500, 503]) {
			expect(authProbeFailure(new HttpError(status, "x"))).toEqual({
				reprompt: false,
			});
		}
	});

	it("leaves an error that is not an HTTP answer alone", () => {
		expect(authProbeFailure(new TypeError("Failed to fetch"))).toEqual({
			reprompt: false,
		});
		expect(authProbeFailure(undefined)).toEqual({ reprompt: false });
	});
});

describe("runAuthProbe", () => {
	const recorder = (
		probe: () => Promise<unknown>,
		storedKey: boolean,
	): { deps: AuthProbeDeps; calls: string[] } => {
		const calls: string[] = [];
		return {
			calls,
			deps: {
				probe,
				hasStoredKey: () => storedKey,
				clearApiKey: () => calls.push("clearApiKey"),
				setIsAuthenticated: (v) => calls.push(`isAuthenticated=${v}`),
				setAuthRequired: (v) => calls.push(`authRequired=${v}`),
				setAuthError: (v) => calls.push(`authError=${v}`),
				setShowAuthDialog: (v) => calls.push(`showAuthDialog=${v}`),
			},
		};
	};

	it("authenticates with a stored key that the server accepts", async () => {
		const { deps, calls } = recorder(async () => ({}), true);
		await runAuthProbe(deps);
		expect(calls).toEqual(["isAuthenticated=true", "authRequired=true"]);
	});

	it("authenticates with auth off and no stored key", async () => {
		const { deps, calls } = recorder(async () => ({}), false);
		await runAuthProbe(deps);
		expect(calls).toEqual(["isAuthenticated=true", "authRequired=false"]);
	});

	it("opens the dialog with no message on 401", async () => {
		const { deps, calls } = recorder(async () => {
			throw new HttpError(401, "Invalid API key");
		}, true);
		await runAuthProbe(deps);
		expect(calls).toEqual([
			"clearApiKey",
			"authError=null",
			"authRequired=true",
			"showAuthDialog=true",
		]);
	});

	// The case SB23-3746 created: a stored api-only key now gets 403. Before
	// the probe handled it, none of these calls happened and the dashboard
	// painted an empty shell with no dialog.
	it("opens the dialog with the server's reason on 403", async () => {
		const { deps, calls } = recorder(async () => {
			throw new HttpError(
				403,
				"Unauthorized: This API key does not have dashboard access",
			);
		}, true);
		await runAuthProbe(deps);
		expect(calls).toEqual([
			"clearApiKey",
			"authError=Unauthorized: This API key does not have dashboard access",
			"authRequired=true",
			"showAuthDialog=true",
		]);
	});

	it("keeps the key and opens nothing on a server error", async () => {
		const { deps, calls } = recorder(async () => {
			throw new HttpError(500, "boom");
		}, true);
		await runAuthProbe(deps);
		expect(calls).toEqual([]);
	});
});
