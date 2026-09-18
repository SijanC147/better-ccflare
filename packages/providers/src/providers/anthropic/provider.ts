import {
	BUFFER_SIZES,
	mapModelName,
	validateEndpointUrl,
} from "@better-ccflare/core";
import { sanitizeProxyHeaders } from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import { BaseProvider } from "../../base";
import type { RateLimitInfo, TokenRefreshResult } from "../../types";
import { transformRequestBodyModel } from "../../utils/model-mapping";
import { drainReader } from "../../utils/stream-drain";

// The API version Anthropic requires on every request. Same value
// model-catalog.ts and auto-refresh-scheduler.ts pin for their own fetches.
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * How many pages beyond the first `GET /v1/models` will be followed when
 * stitching the listing for a client that cannot page itself. Eleven models
 * come back in one page today, so ten further pages is far more headroom than
 * the catalogue needs; the number exists to bound an upstream that answers
 * `has_more: true` forever, not to be tuned.
 */
const MODELS_MAX_EXTRA_PAGES = 10;

/** Per-page abort for the same loop. */
const MODELS_PAGE_TIMEOUT_MS = 10_000;

/** One page of Anthropic's `GET /v1/models`. */
type AnthropicModelSummary = {
	id?: string;
	display_name?: string;
	created_at?: string;
};

type AnthropicModelsPage = {
	data?: AnthropicModelSummary[];
	has_more?: boolean;
	first_id?: string | null;
	last_id?: string | null;
};

/**
 * One Anthropic model summary rendered as one OpenAI model object.
 *
 * Shared by the listing (`GET /v1/models`) and the single-model lookup
 * (`GET /v1/models/{id}`) on purpose: they are the same per-entry contract,
 * and a translation that drifted between them would put two different shapes
 * of the same model in front of one client. One function means one mutation
 * kills both.
 *
 * `display_name` and `created_at` survive as extra fields because
 * `ingestModelsListing` in `packages/proxy/src/model-catalog.ts` reads them
 * off the proxied listing body, and OpenAI clients ignore keys they do not
 * know. An unparseable or absent `created_at` becomes 0 rather than NaN,
 * which would serialize as `null` and break clients that expect a number.
 */
function toOpenAIModelEntry(model: AnthropicModelSummary): {
	id: string;
	object: string;
	created: number;
	owned_by: string;
	display_name: string;
	created_at: string | null;
} {
	const createdMs = model.created_at
		? Date.parse(model.created_at)
		: Number.NaN;
	return {
		id: model.id as string,
		object: "model",
		created: Number.isNaN(createdMs) ? 0 : Math.floor(createdMs / 1000),
		owned_by: "anthropic",
		display_name: model.display_name ?? (model.id as string),
		created_at: model.created_at ?? null,
	};
}

// Hard rate limit statuses that should block account usage
const HARD_LIMIT_STATUSES = new Set([
	"rate_limited",
	"blocked",
	"queueing_hard",
	"payment_required",
]);

// Maximum allowed reset time: 24 hours from now.
// Prevents a pathological Retry-After value from keeping an account
// cooled down for days (or effectively forever with "Infinity").
const MAX_RESET_MS = 24 * 60 * 60 * 1000;

/**
 * Clamp a candidate reset-time epoch-ms value.
 *
 * Returns:
 *   - `undefined` if the input is NaN, not finite, or <= now (already in the past).
 *   - `Math.min(input, now + MAX_RESET_MS)` otherwise — capped at 24 h from now.
 */
function clampResetTime(candidateMs: number, now: number): number | undefined {
	if (!Number.isFinite(candidateMs) || candidateMs <= now) {
		return undefined;
	}
	return Math.min(candidateMs, now + MAX_RESET_MS);
}

// Soft warning statuses that should not block account usage
const _SOFT_WARNING_STATUSES = new Set(["allowed_warning", "queueing_soft"]);

/**
 * Anthropic returns this header value (via
 * `anthropic-ratelimit-unified-overage-disabled-reason`) when credits/overage
 * are depleted for a specific model or beta (e.g. context-1m). This is
 * model/beta-scoped, NOT account-wide — other models on the same account still
 * succeed — so the account must NOT be benched; the proxy fails over per-request.
 */
export const OUT_OF_CREDITS_REASON = "out_of_credits";

/**
 * Returns true iff the response carries the exact (case-sensitive)
 * `anthropic-ratelimit-unified-overage-disabled-reason: out_of_credits` header.
 * This signals model/beta-scoped credit depletion, not an account-wide block —
 * callers should fail over without benching the account.
 */
export function isAnthropicOutOfCredits(response: Response): boolean {
	return (
		response.headers.get(
			"anthropic-ratelimit-unified-overage-disabled-reason",
		) === OUT_OF_CREDITS_REASON
	);
}

/**
 * Anthropic returns this 400 `invalid_request_error` when a Claude OAuth
 * account's "extra usage" credit balance is depleted for third-party-app
 * traffic (e.g. OpenCode), as opposed to the plan's included quota. This is
 * a billing-policy rejection, not a rate limit — callers must NOT bench the
 * account, since some models/routes may still succeed; this exists purely
 * for labeling in request history / the dashboard.
 */
export const EXTRA_USAGE_EXHAUSTED_REASON = "extra_usage_exhausted";

