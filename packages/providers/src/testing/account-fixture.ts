import type { Account } from "@better-ccflare/types";

/**
 * Build a complete `Account` for tests.
 *
 * Every field the `Account` interface requires is given a default here, so a
 * caller supplies only the fields its assertions care about. That is the point:
 * the fixtures this replaces each listed a subset of the interface and drifted
 * out of date independently, so adding a required field to `Account` broke
 * seventeen test files at once (SB23-2441).
 *
 * The defaults are deliberately inert. Nullable fields default to `null`,
 * booleans to `false`, counters to `0`, so a test that does not name a field is
 * not silently relying on a value some other test chose.
 *
 * There is no `as Account` here on purpose. The return type is checked against
 * the interface, so the next field added to `Account` fails this one file at
 * compile time instead of reopening the fixtures.
 */
export function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "test-account",
		name: "test-account",
		provider: "test",
		api_key: null,
		refresh_token: null,
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		requires_reauth: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		request_transformer: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		last_manual_reauth_at: null,
		consecutive_rate_limits: 0,
		renewal_day: null,
		...overrides,
	};
}
