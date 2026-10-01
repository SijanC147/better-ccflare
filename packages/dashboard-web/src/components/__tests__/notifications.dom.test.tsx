// A side-effect import first, because the App graph reads the DOM at load
// and biome's import sorting would otherwise move the named import from
// test/dom below it: measured, that left a module initialised without a DOM
// and broke OpenAIGatewaysCard.test.tsx later in the same process.
import "../../test/dom";
import { afterEach, describe, expect, test } from "bun:test";
import type { AccountResponse } from "@better-ccflare/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { App } from "../../App";
import { NotificationsProvider } from "../../contexts/notifications-context";
import { ThemeProvider } from "../../contexts/theme-context";
import {
	baselineStorageKey,
	DEFAULT_NOTIFICATION_PREFS,
	type KeyValueStorage,
	type NotificationApi,
	type NotificationEnv,
	PREFS_STORAGE_KEY,
} from "../../lib/notifications";
import { queryKeys } from "../../lib/query-keys";
import { byText, click, mount } from "../../test/dom";
import { NotificationsTab } from "../NotificationsTab";
import { Navigation } from "../navigation";
import {
	NotificationWatcher,
	refreshIfStale,
} from "../notifications/NotificationWatcher";

function memoryStorage(
	initial: Record<string, unknown> = {},
): KeyValueStorage & { map: Map<string, string> } {
	const map = new Map<string, string>();
	for (const [k, v] of Object.entries(initial)) map.set(k, JSON.stringify(v));
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

function fakeEnv(permission: string, answer = "granted", gate?: Promise<void>) {
	const created: string[] = [];
	let requests = 0;
	let current = permission;
	const Fake = function (this: Record<string, unknown>, title: string) {
		created.push(title);
		this.onclick = null;
		this.close = () => {};
	} as unknown as NotificationApi;
	Object.defineProperty(Fake, "permission", { get: () => current });
	(Fake as unknown as { requestPermission: unknown }).requestPermission =
		async () => {
			requests += 1;
			// A gate holds the browser prompt open until the test releases it.
			if (gate) await gate;
			current = answer;
			return answer;
		};
	const env: NotificationEnv = { Notification: Fake, isSecureContext: true };
	return {
		env,
		created,
		get requests() {
			return requests;
		},
		setPermission(next: string) {
			current = next;
		},
	};
}

function client() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
}