export async function isAnthropicExtraUsageExhausted(
	response: Response,
): Promise<boolean> {
	if (response.status !== 400) return false;
	try {
		// Clone only after the content-type gate. Cloning first teed the body
		// and then returned early for every non-JSON 400 (gateway error pages,
		// plain-text upstream errors), leaving that copy unread forever — the
		// tee then keeps buffering for whoever consumes the original. See #356.
		const contentType = response.headers.get("content-type");
		if (!contentType?.includes("application/json")) return false;
		const json = await response.clone().json();
		return (
			json?.error?.type === "invalid_request_error" &&
			typeof json?.error?.message === "string" &&
			json.error.message.toLowerCase().includes("extra usage")
		);
	} catch {
		return false;
	}
}

/**
 * Anthropic returns 403 `permission_error` when the account's ORGANIZATION —
 * not the account's quota — forbids the request: OAuth disabled org-wide,
 * Claude Code subscription access turned off by an admin, and the like. The
 * account cannot serve ANY request until someone changes a setting upstream,
 * so it must be benched and the request failed over, exactly like an exhausted
 * quota window. Distinct from `out_of_credits` / `extra_usage_exhausted`,
 * which are scoped to a model or surface and leave the account routable.
 */
export const ORG_PERMISSION_DENIED_REASON = "org_permission_denied";

/**
 * The only `details.error_code` value observed alongside `permission_error`
 * for this condition. Not every observed body carries `details` at all (see
 * below), so this is an allow-when-present check, not a required match.
 */
const ORG_PERMISSION_DENIED_ERROR_CODE = "oauth_not_allowed_for_organization";

/**
 * Returns true iff the response is a 403 carrying Anthropic's
 * `error.type: "permission_error"`, narrowed to the org-block condition this
 * predicate exists to detect (see below) rather than every possible cause of
 * a `permission_error` 403.
 *
 * KEYED ON `error.type`, DELIBERATELY NOT ON THE MESSAGE. Two different
 * wordings of the same condition were observed on one organization within the
 * same hour — `/api/oauth/usage` answers "OAuth authentication is currently
 * not allowed for this organization." (with
 * `details.error_code: oauth_not_allowed_for_organization`), while
 * `/v1/messages` tells Claude Code "Your organization has disabled Claude
 * subscription access for Claude Code…" with no `details` object at all.
 * Anthropic owns that copy and can reword it without notice; `error.type` is
 * the machine-readable field and the only part stable enough to route on.
 * `x-should-retry: false` accompanied every observed instance and
 * corroborates the classification, but is not required here: gating on it
 * would fail closed — straight back to forwarding the 403 to the client —
 * the moment a variant omits it.
 *
 * `details.error_code` is checked the same way: REQUIRED to equal
 * `oauth_not_allowed_for_organization` when present, but not required to be
 * present at all, since the Claude-Code-specific wording never included a
 * `details` object in the observed sample. This means a `permission_error`
 * 403 that carries a *different*, unrecognized `error_code` — e.g. a
 * scoped/per-request permission rejection Anthropic hasn't been observed to
 * send yet — does NOT match and falls through to the pre-existing
 * pass-through behavior instead of benching the account on an unproven
 * cause. Only a body with no error_code, or the one known code, benches.
 *
 * Narrow by construction in two more ways:
 *   - A non-JSON 403 (edge/WAF block page) does NOT match. Such a block
 *     usually rejects every account identically, and benching the pool one
 *     account per attempt is the pool-drain failure mode of issue #301.
 *   - The content-type gate runs BEFORE `.clone()`. Cloning first tees the
 *     body and then returns early for every non-JSON 403, stranding that copy
 *     unread while the tee keeps buffering for whoever consumes the original
 *     (issue #356) — same ordering as `isAnthropicExtraUsageExhausted` above.
 */
export async function isAnthropicOrgPermissionDenied(
	response: Response,
): Promise<boolean> {
	if (response.status !== 403) return false;
	try {
		const contentType = response.headers.get("content-type");
		if (!contentType?.includes("application/json")) return false;
		const json = await response.clone().json();
		if (json?.error?.type !== "permission_error") return false;
		const errorCode = json?.error?.details?.error_code;
		return (
			errorCode === undefined || errorCode === ORG_PERMISSION_DENIED_ERROR_CODE
		);
	} catch {
		return false;
	}
}

const log = new Logger("AnthropicProvider");

export class AnthropicProvider extends BaseProvider {
	name = "anthropic";

	canHandle(_path: string): boolean {
		// Handle all paths for now since this is Anthropic-specific
		return true;
	}

	async refreshToken(
		account: Account,
		clientId: string,
	): Promise<TokenRefreshResult> {
		// Debug: Log account classification
		log.debug(`Account classification for ${account.name}:`, {
			hasApiKey: !!account.api_key,
			hasAccessToken: !!account.access_token,
			hasRefreshToken: !!account.refresh_token,
			provider: account.provider,
		});

		// Determine account type based on token presence (same logic as re-authentication)
		const isConsoleMode = !!account.api_key;
		const accountType = isConsoleMode ? "Console (API key)" : "CLI (OAuth)";
		log.debug(`Account type: ${accountType}`);

		if (isConsoleMode) {
			// For console API key accounts, return the API key directly
			if (!account.api_key) {
				throw new Error(
					`No API key available for console account ${account.name}`,
				);
			}

			log.info(`Using API key for console account ${account.name}`);

			return {
				accessToken: account.api_key,
				expiresAt: Date.now() + 24 * 60 * 60 * 1000, // API keys don't expire, but set a reasonable time
				refreshToken: "", // Empty string prevents DB update for console mode
			};
		}

		// For OAuth accounts (claude-oauth), use the OAuth refresh flow
		if (!account.refresh_token) {
			throw new Error(`No refresh token available for account ${account.name}`);
		}

		log.info(
			`Refreshing OAuth token for account ${account.name} with client ID: ${clientId}`,
		);

		// Debug: Log the refresh attempt details
		log.debug(`Token refresh attempt for ${account.name}:`, {
			refreshTokenPreview: account.refresh_token
				? `${account.refresh_token.substring(0, 30)}...`
				: "null/undefined",
			clientId,
			refreshTokenLength: account.refresh_token?.length || 0,
		});

		const requestBody = {
			grant_type: "refresh_token",
			refresh_token: account.refresh_token,
			client_id: clientId,
		};

		log.debug("Request body:", requestBody);

		const response = await fetch("https://platform.claude.com/v1/oauth/token", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(requestBody),
		});

