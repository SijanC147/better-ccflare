/**
 * Per-slot combo throttles read through the real repository (SB23-3390).
 *
 * `combo-slot-throttle.test.ts` hands `selectAccountsForRequest` a stubbed
 * `getActiveComboForFamily` that returns fully populated slots, so it proves
 * the rule and says nothing about whether the thresholds reach the rule. They
 * did not: the family-combo SELECT listed six columns and omitted both
 * thresholds, `toComboSlot` mapped the absent columns to null, and null means
 * "no threshold". Every slot on the live family path was unthrottled whatever
 * the operator stored, while `getComboSlots` (the API and dashboard read) showed
 * the thresholds as set.
 *
 * So the combo here is written and read by a real `DatabaseOperations` over an
 * in-memory SQLite database, and only the accounts stay in memory. Each
 * threshold gets its own test with only that threshold configured: with both
 * set, dropping either column from the SELECT leaves the other clause to fire
 * on its own and the skip still happens, so a both-set test cannot tell whether
 * the columns are read.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "@better-ccflare/database";
import { usageCache } from "@better-ccflare/providers";
import type { Account, ComboFamily, RequestMeta } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { selectAccountsForRequest } from "../handlers/account-selector";

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const MODEL = "claude-sonnet-4-5";
const FAMILY: ComboFamily = "sonnet";
const COMBO_NAME = "Sonnet ladder";

// Distinct from combo-slot-throttle.test.ts's acc-1/acc-2, so the usage cache
// entries each file seeds and deletes can never cross files.
const FIRST = "acc-repo-1";
const SECOND = "acc-repo-2";

function makeAccount(id: string): Account {
	return {
		id,
		name: id,
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: NOW + 3 * HOUR,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: NOW,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		requires_reauth: false,
		peak_hours_pause_enabled: false,
		request_transformer: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		last_manual_reauth_at: null,
		consecutive_rate_limits: 0,
		renewal_day: null,
		usage_pause_five_hour_threshold: null,
		usage_pause_weekly_threshold: null,
		usage_pause_five_hour_enabled: false,
		usage_pause_weekly_enabled: false,
		usage_pause_five_hour_min_reset_remaining_ms: null,
		usage_pause_weekly_min_reset_remaining_ms: null,
	};
}

/** Seed the representative (five-hour) window the selector reads. */
function setUsage(accountId: string, utilization: number, resetsAt: number) {
	usageCache.set(accountId, {
		five_hour: {
			utilization,
			resets_at: new Date(resetsAt).toISOString(),
		},
		seven_day: { utilization: 0, resets_at: null },
	} as never);
}

function makeMeta(): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: NOW,
		headers: new Headers({ "Content-Type": "application/json" }),
	} as unknown as RequestMeta;
}

/**
 * Freezes `Date.now` for the whole of `fn`, including its async tail. The
 * `return await` is load-bearing; see the same helper in
 * combo-slot-throttle.test.ts (SB23-1997).
 */
async function withFrozenClock<T>(fn: () => T | Promise<T>): Promise<T> {
	const realDateNow = Date.now;
	Date.now = () => NOW;
	try {
		return await fn();
	} finally {
		Date.now = realDateNow;
	}
}

