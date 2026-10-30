/**
 * SB23-10878. When failover runs out, the client gets the error from an
 * account that serves the requested model, not a rewritten model's error.
 *
 * Reported 2026-10-30: six Anthropic accounts refused a `claude-haiku-5-5`
 * request with a windowless 429, then a META account, mapping the request to
 * `muse-spark-1.2-contributor`, answered 402 with a link to Meta's billing
 * page, and the client got the 402.
 *
 * Every upstream call lands on the `fetch` stub below, which records it and
 * throws for any host it does not know, so nothing here reaches a real
 * account. The real `AnthropicProvider` and `MetaProvider` run, because the
 * registry outranks `ctx.provider` for a registered provider name.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { AnthropicProvider, usageCache } from "@better-ccflare/providers";
import type { Account, ComboWithSlots } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { clearFamilyExhaustionCache } from "../handlers/model-capacity";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";
import { fetchSlot } from "./fetch-slot";
import { makeProxyContext } from "./proxy-context-fixture";

const originalFetch = globalThis.fetch;
const MODEL = "claude-haiku-5-5";
const META_MODEL = "muse-spark-1.2-contributor";
const META_ENDPOINT = "http://127.0.0.1:9";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-x",
		name: "acc-x",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		// Beyond the refresh safety window, so no token refresh is fetched.
		expires_at: Date.now() + 3 * 60 * 60 * 1000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
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
		rate_limited_reason: null,
		rate_limited_at: null,
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
		...overrides,
	};
}

/** The six Anthropic accounts of the incident. */
const ANTHROPIC_NAMES = ["XBOX", "PRTN", "OTLK", "ICLD", "UOM", "SB23"];

function anthropicAccounts(): Account[] {
	return ANTHROPIC_NAMES.map((name, index) =>
		makeAccount({ id: `anthropic-${name}`, name, priority: index }),
	);
}

function metaAccount(priority = 10): Account {
	return makeAccount({
		id: "meta-META",
		name: "META",
		provider: "meta",
		api_key: "meta-key",
		refresh_token: null,
		access_token: null,
		expires_at: null,
		custom_endpoint: META_ENDPOINT,
		model_mappings: JSON.stringify({ haiku: META_MODEL }),
		priority,
	});
}

function makeContext(
	accounts: Account[],
	combo: ComboWithSlots | null = null,
): ProxyContext {
	return makeProxyContext({
		strategy: { select: mock((accs: Account[]) => accs) },
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => combo),
			markAccountRateLimited: mock(() =>
				Promise.resolve({ consecutiveRateLimits: 1, applied: true }),
			),
			saveRequest: mock(() => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
		},
		runtime: { clientId: "test" },
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getModelScopedCapacityRouting: () => "off",
			getStorePayloads: () => false,
			getForceAccountModel: () => false,
			getCombosEnabled: () => combo !== null,
			// A combo here always tests the terminal that skips step 11.
			getComboSessionFallback: () => combo === null,
		},
		provider: new AnthropicProvider(),
		asyncWriter: {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		},
	});
}

/** The windowless 429 captured from Anthropic (issue #301). */
function windowless429(): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "Error" },
		}),
		{
			status: 429,
			headers: {
				"content-type": "application/json",
				"x-should-retry": "true",
			},
		},
	);
}

/** Meta's billing refusal, as the incident's client received it. */
function metaBilling402(): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "billing_error",
				message: "Add credits at https://dev.meta.ai/billing",
			},
		}),
		{ status: 402, headers: { "content-type": "application/json" } },
	);
}