		log.debug(`Response status: ${response.status} ${response.statusText}`, {
			headers: Object.fromEntries(response.headers.entries()),
		});

		if (!response.ok) {
			let errorMessage = response.statusText;
			let errorData: unknown = null;
			try {
				const responseText = await response.text();
				log.debug("Error response body:", responseText);
				errorData = JSON.parse(responseText);
				const errorObj = errorData as {
					error?: string;
					error_description?: string;
					message?: string;
				};
				// Preserve the machine-readable RFC-6749 error code (e.g.
				// "invalid_grant") ahead of any human-readable description. When only
				// error_description is surfaced the code is discarded, and the
				// token-manager's requires_reauth detection — which keys on that code —
				// silently misses a dead refresh token (the exact 43h-undetected
				// incident this feature exists for).
				errorMessage =
					[errorObj.error, errorObj.error_description || errorObj.message]
						.filter(Boolean)
						.join(": ") || errorMessage;

				// Log specific OAuth authentication errors
				if (response.status === 401 && typeof errorMessage === "string") {
					if (
						errorMessage.includes(
							"OAuth authentication is currently not supported",
						)
					) {
						log.error(
							`OAuth authentication not supported for ${account.name} - the refresh token may be revoked or invalid. Account may need re-authentication.`,
						);
					} else if (
						errorMessage.includes("invalid_grant") ||
						errorMessage.includes("invalid_refresh_token")
					) {
						log.error(
							`Refresh token invalid or expired for ${account.name} - account needs re-authentication`,
						);
					}
				}
			} catch {
				// If we can't parse the error response, use the status text
				log.error(
					`Failed to parse token refresh error response for ${account.name}: ${response.statusText}`,
				);
			}
			log.error(
				`Token refresh failed for ${account.name}: Status ${response.status}, Error: ${errorMessage}`,
				errorData,
			);
			throw new Error(
				`Failed to refresh token for account ${account.name}: ${errorMessage}`,
			);
		}

		const json = (await response.json()) as {
			access_token: string;
			expires_in: number;
			refresh_token?: string;
		};

		log.debug(`token response for ${account.name}:`, {
			expiresIn: json.expires_in,
			hasRefreshToken: !!json.refresh_token,
			responseKeys: Object.keys(json),
		});
		// Ensure we always return a refresh token
		const refreshToken = json.refresh_token || account.refresh_token;

		if (!json.refresh_token) {
			log.warn(
				`Anthropic refresh endpoint did not return a refresh_token for ${account.name} - continuing with previous one`,
			);
		} else {
			log.info(
				`Token refresh successful for ${account.name}, new refresh token provided`,
			);
		}

