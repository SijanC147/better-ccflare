import { HttpError } from "@better-ccflare/http-common";
import {
	MutationCache,
	QueryCache,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
	Navigate,
	Route,
	Routes,
	useLocation,
	useNavigate,
} from "react-router-dom";
import { api } from "./api";
import { AccountsTab } from "./components/AccountsTab";
import { AgentsTab } from "./components/AgentsTab";
import { ApiKeyAuthDialog } from "./components/ApiKeyAuthDialog";
import { ApiKeysTab } from "./components/ApiKeysTab";
import { ApiPlaygroundTab } from "./components/ApiPlaygroundTab";
import { legacyApiKeyUsageLocation } from "./components/api-key-usage/tab-helpers";
import { ComboFlowTab } from "./components/combo-flow/ComboFlowTab";
import { CombosTab } from "./components/combos/CombosTab";
import { DebugPanel } from "./components/DebugPanel";
import { KioskTab } from "./components/KioskTab";
import { LogsTab } from "./components/LogsTab";
import { ModelPricesTab } from "./components/ModelPricesTab";
import { NotificationsTab } from "./components/NotificationsTab";
import { Navigation } from "./components/navigation";
import { NotificationWatcher } from "./components/notifications/NotificationWatcher";
import { OverviewTab } from "./components/OverviewTab";
import { ProjectsTab } from "./components/ProjectsTab";
import { RequestsTab } from "./components/RequestsTab";
import { SettingsTab } from "./components/SettingsTab";
import { SearchTab } from "./components/search/SearchTab";
import { QUERY_CONFIG, REFRESH_INTERVALS } from "./constants";
import { NotificationsProvider } from "./contexts/notifications-context";
import { ThemeProvider } from "./contexts/theme-context";
import { runAuthProbe } from "./lib/auth-probe";
import { cn } from "./lib/utils";
import "./index.css";

// Lazy load heavy components for better bundle splitting
const LazyAnalyticsTab = lazy(() =>
	import("./components/LazyAnalytics").then((module) => ({
		default: module.LazyAnalytics,
	})),
);
const LazyInsightsTab = lazy(() =>
	import("./components/InsightsTab").then((module) => ({
		default: module.InsightsTab,
	})),
);
const LazyUsageHistoryTab = lazy(() =>
	import("./components/usage-history/UsageHistoryTab").then((m) => ({
		default: m.UsageHistoryTab,
	})),
);
const LazyApiKeyUsageTab = lazy(() =>
	import("./components/api-key-usage/ApiKeyUsageTab").then((m) => ({
		default: m.ApiKeyUsageTab,
	})),
);
const LoadingSkeleton = () => (
	<div className="space-y-6 p-6">
		<div className="animate-pulse">
			<div className="h-8 bg-muted rounded w-32 mb-4"></div>
			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
				{Array.from({ length: 4 }, (_, i) => `skeleton-card-${i}`).map(
					(key) => (
						<div key={key} className="h-24 bg-muted rounded" />
					),
				)}
			</div>
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				{Array.from({ length: 2 }, (_, i) => `skeleton-chart-${i}`).map(
					(key) => (
						<div key={key} className="h-64 bg-muted rounded" />
					),
				)}
			</div>
		</div>
	</div>
);

// QueryClient will be created inside App component to have access to auth state

export function LegacyApiKeyUsageRedirect() {
	const location = useLocation();
	return <Navigate to={legacyApiKeyUsageLocation(location.pathname)} replace />;
}

