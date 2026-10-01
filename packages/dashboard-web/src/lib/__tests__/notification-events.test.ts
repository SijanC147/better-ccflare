import { describe, expect, test } from "bun:test";
import type { AccountResponse, AlertEvent } from "@better-ccflare/types";
import type { ServiceStatusResponse } from "../../api";
import {
	accountHealthState,
	buildErrorBurstMessages,
	evaluateCategory,
	formatClock,
	MESSAGE_BUILDERS,
	type Observation,
	observeAccountHealth,
	observeErrorBursts,
	observeRateLimits,
	observeServiceStatus,
	POOL_KEY,
	rateLimitState,
} from "../notification-events";
import {
	baselineStorageKey,
	DEFAULT_NOTIFICATION_PREFS,
	type KeyValueStorage,
	type NotificationCategory,
	type NotificationMessage,
	type NotificationPrefs,
} from "../notifications";

function memoryStorage(): KeyValueStorage & { map: Map<string, string> } {
	const map = new Map<string, string>();
	return {
		map,
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => {
			map.set(key, value);
		},
		removeItem: (key) => {
			map.delete(key);
		},
	};
}

const ON: NotificationPrefs = {
	enabled: true,
	categories: { ...DEFAULT_NOTIFICATION_PREFS.categories },
};

/** A dispatcher harness: one storage, one notifier, one category. */
function harness(
	category: NotificationCategory,
	storage = memoryStorage(),
	prefs: NotificationPrefs = ON,
) {
	const sent: NotificationMessage[] = [];
	const run = (observation: Observation, p: NotificationPrefs = prefs) =>
		evaluateCategory({
			category,
			observation,
			prefs: p,
			storage,
			notify: (message) => {
				sent.push(message);
				return true;
			},
			build: MESSAGE_BUILDERS[category],
		});
	return { sent, run, storage };
}

function status(
	level: "operational" | "degraded" | "outage" | "unknown",
): ServiceStatusResponse {
	return {
		snapshot: {
			level,
			components: [],
			affected:
				level === "operational"
					? []
					: [{ id: "a", name: "Claude API", status: level }],
			incidents: [],
			missingComponentIds: [],
			pageIndicator: "none",
			pageUrl: "https://status.claude.com",
			checkedAt: 0,
		},
		stale: false,
		error: null,
	};
}

