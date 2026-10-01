/**
 * Browser notification manager for the dashboard (SB23-2598).
 *
 * Everything that touches the Web Notifications API or browser storage lives
 * here, and every one of those touches is wrapped: the API is missing on some
 * browsers, `new Notification()` throws "Illegal constructor" on Chrome for
 * Android (it needs a service worker there), `requestPermission` still has a
 * callback form on older Safari, and `localStorage` throws in a private window
 * or when site data is blocked. None of that may reach a render.
 *
 * The browser environment is passed in rather than read from globals so the
 * tests can describe "unsupported", "insecure" and "denied" without
 * monkey-patching `globalThis`, which happy-dom may or may not populate.
 */

/** The notification categories, in the order the control page lists them. */
export const NOTIFICATION_CATEGORIES = [
	"serviceOutage",
	"rateLimit",
	"accountHealth",
	"errorBurst",
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export interface NotificationCategoryInfo {
	id: NotificationCategory;
	label: string;
	description: string;
	/** What the dashboard reads to detect a transition, shown on the page. */
	source: string;
}

export const NOTIFICATION_CATALOGUE: Record<
	NotificationCategory,
	NotificationCategoryInfo
> = {
	serviceOutage: {
		id: "serviceOutage",
		label: "Claude service outages",
		description:
			"When status.claude.com reports the Claude API or Claude Code degraded or down, and when it recovers.",
		source: "GET /api/service-status, every 2 minutes",
	},
	rateLimit: {
		id: "rateLimit",
		label: "Rate limits and quota exhaustion",
		description:
			"When an account is rate-limited or exhausts its usage quota, when every routable account is limited at once, and when they clear.",
		source: "GET /api/accounts, every minute",
	},
	accountHealth: {
		id: "accountHealth",
		label: "Account health",
		description:
			"When an account needs re-authentication, is paused after refresh failures, or is benched after upstream errors, and when it recovers.",
		source: "GET /api/accounts, every minute",
	},
	errorBurst: {
		id: "errorBurst",
		label: "Upstream error bursts",
		description:
			"When the alert engine raises an upstream error alert: three errors of one status class on one account inside 15 minutes.",
		source: "GET /api/insights/alerts, every 30 seconds",
	},
};

export interface NotificationPrefs {
	/** Master switch. Nothing is sent while it is off. */
	enabled: boolean;
	categories: Record<NotificationCategory, boolean>;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
	enabled: false,
	categories: {
		serviceOutage: true,
		rateLimit: true,
		accountHealth: true,
		errorBurst: true,
	},
};

export const PREFS_STORAGE_KEY = "better-ccflare:notifications:prefs";
const BASELINE_STORAGE_PREFIX = "better-ccflare:notifications:baseline:";

export function baselineStorageKey(category: NotificationCategory): string {
	return `${BASELINE_STORAGE_PREFIX}${category}`;
}

/** The subset of `Storage` used here, so a test can pass a plain map. */
export interface KeyValueStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

/**
 * The page's localStorage, or null when reading the property itself throws.
 * Some browsers throw on the property access, not only on the calls.
 */
export function browserStorage(): KeyValueStorage | null {
	try {
		return typeof window !== "undefined" ? window.localStorage : null;
	} catch {
		return null;
	}
}

export function readJson(
	storage: KeyValueStorage | null,
	key: string,
): unknown | undefined {
	if (!storage) return undefined;
	try {
		const raw = storage.getItem(key);
		if (raw === null) return undefined;
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

export function writeJson(
	storage: KeyValueStorage | null,
	key: string,
	value: unknown,
): void {
	if (!storage) return;
	try {
		storage.setItem(key, JSON.stringify(value));
	} catch {
		// Quota or blocked storage: the preference lasts for this page only.
	}
}

export function removeKey(storage: KeyValueStorage | null, key: string): void {
	if (!storage) return;
	try {
		storage.removeItem(key);
	} catch {
		// Blocked storage: nothing was persisted, so nothing is left behind.
	}
}

/**
 * Stored preferences, merged over the defaults one field at a time. A value
 * of the wrong type falls back to its default rather than discarding the
 * whole record, and a category the page no longer knows is ignored.
 */
export function loadNotificationPrefs(
	storage: KeyValueStorage | null,
): NotificationPrefs {
	const stored = readJson(storage, PREFS_STORAGE_KEY);
	const prefs: NotificationPrefs = {
		enabled: DEFAULT_NOTIFICATION_PREFS.enabled,
		categories: { ...DEFAULT_NOTIFICATION_PREFS.categories },
	};
	if (typeof stored !== "object" || stored === null) return prefs;
	const record = stored as Record<string, unknown>;
	if (typeof record.enabled === "boolean") prefs.enabled = record.enabled;
	const categories = record.categories;
	if (typeof categories === "object" && categories !== null) {
		for (const id of NOTIFICATION_CATEGORIES) {
			const value = (categories as Record<string, unknown>)[id];
			if (typeof value === "boolean") prefs.categories[id] = value;
		}
	}
	return prefs;
}

export function saveNotificationPrefs(
	storage: KeyValueStorage | null,
	prefs: NotificationPrefs,
): void {
	writeJson(storage, PREFS_STORAGE_KEY, prefs);
}

/**
 * Where the browser stands on notifications.
 *
 * `insecure` is separate from `unsupported` because it has a remedy: the API
 * exists only on HTTPS and localhost, and this dashboard is often opened over
 * plain HTTP on a LAN address, where Chrome reports `denied` without ever
 * asking. Saying "denied" there would send the operator to browser settings
 * that cannot fix it.
 */
export type NotificationPermissionState =
	| "unsupported"
	| "insecure"
	| "default"
	| "granted"
	| "denied";

/** The constructor surface used here, matching the DOM's `Notification`. */
export interface NotificationApi {
	readonly permission: string;
	requestPermission(
		callback?: (permission: string) => void,
	): Promise<string> | undefined;
	new (title: string, options?: NotificationOptions): BrowserNotification;
}

export interface BrowserNotification {
	onclick: ((this: unknown, event: Event) => unknown) | null;
	close(): void;
}

export interface NotificationEnv {
	Notification?: NotificationApi | undefined;
	isSecureContext?: boolean | undefined;
}

/** The real browser environment, read defensively. */
export function browserNotificationEnv(): NotificationEnv {
	try {
		const scope = globalThis as unknown as {
			Notification?: NotificationApi | undefined;
			isSecureContext?: boolean | undefined;
		};
		return {
			Notification:
				typeof scope.Notification === "function"
					? scope.Notification
					: undefined,
			isSecureContext: scope.isSecureContext,
		};
	} catch {
		return {};
	}
}

function normalisePermission(value: unknown): NotificationPermissionState {
	if (value === "granted" || value === "denied") return value;
	return "default";
}

export function getPermissionState(
	env: NotificationEnv,
): NotificationPermissionState {
	if (env.isSecureContext === false) return "insecure";
	if (!env.Notification) return "unsupported";
	try {
		return normalisePermission(env.Notification.permission);
	} catch {
		return "unsupported";
	}
}

/**
 * Ask for permission. Call this only from a click handler: browsers block, or
 * permanently quiet, a prompt raised without a user gesture.
 *
 * Supports both the promise form and the legacy callback form, and resolves
 * to a state rather than ever rejecting.
 */
export async function requestNotificationPermission(
	env: NotificationEnv,
): Promise<NotificationPermissionState> {
	const before = getPermissionState(env);
	if (before === "unsupported" || before === "insecure") return before;
	if (before === "granted" || before === "denied") return before;
	const api = env.Notification;
	if (!api) return "unsupported";
	try {
		const result = await new Promise<string>((resolve) => {
			const maybePromise = api.requestPermission((permission) =>
				resolve(permission),
			);
			if (maybePromise && typeof maybePromise.then === "function") {
				maybePromise.then(resolve, () => resolve("denied"));
			}
		});
		return normalisePermission(result);
	} catch {
		return "denied";
	}
}

export interface NotificationMessage {
	title: string;
	body: string;
	/**
	 * Deterministic for one transition, so two dashboard tabs that both see it
	 * produce one notification: the browser replaces a notification carrying
	 * the same tag instead of stacking a second.
	 */
	tag: string;
	/** Dashboard path to open when the notification is clicked. */
	path?: string | undefined;
}

export type Notifier = (message: NotificationMessage) => boolean;

/**
 * Show one notification. Returns whether the browser accepted it; never
 * throws.
 */
export function showBrowserNotification(
	env: NotificationEnv,
	message: NotificationMessage,
	onClick?: (path: string | undefined) => void,
): boolean {
	if (getPermissionState(env) !== "granted") return false;
	const api = env.Notification;
	if (!api) return false;
	try {
		const notification = new api(message.title, {
			body: message.body,
			tag: message.tag,
			icon: "/favicon.svg",
		});
		notification.onclick = () => {
			try {
				onClick?.(message.path);
				notification.close();
			} catch {
				// A click handler failing must not surface as an uncaught error.
			}
		};
		return true;
	} catch {
		return false;
	}
}
