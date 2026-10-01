import { describe, expect, test } from "bun:test";
import {
	DEFAULT_NOTIFICATION_PREFS,
	getPermissionState,
	type KeyValueStorage,
	loadNotificationPrefs,
	type NotificationApi,
	type NotificationEnv,
	PREFS_STORAGE_KEY,
	requestNotificationPermission,
	saveNotificationPrefs,
	showBrowserNotification,
} from "../notifications";

interface FakeOptions {
	permission?: string;
	/** What requestPermission does. */
	request?: "promise" | "callback" | "reject" | "throw";
	answer?: string;
	constructorThrows?: boolean;
}

/** A fake `Notification` constructor recording what it was asked to do. */
function fakeNotification(opts: FakeOptions = {}) {
	const created: Array<{ title: string; options?: NotificationOptions }> = [];
	let requests = 0;
	const Fake = function (
		this: { onclick: unknown; close: () => void },
		title: string,
		options?: NotificationOptions,
	) {
		if (opts.constructorThrows) throw new TypeError("Illegal constructor");
		created.push({ title, options });
		this.onclick = null;
		this.close = () => {};
	} as unknown as NotificationApi & { permission: string };
	Object.defineProperty(Fake, "permission", {
		get: () => opts.permission ?? "default",
	});
	(Fake as unknown as { requestPermission: unknown }).requestPermission = (
		callback?: (p: string) => void,
	) => {
		requests += 1;
		switch (opts.request ?? "promise") {
			case "callback":
				callback?.(opts.answer ?? "granted");
				return undefined;
			case "reject":
				return Promise.reject(new Error("blocked"));
			case "throw":
				throw new Error("not allowed");
			default:
				return Promise.resolve(opts.answer ?? "granted");
		}
	};
	return {
		Fake,
		created,
		get requests() {
			return requests;
		},
	};
}

function env(opts: FakeOptions = {}, secure = true) {
	const fake = fakeNotification(opts);
	const e: NotificationEnv = {
		Notification: fake.Fake,
		isSecureContext: secure,
	};
	return { env: e, fake };
}

describe("permission state", () => {
	test("no Notification API is unsupported", () => {
		expect(getPermissionState({ isSecureContext: true })).toBe("unsupported");
	});

	test("an insecure origin is reported as such, before anything else", () => {
		expect(getPermissionState(env({ permission: "denied" }, false).env)).toBe(
			"insecure",
		);
	});

	test("granted, denied and default pass through; anything else is default", () => {
		expect(getPermissionState(env({ permission: "granted" }).env)).toBe(
			"granted",
		);
		expect(getPermissionState(env({ permission: "denied" }).env)).toBe(
			"denied",
		);
		expect(getPermissionState(env({ permission: "default" }).env)).toBe(
			"default",
		);
		expect(getPermissionState(env({ permission: "prompt" }).env)).toBe(
			"default",
		);
	});
});

describe("requesting permission", () => {
	test("the promise form resolves to the browser's answer", async () => {
		const { env: e, fake } = env({ answer: "granted" });
		expect(await requestNotificationPermission(e)).toBe("granted");
		expect(fake.requests).toBe(1);
	});

	test("the legacy callback form also resolves", async () => {
		const { env: e } = env({ request: "callback", answer: "denied" });
		expect(await requestNotificationPermission(e)).toBe("denied");
	});

	test("a rejecting or throwing request resolves to denied, never rejects", async () => {
		expect(
			await requestNotificationPermission(env({ request: "reject" }).env),
		).toBe("denied");
		expect(
			await requestNotificationPermission(env({ request: "throw" }).env),
		).toBe("denied");
	});

	test("an already-decided permission is not asked again", async () => {
		const denied = env({ permission: "denied" });
		expect(await requestNotificationPermission(denied.env)).toBe("denied");
		expect(denied.fake.requests).toBe(0);
		const granted = env({ permission: "granted" });
		expect(await requestNotificationPermission(granted.env)).toBe("granted");
		expect(granted.fake.requests).toBe(0);
	});

	test("unsupported and insecure environments never call the API", async () => {
		expect(await requestNotificationPermission({})).toBe("unsupported");
		const insecure = env({}, false);
		expect(await requestNotificationPermission(insecure.env)).toBe("insecure");
		expect(insecure.fake.requests).toBe(0);
	});
});

