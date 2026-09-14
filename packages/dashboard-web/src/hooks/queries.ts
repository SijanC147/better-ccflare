import { getModelDisplayName } from "@better-ccflare/core";
import type {
	AgentUpdatePayload,
	Project,
	WorktreeRule,
} from "@better-ccflare/types";
import { COMMON_MODELS } from "@better-ccflare/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	api,
	type OpenObserveConfigUpdate,
	type RequestPayload,
	type RequestSummary,
} from "../api";
import { queryKeys } from "../lib/query-keys";

/**
 * Build a lightweight RequestPayload from a RequestSummary.
 *
 * The list view only needs metadata; full bodies (which can be ~256KB each)
 * are lazy-loaded by RequestDetailsModal and CopyButton via /api/requests/payload/:id.
 * `meta.bodiesOmitted` signals to consumers that the bodies must be hydrated.
 */
export function summaryToPlaceholder(summary: RequestSummary): RequestPayload {
	// `accountUsed` is the resolved account name when the JOIN succeeds, else
	// the raw account ID. We put it in accountName so the row renders the
	// friendly name; the ID-only fallback is rare (only after account deletion).
	const accountName = summary.accountUsed ?? undefined;
	return {
		id: summary.id,
		request: { headers: {}, body: null },
		response:
			summary.statusCode != null
				? { status: summary.statusCode, headers: {}, body: null }
				: null,
		error: summary.errorMessage ?? undefined,
		meta: {
			accountName,
			timestamp: new Date(summary.timestamp).getTime(),
			success: summary.success,
			path: summary.path,
			method: summary.method,
			agentUsed: summary.agentUsed,
			// Server derives this from statusCode === 429 so the list view can
			// render the Rate Limited badge without lazy-loading the body.
			rateLimited: summary.rateLimited,
			bodiesOmitted: true,
		},
	};
}

/**
 * Filtered Claude service status. The server-side poller keeps the snapshot
 * warm, so this only has to read it; per the convention in this file it does
 * not poll in a hidden tab.
 */
export const useServiceStatus = () => {
	return useQuery({
		queryKey: queryKeys.serviceStatus(),
		queryFn: () => api.getServiceStatus(),
		staleTime: 60_000,
		refetchInterval: 120_000,
		refetchIntervalInBackground: false,
	});
};

export const useStorageInfo = (refetchInterval?: number) => {
	return useQuery({
		queryKey: queryKeys.storage(),
		queryFn: () => api.getStorageInfo(),
		staleTime: 30_000,
		// Cadence boost while a probe is in flight: a full check on a
		// multi-GB DB takes 25–90s, and a fixed 60s poll could miss the
		// transition entirely. While `integrity_status === "running"` poll
		// every 5s so the dashboard surfaces completion within seconds of
		// the worker finishing. Idle steady-state stays at 60s.
		refetchInterval: (query) => {
			if (refetchInterval !== undefined) return refetchInterval;
			const data = query.state.data;
			if (data?.integrity_status === "running") return 5_000;
			return 60_000;
		},
		refetchIntervalInBackground: false,
	});
};

export const useTriggerIntegrityCheck = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (kind: "quick" | "full") => api.triggerIntegrityCheck(kind),
		onError: (error) => {
			// 409 (scheduler already running), network errors, etc. — surface
			// via console so a misbehaving on-demand trigger is visible in
			// devtools. The mutation's `error` field is also exposed by
			// useMutation, so the calling component (StorageIntegrityCard)
			// renders the message inline next to the buttons.
			console.error("Integrity check trigger failed:", error);
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.storage() });
		},
	});
};

export interface AccountsQueryOptions {
	// Keep polling while the tab is in the background. Off for every normal
	// dashboard caller -- a hidden tab has no viewer, so the refetch is waste.
	// The kiosk view (KioskTab) turns it on, because a background tab IS the
	// normal state for an ambient display left on a spare monitor, and that is
	// exactly the state React Query stops polling in by default.
	//
	// Deliberately scoped to this one query. The global default is not flipped,
	// and the version-status query keeps refetchIntervalInBackground: false on
	// purpose (PR #71 / SB23-1790): it polls GitHub every 15 minutes, and a
	// background tab doing that is how a rate limit gets hit.
	backgroundRefresh?: boolean;
}

