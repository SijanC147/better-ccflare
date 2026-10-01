import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { clearBaseline } from "../lib/notification-events";
import {
	browserNotificationEnv,
	browserStorage,
	getPermissionState,
	type KeyValueStorage,
	loadNotificationPrefs,
	NOTIFICATION_CATEGORIES,
	type NotificationCategory,
	type NotificationEnv,
	type NotificationMessage,
	type NotificationPermissionState,
	type NotificationPrefs,
	PREFS_STORAGE_KEY,
	requestNotificationPermission,
	saveNotificationPrefs,
	showBrowserNotification,
} from "../lib/notifications";

interface NotificationsContextValue {
	prefs: NotificationPrefs;
	permission: NotificationPermissionState;
	/** True when notifications can be sent right now. */
	active: boolean;
	/** Ask for permission, from a click, and switch notifications on if granted. */
	enable: () => Promise<NotificationPermissionState>;
	disable: () => void;
	setCategory: (category: NotificationCategory, on: boolean) => void;
	/** Show one notification; false when the browser did not accept it. */
	notify: (message: NotificationMessage) => boolean;
	storage: KeyValueStorage | null;
}

const NotificationsContext = createContext<NotificationsContextValue | null>(
	null,
);

interface NotificationsProviderProps {
	children: ReactNode;
	/** Overridable for tests; defaults to the real browser. */
	env?: NotificationEnv;
	storage?: KeyValueStorage | null;
	/** Called with a notification's dashboard path when it is clicked. */
	onNavigate?: (path: string) => void;
}

export function NotificationsProvider({
	children,
	env: envProp,
	storage: storageProp,
	onNavigate,
}: NotificationsProviderProps) {
	const env = useMemo(() => envProp ?? browserNotificationEnv(), [envProp]);
	const storage = useMemo(
		() => (storageProp === undefined ? browserStorage() : storageProp),
		[storageProp],
	);
	const [prefs, setPrefs] = useState<NotificationPrefs>(() =>
		loadNotificationPrefs(storage),
	);
	const [permission, setPermission] = useState<NotificationPermissionState>(
		() => getPermissionState(env),
	);
	// The latest values, for handlers that run after an await or from a
	// browser event: a closure over `prefs` taken at click time would write
	// back a category switched while the permission prompt was open.
	const prefsRef = useRef(prefs);
	const permissionRef = useRef(permission);
	const onNavigateRef = useRef(onNavigate);
	onNavigateRef.current = onNavigate;

	const clearAllBaselines = useCallback(() => {
		for (const category of NOTIFICATION_CATEGORIES) {
			clearBaseline(storage, category);
		}
	}, [storage]);

	const applyPermission = useCallback(
		(next: NotificationPermissionState) => {
			// Granted again after being revoked in site settings: start from
			// fresh baselines, as `enable` does, rather than announcing what
			// changed while notifications could not be shown. Cleared before
			// the state update, because the watcher's effects run before this
			// provider's and would otherwise diff against the old baselines.
			if (next === "granted" && permissionRef.current !== "granted") {
				clearAllBaselines();
			}
			permissionRef.current = next;
			setPermission(next);
		},
		[clearAllBaselines],
	);

	// Permission can change behind the page's back, in the browser's site
	// settings. Re-read it whenever the page becomes visible again.
	useEffect(() => {
		if (typeof document === "undefined") return;
		const refresh = () => applyPermission(getPermissionState(env));
		document.addEventListener("visibilitychange", refresh);
		window.addEventListener("focus", refresh);
		return () => {
			document.removeEventListener("visibilitychange", refresh);
			window.removeEventListener("focus", refresh);
		};
	}, [env, applyPermission]);

	// Another tab changed the preferences. Without this, a tab still holding
	// the old choice keeps evaluating on it until it reloads.
	useEffect(() => {
		if (typeof window === "undefined") return;
		const onStorage = (event: StorageEvent) => {
			if (event.key !== null && event.key !== PREFS_STORAGE_KEY) return;
			const next = loadNotificationPrefs(storage);
			prefsRef.current = next;
			setPrefs(next);
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, [storage]);

	const update = useCallback(
		(change: (current: NotificationPrefs) => NotificationPrefs) => {
			const next = change(prefsRef.current);
			prefsRef.current = next;
			setPrefs(next);
			saveNotificationPrefs(storage, next);
		},
		[storage],
	);

	const enable = useCallback(async () => {
		const result = await requestNotificationPermission(env);
		if (result === "granted") {
			// Fresh baselines: the first reading after switching on is the
			// reference, not a transition.
			clearAllBaselines();
			update((current) => ({ ...current, enabled: true }));
		}
		applyPermission(result);
		return result;
	}, [env, update, clearAllBaselines, applyPermission]);

	const disable = useCallback(() => {
		clearAllBaselines();
		update((current) => ({ ...current, enabled: false }));
	}, [update, clearAllBaselines]);

	const setCategory = useCallback(
		(category: NotificationCategory, on: boolean) => {
			clearBaseline(storage, category);
			update((current) => ({
				...current,
				categories: { ...current.categories, [category]: on },
			}));
		},
		[storage, update],
	);

	// Stable across navigation: `useNavigate` changes identity on every route
	// change, and a new `notify` would re-run every source's evaluation.
	const notify = useCallback(
		(message: NotificationMessage) =>
			showBrowserNotification(env, message, (path) => {
				try {
					window.focus();
				} catch {
					// Some browsers refuse focus from a notification; harmless.
				}
				if (path) onNavigateRef.current?.(path);
			}),
		[env],
	);

	const value = useMemo<NotificationsContextValue>(
		() => ({
			prefs,
			permission,
			active: prefs.enabled && permission === "granted",
			enable,
			disable,
			setCategory,
			notify,
			storage,
		}),
		[prefs, permission, enable, disable, setCategory, notify, storage],
	);

	return (
		<NotificationsContext.Provider value={value}>
			{children}
		</NotificationsContext.Provider>
	);
}

export function useNotifications(): NotificationsContextValue {
	const value = useContext(NotificationsContext);
	if (!value) {
		throw new Error(
			"useNotifications must be used inside NotificationsProvider",
		);
	}
	return value;
}