describe("NotificationsTab", () => {
	test("permission is requested on the Enable click and not before", async () => {
		const fake = fakeEnv("default");
		const storage = memoryStorage();
		const view = await mount(
			<NotificationsProvider env={fake.env} storage={storage}>
				<NotificationsTab />
			</NotificationsProvider>,
		);
		try {
			expect(fake.requests).toBe(0);
			const [enable] = byText(view.host, "button", "Enable notifications");
			expect(enable).toBeDefined();
			await click(enable);
			expect(fake.requests).toBe(1);
			expect(
				view.host.querySelector('[data-testid="notification-status"]')
					?.textContent,
			).toBe("On");
			expect(
				JSON.parse(storage.map.get(PREFS_STORAGE_KEY) ?? "{}").enabled,
			).toBe(true);
		} finally {
			await view.unmount();
		}
	});

	test("a refusal leaves notifications off and shows the blocked state", async () => {
		const fake = fakeEnv("default", "denied");
		const view = await mount(
			<NotificationsProvider env={fake.env} storage={memoryStorage()}>
				<NotificationsTab />
			</NotificationsProvider>,
		);
		try {
			await click(byText(view.host, "button", "Enable notifications")[0]);
			expect(
				view.host.querySelector('[data-testid="notification-status"]')
					?.textContent,
			).toBe("Off");
			expect(view.host.textContent).toContain(
				"Notifications are blocked for this site.",
			);
			const [enable] = byText(view.host, "button", "Enable notifications");
			expect((enable as HTMLButtonElement).disabled).toBe(true);
		} finally {
			await view.unmount();
		}
	});

	test("denied and unsupported render disabled controls without throwing", async () => {
		for (const env of [
			fakeEnv("denied").env,
			{ isSecureContext: true } as NotificationEnv,
			{ ...fakeEnv("default").env, isSecureContext: false },
		]) {
			const view = await mount(
				<NotificationsProvider env={env} storage={memoryStorage()}>
					<NotificationsTab />
				</NotificationsProvider>,
			);
			try {
				const [enable] = byText(view.host, "button", "Enable notifications");
				expect((enable as HTMLButtonElement).disabled).toBe(true);
				const switches = view.host.querySelectorAll('button[role="switch"]');
				expect(switches.length).toBe(4);
				for (const s of Array.from(switches)) {
					expect((s as HTMLButtonElement).disabled).toBe(true);
				}
				expect(view.host.querySelector('[role="status"]')).not.toBeNull();
			} finally {
				await view.unmount();
			}
		}
	});

	test("each category toggles on its own and the choice persists", async () => {
		const fake = fakeEnv("granted");
		const storage = memoryStorage({
			[PREFS_STORAGE_KEY]: { ...DEFAULT_NOTIFICATION_PREFS, enabled: true },
			[baselineStorageKey("rateLimit")]: {},
		});
		const view = await mount(
			<NotificationsProvider env={fake.env} storage={storage}>
				<NotificationsTab />
			</NotificationsProvider>,
		);
		try {
			const rate = view.host.querySelector(
				"#notification-category-rateLimit",
			) as HTMLButtonElement;
			expect(rate.getAttribute("aria-checked")).toBe("true");
			await click(rate);
			expect(rate.getAttribute("aria-checked")).toBe("false");
			const saved = JSON.parse(storage.map.get(PREFS_STORAGE_KEY) ?? "{}");
			expect(saved.categories).toEqual({
				serviceOutage: true,
				rateLimit: false,
				accountHealth: true,
				errorBurst: true,
			});
			// Its baseline goes with it, so switching back on cannot replay.
			expect(storage.map.has(baselineStorageKey("rateLimit"))).toBe(false);
		} finally {
			await view.unmount();
		}
	});

	test("the test button sends one notification through the browser", async () => {
		const fake = fakeEnv("granted");
		const view = await mount(
			<NotificationsProvider env={fake.env} storage={memoryStorage()}>
				<NotificationsTab />
			</NotificationsProvider>,
		);
		try {
			await click(byText(view.host, "button", "Send test notification")[0]);
			expect(fake.created).toEqual(["better-ccflare test notification"]);
		} finally {
			await view.unmount();
		}
	});
});

const NOW = Date.now();

function account(over: Partial<AccountResponse>): AccountResponse {
	return {
		id: "acc-1",
		name: "one",
		paused: false,
		pauseReason: null,
		requiresReauth: false,
		rateLimitStatus: "OK",
		rateLimitedUntil: null,
		rateLimitedReason: null,
		usageUtilization: null,
		...over,
	} as AccountResponse;
}

