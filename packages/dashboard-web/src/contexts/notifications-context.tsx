import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
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

	// Permission can change behind the page's back, in the browser's site
	// settings. Re-read it whenever the page becomes visible again.
	useEffect(() => {
		if (typeof document === "undefined") return;
		const refresh = () => setPermission(getPermissionState(env));
		document.addEventListener("visibilitychange", refresh);
		window.addEventListener("focus", refresh);
		return () => {
			document.removeEventListener("visibilitychange", refresh);
			window.removeEventListener("focus", refresh);
		};
	}, [env]);

	const update = useCallback(
		(next: NotificationPrefs) => {
			setPrefs(next);
			saveNotificationPrefs(storage, next);
		},
		[storage],
	);

	const clearAllBaselines = useCallback(() => {
		for (const category of NOTIFICATION_CATEGORIES) {
			clearBaseline(storage, category);
		}
	}, [storage]);

	const enable = useCallback(async () => {
		const result = await requestNotificationPermission(env);
		setPermission(result);
		if (result === "granted") {
			// Fresh baselines: the first reading after switching on is the
			// reference, not a transition.
			clearAllBaselines();
			update({ ...prefs, enabled: true });
		}
		return result;
	}, [env, prefs, update, clearAllBaselines]);

	const disable = useCallback(() => {
		clearAllBaselines();
		update({ ...prefs, enabled: false });
	}, [prefs, update, clearAllBaselines]);

	const setCategory = useCallback(
		(category: NotificationCategory, on: boolean) => {
			clearBaseline(storage, category);
			update({ ...prefs, categories: { ...prefs.categories, [category]: on } });
		},
		[prefs, storage, update],
	);

	const notify = useCallback(
		(message: NotificationMessage) =>
			showBrowserNotification(env, message, (path) => {
				try {
					window.focus();
				} catch {
					// Some browsers refuse focus from a notification; harmless.
				}
				if (path) onNavigate?.(path);
			}),
		[env, onNavigate],
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
