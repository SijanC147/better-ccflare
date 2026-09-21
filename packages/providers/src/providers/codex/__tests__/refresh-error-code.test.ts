import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { makeAccount as baseAccount } from "../../../testing/account-fixture";
import { CodexProvider } from "../provider";

// Only the fields this file's assertions depend on are named here; the rest
// come from the shared fixture. `expires_at: 1` is the point of the file: it
// puts the account past expiry so every case exercises the refresh path.
function codexAccount(overrides: Partial<Account> = {}): Account {
	return baseAccount({
		id: "codex-1",
		name: "codex-test",
		provider: "codex",
		refresh_token: "refresh-token",
		access_token: "expired-access-token",
		expires_at: 1,
		...overrides,
	});
}

describe("CodexProvider.refreshToken preserves the OAuth error code", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("keeps invalid_grant when only error_description is human-readable", async () => {
		const provider = new CodexProvider();
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						error: "invalid_grant",
						error_description: "The refresh token has expired.",
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				),
		) as unknown as typeof fetch;

		let thrown: Error | null = null;
		try {
			await provider.refreshToken(codexAccount(), "test-client");
		} catch (error) {
			thrown = error as Error;
		}

		expect(thrown?.message).toContain("invalid_grant");
	});

	it("carries the refresh_token_reused marker verbatim on token rotation reuse", async () => {
		const provider = new CodexProvider();
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ error: "refresh_token_reused" }), {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;

		let thrown: Error | null = null;
		try {
			await provider.refreshToken(codexAccount(), "test-client");
		} catch (error) {
			thrown = error as Error;
		}

		// The reused case must keep the machine marker so detection fires; the
		// friendly re-auth hint alone ("token was reused") would not match.
		expect(thrown?.message).toContain("refresh_token_reused");
	});
});