export function App() {
	const location = useLocation();
	const navigate = useNavigate();
	const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(
		localStorage.getItem("ccflare-sidebar-collapsed") === "true",
	);

	const isUsagePage =
		location.pathname === "/api-key-usage" ||
		location.pathname.startsWith("/api-keys/");
	// Build the dashboard routes once; released features remain reachable.
	const routes = useMemo(() => {
		const baseRoutes = [
			{
				path: "/",
				element: <OverviewTab />,
				title: "Dashboard Overview",
				subtitle: "Monitor your ccflare performance and usage",
			},
			{
				path: "/analytics",
				element: (
					<Suspense fallback={<LoadingSkeleton />}>
						<LazyAnalyticsTab />
					</Suspense>
				),
				title: "Analytics",
				subtitle: "Deep dive into your usage patterns and trends",
			},
			{
				path: "/insights",
				element: (
					<Suspense fallback={<LoadingSkeleton />}>
						<LazyInsightsTab />
					</Suspense>
				),
				title: "Insights",
				subtitle: "Cache efficiency and estimated cost savings",
			},
			{
				path: "/requests",
				element: <RequestsTab />,
				title: "Request History",
				subtitle: "View detailed request and response data",
			},
			{
				path: "/accounts",
				element: <AccountsTab />,
				title: "Account Management",
				subtitle: "Manage your OAuth accounts and settings",
			},
			{
				path: "/projects",
				element: <ProjectsTab />,
				title: "Projects",
				subtitle: "Manage discovered and manual Claude Code projects",
			},
			{
				path: "/usage-history",
				element: (
					<Suspense fallback={<LoadingSkeleton />}>
						<LazyUsageHistoryTab />
					</Suspense>
				),
				title: "Usage History",
				subtitle: "Per-account usage windows over time, with limit prediction",
			},
			{
				path: "/api-key-usage",
				element: (
					<Suspense fallback={<LoadingSkeleton />}>
						<LazyApiKeyUsageTab />
					</Suspense>
				),
				title: "API Key Usage",
				subtitle:
					"Per-key cost, plan efficiency and limits for one API key at a time",
			},
			{
				path: "/agents",
				element: <AgentsTab />,
				title: "Agent Management",
				subtitle: "Discover and manage Claude Code agents",
			},
			{
				path: "/api-keys",
				element: <ApiKeysTab />,
				title: "API Key Management",
				subtitle: "Generate and manage API keys for authentication",
			},
			{
				path: "/model-prices",
				element: <ModelPricesTab />,
				title: "Model prices",
				subtitle: "The gateway's catalogue rates in USD per 1M tokens",
			},
			{
				path: "/search",
				element: <SearchTab />,
				title: "Web search",
				subtitle:
					"Serve client web-search requests yourself through your own search providers",
			},
			{
				path: "/logs",
				element: <LogsTab />,
				title: "System Logs",
				subtitle: "Real-time system logs and debugging information",
			},
			{
				path: "/api-playground",
				element: <ApiPlaygroundTab />,
				title: "API Playground",
				subtitle:
					"Call any endpoint this server serves and inspect the response",
			},
			{
				path: "/notifications",
				element: <NotificationsTab />,
				title: "Notifications",
				subtitle:
					"Desktop notifications for outages, rate limits, account health and error bursts",
			},
			{
				path: "/settings",
				element: <SettingsTab />,
				title: "Settings",
				subtitle: "Configure system behavior and data retention",
			},
		];

		baseRoutes.splice(5, 0, {
			path: "/combos",
			element: <CombosTab />,
			title: "Combos Management",
			subtitle: "Define fallback chains for model families",
		});
		baseRoutes.splice(6, 0, {
			path: "/combo-flow",
			element: <ComboFlowTab />,
			title: "Combo Flow",
			subtitle:
				"How each active combo routes a request: family → combo → account/model chain",
		});

		return baseRoutes;
	}, []);

	const currentRoute =
		routes.find(
			(route) =>
				route.path === location.pathname ||
				(route.path === "/api-key-usage" &&
					location.pathname.startsWith("/api-keys/")),
		) || routes[0];
	const [showAuthDialog, setShowAuthDialog] = useState(false);
	const [isAuthenticated, setIsAuthenticated] = useState(false);
	const [canManage, setCanManage] = useState(false);
	const [isCheckingAuth, setIsCheckingAuth] = useState(true);
	const [authError, setAuthError] = useState<string | null>(null);
	const [authRequired, setAuthRequired] = useState(false);

	// Use refs to store state setters so they can be accessed in QueryClient callbacks
	const showAuthDialogRef = useRef(setShowAuthDialog);
	const isAuthenticatedRef = useRef(setIsAuthenticated);
	const authErrorRef = useRef(setAuthError);
	const authRequiredRef = useRef(setAuthRequired);

	// Update refs when setters change
	useEffect(() => {
		showAuthDialogRef.current = setShowAuthDialog;
		isAuthenticatedRef.current = setIsAuthenticated;
		authErrorRef.current = setAuthError;
		authRequiredRef.current = setAuthRequired;
	}, []);

	// Create QueryClient with global error handler for 401 errors
	const queryClient = useMemo(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: {
						refetchInterval: REFRESH_INTERVALS.default,
						staleTime: QUERY_CONFIG.staleTime,
						retry: (failureCount, error) => {
							// Don't retry a refusal: 401 (no valid key) or 403 (a valid
							// key, or a request, the server will not allow). Retrying
							// cannot change either answer (SB23-3746).
							if (
								error instanceof HttpError &&
								(error.status === 401 || error.status === 403)
							) {
								return false;
							}
							return failureCount < 2;
						},
					},
					mutations: {
						retry: false,
					},
				},
				queryCache: new QueryCache({
					onError: (error) => {
						// Show auth dialog on any 401 error
						if (error instanceof HttpError && error.status === 401) {
							console.log("[App] 401 error in query - showing auth dialog");
							api.clearApiKey();
							authErrorRef.current(null); // Clear any previous errors
							isAuthenticatedRef.current(false);
							authRequiredRef.current(true);
							showAuthDialogRef.current(true);
						}
					},
				}),
				mutationCache: new MutationCache({
					onError: (error) => {
						// Show auth dialog on any 401 error
						if (error instanceof HttpError && error.status === 401) {
							console.log("[App] 401 error in mutation - showing auth dialog");
							api.clearApiKey();
							authErrorRef.current(null); // Clear any previous errors
							isAuthenticatedRef.current(false);
							authRequiredRef.current(true);
							showAuthDialogRef.current(true);
						}
					},
				}),
			}),
		[],
	);

	// Check if authentication is required
	useEffect(() => {
		const checkAuth = async () => {
			// Subsequent navigation verifies auth without unmounting page state.

			// Always verify with a test request, even if we have a stored key
			// The stored key might be invalid, deleted, or expired
			try {
				await runAuthProbe({
					probe: async () => {
						if (isUsagePage) {
							const session = await api.get<{
								canManage: boolean;
								apiKeyId: string | null;
							}>("/api/auth/session");
							queryClient.setQueryData(["auth-session"], session);
							setCanManage(session.canManage);
						} else {
							await api.getStats();
							setCanManage(true);
						}
					},
					hasStoredKey: () => !!api.getApiKey(),
					clearApiKey: () => api.clearApiKey(),
					setIsAuthenticated,
					setAuthRequired,
					setAuthError,
					setShowAuthDialog,
					repromptOn403: !isUsagePage,
					onOtherFailure: () => {
						if (isUsagePage) {
							setCanManage(false);
							// The page presents missing-key and permission errors itself.
							setIsAuthenticated(true);
						}
					},
				});
			} finally {
				setIsCheckingAuth(false);
			}
		};

		checkAuth();
	}, [isUsagePage, queryClient]);

	// Listen for 401 errors from API client
	useEffect(() => {
		const handleAuthRequired = () => {
			api.clearApiKey();
			setAuthError(null);
			setIsAuthenticated(false);
			setAuthRequired(true);
			setShowAuthDialog(true);
		};

		window.addEventListener("auth-required", handleAuthRequired);
		return () =>
			window.removeEventListener("auth-required", handleAuthRequired);
	}, []);

	const handleAuthenticate = async (apiKey: string): Promise<boolean> => {
		setAuthError(null);

		// Store the API key
		api.setApiKey(apiKey);

		// Try to make a request to verify the key
		try {
			if (isUsagePage) {
				const session = await api.get<{
					canManage: boolean;
					apiKeyId: string | null;
				}>("/api/auth/session");
				setCanManage(session.canManage);
			} else {
				await api.getStats();
				setCanManage(true);
			}
			queryClient.clear();
			setIsAuthenticated(true);
			setShowAuthDialog(false);
			return true;
		} catch (error) {
			// Invalid API key or insufficient permissions, clear it
			api.clearApiKey();
			// Use the actual error message from the server if available
			const errorMessage =
				error instanceof Error ? error.message : "Invalid API key";
			setAuthError(errorMessage);
			return false;
		}
	};

	const handleLogout = () => {
		queryClient.clear();
		api.clearApiKey();
		setIsAuthenticated(false);
		setShowAuthDialog(true);
	};

	const handleToggleSidebarCollapse = () => {
		const newCollapsed = !isSidebarCollapsed;
		setIsSidebarCollapsed(newCollapsed);
		localStorage.setItem("ccflare-sidebar-collapsed", String(newCollapsed));
	};

	// Show loading state while checking authentication
	if (isCheckingAuth) {
		return (
			<QueryClientProvider client={queryClient}>
				<ThemeProvider>
					<div className="min-h-screen bg-background flex items-center justify-center">
						<div className="text-center">
							<div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4" />
							<p className="text-muted-foreground">
								Checking authentication...
							</p>
						</div>
					</div>
				</ThemeProvider>
			</QueryClientProvider>
		);
	}

	// Kiosk view: an ambient fullscreen display for the pool capacity section,
	// rendered here rather than as an entry in `routes` above, and that is
	// load-bearing rather than stylistic. Everything in `routes` renders INSIDE
	// the shell -- sidebar, page header, content padding -- which is exactly the
	// chrome a kiosk must not have. Adding /kiosk to the array and letting it
	// render through <Routes> would also put it behind the `currentRoute` header
	// lookup, which expects every route to have a title and subtitle to display.
	//
	// The auth gate still applies (the kiosk reads /api/accounts like any other
	// view), so this sits after the isCheckingAuth return and renders the auth
	// dialog when a key is needed.
	if (location.pathname === "/kiosk") {
		return (
			<QueryClientProvider client={queryClient}>
				<ThemeProvider>
					{isAuthenticated ? (
						<KioskTab />
					) : (
						<div className="min-h-screen bg-background" />
					)}
					<ApiKeyAuthDialog
						isOpen={showAuthDialog}
						onAuthenticate={handleAuthenticate}
						error={authError}
					/>
				</ThemeProvider>
			</QueryClientProvider>
		);
	}

	return (
		<QueryClientProvider client={queryClient}>
			<ThemeProvider>
				<NotificationsProvider onNavigate={navigate}>
					<div className="min-h-screen bg-background">
						<Navigation
							canManage={isAuthenticated && canManage}
							onLogout={authRequired ? handleLogout : undefined}
							isCollapsed={isSidebarCollapsed}
							onToggleCollapse={handleToggleSidebarCollapse}
						/>

						{/* Main Content */}
						<main
							className={cn(
								"transition-all duration-300",
								isSidebarCollapsed ? "lg:pl-16" : "lg:pl-64",
							)}
						>
							{/* Mobile spacer */}
							<div className="h-16 lg:hidden" />

							{/* Page Content */}
							<div className="p-4 md:p-6 lg:p-8 max-w-[1600px] mx-auto">
								{/* Page Header */}
								<div className="mb-8">
									<h1 className="text-3xl font-bold gradient-text">
										{currentRoute.title}
									</h1>
									<p className="text-muted-foreground mt-2">
										{currentRoute.subtitle}
									</p>
								</div>

								{/* Tab Content - Only render if auth check is complete and user is authenticated */}
								{!isCheckingAuth && isAuthenticated && (
									<div className="animate-in fade-in-0 duration-200">
										<Routes>
											<Route
												path="/api-keys/*"
												element={<LegacyApiKeyUsageRedirect />}
											/>
											{routes.map((route) => (
												<Route
													key={route.path}
													path={route.path}
													element={route.element}
												/>
											))}
											<Route path="*" element={<Navigate to="/" replace />} />
										</Routes>
									</div>
								)}
							</div>
						</main>
					</div>
					{/* Notification sources poll only once the API answers: before
				    that they would 401 and reopen the auth dialog in a loop. */}
					{isAuthenticated && <NotificationWatcher />}
				</NotificationsProvider>
				<DebugPanel />

				{/* API Key Authentication Dialog */}
				<ApiKeyAuthDialog
					isOpen={showAuthDialog}
					onAuthenticate={handleAuthenticate}
					error={authError}
				/>
			</ThemeProvider>
		</QueryClientProvider>
	);
}