/**
 * Query options for the accounts list, as a pure value so the background-refresh
 * behaviour can be asserted directly rather than inferred from a running query.
 */
export function accountsQueryOptions(options?: AccountsQueryOptions) {
	return {
		queryKey: queryKeys.accounts(),
		queryFn: () => api.getAccounts(),
		staleTime: 20000, // Consider data fresh for 20 seconds
		refetchInterval: 60000, // Refresh every minute for usage data
		refetchIntervalInBackground: options?.backgroundRefresh ?? false,
		gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
	};
}

export const useAccounts = (options?: AccountsQueryOptions) => {
	return useQuery(accountsQueryOptions(options));
};

export const useRoutingObservations = () => {
	return useQuery({
		queryKey: queryKeys.routingObservations(),
		queryFn: () => api.getRoutingObservations(),
		staleTime: 20000, // Consider data fresh for 20 seconds
		refetchInterval: 60000, // Same cadence as useAccounts -- both drive the pool cards
		refetchIntervalInBackground: false, // Don't refresh when tab is not focused
		gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
	});
};

export const useAgents = () => {
	return useQuery({
		queryKey: queryKeys.agents(),
		queryFn: () => api.getAgents(),
		staleTime: 60000, // Consider data fresh for 1 minute
		refetchInterval: 60000, // Increase from 30 to 60 seconds
		refetchIntervalInBackground: false, // Don't refresh when tab is not focused
		gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
	});
};

interface ApiKeyListItem {
	id: string;
	name: string;
	prefixLast8: string;
	createdAt: string;
	lastUsed: string | null;
	usageCount: number;
	isActive: boolean;
}

interface ApiKeysListResponse {
	success: boolean;
	data: ApiKeyListItem[];
	count: number;
}

export const useApiKeys = () => {
	return useQuery({
		queryKey: queryKeys.apiKeys(),
		queryFn: async () => {
			const res = await api.get<ApiKeysListResponse>("/api/api-keys");
			return res.data ?? [];
		},
		staleTime: 60000,
		gcTime: 5 * 60 * 1000,
	});
};

export const useStats = (
	refetchInterval?: number,
	errorsSinceHours?: number,
) => {
	return useQuery({
		queryKey: queryKeys.stats(errorsSinceHours),
		queryFn: () => api.getStats({ errorsSinceHours }),
		staleTime: 15000, // Consider data fresh for 15 seconds
		refetchInterval: refetchInterval ?? 30000, // Default to 30 seconds instead of 10
		refetchIntervalInBackground: false, // Don't refresh when tab is not focused
		gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
	});
};

export const useAnalytics = (
	timeRange: string,
	filters: {
		accounts?: string[];
		models?: string[];
		projects?: string[];
		apiKeys?: string[];
		status?: "all" | "success" | "error";
	},
	viewMode: "normal" | "cumulative",
	modelBreakdown?: boolean,
) => {
	const logger = {
		debug: (message: string, ...args: unknown[]) => {
			console.debug(`[Analytics Query] ${message}`, ...args);
		},
		error: (message: string, ...args: unknown[]) => {
			console.error(`[Analytics Query] ${message}`, ...args);
		},
	};

	return useQuery({
		queryKey: queryKeys.analytics(timeRange, filters, viewMode, modelBreakdown),
		queryFn: async () => {
			logger.debug(`Starting analytics query`, {
				timeRange,
				filters,
				viewMode,
				modelBreakdown,
				timestamp: new Date().toISOString(),
			});

			try {
				const result = await api.getAnalytics(
					timeRange,
					filters,
					viewMode,
					modelBreakdown,
				);
				logger.debug(`Analytics query completed successfully`, {
					timeRange,
					filters,
					viewMode,
					modelBreakdown,
					resultType: Array.isArray(result) ? "array" : "object",
					timestamp: new Date().toISOString(),
				});
				return result;
			} catch (error) {
				logger.error(`Analytics query failed`, {
					timeRange,
					filters,
					viewMode,
					modelBreakdown,
					error: error instanceof Error ? error.message : String(error),
					errorStack: error instanceof Error ? error.stack : undefined,
					timestamp: new Date().toISOString(),
				});
				throw error;
			}
		},
		staleTime: 45000,
		refetchInterval: 60000,
		refetchIntervalInBackground: false,
		gcTime: 15 * 60 * 1000,
		enabled: !!timeRange,
		retry: (failureCount, error) => {
			logger.debug(`Analytics query retry attempt ${failureCount + 1}`, {
				error: error instanceof Error ? error.message : String(error),
				willRetry: failureCount < 3, // Retry up to 3 times
				timestamp: new Date().toISOString(),
			});
			return failureCount < 3;
		},
	});
};