function message(model: string): Response {
	return new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			model,
			content: [{ type: "text", text: "hi" }],
			stop_reason: "end_turn",
			stop_sequence: null,
			usage: { input_tokens: 5, output_tokens: 2 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

interface Calls {
	hosts: Array<"anthropic" | "meta">;
	metaModels: string[];
	unknown: string[];
}

function installFetch(
	anthropicAnswer: (index: number) => Response,
	metaAnswer: () => Response,
): Calls {
	const calls: Calls = { hosts: [], metaModels: [], unknown: [] };
	let anthropicIndex = 0;
	fetchSlot.fetch = async (input, init) => {
		const request =
			input instanceof Request ? input : new Request(String(input), init);
		const url = new URL(request.url);
		if (url.hostname === "api.anthropic.com") {
			calls.hosts.push("anthropic");
			return anthropicAnswer(anthropicIndex++);
		}
		if (url.href.startsWith(META_ENDPOINT)) {
			calls.hosts.push("meta");
			const body = (await request.json()) as { model?: string };
			calls.metaModels.push(body.model ?? "");
			return metaAnswer();
		}
		calls.unknown.push(url.href);
		throw new Error(`unexpected fetch in relevant-error test: ${url.href}`);
	};
	return calls;
}

/** One combo slot per account, each sending the requested model. */
function makeCombo(accountIds: string[]): ComboWithSlots {
	return {
		id: "combo-haiku",
		name: "ComboHaiku",
		description: null,
		enabled: true,
		created_at: Date.now(),
		updated_at: Date.now(),
		slots: accountIds.map((accountId, index) => ({
			id: `slot-${index}`,
			combo_id: "combo-haiku",
			account_id: accountId,
			model: MODEL,
			priority: index,
			enabled: true,
			max_utilization_percent: null,
			min_reset_remaining_ms: null,
		})),
	};
}

/**
 * Answers Anthropic calls in order and records `<host>:<model>` for every
 * call, so a test can see which model each answer was about.
 */
function installModelFetch(
	anthropicAnswers: Array<() => Response>,
	metaAnswer: () => Response,
): string[] {
	const seen: string[] = [];
	let index = 0;
	fetchSlot.fetch = async (input, init) => {
		const request =
			input instanceof Request ? input : new Request(String(input), init);
		const url = new URL(request.url);
		const body = (await request.json()) as { model?: string };
		if (url.hostname === "api.anthropic.com") {
			seen.push(`anthropic:${body.model}`);
			const answer = anthropicAnswers[index++];
			if (!answer) throw new Error("no Anthropic answer left");
			return answer();
		}
		if (url.href.startsWith(META_ENDPOINT)) {
			seen.push(`meta:${body.model}`);
			return metaAnswer();
		}
		throw new Error(`unexpected fetch in relevant-error test: ${url.href}`);
	};
	return seen;
}

function errorResponse(status: number, type: string): Response {
	return new Response(
		JSON.stringify({ type: "error", error: { type, message: type } }),
		{ status, headers: { "content-type": "application/json" } },
	);
}

function send(ctx: ProxyContext): Promise<Response> {
	return handleProxy(
		new Request("http://localhost/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: MODEL,
				max_tokens: 16,
				messages: [{ role: "user", content: "hello" }],
			}),
		}),
		new URL("http://localhost/v1/messages"),
		ctx,
	);
}