describe("dispatcher transitions", () => {
	test("the first reading is a baseline and sends nothing, even mid-outage", () => {
		const h = harness("serviceOutage");
		expect(h.run(observeServiceStatus(status("outage")))).toEqual([]);
		expect(h.sent).toEqual([]);
		// The baseline was written, so a second identical reading is also quiet.
		expect(h.storage.map.has(baselineStorageKey("serviceOutage"))).toBe(true);
		h.run(observeServiceStatus(status("outage")));
		expect(h.sent).toEqual([]);
	});

	test("operational to degraded notifies once, and the same state again does not", () => {
		const h = harness("serviceOutage");
		h.run(observeServiceStatus(status("operational")));
		h.run(observeServiceStatus(status("degraded")));
		expect(h.sent.map((m) => m.title)).toEqual(["Claude service degraded"]);
		expect(h.sent[0].body).toContain("Claude API");
		h.run(observeServiceStatus(status("degraded")));
		h.run(observeServiceStatus(status("degraded")));
		expect(h.sent).toHaveLength(1);
	});

	test("degraded to outage notifies the escalation", () => {
		const h = harness("serviceOutage");
		h.run(observeServiceStatus(status("degraded")));
		h.run(observeServiceStatus(status("outage")));
		expect(h.sent.map((m) => m.title)).toEqual([
			"Claude service outage reported",
		]);
	});

	test("recovery notifies exactly once", () => {
		const h = harness("serviceOutage");
		h.run(observeServiceStatus(status("operational")));
		h.run(observeServiceStatus(status("outage")));
		h.run(observeServiceStatus(status("operational")));
		h.run(observeServiceStatus(status("operational")));
		expect(h.sent.map((m) => m.title)).toEqual([
			"Claude service outage reported",
			"Claude service recovered",
		]);
	});

	test("a reload resumes from the stored baseline and does not re-notify", () => {
		const storage = memoryStorage();
		const first = harness("serviceOutage", storage);
		first.run(observeServiceStatus(status("operational")));
		first.run(observeServiceStatus(status("outage")));
		expect(first.sent).toHaveLength(1);
		// A new page load: new notifier, same storage, same ongoing outage.
		const reloaded = harness("serviceOutage", storage);
		reloaded.run(observeServiceStatus(status("outage")));
		expect(reloaded.sent).toEqual([]);
	});

	test("an unreadable status neither notifies nor erases the baseline", () => {
		const h = harness("serviceOutage");
		h.run(observeServiceStatus(status("outage")));
		h.run(observeServiceStatus(status("unknown")));
		h.run(observeServiceStatus({ snapshot: null, stale: false, error: "x" }));
		expect(h.sent).toEqual([]);
		// Still outage underneath: returning to outage is not news...
		h.run(observeServiceStatus(status("outage")));
		expect(h.sent).toEqual([]);
		// ...and a real recovery is still announced.
		h.run(observeServiceStatus(status("operational")));
		expect(h.sent.map((m) => m.title)).toEqual(["Claude service recovered"]);
	});

	test("a disabled category sends nothing and clears its baseline", () => {
		const h = harness("serviceOutage");
		const off: NotificationPrefs = {
			enabled: true,
			categories: { ...ON.categories, serviceOutage: false },
		};
		h.run(observeServiceStatus(status("operational")));
		expect(h.run(observeServiceStatus(status("outage")), off)).toEqual([]);
		expect(h.sent).toEqual([]);
		expect(h.storage.map.has(baselineStorageKey("serviceOutage"))).toBe(false);
		// Switched back on mid-outage: a fresh baseline, not a replay.
		h.run(observeServiceStatus(status("outage")));
		expect(h.sent).toEqual([]);
	});

	test("the master switch off sends nothing for any category", () => {
		const h = harness("serviceOutage");
		const masterOff: NotificationPrefs = { ...ON, enabled: false };
		h.run(observeServiceStatus(status("operational")), masterOff);
		h.run(observeServiceStatus(status("outage")), masterOff);
		expect(h.sent).toEqual([]);
	});

	test("a corrupt stored baseline is treated as none, not as a crash", () => {
		const h = harness("serviceOutage");
		h.storage.setItem(baselineStorageKey("serviceOutage"), "{not json");
		expect(() => h.run(observeServiceStatus(status("outage")))).not.toThrow();
		expect(h.sent).toEqual([]);
	});

	test("storage that throws on every call still evaluates without throwing", () => {
		const hostile: KeyValueStorage = {
			getItem: () => {
				throw new Error("SecurityError");
			},
			setItem: () => {
				throw new Error("QuotaExceededError");
			},
			removeItem: () => {
				throw new Error("SecurityError");
			},
		};
		const h = harness("serviceOutage", hostile as never);
		expect(() => h.run(observeServiceStatus(status("outage")))).not.toThrow();
		expect(h.sent).toEqual([]);
	});
});

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

function account(over: Partial<AccountResponse> = {}): AccountResponse {
	return {
		id: "acc-1",
		name: "one",
		paused: false,
		pauseReason: null,
		requiresReauth: false,
		rateLimitStatus: "OK",
		rateLimitedUntil: null,
		rateLimitedReason: null,
		usageUtilization: null,
		...over,
	} as AccountResponse;
}