export const useCacheInsights = (timeRange: string, threshold?: number) => {
	return useQuery({
		queryKey: queryKeys.insightsCache(timeRange, threshold),
		queryFn: () => api.getCacheInsights(timeRange, threshold),
		staleTime: 45000,
		refetchInterval: 60000,
		refetchIntervalInBackground: false,
		gcTime: 15 * 60 * 1000,
		enabled: !!timeRange,
	});
};

export const useUsageHistory = (account: string, range: string) => {
	return useQuery({
		queryKey: queryKeys.usageHistory(account, range),
		queryFn: () => api.getUsageHistory(account, range),
		staleTime: 45000,
		refetchInterval: 60000,
		refetchIntervalInBackground: false,
		gcTime: 15 * 60 * 1000,
		enabled: !!account,
	});
};

export const useContextInsights = (timeRange: string) => {
	return useQuery({
		queryKey: queryKeys.insightsContext(timeRange),
		queryFn: () => api.getContextInsights(timeRange),
		staleTime: 45000,
		refetchInterval: 60000,
		refetchIntervalInBackground: false,
		gcTime: 15 * 60 * 1000,
		enabled: !!timeRange,
	});
};

export const useAnomalyInsights = (timeRange: string) => {
	return useQuery({
		queryKey: queryKeys.insightsAnomalies(timeRange),
		queryFn: () => api.getAnomalyInsights(timeRange),
		staleTime: 45000,
		refetchInterval: 60000,
		refetchIntervalInBackground: false,
		gcTime: 15 * 60 * 1000,
		enabled: !!timeRange,
	});
};

export const useRequests = (limit: number, _refetchInterval?: number) => {
	return useQuery({
		queryKey: queryKeys.requests(limit),
		queryFn: async () => {
			// Fetch only the summary endpoint - it has everything the list view needs.
			// Full request/response bodies are lazy-loaded per row when needed
			// (modal open, copy-as-JSON) via /api/requests/payload/:id.
			const requestsSummary = await api.getRequestsSummary(limit);
			const detailsMap = new Map(
				requestsSummary.map((summary) => [summary.id, summary]),
			);
			const requests: RequestPayload[] =
				requestsSummary.map(summaryToPlaceholder);
			return { requests, detailsMap };
		},
		staleTime: Infinity, // Consider data fresh until manually refetched
		gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
		// Remove refetchInterval - SSE stream handles real-time updates
	});
};

export const useLogHistory = () => {
	return useQuery({
		queryKey: queryKeys.logHistory(),
		queryFn: () => api.getLogHistory(),
	});
};

export const useProjects = () => {
	return useQuery({
		queryKey: queryKeys.projects(),
		queryFn: () => api.getProjects(),
		staleTime: 2 * 60 * 1000, // Consider data fresh for 2 minutes
		gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
	});
};

// Mutations
export const useRemoveAccount = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			id,
			name,
			confirmInput,
		}: {
			id: string;
			name: string;
			confirmInput: string;
		}) => api.removeAccount(id, name, confirmInput),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });
		},
	});
};

export const useRenameAccount = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			accountId,
			newName,
		}: {
			accountId: string;
			newName: string;
		}) => api.renameAccount(accountId, newName),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });
		},
	});
};

export const useResetStats = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => api.resetStats(),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.stats() });
		},
	});
};

/**
 * Sentinel select value for "remove the explicit preference" — routed to
 * DELETE /api/agents/:id/preference instead of the POST update (which
 * requires a concrete model). Deliberately not a valid model id.
 */
export const AGENT_DEFAULT_MODEL_SENTINEL = "__agent_default__";

