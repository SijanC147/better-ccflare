import {
	type QueryClient,
	type QueryKey,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useNotifications } from "../../contexts/notifications-context";
import {
	accountsQueryOptions,
	alertsQueryOptions,
	serviceStatusQueryOptions,
} from "../../hooks/queries";
import {
	evaluateCategory,
	MESSAGE_BUILDERS,
	type Observation,
	observeAccountHealth,
	observeErrorBursts,
	observeRateLimits,
	observeServiceStatus,
} from "../../lib/notification-events";
import type { NotificationCategory } from "../../lib/notifications";

/**
 * Keeps the notification sources fresh while notifications are on, and turns
 * each fresh reading into notifications (SB23-2598).
 *
 * Mounted once, in the authenticated shell, so it runs on every page. It adds
 * no endpoint and no server-side poller: it reads the same three queries the
 * pages already poll, at their existing cadence. What it changes is when they
 * are polled. The page hooks stop in a hidden tab and service status is only
 * mounted on Overview, which would leave a notification feature that only
 * fires while someone is already looking at the page. The kiosk view made the
 * same trade for accounts, through `AccountsQueryOptions.backgroundRefresh`.
 *
 * Polling goes through `refreshIfStale` rather than a second `refetchInterval`
 * observer. Two observers on one query each run their own interval timer, so
 * a page that already polls would double its requests; refreshing only when
 * the cached reading is older than the cadence fetches nothing extra while a
 * page keeps it fresh, and keeps it fresh itself when nothing else does.
 */
export function NotificationWatcher() {
	const { active, prefs } = useNotifications();
	if (!active) return null;
	const watchAccounts =
		prefs.categories.rateLimit || prefs.categories.accountHealth;
	return (
		<>
			{prefs.categories.serviceOutage ? <ServiceStatusSource /> : null}
			{watchAccounts ? <AccountsSource /> : null}
			{prefs.categories.errorBurst ? <AlertsSource /> : null}
		</>
	);
}

interface RefreshableOptions {
	queryKey: QueryKey;
	queryFn: () => Promise<unknown>;
}

/**
 * Fetch a query only when its cached reading is older than `maxAgeMs`, or
 * missing. Resolves to whether a fetch was started; never rejects.
 */
export async function refreshIfStale(
	queryClient: QueryClient,
	options: RefreshableOptions,
	maxAgeMs: number,
	now: number = Date.now(),
): Promise<boolean> {
	const state = queryClient.getQueryState(options.queryKey);
	if (
		state &&
		state.dataUpdatedAt > 0 &&
		now - state.dataUpdatedAt <= maxAgeMs
	) {
		return false;
	}
	try {
		await queryClient.fetchQuery({ ...options, staleTime: 0 });
	} catch {
		// The page's own query surfaces the error; a notification source just
		// waits for the next tick.
	}
	return true;
}

/** Check every half cadence, fetch when the reading is a cadence old. */
function useKeepFresh(options: RefreshableOptions, cadenceMs: number) {
	const queryClient = useQueryClient();
	const optionsRef = useRef(options);
	optionsRef.current = options;
	useEffect(() => {
		const tick = () => {
			void refreshIfStale(queryClient, optionsRef.current, cadenceMs);
		};
		const id = setInterval(tick, Math.max(1_000, Math.round(cadenceMs / 2)));
		return () => clearInterval(id);
	}, [queryClient, cadenceMs]);
}

/** Evaluate categories each time their source records a successful fetch. */
function useEvaluate(
	dataUpdatedAt: number,
	readings: () => Array<[NotificationCategory, Observation]>,
) {
	const { prefs, storage, notify } = useNotifications();
	const readingsRef = useRef(readings);
	readingsRef.current = readings;
	useEffect(() => {
		// `dataUpdatedAt` rather than `data`: React Query keeps the same `data`
		// reference when a refetch returns equal JSON, and an account's
		// `rateLimitedUntil` passing is a transition with identical data.
		if (dataUpdatedAt === 0) return;
		for (const [category, observation] of readingsRef.current()) {
			evaluateCategory({
				category,
				observation,
				prefs,
				storage,
				notify,
				build: MESSAGE_BUILDERS[category],
			});
		}
	}, [dataUpdatedAt, prefs, storage, notify]);
}

function ServiceStatusSource() {
	const options = serviceStatusQueryOptions();
	const { data, dataUpdatedAt } = useQuery({
		...options,
		refetchInterval: false,
	});
	useKeepFresh(options, options.refetchInterval);
	useEvaluate(dataUpdatedAt, () => [
		["serviceOutage", observeServiceStatus(data)],
	]);
	return null;
}

function AccountsSource() {
	const options = accountsQueryOptions();
	const { data, dataUpdatedAt } = useQuery({
		...options,
		refetchInterval: false,
	});
	useKeepFresh(options, options.refetchInterval);
	useEvaluate(dataUpdatedAt, () => {
		const now = Date.now();
		return [
			["rateLimit", observeRateLimits(data, now)],
			["accountHealth", observeAccountHealth(data, now)],
		];
	});
	return null;
}

function AlertsSource() {
	const options = alertsQueryOptions();
	const { data, dataUpdatedAt } = useQuery({
		...options,
		refetchInterval: false,
	});
	useKeepFresh(options, options.refetchInterval);
	useEvaluate(dataUpdatedAt, () => [
		["errorBurst", observeErrorBursts(data?.alerts)],
	]);
	return null;
}
