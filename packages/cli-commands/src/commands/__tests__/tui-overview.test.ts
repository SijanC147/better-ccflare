import { describe, expect, it } from "bun:test";
import type { AccountResponse } from "@better-ccflare/types";
import {
	API_KEY_REQUIRED_SENTENCE,
	buildOverviewAccount,
	type FetchLike,
	fetchOverview,
	formatClock,
	formatResetIn,
	renderOverview,
} from "../tui-overview";

const NOW = Date.parse("2026-10-01T08:00:00Z");

/**
 * Shaped like one element of a real `GET /api/accounts` body: every field the
 * handler emits, so a renderer reading a field the server never sends fails
 * here rather than in a terminal.
 */
function account(overrides: Partial<AccountResponse> = {}): AccountResponse {
	return {
		id: "acc-1",
		name: "work",
		provider: "anthropic",
		requestCount: 0,
		totalRequests: 0,
		lastUsed: null,
		created: "2026-09-01T00:00:00.000Z",
		paused: false,
		requiresReauth: false,
		pauseReason: null,
		tokenStatus: "valid",
		tokenExpiresAt: null,
		rateLimitStatus: "OK",
		rateLimitReset: null,
		rateLimitRemaining: null,
		rateLimitedUntil: null,
		rateLimitedReason: null,
		rateLimitedAt: null,
		sessionInfo: "",
		priority: 0,
		autoFallbackEnabled: false,
		autoRefreshEnabled: false,
		usagePauseFiveHourThreshold: null,
		usagePauseWeeklyThreshold: null,
		usagePauseFiveHourEnabled: false,
		usagePauseWeeklyEnabled: false,
		usagePauseFiveHourMinResetRemainingMs: null,
		usagePauseWeeklyMinResetRemainingMs: null,
		customEndpoint: null,
		modelMappings: null,
		requestTransformer: null,
		usageUtilization: null,
		usageWindow: null,
		usageData: null,
		usageRateLimitedUntil: null,
		usageThrottledUntil: null,
		usageThrottledWindows: [],
		hasRefreshToken: true,
		sessionStats: null,
		isPrimary: false,
		lastManualReauthAt: null,
		reauthDeadlineStatus: null,
		daysUntilReauthRequired: null,
		hoursUntilReauthRequired: null,
		renewalDay: null,
		nextRenewalAt: null,
		daysUntilRenewal: null,
		...overrides,
	};
}

/** An Anthropic payload whose per-model cap lives only in limits[]. */
const ANTHROPIC_USAGE = {
	five_hour: { utilization: 42, resets_at: "2026-10-01T10:13:00Z" },
	seven_day: { utilization: 17, resets_at: "2026-10-05T03:00:00Z" },
	seven_day_fable: null,
	limits: [
		{
			kind: "session",
			percent: 42,
			severity: "normal",
			resets_at: "2026-10-01T10:13:00Z",
			is_active: true,
		},
		{
			kind: "weekly_all",
			percent: 17,
			severity: "normal",
			resets_at: "2026-10-05T03:00:00Z",
			is_active: false,
		},
		{
			kind: "weekly_scoped",
			percent: 91,
			severity: "warning",
			resets_at: "2026-10-05T03:00:00Z",
			is_active: false,
			scope: { model: { id: "claude-fable-5", display_name: "Fable" } },
		},
	],
} as unknown as AccountResponse["usageData"];

const ESC = "\x1b";