export const useUpdateAgentPreference = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ agentId, model }: { agentId: string; model: string }) =>
			model === AGENT_DEFAULT_MODEL_SENTINEL
				? api.clearAgentPreference(agentId)
				: api.updateAgentPreference(agentId, model),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.agents() });
		},
	});
};

export const useDefaultAgentModel = () => {
	return useQuery({
		queryKey: queryKeys.defaultAgentModel(),
		queryFn: () => api.getDefaultAgentModel(),
		staleTime: 2 * 60 * 1000, // Consider data fresh for 2 minutes
		refetchInterval: 5 * 60 * 1000, // Poll every 5 minutes instead of 1
		refetchIntervalInBackground: false, // Don't refresh when tab is not focused
		gcTime: 30 * 60 * 1000, // Keep in cache for 30 minutes
	});
};

export const useSetDefaultAgentModel = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (model: string) => api.setDefaultAgentModel(model),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.defaultAgentModel(),
			});
			queryClient.invalidateQueries({ queryKey: queryKeys.agents() });
		},
	});
};

export const useBulkUpdateAgentPreferences = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (model: string) => api.setBulkAgentPreferences(model),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.agents() });
		},
	});
};

export const useModels = () => {
	return useQuery({
		queryKey: queryKeys.models(),
		queryFn: () => api.getModels(),
		staleTime: 2 * 60 * 1000, // Consider data fresh for 2 minutes
		refetchInterval: 5 * 60 * 1000, // Poll every 5 minutes
		refetchIntervalInBackground: false,
		gcTime: 30 * 60 * 1000, // Keep in cache for 30 minutes
	});
};

/**
 * Model select options, sourced from the live Anthropic model catalog when
 * available. Falls back to the bundled static list while the catalog is
 * loading or if it comes back empty for any reason.
 */
export const useModelOptions = (): { id: string; displayName: string }[] => {
	const { data: modelCatalog } = useModels();

	return modelCatalog && modelCatalog.models.length > 0
		? modelCatalog.models.map((m) => ({
				id: m.id,
				displayName: m.displayName,
			}))
		: COMMON_MODELS.map((id) => ({
				id,
				displayName: getModelDisplayName(id),
			}));
};

export const useRefreshModels = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => api.refreshModels(),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.models() });
		},
	});
};

export const useUpdateAgent = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			id,
			payload,
		}: {
			id: string;
			payload: AgentUpdatePayload;
		}) => api.updateAgent(id, payload),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.agents() });
		},
	});
};

// Note: Clear logs functionality appears to be removed from the API

// Retention settings
export const useRetention = () => {
	return useQuery({
		queryKey: ["retention"],
		queryFn: () => api.getRetention(),
	});
};

export const useSetRetention = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (partial: {
			payloadDays?: number;
			requestDays?: number;
			storePayloads?: boolean;
		}) => api.setRetention(partial),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["retention"] });
		},
	});
};

export const useGithubTokenConfig = () => {
	return useQuery({
		queryKey: ["github-token-config"],
		queryFn: () => api.getGithubTokenConfig(),
	});
};

export const useSetGithubToken = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (token: string) => api.setGithubToken(token),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["github-token-config"] });
			// The widget reads the token per request, so the next status refresh
			// already uses it. Invalidate so the card stops showing the old error.
			queryClient.invalidateQueries({ queryKey: queryKeys.versionStatus() });
		},
	});
};

export const useOpenObserveConfig = () => {
	return useQuery({
		queryKey: ["openobserve-config"],
		queryFn: () => api.getOpenObserveConfig(),
	});
};

export const useSetOpenObserveConfig = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (settings: OpenObserveConfigUpdate) =>
			api.setOpenObserveConfig(settings),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["openobserve-config"] });
		},
	});
};

export const useRequestStorage = () => {
	return useQuery({
		queryKey: ["request-storage"],
		queryFn: () => api.getRequestStorage(),
	});
};

export const useSetRequestStorage = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: { headersOnly: boolean }) => api.setRequestStorage(body),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["request-storage"] });
		},
	});
};

export const useKeepaliveTtl = () => {
	return useQuery({
		queryKey: ["keepalive"],
		queryFn: () => api.getCacheKeepaliveTtl(),
	});
};