		return {
			accessToken: json.access_token,
			expiresAt: Date.now() + json.expires_in * 1000,
			refreshToken: refreshToken,
		};
	}

	async transformRequestBody(
		request: Request,
		account?: Account,
	): Promise<Request> {
		return transformRequestBodyModel(request, account, (model, acc) => {
			if (acc) {
				return mapModelName(model, acc);
			}
			return model;
		});
	}

	buildUrl(path: string, query: string, account?: Account): string {
		const defaultEndpoint = "https://api.anthropic.com";

		if (account?.custom_endpoint) {
			try {
				// Validate and sanitize the custom endpoint
				const validatedEndpoint = validateEndpointUrl(
					account.custom_endpoint,
					"custom_endpoint",
				);
				return `${validatedEndpoint}${path}${query}`;
			} catch (error) {
				log.warn(
					`Invalid custom endpoint for account ${account.name}: ${account.custom_endpoint}. Using default.`,
					error,
				);
				return `${defaultEndpoint}${path}${query}`;
			}
		}

		return `${defaultEndpoint}${path}${query}`;
	}

	prepareHeaders(
		headers: Headers,
		accessToken?: string,
		apiKey?: string,
	): Headers {
		const newHeaders = new Headers(headers);

		// SECURITY: Remove client's authorization headers when we have provider credentials
		// to prevent credential leakage. If no credentials provided (passthrough mode),
		// preserve client's authorization for direct API access.
		// Use explicit undefined checks to handle empty strings correctly.
		if (accessToken !== undefined || apiKey !== undefined) {
			newHeaders.delete("authorization");
			newHeaders.delete("x-api-key");
		}

		// Set authentication header
		if (accessToken) {
			newHeaders.set("Authorization", `Bearer ${accessToken}`);
			// Add required OAuth beta header for OAuth accounts
			// This is needed when clients (like Claude Code with API key auth) don't include it
			const betaHeader = newHeaders.get("anthropic-beta");
			if (betaHeader) {
				// Header exists, check if oauth value is already present
				if (!betaHeader.includes("oauth-2025-04-20")) {
					newHeaders.set("anthropic-beta", `${betaHeader},oauth-2025-04-20`);
				}
			} else {
				// Header doesn't exist, create it
				newHeaders.set("anthropic-beta", "oauth-2025-04-20");
			}
		} else if (apiKey) {
			newHeaders.set("x-api-key", apiKey);
		}

		// Remove host header
		newHeaders.delete("host");

		// Anthropic rejects every request without anthropic-version, including
		// GET /v1/models, with HTTP 400 "anthropic-version: header is required".
		// Native SDK clients always send it; an OpenAI-compatible client never
		// does, so supply the same version model-catalog.ts and
		// auto-refresh-scheduler.ts already pin. A client that sent its own
		// version keeps it.
		if (!newHeaders.has("anthropic-version")) {
			newHeaders.set("anthropic-version", ANTHROPIC_VERSION);
		}

		return newHeaders;
	}

	parseRateLimit(response: Response): RateLimitInfo {
		// Check for unified rate limit headers
		const statusHeader = response.headers.get(
			"anthropic-ratelimit-unified-status",
		);
		const resetHeader = response.headers.get(
			"anthropic-ratelimit-unified-reset",
		);
		const remainingHeader = response.headers.get(
			"anthropic-ratelimit-unified-remaining",
		);

		if (statusHeader || resetHeader) {
			const now = Date.now();
			const remaining = remainingHeader ? Number(remainingHeader) : undefined;

			// Only mark as rate limited for hard limit statuses, 429, or 529 (overloaded).
			// A 529 is an overload even when the unified-status header says "allowed" —
			// the overload condition takes precedence over the header value.
			const isRateLimited =
				HARD_LIMIT_STATUSES.has(statusHeader || "") ||
				response.status === 429 ||
				response.status === 529;

			// For 529 with a unified-reset header: clamp the reset time.
			// If clamping rejects the value (past/NaN/infinite), fall through
			// to the 529 block below to try Retry-After and x-ratelimit-reset.
			if (response.status === 529 && resetHeader) {
				const clamped = clampResetTime(Number(resetHeader) * 1000, now);
				if (clamped === undefined) {
					// Fall through to the 529 block for better header candidates.
					// (handled below)
				} else {
					return {
						isRateLimited,
						resetTime: clamped,
						statusHeader: statusHeader || undefined,
						remaining,
					};
				}
			} else if (response.status !== 529) {
				// Non-529: use resetHeader as-is (existing behaviour for 429 / 200).
				const resetTime = resetHeader ? Number(resetHeader) * 1000 : undefined;
				return {
					isRateLimited,
					resetTime,
					statusHeader: statusHeader || undefined,
					remaining,
				};
			}
			// 529 with no usable resetHeader — fall through to 529 block below.
		}

		// Handle 529 (overloaded_error) — try Retry-After, then x-ratelimit-reset
		if (response.status === 529) {
			const now = Date.now();
			const retryAfterHeader = response.headers.get("retry-after");
			if (retryAfterHeader) {
				const parsed = Number(retryAfterHeader);
				if (Number.isFinite(parsed) && parsed > 0) {
					// Positive finite number → treat as delta-seconds
					const clamped = clampResetTime(now + parsed * 1000, now);
					if (clamped !== undefined) {
						return {
							isRateLimited: true,
							resetTime: clamped,
							statusHeader: undefined,
							remaining: undefined,
						};
					}
				}
				// Try HTTP-date format
				const dateMs = new Date(retryAfterHeader).getTime();
				const clampedDate = clampResetTime(dateMs, now);
				if (clampedDate !== undefined) {
					return {
						isRateLimited: true,
						resetTime: clampedDate,
						statusHeader: undefined,
						remaining: undefined,
					};
				}
			}

			// Fall back to x-ratelimit-reset (unix epoch seconds → ms)
			const rateLimitReset = response.headers.get("x-ratelimit-reset");
			if (rateLimitReset) {
				const resetMs = parseInt(rateLimitReset, 10) * 1000;
				const clamped = clampResetTime(resetMs, now);
				if (clamped !== undefined) {
					return {
						isRateLimited: true,
						resetTime: clamped,
						statusHeader: undefined,
						remaining: undefined,
					};
				}
			}

			// No usable reset time — return without resetTime so the no-reset cooldown path fires
			return {
				isRateLimited: true,
				resetTime: undefined,
				statusHeader: undefined,
				remaining: undefined,
			};
		}

		// Fall back to 429 status with x-ratelimit-reset header
		if (response.status !== 429) {
			return { isRateLimited: false };
		}

		const now429 = Date.now();
		const rateLimitReset = response.headers.get("x-ratelimit-reset");
		// Apply clampResetTime to both the upstream-provided reset header and the
		// no-header default, matching the 529 path. Header values that are invalid,
		// in the past, or beyond the 24h cap fall back to the 60s default.
		const DEFAULT_429_COOLDOWN_MS = 60_000;
		const parsedReset = rateLimitReset
			? clampResetTime(parseInt(rateLimitReset, 10) * 1000, now429)
			: undefined;
		const resetTime = parsedReset ?? now429 + DEFAULT_429_COOLDOWN_MS;

		return {
			isRateLimited: true,
			resetTime,
		};
	}

	/**
	 * Transform Anthropic SSE stream to add OpenAI-compatible finish_reason.
	 * Anthropic uses stop_reason on message_delta events; OpenAI clients expect
	 * finish_reason. This maps between them without breaking native Anthropic clients
	 * since both fields are present in the transformed output.
	 */
	private async transformStreamToOpenAIFormat(
		response: Response,
		requestHeaders?: Headers,
	): Promise<Response> {
		// Native Anthropic SDK clients always send anthropic-version; skip transform for them
		if (requestHeaders?.has("anthropic-version")) {
			return response;
		}

		const contentType = response.headers.get("content-type");

		// Only transform streaming responses
		if (!contentType?.includes("text/event-stream")) {
			return response;
		}

		const reader = response.body?.getReader();
		if (!reader) return response;

		const encoder = new TextEncoder();
		const decoder = new TextDecoder();

		// stopReasonMap defined once outside the loop for performance
		const stopReasonMap: Record<string, string> = {
			end_turn: "stop",
			max_tokens: "length",
			stop_sequence: "stop",
			tool_use: "tool_calls",
		};

		const stream = new ReadableStream({
			async start(controller) {
				// lineBuffer carries incomplete lines across chunk boundaries
				let lineBuffer = "";
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) {
							// Flush any remaining buffered content
							if (lineBuffer) {
								controller.enqueue(encoder.encode(lineBuffer));
							}
							break;
						}

						// Accumulate decoded bytes into lineBuffer, split on newlines
						lineBuffer += decoder.decode(value, { stream: true });
						const lines = lineBuffer.split("\n");
						// Last element may be an incomplete line — keep it in the buffer
						lineBuffer = lines.pop() ?? "";

						for (const line of lines) {
							// Pass through non-data lines (empty lines, event:, id:, comment:)
							// SSE allows both "data:" and "data: " prefixes
							if (!line.startsWith("data:")) {
								controller.enqueue(encoder.encode(`${line}\n`));
								continue;
							}

							const data = line.replace(/^data:\s?/, "");

							// Pass through [DONE] marker
							if (data === "[DONE]") {
								controller.enqueue(encoder.encode(`${line}\n`));
								continue;
							}

							try {
								const event = JSON.parse(data);

								// Map Anthropic stop_reason -> OpenAI finish_reason on message_delta
								if (
									event.type === "message_delta" &&
									event.delta?.stop_reason
								) {
									event.finish_reason =
										stopReasonMap[event.delta.stop_reason] ?? "stop";
								}

								controller.enqueue(
									encoder.encode(`data: ${JSON.stringify(event)}\n`),
								);
							} catch {
								// Non-JSON data line — pass through unchanged
								controller.enqueue(encoder.encode(`${line}\n`));
							}
						}
					}
				} catch (error) {
					controller.error(error);
				} finally {
					// Guard close() — stream may already be errored
					try {
						controller.close();
					} catch {
						// ignore: stream is already in errored state
					}
				}
			},
			cancel() {
				// reader.cancel() is a no-op on Bun and leaks the native buffer;
				// drain to `done` instead — see drainReader() above (#382).
				void drainReader(reader);
			},
		});

		return new Response(stream, {
			headers: response.headers,
			status: response.status,
			statusText: response.statusText,
		});
	}

	async processResponse(
		response: Response,
		_account: Account | null,
		requestHeaders?: Headers,
	): Promise<Response> {
		// Sanitize headers by removing hop-by-hop headers
		const headers = sanitizeProxyHeaders(response.headers);

		const sanitizedResponse = new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});

		// A model listing an OpenAI client asked for has to come back in the
		// OpenAI shape; a native Anthropic client keeps Anthropic's.
		const requestPath = response.headers.get("x-better-ccflare-request-path");
		const nativeClient = requestHeaders?.has("anthropic-version") === true;
		if (requestPath === "/v1/models" && !nativeClient) {
			return this.transformModelsListResponse(
				sanitizedResponse,
				_account,
				requestHeaders,
			);
		}

		// `GET /v1/models/{id}`. The exact match above runs first, so the
		// listing is never reached by this branch; a request path that only
		// starts with `/v1/models/` is a single-model lookup. Anthropic serves
		// the same endpoint, so this is a passthrough plus the same per-entry
		// translation the listing uses.
		//
		// This is a prefix test, not a shape test, so a deeper path such as
		// `/v1/models/x/y` also lands here. That is harmless: the body is
		// whatever the upstream returned for that path, and a non-model body
		// falls out of `transformSingleModelResponse` untranslated. Tighten
		// this to a single trailing segment only if Anthropic ever serves
		// something else below `/v1/models/`.
		//
		// `requestMeta.path` is `url.pathname`
		// (`packages/proxy/src/handlers/request-handler.ts`), so it carries no
		// query string and a URL-encoded id stays encoded, which still matches
		// this prefix.
		if (
			requestPath?.startsWith("/v1/models/") &&
			requestPath.length > "/v1/models/".length &&
			!nativeClient
		) {
			return this.transformSingleModelResponse(sanitizedResponse);
		}

		// Add OpenAI-compatible finish_reason alongside Anthropic's stop_reason
		return this.transformStreamToOpenAIFormat(
			sanitizedResponse,
			requestHeaders,
		);
	}

	/**
	 * Anthropic's `GET /v1/models/{id}` answer rendered in the OpenAI
	 * single-model shape: `{id, object: "model", created, owned_by}`.
	 *
	 * Served by proxying to Anthropic rather than by reading the local model
	 * catalog, and the choice is deliberate. The catalog's `source` can be
	 * `fallback`, meaning a bundled or on-disk list rather than anything the
	 * account was told (`packages/http-api/src/handlers/models.ts` documents
	 * why a catalogue is not an entitlement claim). Serving from it would let
	 * a miss 404 a model the account can really call, and a hit 200 a model
	 * the plan refuses. The passthrough is the live entitlement of the account
	 * that was actually routed to. It costs one upstream round trip per
	 * lookup, which a single-model lookup is not issued often enough to feel.
	 *
	 * An upstream error is translated into OpenAI's error envelope rather than
	 * passed through as Anthropic's, because a client that reached this
	 * endpoint without `anthropic-version` is an OpenAI client and cannot read
	 * the other shape. **The status code is preserved**: a 404 stays a 404, so
	 * an unknown or unentitled id surfaces as OpenAI's 404-with-`error`, never
	 * as an empty 200.
	 *
	 * Anything that is not a JSON body passes through untouched.
	 */
	private async transformSingleModelResponse(
		response: Response,
	): Promise<Response> {
		if (!response.headers.get("content-type")?.toLowerCase().includes("json")) {
			return response;
		}

		let body: AnthropicModelSummary & {
			error?: { type?: string; message?: string };
		};
		try {
			body = await response.clone().json();
		} catch (error) {
			log.warn("Could not parse the /v1/models/{id} body as JSON:", error);
			return response;
		}

		// `JSON.parse("null")` is a successful parse that yields null, and
		// optional chaining does not protect the base access: `body.error?.x`
		// still throws when `body` itself is null. A throw here does not
		// degrade to an untranslated body, it escapes `processResponse` into
		// the catch in `packages/proxy/src/handlers/proxy-operations.ts`,
		// which treats it as "this account failed" and moves to the next one.
		// One intermediary answering `null` would therefore walk the whole
		// account pool and report that every account failed.
		if (body === null || typeof body !== "object") {
			return response;
		}

		const headers = new Headers(response.headers);
		// Belt and braces. `sanitizeProxyHeaders` in
		// `packages/http-common/src/headers.ts` already dropped both of these
		// before `processResponse` built the response this reads, so neither
		// delete fires on the live path and a mutation removing either one
		// survives the suite. They stay because the reason they exist is real:
		// the body below is re-serialized to a different length after being
		// decoded, so an inherited content-length or content-encoding would
		// truncate it if this method were ever reached from a caller that did
		// not sanitize first.
		headers.delete("content-length");
		headers.delete("content-encoding");
		headers.set("content-type", "application/json");

		if (!response.ok) {
			// `type` and `code` are derived from ONE condition on purpose.
			// Keying them separately (status for one, the upstream error type
			// for the other) let them disagree: a 404 that is not Anthropic's
			// envelope, such as a CDN page or `{"message": "Not Found"}`,
			// produced `type: "api_error"` beside `code: "model_not_found"`.
			// That pair is contradictory to a client, which reads `api_error`
			// as a server fault worth retrying and `model_not_found` as its
			// own bad id. OpenAI's real 404 pairs `invalid_request_error`
			// with `model_not_found`.
			const notFound =
				response.status === 404 || body.error?.type === "not_found_error";
			const translated = {
				error: {
					message:
						body.error?.message ??
						`Upstream returned HTTP ${response.status} for this model`,
					// Every upstream type that is not a not-found is reported as
					// itself, so a caller can still tell a rate limit from a bad
					// request.
					type: notFound
						? "invalid_request_error"
						: (body.error?.type ?? "api_error"),
					// Explicitly null rather than omitted: OpenAI emits the key,
					// and dropping it changes the shape an SDK destructures.
					code: notFound ? "model_not_found" : null,
					param: null,
				},
			};
			return new Response(JSON.stringify(translated), {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		}

		// A 200 with no usable id is not a model. Passing it through unchanged
		// is honest: inventing an OpenAI object around an empty body would
		// tell the client a model exists when the upstream never said so.
		if (typeof body.id !== "string" || body.id.length === 0) {
			return response;
		}

		return new Response(JSON.stringify(toOpenAIModelEntry(body)), {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	/**
	 * Anthropic's `GET /v1/models` page rendered in the OpenAI listing shape.
	 *
	 * Anthropic answers `{data: [{id, display_name, created_at, type}],
	 * has_more, first_id, last_id}`; an OpenAI client wants
	 * `{object: "list", data: [{id, object: "model", created, owned_by}]}`.
	 * We translate rather than serve a local listing so the answer stays the
	 * live entitlement of the account that was routed to, not a table of ours
	 * that goes stale (`packages/http-api/src/handlers/models.ts` documents why
	 * a vendor's catalogue is not the same claim).
	 *
	 * `display_name`, `created_at` and `has_more` survive as extra fields:
	 * `ingestModelsListing` in `packages/proxy/src/model-catalog.ts` reads all
	 * three off this very body when it is teed, and OpenAI clients ignore keys
	 * they do not know.
	 *
	 * Anything that is not a 200 JSON body is passed through untouched — an
	 * error still has to reach the client as the error it was.
	 *
	 * The OpenAI listing has no pagination contract, so an OpenAI SDK handed a
	 * first page will never ask for the second. The remaining pages are
	 * therefore followed here, server-side, and the client gets one body. See
	 * `fetchRemainingModelPages` for the bound on that loop and for what a
	 * failure part-way through returns.
	 */
	private async transformModelsListResponse(
		response: Response,
		account?: Account | null,
		requestHeaders?: Headers,
	): Promise<Response> {
		if (!response.ok) return response;
		if (!response.headers.get("content-type")?.toLowerCase().includes("json")) {
			return response;
		}

		let body: AnthropicModelsPage;
		try {
			body = await response.clone().json();
		} catch (error) {
			log.warn("Could not parse the /v1/models body as JSON:", error);
			return response;
		}

		// Same null-body trap as the single-model path above: `body.data` on a
		// literal `null` throws rather than returning undefined, and a throw
		// out of `processResponse` is read as an account failure and fails the
		// request over to the next account. Pre-existing here; fixed alongside
		// the new path because one intermediary answering `null` would
		// otherwise walk the whole pool.
		if (body === null || typeof body !== "object") return response;
		if (!Array.isArray(body.data)) return response;

		const models = [...body.data];
		const stitched = await this.fetchRemainingModelPages(
			body,
			account,
			requestHeaders,
		);
		models.push(...stitched.models);

		const translated = {
			object: "list",
			data: models
				.filter((model) => typeof model.id === "string" && model.id.length > 0)
				.map(toOpenAIModelEntry),
			// `has_more` is the honest state of the stitched body, not of the
			// first page: false only when the last page we read said so.
			has_more: stitched.hasMore,
			first_id: body.first_id ?? null,
			last_id: stitched.lastId,
		};

		const headers = new Headers(response.headers);
		// The re-serialized body has a different length, and was already
		// decoded — a stale content-length or content-encoding truncates it.
		headers.delete("content-length");
		headers.delete("content-encoding");
		headers.set("content-type", "application/json");

		return new Response(JSON.stringify(translated), {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	/**
	 * Follow `last_id` through Anthropic's remaining `/v1/models` pages.
	 *
	 * Bounds, because an upstream that always answers `has_more: true` must not
	 * hang the request: at most `MODELS_MAX_EXTRA_PAGES` further pages, each
	 * with its own `MODELS_PAGE_TIMEOUT_MS` abort.
	 *
	 * Every exit that is not "the upstream said `has_more: false`" returns the
	 * models gathered so far with `hasMore: true`. A page that fails, times out,
	 * comes back as an error status, or is unparseable does not discard the
	 * pages already read, and does not fail a request that has a usable partial
	 * answer; `has_more: true` is the client's signal that the list is short.
	 * That value is also what keeps `ingestModelsListing` in
	 * `packages/proxy/src/model-catalog.ts` off its "this listing is complete"
	 * branch, so a truncated stitch merges into the catalog instead of
	 * replacing it.
	 */
	private async fetchRemainingModelPages(
		firstPage: AnthropicModelsPage,
		account?: Account | null,
		requestHeaders?: Headers,
	): Promise<{
		models: AnthropicModelSummary[];
		hasMore: boolean;
		lastId: string | null;
	}> {
		const models: AnthropicModelSummary[] = [];
		let lastId = firstPage.last_id ?? null;

		if (firstPage.has_more !== true) {
			return { models, hasMore: false, lastId };
		}

		// Anthropic's own credentials, not the client's: `prepareHeaders` strips
		// the client authorization whenever the account supplies one, exactly as
		// the original request did. A passthrough account (none) keeps the
		// client's, which is the only credential that request had either.
		const outgoing = new Headers(requestHeaders ?? new Headers());
		outgoing.delete("content-length");
		outgoing.delete("content-type");
		const headers = this.prepareHeaders(
			outgoing,
			account?.access_token ?? undefined,
			account?.api_key ?? undefined,
		);

		for (let page = 0; page < MODELS_MAX_EXTRA_PAGES; page++) {
			if (!lastId) return { models, hasMore: true, lastId };

			const url = this.buildUrl(
				"/v1/models",
				`?after_id=${encodeURIComponent(lastId)}`,
				account ?? undefined,
			);

			const controller = new AbortController();
			const timeoutId = setTimeout(
				() => controller.abort(),
				MODELS_PAGE_TIMEOUT_MS,
			);
			let next: AnthropicModelsPage;
			try {
				const pageResponse = await fetch(url, {
					method: "GET",
					headers,
					signal: controller.signal,
				});
				if (!pageResponse.ok) {
					log.warn(
						`Stopping the /v1/models stitch at HTTP ${pageResponse.status}; returning ${models.length} extra models with has_more: true`,
					);
					return { models, hasMore: true, lastId };
				}
				next = await pageResponse.json();
			} catch (error) {
				log.warn(
					`Stopping the /v1/models stitch after a failed page; returning ${models.length} extra models with has_more: true:`,
					error,
				);
				return { models, hasMore: true, lastId };
			} finally {
				clearTimeout(timeoutId);
			}

			if (!Array.isArray(next.data)) {
				return { models, hasMore: true, lastId };
			}
			models.push(...next.data);
			lastId = next.last_id ?? lastId;
			if (next.has_more !== true) {
				return { models, hasMore: false, lastId };
			}
		}

		// The cap, not the end of the listing. Saying `has_more: false` here
		// would claim a completeness we did not establish.
		log.warn(
			`Reached the ${MODELS_MAX_EXTRA_PAGES}-page cap stitching /v1/models; returning a partial listing with has_more: true`,
		);
		return { models, hasMore: true, lastId };
	}

	async extractTierInfo(response: Response): Promise<number | null> {
		try {
			const clone = response.clone();
			const json = (await clone.json()) as {
				type?: string;
				usage?: {
					rate_limit_tokens?: number;
				};
			};

			// Check for tier information in response
			if (json.type === "message" && json.usage?.rate_limit_tokens) {
				const rateLimit = json.usage.rate_limit_tokens;
				if (rateLimit >= 800000) return 20;
				if (rateLimit >= 200000) return 5;
				return 1;
			}
		} catch {
			// Ignore JSON parsing errors
		}

		return null;
	}

	async extractUsageInfo(response: Response): Promise<{
		model?: string;
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		costUsd?: number;
		inputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		outputTokens?: number;
	} | null> {
		try {
			const clone = response.clone();
			const contentType = response.headers.get("content-type");

			// Handle streaming responses (SSE)
			if (contentType?.includes("text/event-stream")) {
				// Use bounded reader to avoid consuming entire stream
				const reader = clone.body?.getReader();
				if (!reader) return null;

				let buffered = "";
				const maxBytes = BUFFER_SIZES.ANTHROPIC_STREAM_CAP_BYTES;
				const decoder = new TextDecoder();
				let foundMessageStart = false;
				const READ_TIMEOUT_MS = 10000; // 10 second timeout for stream reads
				const startTime = Date.now();

				try {
					while (buffered.length < maxBytes) {
						// Check for timeout — the enclosing `finally` drains the
						// reader on every exit path, including this throw.
						if (Date.now() - startTime > READ_TIMEOUT_MS) {
							throw new Error(
								"Stream read timeout while extracting usage info",
							);
						}

						// Read with timeout
						const readPromise = reader.read();
						const timeoutPromise = new Promise<{
							value?: Uint8Array;
							done: boolean;
						}>((_, reject) =>
							setTimeout(
								() => reject(new Error("Read operation timeout")),
								5000,
							),
						);

						const { value, done } = await Promise.race([
							readPromise,
							timeoutPromise,
						]);

						if (done) break;

						buffered += decoder.decode(value, { stream: true });

						// Check if we have the message_start event
						if (buffered.includes("event: message_start")) {
							foundMessageStart = true;
							// Read a bit more to ensure we get the data line
							const nextReadPromise = reader.read();
							const nextTimeoutPromise = new Promise<{
								value?: Uint8Array;
								done: boolean;
							}>((_, reject) =>
								setTimeout(
									() => reject(new Error("Read operation timeout")),
									5000,
								),
							);

							const { value: nextValue, done: nextDone } = await Promise.race([
								nextReadPromise,
								nextTimeoutPromise,
							]);

							if (!nextDone && nextValue) {
								buffered += decoder.decode(nextValue, { stream: true });
							}
							break;
						}
					}
				} finally {
					// Drain the reader to prevent hanging and release the native buffer
					void drainReader(reader);
				}

				if (!foundMessageStart) return null;

				// Parse the buffered content
				const lines = buffered.split("\n");

				// Parse SSE events
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					if (line.startsWith("event: message_start")) {
						// Next line should be the data
						const dataLine = lines[i + 1];
						if (dataLine?.startsWith("data: ")) {
							try {
								const jsonStr = dataLine.slice(6); // Remove "data: " prefix
								const data = JSON.parse(jsonStr) as {
									message?: {
										model?: string;
										usage?: {
											input_tokens?: number;
											output_tokens?: number;
											cache_creation_input_tokens?: number;
											cache_read_input_tokens?: number;
										};
									};
								};

								if (data.message?.usage) {
									const usage = data.message.usage;
									const inputTokens = usage.input_tokens || 0;
									const cacheCreationInputTokens =
										usage.cache_creation_input_tokens || 0;
									const cacheReadInputTokens =
										usage.cache_read_input_tokens || 0;
									const outputTokens = usage.output_tokens || 0;
									const promptTokens =
										inputTokens +
										cacheCreationInputTokens +
										cacheReadInputTokens;
									const completionTokens = outputTokens;
									const totalTokens = promptTokens + completionTokens;

									// Extract cost from header if available
									const costHeader = response.headers.get(
										"anthropic-billing-cost",
									);
									const costUsd = costHeader
										? parseFloat(costHeader)
										: undefined;

									return {
										model: data.message.model,
										promptTokens,
										completionTokens,
										totalTokens,
										costUsd,
										inputTokens,
										cacheReadInputTokens,
										cacheCreationInputTokens,
										outputTokens,
									};
								}
							} catch {
								// Ignore parse errors
							}
						}
					}
				}

				// For streaming responses, we only extract initial usage
				// Output tokens will be accumulated during streaming but we can't capture that here
				return null;
			} else {
				// Handle non-streaming JSON responses
				const json = (await clone.json()) as {
					model?: string;
					usage?: {
						input_tokens?: number;
						output_tokens?: number;
						cache_creation_input_tokens?: number;
						cache_read_input_tokens?: number;
					};
				};

				if (!json.usage) return null;

				const inputTokens = json.usage.input_tokens || 0;
				const cacheCreationInputTokens =
					json.usage.cache_creation_input_tokens || 0;
				const cacheReadInputTokens = json.usage.cache_read_input_tokens || 0;
				const outputTokens = json.usage.output_tokens || 0;
				const promptTokens =
					inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
				const completionTokens = outputTokens;
				const totalTokens = promptTokens + completionTokens;

				// Extract cost from header if available
				const costHeader = response.headers.get("anthropic-billing-cost");
				const costUsd = costHeader ? parseFloat(costHeader) : undefined;

				return {
					model: json.model,
					promptTokens,
					completionTokens,
					totalTokens,
					costUsd,
					inputTokens,
					cacheReadInputTokens,
					cacheCreationInputTokens,
					outputTokens,
				};
			}
		} catch {
			// Ignore parsing errors
			return null;
		}
	}

	/**
	 * Check if this provider supports OAuth
	 */
	supportsOAuth(): boolean {
		return true;
	}

	/**
	 * Get the OAuth provider for this provider
	 */
	getOAuthProvider() {
		// Lazy load to avoid circular dependencies
		const { AnthropicOAuthProvider } = require("./oauth.js");
		return new AnthropicOAuthProvider();
	}
}