describe("account classification", () => {
	test("a 429-family lock is a rate limit, not a health problem", () => {
		const a = account({
			rateLimitedUntil: NOW + 60_000,
			rateLimitedReason: "upstream_429_with_reset",
		});
		expect(rateLimitState(a, NOW)).toBe("rate_limited");
		expect(accountHealthState(a, NOW)).toBeNull();
	});

	test("a server-error lock is a bench, not a rate limit", () => {
		for (const reason of [
			"upstream_5xx_server_error",
			"upstream_529_overloaded_with_reset",
			"org_permission_denied",
		] as const) {
			const a = account({
				rateLimitedUntil: NOW + 60_000,
				rateLimitedReason: reason,
			});
			expect(accountHealthState(a, NOW)).toBe("benched");
			expect(rateLimitState(a, NOW)).toBeNull();
		}
	});

	test("an expired lock is healthy on both counts", () => {
		const a = account({
			rateLimitedUntil: NOW - 1,
			rateLimitedReason: "upstream_429_with_reset",
		});
		expect(rateLimitState(a, NOW)).toBeNull();
		const b = account({
			rateLimitedUntil: NOW - 1,
			rateLimitedReason: "upstream_5xx_server_error",
		});
		expect(accountHealthState(b, NOW)).toBeNull();
	});

	test("a lock with no recorded reason is a rate limit", () => {
		const a = account({ rateLimitedUntil: NOW + 1 });
		expect(rateLimitState(a, NOW)).toBe("rate_limited");
	});

	test("a hard-limit status counts even without a lock", () => {
		expect(
			rateLimitState(account({ rateLimitStatus: "rate_limited" }), NOW),
		).toBe("rate_limited");
		expect(
			rateLimitState(account({ rateLimitStatus: "allowed_warning" }), NOW),
		).toBeNull();
	});

	test("full usage is quota exhaustion", () => {
		expect(rateLimitState(account({ usageUtilization: 100 }), NOW)).toBe(
			"quota_exhausted",
		);
		expect(rateLimitState(account({ usageUtilization: 99.9 }), NOW)).toBeNull();
	});

	test("pauses: quota pauses are rate limits, deliberate pauses are nothing, the rest are health", () => {
		const quota = account({ paused: true, pauseReason: "usage_threshold" });
		expect(rateLimitState(quota, NOW)).toBe("quota_paused");
		expect(accountHealthState(quota, NOW)).toBeNull();
		expect(
			rateLimitState(account({ paused: true, pauseReason: "overage" }), NOW),
		).toBe("quota_paused");
		for (const reason of ["manual", "peak_hours"]) {
			const a = account({ paused: true, pauseReason: reason });
			expect(rateLimitState(a, NOW)).toBeNull();
			expect(accountHealthState(a, NOW)).toBeNull();
		}
		const failing = account({ paused: true, pauseReason: "failure_threshold" });
		expect(accountHealthState(failing, NOW)).toBe("paused");
		expect(rateLimitState(failing, NOW)).toBeNull();
	});

	test("re-authentication outranks everything else", () => {
		const a = account({
			requiresReauth: true,
			paused: true,
			pauseReason: "failure_threshold",
			rateLimitedUntil: NOW + 1,
		});
		expect(accountHealthState(a, NOW)).toBe("requires_reauth");
		expect(rateLimitState(a, NOW)).toBeNull();
	});
});

describe("rate-limit pool", () => {
	const limited = (id: string) =>
		account({
			id,
			name: id,
			rateLimitedUntil: NOW + 60_000,
			rateLimitedReason: "upstream_429_with_reset",
		});

	test("every routable account limited adds the pool key", () => {
		const obs = observeRateLimits(
			[
				limited("a"),
				limited("b"),
				// Out of the pool for reasons that are not quota.
				account({ id: "c", paused: true, pauseReason: "manual" }),
				account({ id: "d", requiresReauth: true }),
				account({
					id: "e",
					rateLimitedUntil: NOW + 1,
					rateLimitedReason: "upstream_5xx_server_error",
				}),
			],
			NOW,
		);
		expect(obs && Object.keys(obs).sort()).toEqual([POOL_KEY, "a", "b"]);
	});

	test("one routable account with capacity keeps the pool key away", () => {
		const obs = observeRateLimits([limited("a"), account({ id: "b" })], NOW);
		expect(obs && POOL_KEY in obs).toBe(false);
	});

	test("a quota-paused account still counts as limited in the pool", () => {
		const obs = observeRateLimits(
			[
				limited("a"),
				account({ id: "b", paused: true, pauseReason: "overage" }),
			],
			NOW,
		);
		expect(obs && POOL_KEY in obs).toBe(true);
	});

	test("an empty pool is not exhausted", () => {
		expect(observeRateLimits([], NOW)).toEqual({});
	});

	test("pool exhaustion and its recovery each notify once", () => {
		const h = harness("rateLimit");
		h.run(
			observeRateLimits([limited("a"), account({ id: "b", name: "b" })], NOW),
		);
		h.run(observeRateLimits([limited("a"), limited("b")], NOW));
		expect(h.sent.map((m) => m.title)).toEqual([
			"Every account is rate-limited",
			"Account rate-limited: b",
		]);
		h.run(observeRateLimits([limited("a"), limited("b")], NOW));
		h.run(
			observeRateLimits([limited("a"), account({ id: "b", name: "b" })], NOW),
		);
		expect(h.sent.map((m) => m.title).slice(2)).toEqual([
			"Accounts available again",
			"Rate limit cleared: b",
		]);
	});

	test("a lock passing its reset time is a recovery with unchanged data", () => {
		const h = harness("rateLimit");
		const accounts = [limited("a"), account({ id: "b" })];
		h.run(observeRateLimits(accounts, NOW));
		h.run(observeRateLimits(accounts, NOW + 120_000));
		expect(h.sent.map((m) => m.title)).toEqual(["Rate limit cleared: a"]);
	});
});