export const useSetKeepaliveTtl = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: { ttlMinutes: number }) =>
			api.setCacheKeepaliveTtl(body),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["keepalive"] });
		},
	});
};

export const useSystemCacheTtl = () => {
	return useQuery({
		queryKey: ["system-cache-ttl"],
		queryFn: () => api.getSystemCacheTtl(),
	});
};

export const useSetSystemCacheTtl = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (enabled: boolean) => api.setSystemCacheTtl(enabled),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["system-cache-ttl"] });
		},
	});
};

export const useUsageThrottling = () => {
	return useQuery({
		queryKey: ["usage-throttling"],
		queryFn: () => api.getUsageThrottling(),
	});
};

export const useSetUsageThrottling = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (settings: {
			fiveHourEnabled: boolean;
			weeklyEnabled: boolean;
		}) => api.setUsageThrottling(settings),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["usage-throttling"] });
			queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });
		},
	});
};

export const useStrategy = () => {
	return useQuery({
		queryKey: ["strategy"],
		queryFn: () => api.getStrategy(),
	});
};

export const useSetStrategy = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (strategy: string) => api.setStrategy(strategy),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["strategy"] });
			queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });
		},
	});
};

export const useModelCapacityRouting = () => {
	return useQuery({
		queryKey: ["model-capacity-routing"],
		queryFn: () => api.getModelCapacityRouting(),
	});
};

export const useSetModelCapacityRouting = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (mode: "off" | "exhausted") =>
			api.setModelCapacityRouting(mode),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["model-capacity-routing"] });
		},
	});
};

export const useCleanupNow = () => {
	return useMutation({
		mutationFn: () => api.cleanupNow(),
	});
};

// PostgreSQL configuration
export const usePostgresConfig = () => {
	return useQuery({
		queryKey: ["postgres-config"],
		queryFn: () => api.getPostgresConfig(),
	});
};

export const useSetPostgresConfig = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: {
			enabled?: boolean;
			host?: string;
			port?: number;
			database?: string;
			user?: string;
			password?: string;
			sslMode?: "disable" | "require" | "verify-ca" | "verify-full";
		}) => api.setPostgresConfig(body),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["postgres-config"] });
		},
	});
};

export const useAdminRestart = () => {
	return useMutation({
		mutationFn: () => api.adminRestart(),
	});
};

export const useCombos = () => {
	return useQuery({
		queryKey: queryKeys.combos(),
		queryFn: () => api.getCombos(),
	});
};

export const useFamilies = () => {
	return useQuery({
		queryKey: queryKeys.families(),
		queryFn: () => api.getFamilies(),
	});
};

export const useCreateCombo = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (params: {
			name: string;
			description?: string;
			enabled?: boolean;
		}) => api.createCombo(params),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.combos() });
		},
	});
};

export const useAssignFamily = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (params: {
			family: string;
			comboId: string | null;
			enabled: boolean;
		}) => api.assignFamily(params),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.families() });
			queryClient.invalidateQueries({ queryKey: queryKeys.combos() });
		},
	});
};

export const useDeleteCombo = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteCombo(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.combos() });
		},
	});
};

export const useUpdateCombo = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (params: {
			id: string;
			name?: string;
			description?: string;
			enabled?: boolean;
		}) => api.updateCombo(params.id, params),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.combos() });
		},
	});
};

export const useGetCombo = (id: string | null) => {
	return useQuery({
		queryKey: ["combo", id],
		// biome-ignore lint/style/noNonNullAssertion: queryFn only runs when `enabled: !!id` is true, so id is guaranteed non-null here — TS can't see the enabled/queryFn connection.
		queryFn: () => api.getCombo(id!),
		enabled: !!id,
	});
};

export const useAddComboSlot = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			comboId,
			params,
		}: {
			comboId: string;
			params: { account_id: string; model: string; enabled?: boolean };
		}) => api.addComboSlot(comboId, params),
		onSuccess: (_data, { comboId }) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.combos() });
			queryClient.invalidateQueries({ queryKey: ["combo", comboId] });
		},
	});
};

export const useUpdateComboSlot = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			comboId,
			slotId,
			params,
		}: {
			comboId: string;
			slotId: string;
			params: { model?: string; enabled?: boolean };
		}) => api.updateComboSlot(comboId, slotId, params),
		onSuccess: (_data, { comboId }) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.combos() });
			queryClient.invalidateQueries({ queryKey: ["combo", comboId] });
		},
	});
};