describe("buildOverviewAccount", () => {
	it("shows 5-hour, Weekly and the Fable weekly_scoped row for an Anthropic account", () => {
		const built = buildOverviewAccount(account({ usageData: ANTHROPIC_USAGE }));
		expect(built.rows.map((r) => [r.label, r.utilization, r.severity])).toEqual(
			[
				["5-hour", 42, "normal"],
				["Weekly", 17, "normal"],
				["Fable (Weekly)", 91, "warning"],
			],
		);
		expect(built.rows[0].isActive).toBe(true);
		expect(built.note).toBeNull();
	});

	it("says there is no data, never 0 percent, for an account never polled", () => {
		const built = buildOverviewAccount(account({ usageData: null }));
		expect(built.rows).toEqual([]);
		expect(built.note).toBe("no usage data yet");
	});

	it("drops a Codex 5-hour row the payload did not report", () => {
		const built = buildOverviewAccount(
			account({
				provider: "codex",
				usageUtilization: 30,
				usageData: {
					seven_day: { utilization: 30, resets_at: "2026-10-04T00:00:00Z" },
				} as unknown as AccountResponse["usageData"],
			}),
		);
		expect(built.rows.map((r) => r.label)).toEqual(["Weekly"]);
	});

	it("keeps a Codex account's Weekly row as N/A when it has no data", () => {
		const built = buildOverviewAccount(
			account({ provider: "codex", usageData: null }),
		);
		expect(built.rows.map((r) => [r.label, r.utilization])).toEqual([
			["Weekly", null],
		]);
	});

	it("notes the usage API rate limit only when there is no payload, like the card", () => {
		const limited = buildOverviewAccount(
			account({ usageData: null, usageRateLimitedUntil: NOW + 60_000 }),
		);
		expect(limited.note).toStartWith("usage API rate limited until ");
		const withPayload = buildOverviewAccount(
			account({
				usageData: { credits: {} } as unknown as AccountResponse["usageData"],
				usageRateLimitedUntil: NOW + 60_000,
				usageUtilization: 12,
				usageWindow: "five_hour",
			}),
		);
		expect(withPayload.note).toBeNull();
		expect(withPayload.rows.map((r) => r.utilization)).toEqual([12]);
	});

	it("shows the representative scalar for other providers", () => {
		const built = buildOverviewAccount(
			account({
				provider: "zai",
				usageUtilization: 55,
				usageWindow: "tokens_limit",
			}),
		);
		expect(built.rows.map((r) => [r.label, r.utilization])).toEqual([
			["5-hour", 55],
		]);
	});

	it("reports paused and reauth before the rate-limit status", () => {
		expect(
			buildOverviewAccount(account({ paused: true, pauseReason: "manual" }))
				.status,
		).toBe("paused (manual)");
		expect(buildOverviewAccount(account({ requiresReauth: true })).status).toBe(
			"reauth needed",
		);
		expect(
			buildOverviewAccount(account({ rateLimitStatus: "Rate limited (5m)" }))
				.status,
		).toBe("Rate limited (5m)");
	});
});

describe("renderOverview", () => {
	const options = {
		width: 100,
		color: false,
		now: NOW,
		baseUrl: "http://127.0.0.1:8080",
	};

	it("prints the Fable (Weekly) row with its percent and reset", () => {
		const text = renderOverview(
			[account({ usageData: ANTHROPIC_USAGE })],
			options,
		);
		const fable = text.split("\n").find((l) => l.includes("Fable (Weekly)"));
		expect(fable).toBeDefined();
		expect(fable).toContain("91%");
		expect(fable).toContain("resets in 3d 19h");
		expect(text).toContain("5-hour");
		expect(text).toContain("Weekly");
	});

	it("emits no escape bytes with colour off and colours rows with it on", () => {
		const plain = renderOverview(
			[account({ usageData: ANTHROPIC_USAGE })],
			options,
		);
		expect(plain.includes(ESC)).toBe(false);
		const coloured = renderOverview([account({ usageData: ANTHROPIC_USAGE })], {
			...options,
			color: true,
		});
		expect(coloured).toContain(`${ESC}[33m 91%${ESC}[0m`);
	});

	it("cuts every line to a narrow panel width", () => {
		const text = renderOverview(
			[
				account({ usageData: ANTHROPIC_USAGE }),
				account({ name: "a-very-long-account-name-indeed", usageData: null }),
			],
			{ ...options, width: 30 },
		);
		for (const line of text.split("\n")) {
			expect(line.length).toBeLessThanOrEqual(30);
		}
	});

	it("names an empty pool", () => {
		expect(renderOverview([], options)).toContain("No accounts.");
	});
});

describe("formatClock", () => {
	it("prints local time on the 24-hour clock in any zone", () => {
		// Built from local components, so the expectation holds in every zone.
		expect(formatClock(new Date(2026, 9, 1, 15, 4, 5))).toBe("15:04:05");
		expect(formatClock(new Date(2026, 9, 1, 0, 0, 0))).toBe("00:00:00");
	});
});