describe("account health notifications", () => {
	test("degradation and recovery each notify once", () => {
		const h = harness("accountHealth");
		h.run(observeAccountHealth([account()], NOW));
		h.run(observeAccountHealth([account({ requiresReauth: true })], NOW));
		h.run(observeAccountHealth([account({ requiresReauth: true })], NOW));
		h.run(observeAccountHealth([account()], NOW));
		expect(h.sent.map((m) => m.title)).toEqual([
			"Account needs re-authentication: one",
			"Account healthy again: one",
		]);
	});

	test("a change from one problem to another notifies", () => {
		const h = harness("accountHealth");
		h.run(
			observeAccountHealth(
				[account({ paused: true, pauseReason: "failure_threshold" })],
				NOW,
			),
		);
		h.run(observeAccountHealth([account({ requiresReauth: true })], NOW));
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0].body).toBe("one: needs re-authentication");
	});

	test("a missing accounts reading is no reading", () => {
		expect(observeAccountHealth(undefined, NOW)).toBeNull();
		expect(observeRateLimits(undefined, NOW)).toBeNull();
	});
});

function alert(over: Partial<AlertEvent>): AlertEvent {
	return {
		id: "upstream_error:x:1",
		timestamp: NOW,
		type: "upstream_error",
		severity: "warning",
		title: "Upstream rate limiting",
		message: "3 rate-limited (429) responses for account one.",
		value: 3,
		threshold: 3,
		account: "one",
		model: null,
		project: null,
		requestId: null,
		acknowledged: false,
		...over,
	};
}

describe("error bursts", () => {
	test("a new upstream_error alert notifies once; other types and acknowledged ones do not", () => {
		const h = harness("errorBurst");
		h.run(observeErrorBursts([alert({ id: "upstream_error:x:1" })]));
		h.run(
			observeErrorBursts([
				alert({ id: "upstream_error:x:1" }),
				alert({ id: "upstream_error:x:2", title: "Upstream server errors" }),
				alert({ id: "daily_spend:x:2", type: "daily_spend" }),
				alert({ id: "upstream_error:y:2", acknowledged: true }),
			]),
		);
		expect(h.sent.map((m) => m.title)).toEqual(["Upstream server errors"]);
		h.run(
			observeErrorBursts([
				alert({ id: "upstream_error:x:1" }),
				alert({ id: "upstream_error:x:2", title: "Upstream server errors" }),
			]),
		);
		expect(h.sent).toHaveLength(1);
	});

	test("an alert leaving the list is not a recovery", () => {
		expect(
			buildErrorBurstMessages({
				entered: [],
				changed: [],
				recovered: [{ key: "k", label: "l", from: "open", to: null }],
			}),
		).toEqual([]);
	});
});

describe("message details", () => {
	test("tags are deterministic for one transition, so two tabs collapse to one notification", () => {
		const a = harness("serviceOutage");
		const b = harness("serviceOutage");
		for (const h of [a, b]) {
			h.run(observeServiceStatus(status("operational")));
			h.run(observeServiceStatus(status("outage")));
		}
		expect(a.sent[0].tag).toBe(b.sent[0].tag);
		expect(a.sent[0].tag).not.toBe("");
	});

	test("reset times are on the 24-hour clock", () => {
		expect(formatClock(new Date(2026, 9, 1, 15, 4).getTime())).toBe("15:04");
		expect(formatClock(new Date(2026, 9, 1, 0, 5).getTime())).toBe("00:05");
	});
});