export const useRemoveComboSlot = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ comboId, slotId }: { comboId: string; slotId: string }) =>
			api.removeComboSlot(comboId, slotId),
		onSuccess: (_data, { comboId }) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.combos() });
			queryClient.invalidateQueries({ queryKey: ["combo", comboId] });
		},
	});
};

export const useReorderComboSlots = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			comboId,
			slotIds,
		}: {
			comboId: string;
			slotIds: string[];
		}) => api.reorderComboSlots(comboId, slotIds),
		onSuccess: (_data, { comboId }) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.combos() });
			queryClient.invalidateQueries({ queryKey: ["combo", comboId] });
		},
	});
};

// ── Projects ─────────────────────────────────────────────────────────────────

export const useProjectsAll = () => {
	return useQuery<Project[]>({
		queryKey: queryKeys.projectsAll(),
		queryFn: () => api.getProjectsAll(),
		staleTime: 2 * 60 * 1000,
		gcTime: 10 * 60 * 1000,
	});
};

export const useDiscoverProjects = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => api.discoverProjects(),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.projectsAll() });
			queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
		},
	});
};

export const useAlerts = () => {
	return useQuery({
		queryKey: queryKeys.insightsAlerts(),
		queryFn: async () => {
			const res = await api.getAlerts(200);
			return res;
		},
		staleTime: 15_000,
		refetchInterval: 30_000,
		refetchIntervalInBackground: false,
	});
};

/**
 * Fork release state, upstream sync gap and any open sync PR.
 *
 * The server caches the underlying GitHub reads for 15 minutes, so polling more
 * often than that only returns the stored snapshot. `retry: false` keeps a
 * GitHub outage from re-requesting: the endpoint already answers 200 with the
 * local identity and an explanatory error, so a failure here means the server
 * itself is unreachable.
 */
export const useVersionStatus = () => {
	return useQuery({
		queryKey: queryKeys.versionStatus(),
		queryFn: () => api.getVersionStatus(),
		staleTime: 5 * 60_000,
		refetchInterval: 15 * 60_000,
		refetchIntervalInBackground: false,
		retry: false,
	});
};

export const useAcknowledgeAlert = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.acknowledgeAlert(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.insightsAlerts() });
		},
	});
};

export const useUpdateProject = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			id,
			body,
		}: {
			id: string;
			body: Partial<{
				display_name: string;
				enabled: boolean;
				parent_project_id: string | null;
			}>;
		}) => api.updateProject(id, body),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.projectsAll() });
			queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
		},
	});
};

export const useCreateProject = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: {
			canonical_path: string;
			display_name?: string;
			parent_project_id?: string | null;
			enabled?: boolean;
		}) => api.createProject(body),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.projectsAll() });
			queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
		},
	});
};

export const useDeleteProject = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteProject(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.projectsAll() });
			queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
		},
	});
};

// ── Worktree Rules ────────────────────────────────────────────────────────────

export const useWorktreeRules = () => {
	return useQuery<WorktreeRule[]>({
		queryKey: queryKeys.worktreeRules(),
		queryFn: () => api.getWorktreeRules(),
		staleTime: 2 * 60 * 1000,
		gcTime: 10 * 60 * 1000,
	});
};

export const useCreateWorktreeRule = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: {
			kind: string;
			pattern: string;
			parent_project_id?: string | null;
			priority?: number;
		}) => api.createWorktreeRule(body),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.worktreeRules() });
		},
	});
};

export const useUpdateWorktreeRule = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			id,
			body,
		}: {
			id: string;
			body: Partial<{
				kind: string;
				pattern: string;
				parent_project_id: string | null;
				priority: number;
				enabled: boolean;
			}>;
		}) => api.updateWorktreeRule(id, body),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.worktreeRules() });
		},
	});
};

export const useDeleteWorktreeRule = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteWorktreeRule(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.worktreeRules() });
		},
	});
};

export const useAcknowledgeAllAlerts = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => api.acknowledgeAllAlerts(),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.insightsAlerts() });
		},
	});
};