describe("family combo slot thresholds survive the repository read", () => {
	let configHome: string;
	let savedConfigHome: string | undefined;
	let savedDatabaseUrl: string | undefined;
	let dbOps: DatabaseOperations;
	let firstSlotId: string;

	beforeAll(() => {
		// DatabaseOperations consults DATABASE_URL and then a Config for a
		// PostgreSQL URL; neither may reach a real install.
		savedConfigHome = process.env.XDG_CONFIG_HOME;
		savedDatabaseUrl = process.env.DATABASE_URL;
		configHome = mkdtempSync(join(tmpdir(), "sb23-3390-"));
		process.env.XDG_CONFIG_HOME = configHome;
		delete process.env.DATABASE_URL;
	});

	afterAll(() => {
		if (savedConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = savedConfigHome;
		if (savedDatabaseUrl !== undefined)
			process.env.DATABASE_URL = savedDatabaseUrl;
		rmSync(configHome, { recursive: true, force: true });
	});

	beforeEach(async () => {
		dbOps = new DatabaseOperations(":memory:", { walMode: false });
		// combo_slots.account_id is a foreign key, so the accounts must exist.
		for (const id of [FIRST, SECOND]) {
			dbOps
				.getDatabase()
				.run(
					"INSERT INTO accounts (id, name, provider, created_at) VALUES (?, ?, ?, ?)",
					[id, id, "anthropic", NOW],
				);
		}
		const combo = await dbOps.createCombo(COMBO_NAME);
		firstSlotId = (await dbOps.addComboSlot(combo.id, FIRST, MODEL, 0)).id;
		await dbOps.addComboSlot(combo.id, SECOND, MODEL, 1);
		await dbOps.setFamilyCombo(FAMILY, combo.id, true);
	});

	afterEach(async () => {
		usageCache.delete(FIRST);
		usageCache.delete(SECOND);
		await dbOps.dispose();
	});

	/** The accounts stay in memory; the combo read is the repository's. */
	function makeContext(): ProxyContext {
		const accounts = [makeAccount(FIRST), makeAccount(SECOND)];
		return {
			strategy: { select: mock((accs: Account[]) => accs) } as never,
			dbOps: {
				getAllAccounts: mock(async () => accounts),
				getActiveComboForFamily: (family: ComboFamily) =>
					dbOps.getActiveComboForFamily(family),
			} as never,
			runtime: { port: 8080, clientId: "test" } as never,
			config: {
				getUsageThrottlingFiveHourEnabled: () => false,
				getUsageThrottlingWeeklyEnabled: () => false,
				getSystemPromptCacheTtl1h: () => false,
				getAgentFrontmatterModelFallback: () => false,
				getModelScopedCapacityRouting: () => "off",
			} as never,
			provider: { name: "anthropic" } as never,
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) } as never,
		};
	}

	/**
	 * The selected ids plus the combo that routed them. The combo name is what
	 * separates "the combo kept this slot" from "every slot was skipped and
	 * normal routing returned the pool": with the pass-through strategy mock
	 * both can yield the same ids, and only the combo path stamps `comboName`.
	 */
	async function select(): Promise<{
		ids: string[];
		comboName: string | null | undefined;
	}> {
		const meta = makeMeta();
		const selected = await withFrozenClock(() =>
			selectAccountsForRequest(meta, makeContext(), MODEL),
		);
		return { ids: selected.map((a) => a.id), comboName: meta.comboName };
	}

	it("returns both thresholds on the active family combo's slots", async () => {
		await dbOps.updateComboSlot(firstSlotId, {
			max_utilization_percent: 80,
			min_reset_remaining_ms: HOUR,
		});

		const combo = await dbOps.getActiveComboForFamily(FAMILY);

		expect(combo?.slots.map((s) => s.id)[0]).toBe(firstSlotId);
		expect(combo?.slots[0].max_utilization_percent).toBe(80);
		expect(combo?.slots[0].min_reset_remaining_ms).toBe(HOUR);
	});

	it("skips a slot over its utilization-only threshold", async () => {
		await dbOps.updateComboSlot(firstSlotId, { max_utilization_percent: 80 });
		setUsage(FIRST, 90, NOW + 4 * HOUR);
		setUsage(SECOND, 5, NOW + 4 * HOUR);

		expect(await select()).toEqual({ ids: [SECOND], comboName: COMBO_NAME });
	});

	it("skips a slot whose reset-only threshold is met", async () => {
		await dbOps.updateComboSlot(firstSlotId, { min_reset_remaining_ms: HOUR });
		// Utilization of 10% would defeat any utilization clause; none is
		// configured, so only the reset distance of four hours decides.
		setUsage(FIRST, 10, NOW + 4 * HOUR);
		setUsage(SECOND, 5, NOW + 4 * HOUR);

		expect(await select()).toEqual({ ids: [SECOND], comboName: COMBO_NAME });
	});

	it("keeps the slot when no threshold is stored", async () => {
		// The control: same usage as the utilization test, so a skip there is
		// the threshold and not the account being unavailable.
		setUsage(FIRST, 90, NOW + 4 * HOUR);
		setUsage(SECOND, 5, NOW + 4 * HOUR);

		expect(await select()).toEqual({
			ids: [FIRST, SECOND],
			comboName: COMBO_NAME,
		});
	});

	it("keeps a stored 0 threshold as 0, which skips the slot at any utilization", async () => {
		// 0 means "always skip" (#131). A read that turned a stored 0 into null
		// would switch a deliberately benched slot back on, and 0% utilization
		// is the one reading only a real 0 threshold can skip.
		await dbOps.updateComboSlot(firstSlotId, { max_utilization_percent: 0 });
		setUsage(FIRST, 0, NOW + 4 * HOUR);
		setUsage(SECOND, 5, NOW + 4 * HOUR);

		const combo = await dbOps.getActiveComboForFamily(FAMILY);
		expect(combo?.slots[0].max_utilization_percent).toBe(0);
		expect(await select()).toEqual({ ids: [SECOND], comboName: COMBO_NAME });
	});
});