describe("showing a notification", () => {
	const message = { title: "t", body: "b", tag: "tag-1" };

	test("granted: the browser receives title, body and tag", () => {
		const { env: e, fake } = env({ permission: "granted" });
		expect(showBrowserNotification(e, message)).toBe(true);
		expect(fake.created).toHaveLength(1);
		expect(fake.created[0].title).toBe("t");
		expect(fake.created[0].options?.body).toBe("b");
		expect(fake.created[0].options?.tag).toBe("tag-1");
	});

	test("not granted: nothing is constructed", () => {
		for (const permission of ["default", "denied"]) {
			const { env: e, fake } = env({ permission });
			expect(showBrowserNotification(e, message)).toBe(false);
			expect(fake.created).toHaveLength(0);
		}
	});

	test("a constructor that throws (Chrome on Android) returns false", () => {
		const { env: e } = env({ permission: "granted", constructorThrows: true });
		expect(() => showBrowserNotification(e, message)).not.toThrow();
		expect(showBrowserNotification(e, message)).toBe(false);
	});
});

describe("preferences", () => {
	function storage(initial?: string): KeyValueStorage & {
		map: Map<string, string>;
	} {
		const map = new Map<string, string>();
		if (initial !== undefined) map.set(PREFS_STORAGE_KEY, initial);
		return {
			map,
			getItem: (k) => map.get(k) ?? null,
			setItem: (k, v) => {
				map.set(k, v);
			},
			removeItem: (k) => {
				map.delete(k);
			},
		};
	}

	test("defaults: off, every category on", () => {
		expect(loadNotificationPrefs(storage())).toEqual(
			DEFAULT_NOTIFICATION_PREFS,
		);
		expect(loadNotificationPrefs(null)).toEqual(DEFAULT_NOTIFICATION_PREFS);
	});

	test("a saved choice survives a reload", () => {
		const s = storage();
		saveNotificationPrefs(s, {
			enabled: true,
			categories: {
				serviceOutage: false,
				rateLimit: true,
				accountHealth: false,
				errorBurst: true,
			},
		});
		const loaded = loadNotificationPrefs(s);
		expect(loaded.enabled).toBe(true);
		expect(loaded.categories.serviceOutage).toBe(false);
		expect(loaded.categories.accountHealth).toBe(false);
		expect(loaded.categories.rateLimit).toBe(true);
	});

	test("corrupt or mistyped values fall back field by field", () => {
		expect(loadNotificationPrefs(storage("{nope"))).toEqual(
			DEFAULT_NOTIFICATION_PREFS,
		);
		const loaded = loadNotificationPrefs(
			storage(
				JSON.stringify({
					enabled: "yes",
					categories: { serviceOutage: false, rateLimit: "no", bogus: true },
				}),
			),
		);
		expect(loaded.enabled).toBe(false);
		expect(loaded.categories.serviceOutage).toBe(false);
		expect(loaded.categories.rateLimit).toBe(true);
		expect("bogus" in loaded.categories).toBe(false);
	});

	test("storage that throws never reaches the caller", () => {
		const hostile: KeyValueStorage = {
			getItem: () => {
				throw new Error("SecurityError");
			},
			setItem: () => {
				throw new Error("QuotaExceededError");
			},
			removeItem: () => {
				throw new Error("SecurityError");
			},
		};
		expect(loadNotificationPrefs(hostile)).toEqual(DEFAULT_NOTIFICATION_PREFS);
		expect(() =>
			saveNotificationPrefs(hostile, DEFAULT_NOTIFICATION_PREFS),
		).not.toThrow();
	});
});
