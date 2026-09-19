import { OAuthError } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type {
	OAuthProvider,
	OAuthProviderConfig,
	PKCEChallenge,
	TokenResult,
} from "../../types";

const oauthLog = new Logger("AnthropicOAuthProvider");

export class AnthropicOAuthProvider implements OAuthProvider {
	/**
	 * Generate a secure random state string for CSRF protection
	 * This is separate from the PKCE verifier and should never contain secrets
	 */
	private generateSecureRandomState(): string {
		const array = new Uint8Array(32);
		crypto.getRandomValues(array);
		return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join(
			"",
		);
	}

	/**
	 * `mode` is `string` rather than the two literals this method branches on,
	 * because that is what the `OAuthProvider` interface declares
	 * (`packages/providers/src/types.ts:163`) and what `OAuthProviderConfig.mode`
	 * receives (`:159`).
	 *
	 * Every typed caller is narrower than that, so none of them is the reason:
	 * `BeginOptions.mode` and `OAuthSession.mode` are both
	 * `"console" | "claude-oauth"`. The reason is the storage underneath them.
	 * `oauth_sessions.mode` is an unconstrained `TEXT NOT NULL`
	 * (`packages/database/src/migrations.ts:240`) and the repository reads it
	 * into that narrow type without checking, so a row written by an older build
	 * and holding a legacy value such as `"max"` reaches this method at runtime
	 * while every signature between here and the database says it cannot.
	 *
	 * Any value other than `"console"` selects the claude.ai base URL, which is
	 * the behaviour `handlers/__tests__/oauth-features.test.ts:224` pins for
	 * `"max"`. Do not re-narrow this parameter to match `BeginOptions`: the
	 * callers would all still compile and the legacy row would still arrive.
	 */
	getOAuthConfig(mode: string = "console"): OAuthProviderConfig {
		const baseUrl =
			mode === "console"
				? "https://console.anthropic.com"
				: "https://claude.ai";

		return {
			authorizeUrl: `${baseUrl}/oauth/authorize`,
			tokenUrl: "https://platform.claude.com/v1/oauth/token",
			clientId: "", // Will be passed from config
			scopes: [
				"org:create_api_key",
				"user:profile",
				"user:inference",
				"user:sessions:claude_code",
				"user:mcp_servers",
				"user:file_upload",
			],
			redirectUri: "https://platform.claude.com/oauth/code/callback",
			mode,
		};
	}

	generateAuthUrl(config: OAuthProviderConfig, pkce: PKCEChallenge): string {
		// Generate secure random state for CSRF protection (separate from PKCE verifier)
		const state = this.generateSecureRandomState();

		// Use direct OAuth authorize URL for both modes
		const url = new URL(config.authorizeUrl);
		url.searchParams.set("code", "true");
		url.searchParams.set("client_id", config.clientId);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("redirect_uri", config.redirectUri);
		url.searchParams.set("scope", config.scopes.join(" "));
		url.searchParams.set("code_challenge", pkce.challenge);
		url.searchParams.set("code_challenge_method", "S256");
		url.searchParams.set("state", state);
		return url.toString();
	}

	async exchangeCode(
		code: string,
		verifier: string,
		config: OAuthProviderConfig,
	): Promise<TokenResult> {
		// The authorization code from Anthropic contains a state parameter: code#state
		const splits = code.split("#");
		const actualCode = splits[0];
		const state = splits[1];

		oauthLog.debug(`OAuth exchangeCode called:`, {
			hasState: !!state,
			clientId: config.clientId,
			mode: config.mode,
		});

		const requestBody = {
			code: actualCode,
			state: state,
			grant_type: "authorization_code",
			client_id: config.clientId,
			redirect_uri: config.redirectUri,
			code_verifier: verifier,
		};

		// Don't log sensitive request body in production
		if (process.env.NODE_ENV === "development") {
			oauthLog.debug("Exchange request body:", {
				grant_type: requestBody.grant_type,
				client_id: requestBody.client_id,
				redirect_uri: requestBody.redirect_uri,
				// Omit code and code_verifier from logs
			});
		}

		const response = await fetch(config.tokenUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(requestBody),
		});

		oauthLog.debug(
			`Exchange response status: ${response.status} ${response.statusText}`,
		);

		if (!response.ok) {
			let errorDetails: {
				error?: string | { message?: string };
				error_description?: string;
			} | null = null;
			try {
				errorDetails = await response.json();
			} catch {
				// Failed to parse error response
			}

			// Handle error being either a string or an object with a message
			let errorStr: string;
			if (typeof errorDetails?.error === "object" && errorDetails.error) {
				errorStr =
					errorDetails.error.message ||
					JSON.stringify(errorDetails.error) ||
					"Unknown error";
			} else {
				errorStr = errorDetails?.error || "";
			}

			const errorMessage =
				errorDetails?.error_description ||
				errorStr ||
				response.statusText ||
				"OAuth token exchange failed";

			throw new OAuthError(
				errorMessage,
				"anthropic",
				typeof errorDetails?.error === "string"
					? errorDetails.error
					: undefined,
			);
		}

		const json = (await response.json()) as {
			refresh_token: string;
			access_token: string;
			expires_in: number;
		};

		console.log("[AnthropicOAuth] exchange response:", {
			expiresIn: json.expires_in,
			hasRefreshToken: !!json.refresh_token,
			responseKeys: Object.keys(json),
		});

		return {
			refreshToken: json.refresh_token,
			accessToken: json.access_token,
			expiresAt: Date.now() + json.expires_in * 1000,
		};
	}
}
