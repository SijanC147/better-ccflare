import { describe, expect, it } from "bun:test";
import { HttpError } from "@better-ccflare/http-common";
import { authProbeFailure } from "../auth-probe";

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