describe("NotificationWatcher", () => {
	async function mountWatcher(categories: Record<string, boolean>) {
		const fake = fakeEnv("granted");
		const storage = memoryStorage({
			[PREFS_STORAGE_KEY]: {
				enabled: true,
				categories: { ...DEFAULT_NOTIFICATION_PREFS.categories, ...categories },
			},
		});
		const qc = client();
		let stamp = NOW;
		const seed = (key: readonly unknown[], data: unknown) => {
			stamp += 1_000;
			qc.setQueryData(key, data, { updatedAt: stamp });
		};
		// Fresh data for every source, so nothing mounts into a real fetch.
		seed(queryKeys.accounts(), [account({})]);
		seed(queryKeys.serviceStatus(), {
			snapshot: null,
			stale: false,
			error: "x",
		});
		seed(queryKeys.insightsAlerts(), { alerts: [], unacknowledgedCount: 0 });
		const view = await mount(
			<QueryClientProvider client={qc}>
				<NotificationsProvider env={fake.env} storage={storage}>
					<NotificationWatcher />
				</NotificationsProvider>
			</QueryClientProvider>,
		);
		// React Query delivers cache updates to observers on a setTimeout(0)
		// (its notifyManager), and dom.ts keeps Bun's timers, so the update
		// is flushed by waiting one macrotask inside act.
		const update = async (key: readonly unknown[], data: unknown) => {
			await act(async () => {
				seed(key, data);
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
		};
		return { fake, view, update, storage };
	}

	test("a new reading that degrades an account notifies once; the same reading again does not", async () => {
		const { fake, view, update } = await mountWatcher({});
		try {
			// The mount was the baseline.
			expect(fake.created).toEqual([]);
			await update(queryKeys.accounts(), [account({ requiresReauth: true })]);
			expect(fake.created).toEqual(["Account needs re-authentication: one"]);
			await update(queryKeys.accounts(), [account({ requiresReauth: true })]);
			expect(fake.created).toHaveLength(1);
			await update(queryKeys.accounts(), [account({})]);
			expect(fake.created).toEqual([
				"Account needs re-authentication: one",
				"Account healthy again: one",
			]);
		} finally {
			await view.unmount();
		}
	});

	test("a disabled category sends nothing while the others still do", async () => {
		const { fake, view, update } = await mountWatcher({ accountHealth: false });
		try {
			await update(queryKeys.accounts(), [
				account({
					requiresReauth: true,
				}),
				account({
					id: "acc-2",
					name: "two",
					rateLimitedUntil: NOW + 3_600_000,
					rateLimitedReason: "upstream_429_with_reset",
				}),
				// Keeps the pool from reading as exhausted.
				account({ id: "acc-3", name: "three" }),
			]);
			expect(fake.created).toEqual(["Account rate-limited: two"]);
		} finally {
			await view.unmount();
		}
	});

	test("service status and alert readings reach their categories", async () => {
		const { fake, view, update } = await mountWatcher({});
		try {
			const operational = {
				snapshot: {
					level: "operational",
					components: [],
					affected: [],
					incidents: [],
					missingComponentIds: [],
					pageIndicator: "none",
					pageUrl: "https://status.claude.com",
					checkedAt: 0,
				},
				stale: false,
				error: null,
			};
			await update(queryKeys.serviceStatus(), operational);
			await update(queryKeys.serviceStatus(), {
				...operational,
				snapshot: {
					...operational.snapshot,
					level: "outage",
					affected: [{ id: "c", name: "Claude Code", status: "major_outage" }],
				},
			});
			expect(fake.created).toEqual(["Claude service outage reported"]);
			await update(queryKeys.insightsAlerts(), {
				alerts: [
					{
						id: "upstream_error:a:1",
						timestamp: NOW,
						type: "upstream_error",
						severity: "critical",
						title: "Upstream server errors",
						message: "3 server-error (5xx) responses",
						value: 3,
						threshold: 3,
						account: "one",
						model: null,
						project: null,
						requestId: null,
						acknowledged: false,
					},
				],
				unacknowledgedCount: 1,
			});
			expect(fake.created).toEqual([
				"Claude service outage reported",
				"Upstream server errors",
			]);
		} finally {
			await view.unmount();
		}
	});

	test("nothing is watched or sent while notifications are off", async () => {
		const fake = fakeEnv("granted");
		const qc = client();
		const view = await mount(
			<QueryClientProvider client={qc}>
				<NotificationsProvider env={fake.env} storage={memoryStorage()}>
					<NotificationWatcher />
				</NotificationsProvider>
			</QueryClientProvider>,
		);
		try {
			expect(qc.getQueryCache().getAll()).toHaveLength(0);
		} finally {
			await view.unmount();
		}
	});
});

describe("provider", () => {
	test("a switch flipped while the permission prompt is open is not overwritten", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fake = fakeEnv("default", "granted", gate);
		const storage = memoryStorage();
		const view = await mount(
			<NotificationsProvider env={fake.env} storage={storage}>
				<NotificationsTab />
			</NotificationsProvider>,
		);
		try {
			await click(byText(view.host, "button", "Enable notifications")[0]);
			const rate = view.host.querySelector(
				"#notification-category-rateLimit",
			) as HTMLButtonElement;
			await click(rate);
			await act(async () => {
				release();
				await gate;
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			const saved = JSON.parse(storage.map.get(PREFS_STORAGE_KEY) ?? "{}");
			expect(saved.enabled).toBe(true);
			expect(saved.categories.rateLimit).toBe(false);
		} finally {
			await view.unmount();
		}
	});

	test("permission granted again in site settings starts from fresh baselines", async () => {
		const fake = fakeEnv("denied");
		const storage = memoryStorage({
			[PREFS_STORAGE_KEY]: { ...DEFAULT_NOTIFICATION_PREFS, enabled: true },
			[baselineStorageKey("serviceOutage")]: {
				at: Date.now(),
				entries: { claude: { state: "outage", label: "Claude" } },
			},
		});
		const view = await mount(
			<NotificationsProvider env={fake.env} storage={storage}>
				<NotificationsTab />
			</NotificationsProvider>,
		);
		try {
			// A focus with nothing changed keeps the baseline.
			await act(async () => {
				window.dispatchEvent(new Event("focus"));
			});
			expect(storage.map.has(baselineStorageKey("serviceOutage"))).toBe(true);
			fake.setPermission("granted");
			await act(async () => {
				window.dispatchEvent(new Event("focus"));
			});
			expect(storage.map.has(baselineStorageKey("serviceOutage"))).toBe(false);
			expect(
				view.host.querySelector('[data-testid="notification-status"]')
					?.textContent,
			).toBe("On");
		} finally {
			await view.unmount();
		}
	});

	test("a preference changed in another tab reaches this one", async () => {
		const fake = fakeEnv("granted");
		const storage = memoryStorage({
			[PREFS_STORAGE_KEY]: { ...DEFAULT_NOTIFICATION_PREFS, enabled: true },
		});
		const view = await mount(
			<NotificationsProvider env={fake.env} storage={storage}>
				<NotificationsTab />
			</NotificationsProvider>,
		);
		try {
			const rate = () =>
				view.host
					.querySelector("#notification-category-rateLimit")
					?.getAttribute("aria-checked");
			expect(rate()).toBe("true");
			storage.setItem(
				PREFS_STORAGE_KEY,
				JSON.stringify({
					enabled: true,
					categories: {
						...DEFAULT_NOTIFICATION_PREFS.categories,
						rateLimit: false,
					},
				}),
			);
			// An unrelated key changes nothing.
			await act(async () => {
				window.dispatchEvent(
					new StorageEvent("storage", { key: "something-else" }),
				);
			});
			expect(rate()).toBe("true");
			await act(async () => {
				window.dispatchEvent(
					new StorageEvent("storage", { key: PREFS_STORAGE_KEY }),
				);
			});
			expect(rate()).toBe("false");
		} finally {
			await view.unmount();
		}
	});
});

describe("keeping sources fresh", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("the watcher re-fetches a source once its reading is a cadence old, with no page polling it", async () => {
		const requested: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			requested.push(url);
			return new Response("[]", {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		const fake = fakeEnv("granted");
		const storage = memoryStorage({
			[PREFS_STORAGE_KEY]: {
				enabled: true,
				categories: {
					serviceOutage: false,
					rateLimit: false,
					accountHealth: true,
					errorBurst: false,
				},
			},
		});
		const qc = client();
		qc.setQueryData(queryKeys.accounts(), [account({})]);
		const view = await mount(
			<QueryClientProvider client={qc}>
				<NotificationsProvider env={fake.env} storage={storage}>
					<NotificationWatcher cadenceMs={60} />
				</NotificationsProvider>
			</QueryClientProvider>,
		);
		try {
			// Fresh at mount, so nothing is fetched straight away.
			expect(requested).toEqual([]);
			for (let i = 0; i < 40 && requested.length === 0; i++) {
				await act(async () => {
					await new Promise((resolve) => setTimeout(resolve, 10));
				});
			}
			expect(requested.some((u) => u.includes("/api/accounts"))).toBe(true);
		} finally {
			await view.unmount();
		}
	});
});

describe("refreshIfStale", () => {
	test("fetches only when the cached reading is older than the cadence", async () => {
		const qc = client();
		let calls = 0;
		const options = {
			queryKey: ["probe"],
			queryFn: async () => {
				calls += 1;
				return calls;
			},
		};
		expect(await refreshIfStale(qc, options, 60_000)).toBe(true);
		expect(calls).toBe(1);
		const fetchedAt = qc.getQueryState(["probe"])?.dataUpdatedAt ?? 0;
		expect(await refreshIfStale(qc, options, 60_000, fetchedAt + 59_000)).toBe(
			false,
		);
		expect(calls).toBe(1);
		expect(await refreshIfStale(qc, options, 60_000, fetchedAt + 61_000)).toBe(
			true,
		);
		expect(calls).toBe(2);
	});

	test("a failing fetch resolves rather than rejecting", async () => {
		const qc = client();
		await expect(
			refreshIfStale(
				qc,
				{
					queryKey: ["fails"],
					queryFn: async () => {
						throw new Error("down");
					},
				},
				1_000,
			),
		).resolves.toBe(true);
	});
});

describe("navigation and route", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("the sidebar links to /notifications and marks it active there", async () => {
		// The sidebar's version card fetches on mount. Unstubbed, Bun's fetch
		// throws on the relative URL, and the API client retries a thrown
		// request once after a second, which then lands in whichever test file
		// is running by then (measured: OpenAIGatewaysCard.test.tsx). A 404 is
		// not retried.
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ error: "not stubbed" }), {
				status: 404,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch;
		const qc = client();
		qc.setQueryData(queryKeys.insightsAlerts(), {
			alerts: [],
			unacknowledgedCount: 0,
		});
		const view = await mount(
			<QueryClientProvider client={qc}>
				<ThemeProvider>
					<MemoryRouter initialEntries={["/notifications"]}>
						<Navigation />
					</MemoryRouter>
				</ThemeProvider>
			</QueryClientProvider>,
		);
		try {
			const link = view.host.querySelector('a[href="/notifications"]');
			expect(link).not.toBeNull();
			expect(link?.textContent).toContain("Notifications");
			expect(link?.querySelector("svg")).not.toBeNull();
			expect(link?.querySelector("button")?.className).toContain(
				"bg-primary/10",
			);
		} finally {
			await view.unmount();
		}
	});

	test("the app renders the Notifications page at /notifications", async () => {
		const requested: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			requested.push(url);
			const json = (body: unknown, status = 200) =>
				new Response(JSON.stringify(body), {
					status,
					headers: { "content-type": "application/json" },
				});
			if (url.includes("/api/insights/alerts")) {
				return json({ alerts: [], unacknowledgedCount: 0 });
			}
			if (url.includes("/api/stats")) return json({});
			return json({ error: "not stubbed" }, 404);
		}) as typeof fetch;
		const view = await mount(
			<MemoryRouter initialEntries={["/notifications"]}>
				<App />
			</MemoryRouter>,
		);
		try {
			// Let the auth check resolve and the route render.
			for (
				let i = 0;
				i < 20 && !view.host.textContent?.includes("Browser notifications");
				i++
			) {
				await act(async () => {
					await new Promise((r) => setTimeout(r, 10));
				});
			}
			const heading = view.host.querySelector("main h1");
			expect(heading?.textContent).toBe("Notifications");
			expect(view.host.textContent).toContain("Browser notifications");
			expect(view.host.textContent).toContain("Notification types");
			// Notifications are off by default, so no source query was started.
			expect(requested.some((u) => u.includes("/api/service-status"))).toBe(
				false,
			);
		} finally {
			await view.unmount();
		}
	});
});