describe("formatResetIn", () => {
	it("formats days, hours and minutes and handles the edges", () => {
		expect(formatResetIn("2026-10-01T10:13:00Z", NOW)).toBe("resets in 2h 13m");
		expect(formatResetIn("2026-10-01T08:00:30Z", NOW)).toBe("resets in 1m");
		expect(formatResetIn("2026-10-01T07:00:00Z", NOW)).toBe("resetting");
		expect(formatResetIn(null, NOW)).toBe("");
		expect(formatResetIn("not a date", NOW)).toBe("");
	});
});

describe("fetchOverview", () => {
	const url = "http://127.0.0.1:65530";
	const json =
		(status: number, body: unknown): FetchLike =>
		async () =>
			new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			});

	it("returns the account list and sends the key as x-api-key", async () => {
		let seen: Record<string, string> | undefined;
		const result = await fetchOverview(url, "k-1", {
			fetch: async (input, init) => {
				expect(input).toBe(`${url}/api/accounts`);
				seen = init?.headers;
				return new Response(JSON.stringify([account()]), { status: 200 });
			},
		});
		expect(result.ok).toBe(true);
		expect(seen?.["x-api-key"]).toBe("k-1");
	});

	it("sends no credential when none is configured", async () => {
		let seen: Record<string, string> | undefined;
		await fetchOverview(url, null, {
			fetch: async (_input, init) => {
				seen = init?.headers;
				return new Response("[]", { status: 200 });
			},
		});
		expect(seen?.["x-api-key"]).toBeUndefined();
	});

	it("401 prints the server's x-api-key / Authorization: Bearer sentence", async () => {
		const result = await fetchOverview(url, null, {
			fetch: json(401, {
				type: "error",
				error: {
					type: "authentication_error",
					message: API_KEY_REQUIRED_SENTENCE,
				},
			}),
		});
		expect(result).toEqual({
			ok: false,
			kind: "unauthorized",
			message: `${API_KEY_REQUIRED_SENTENCE}. Pass --api-key <key> or set BETTER_CCFLARE_API_KEY.`,
		});
	});

	it("401 with a key names the server's reason and the admin requirement", async () => {
		const result = await fetchOverview(url, "k-api-only", {
			fetch: json(401, {
				error: {
					message: "Unauthorized: This API key does not have dashboard access",
				},
			}),
		});
		expect(result).toEqual({
			ok: false,
			kind: "unauthorized",
			message:
				"The server refused the API key: Unauthorized: This API key does not have dashboard access. /api/accounts needs an admin key (better-ccflare --generate-api-key <name> --admin).",
		});
	});

	// The /api router's body for this refusal since SB23-3746: 403 with the
	// reason as a plain string.
	it("403 says the key lacks admin access, with the server's reason", async () => {
		const result = await fetchOverview(url, "k-api-only", {
			fetch: json(403, {
				error: "Unauthorized: This API key does not have dashboard access",
			}),
		});
		expect(result).toEqual({
			ok: false,
			kind: "forbidden",
			message:
				"This API key lacks admin access (Unauthorized: This API key does not have dashboard access); /api/accounts needs an admin key (better-ccflare --generate-api-key <name> --admin).",
		});
	});

	it("403 without a readable reason still names the admin requirement", async () => {
		const result = await fetchOverview(url, "k-api-only", {
			fetch: async () => new Response("denied", { status: 403 }),
		});
		expect(result).toEqual({
			ok: false,
			kind: "forbidden",
			message:
				"This API key lacks admin access; /api/accounts needs an admin key (better-ccflare --generate-api-key <name> --admin).",
		});
	});

	it("names the URL when nothing is listening", async () => {
		const result = await fetchOverview(url, null, {
			fetch: async () => {
				throw Object.assign(new Error("Unable to connect"), {
					code: "ConnectionRefused",
				});
			},
		});
		expect(result).toEqual({
			ok: false,
			kind: "unreachable",
			message: `server not running on ${url}`,
		});
	});

	it("gives up after the timeout", async () => {
		const result = await fetchOverview(url, null, {
			timeoutMs: 20,
			fetch: (_input, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(init.signal?.reason),
					);
				}),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.kind).toBe("timeout");
	});

	it("refuses a body that is not an account list", async () => {
		for (const body of [{ hello: "world" }, [{}], [{ name: "a" }], [null]]) {
			const result = await fetchOverview(url, null, {
				fetch: json(200, body),
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.kind).toBe("invalid");
		}
	});
});
