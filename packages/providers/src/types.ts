import type { Account } from "@better-ccflare/types";

export interface TokenRefreshResult {
	accessToken: string;
	expiresAt: number;
	refreshToken: string; // Always required - either new token or existing one
}

export interface RateLimitInfo {
	isRateLimited: boolean;
	resetTime?: number;
	statusHeader?: string;
	remaining?: number;
}

/**
 * The per-request carrier (SB23-2508). The proxy creates exactly one of these
 * for each upstream attempt, before `prepareRequest`, and passes that same
 * object to `prepareRequest`, `buildUrl` and every `processResponse` call the
 * attempt makes, the in-place retries included. A failover to another account
 * is a new attempt and gets a new object.
 *
 * A provider that derives something in one hook and needs it in a later one
 * keys it on this object, typically in a module-private
 * `WeakMap<ProviderRequestContext, T>`, so the value lives exactly as long as
 * the attempt and no other request can reach it. It must never be written onto
 * the `Account` or onto the provider instance: both outlive the request, and an
 * account object shared by two requests would hand one request the other's
 * value (SB23-2457).
 */
export interface ProviderRequestContext {
	/**
	 * Model in the final request body sent upstream, after account
	 * mapping/fallback. Set by the proxy immediately before each
	 * `processResponse` call, so it is absent during `prepareRequest` and
	 * `buildUrl`.
	 */
	requestModel?: string | null;
}

/** The name this type had when only `processResponse` received it. */
export type ProviderResponseContext = ProviderRequestContext;

export interface Provider {
	name: string;
	/** Passive request coverage, including refusal before an upstream dispatch. */
	observeRequest?(
		headers: Headers,
		nativeResponses: boolean,
	): RequestObservation | undefined;

	/** Passive metadata capture at the final dispatch boundary, once per actual
	 * upstream attempt. Must not change the request, retry, or consume quota. */
	observeUpstream?(
		request: Request,
		context: UpstreamObservationContext,
	): Promise<UpstreamObservation | undefined>;

	/**
	 * Check if this provider can handle the given request path
	 */
	canHandle(path: string): boolean;

	/**
	 * Refresh the access token for an account
	 */
	refreshToken(account: Account, clientId: string): Promise<TokenRefreshResult>;

	/**
	 * Build the target URL for the provider.
	 *
	 * `context` is the attempt's carrier when the proxy is dispatching a request,
	 * the same object `prepareRequest` received. Callers that build a URL outside
	 * a request (the model catalog, the unauthenticated passthrough) pass none.
	 */
	buildUrl(
		path: string,
		query: string,
		account?: Account,
		context?: ProviderRequestContext,
	): string;

	/**
	 * Optional: Pre-process the request before building URL
	 * This allows providers to extract information from the request body
	 * before buildUrl is called (e.g., for including model in URL path).
	 * Anything derived here that a later hook needs is keyed on `context`.
	 */
	prepareRequest?(
		request: Request,
		requestBodyBuffer: ArrayBuffer | null,
		account: Account,
		context: ProviderRequestContext,
	): void;

	/**
	 * Prepare headers for the provider request
	 * @param headers - Original request headers
	 * @param accessToken - OAuth access token (for Bearer authentication)
	 * @param apiKey - API key (provider-specific header)
	 */
	prepareHeaders(
		headers: Headers,
		accessToken?: string,
		apiKey?: string,
	): Headers;

	/**
	 * Parse rate limit information from response
	 */
	parseRateLimit(response: Response): RateLimitInfo;

	/**
	 * Process the response before returning to client. `context` is the same
	 * carrier object `prepareRequest` and `buildUrl` received for this attempt.
	 */
	processResponse(
		response: Response,
		account: Account | null,
		requestHeaders?: Headers,
		drainAbort?: AbortController,
		context?: ProviderRequestContext,
	): Promise<Response>;

	/**
	 * Transform the request body before sending to the provider
	 */
	transformRequestBody?(request: Request, account?: Account): Promise<Request>;

	/**
	 * Extract tier information from response if available
	 */
	extractTierInfo?(response: Response): Promise<number | null>;

	/**
	 * Extract usage information from response if available
	 */
	extractUsageInfo?(response: Response): Promise<{
		model?: string;
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		costUsd?: number;
		inputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		outputTokens?: number;
	} | null>;

	/**
	 * Parse usage information from streaming SSE response if available
	 * This is called for streaming responses to extract usage from final SSE events
	 * Falls back to extractUsageInfo for non-streaming responses
	 */
	parseUsage?(response: Response): Promise<{
		model?: string;
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		costUsd?: number;
		inputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		outputTokens?: number;
	} | null>;

	/**
	 * Check if the response is a streaming response
	 */
	isStreamingResponse?(response: Response): boolean;
}

export interface UpstreamObservationContext {
	requestId: string;
	account: Account | null;
	sourceBody: ArrayBuffer | null;
	sourceHeaders: Headers;
	nativeResponses: boolean;
	signal: AbortSignal;
}

export interface UpstreamObservation {
	response(response: Response): Response;
	error(error: unknown): void;
}

// OAuth-specific types
export interface OAuthProviderConfig {
	authorizeUrl: string;
	tokenUrl: string;
	clientId: string;
	scopes: string[];
	redirectUri: string;
	mode?: string;
}

export interface OAuthProvider {
	getOAuthConfig(mode?: string, redirectUri?: string): OAuthProviderConfig;
	exchangeCode(
		code: string,
		verifier: string,
		config: OAuthProviderConfig,
	): Promise<TokenResult>;
	generateAuthUrl(config: OAuthProviderConfig, pkce: PKCEChallenge): string;
}

export interface PKCEChallenge {
	verifier: string;
	challenge: string;
}

export interface TokenResult {
	refreshToken: string;
	accessToken: string;
	expiresAt: number;
}

export interface RequestObservation extends UpstreamObservation {
	bindRequestId(requestId: string): void;
}