describe("pool exhaustion returns the requested model's error (SB23-10878)", () => {
	let collector: ReturnType<typeof spyOn> | null = null;
	let refusalCollector: ReturnType<typeof spyOn> | null = null;
	let handleStart = mock((_message: { responseStatus: number }) => {});
	let handleEnd = mock((_message: { error?: string }) => Promise.resolve());
	beforeEach(() => {
		handleStart = mock((_message: { responseStatus: number }) => {});
		handleEnd = mock((_message: { error?: string }) => Promise.resolve());
		const fake = {
			handleStart,
			handleChunk: mock(() => {}),
			handleEnd,
		} as unknown as usageCollectorModule.UsageCollector;
		collector = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue(fake);
		// returnRefusal reads the collector through this accessor.
		refusalCollector = spyOn(
			usageCollectorModule,
			"tryGetUsageCollector",
		).mockReturnValue(fake);
	});

	afterEach(() => {
		collector?.mockRestore();
		refusalCollector?.mockRestore();
		fetchSlot.fetch = originalFetch;
		usageCache.clear();
		clearFamilyExhaustionCache();
		resetRateLimitProbeGatesForTests();
	});

	it("six windowless 429s then META's 402: the client gets the 429", async () => {
		const ctx = makeContext([...anthropicAccounts(), metaAccount()]);
		const calls = installFetch(() => windowless429(), metaBilling402);

		const response = await send(ctx);
		const body = (await response.json()) as {
			type: string;
			error: { type: string; message: string };
		};

		expect(calls.hosts).toEqual([...Array(6).fill("anthropic"), "meta"]);
		expect(calls.metaModels).toEqual([META_MODEL]);
		expect(calls.unknown).toEqual([]);
		expect(response.status).toBe(429);
		expect(response.headers.get("x-should-retry")).toBe("true");
		expect(body.type).toBe("error");
		expect(body.error.type).toBe("rate_limit_error");
		expect(body.error.message).toBe(
			`Every account that serves ${MODEL} refused this request; the last answered 429 (anthropic). ` +
				`A meta account that maps the request to ${META_MODEL} answered 402, ` +
				"which is not forwarded because it is not about the requested model.",
		);
		// META's attempt keeps its audit row.
		const saveRequest = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		const metaRows = saveRequest.mock.calls.filter(
			(args) => args[3] === "meta-META",
		);
		expect(metaRows.map((args) => [args[4], args[6]])).toEqual([
			[402, "foreign_model_error"],
		]);
	});

	it("META's 402 mid-pool after a native failure fails over to the next account", async () => {
		const [first, ...rest] = anthropicAccounts();
		const ctx = makeContext([first, metaAccount(1), ...rest]);
		const calls = installFetch(
			(index) => (index === 0 ? windowless429() : message(MODEL)),
			metaBilling402,
		);

		const response = await send(ctx);

		expect(calls.hosts).toEqual(["anthropic", "meta", "anthropic"]);
		expect(response.status).toBe(200);
	});

	it("META's 402 with no native failure before it is still forwarded", async () => {
		const ctx = makeContext([metaAccount(0), ...anthropicAccounts()]);
		const calls = installFetch(() => message(MODEL), metaBilling402);

		const response = await send(ctx);

		expect(calls.hosts).toEqual(["meta"]);
		expect(response.status).toBe(402);
	});

	it("six windowless 429s with no foreign answer still end in the all-accounts-failed error", async () => {
		const ctx = makeContext(anthropicAccounts());
		const calls = installFetch(() => windowless429(), metaBilling402);

		await expect(send(ctx)).rejects.toThrow("All accounts failed");
		expect(calls.hosts).toEqual(Array(6).fill("anthropic"));
	});

	it("a META 200 after native failures still serves the request", async () => {
		const ctx = makeContext([...anthropicAccounts(), metaAccount()]);
		const calls = installFetch(
			() => windowless429(),
			() => message(META_MODEL),
		);

		const response = await send(ctx);

		expect(calls.hosts).toEqual([...Array(6).fill("anthropic"), "meta"]);
		expect(response.status).toBe(200);
	});

	it("a model-fallback answer is labelled with the model that fetch sent: foreign 402 fails over", async () => {
		const native = makeAccount({ id: "anthropic-X", name: "X", priority: 0 });
		const mapped = makeAccount({
			id: "anthropic-A",
			name: "A",
			priority: 1,
			model_mappings: JSON.stringify({ haiku: [MODEL, "claude-sonnet-9"] }),
		});
		const ctx = makeContext([native, mapped]);
		const seen = installModelFetch(
			[windowless429, windowless429, () => errorResponse(402, "billing_error")],
			metaBilling402,
		);

		const response = await send(ctx);

		expect(seen).toEqual([
			`anthropic:${MODEL}`,
			`anthropic:${MODEL}`,
			"anthropic:claude-sonnet-9",
		]);
		expect(response.status).toBe(429);
	});

	it("a model-fallback answer on the requested model is native: its 413 reaches the client", async () => {
		const native = makeAccount({ id: "anthropic-X", name: "X", priority: 0 });
		const mapped = makeAccount({
			id: "anthropic-A",
			name: "A",
			priority: 1,
			model_mappings: JSON.stringify({ haiku: ["claude-haiku-4-5", MODEL] }),
		});
		const ctx = makeContext([native, mapped]);
		const seen = installModelFetch(
			[
				windowless429,
				windowless429,
				() => errorResponse(413, "request_too_large"),
			],
			metaBilling402,
		);

		const response = await send(ctx);

		expect(seen).toEqual([
			`anthropic:${MODEL}`,
			"anthropic:claude-haiku-4-5",
			`anthropic:${MODEL}`,
		]);
		expect(response.status).toBe(413);
	});

	it("META's model-not-found 404 after a native failure fails over too", async () => {
		const ctx = makeContext([
			makeAccount({ id: "anthropic-X", name: "X", priority: 0 }),
			metaAccount(1),
		]);
		const seen = installModelFetch([windowless429], () =>
			errorResponse(404, "not_found_error"),
		);

		const response = await send(ctx);

		expect(seen).toEqual([`anthropic:${MODEL}`, `meta:${META_MODEL}`]);
		expect(response.status).toBe(429);
	});

	it("a combo with session fallback off answers the native 429, not the combo-disabled error", async () => {
		const accounts = [...anthropicAccounts(), metaAccount()];
		const ctx = makeContext(
			accounts,
			makeCombo(accounts.map((account) => account.id)),
		);
		const calls = installFetch(() => windowless429(), metaBilling402);

		const response = await send(ctx);

		expect(calls.hosts).toEqual([...Array(6).fill("anthropic"), "meta"]);
		expect(response.status).toBe(429);
		const body = (await response.json()) as { error: { type: string } };
		expect(body.error.type).toBe("rate_limit_error");
		// Still recorded as the combo refusal, under the status the client got.
		expect(handleStart.mock.calls.map(([m]) => m.responseStatus)).toEqual([
			429,
		]);
		expect(handleEnd.mock.calls.map(([m]) => m.error)).toEqual([
			"combo_session_fallback_disabled",
		]);
	});
});
