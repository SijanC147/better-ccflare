/**
 * DOM renderer for packages/dashboard-web tests.
 *
 * Every component test in this package rendered with `renderToStaticMarkup`,
 * which produces a string and dispatches nothing. That made every click path
 * structurally untestable: a handler could be given the wrong expression and
 * no assertion in the package could see it. Three mutations survived the full
 * suite on merged code because of it, documented on SB23-2285.
 *
 * The renderer is happy-dom, registered into the global scope by
 * `@happy-dom/global-registrator`. It is a devDependency of this package only,
 * costs 17M in `node_modules` and pulls seven transitive packages, and nothing
 * it installs reaches a shipped bundle.
 *
 * Why happy-dom rather than the alternatives, measured rather than recited:
 *
 * - Bun has no DOM of its own. `bun test` gives a server-side global scope with
 *   no `document`, so `react-dom/client` cannot mount at all. There is nothing
 *   to configure; the capability is absent.
 * - jsdom is the other real option. It is the more complete implementation and
 *   the slower one, and this package needs `createRoot`, event dispatch and
 *   `querySelector`, which is the subset both cover. happy-dom is also the one
 *   Bun documents a registrator for, so wiring it costs one import rather than
 *   a hand-written global shim.
 *
 * Usage: `import { mount, click } from "../../test/dom";` in a test file. This
 * is opt-in per file rather than a preload, so every existing test keeps its
 * `renderToStaticMarkup` shape and no existing test's assertions changed.
 *
 * One existing file was edited and it is worth naming, because "nothing was
 * touched" would be the easier sentence and would be false:
 * `AlertsView.test.tsx` carried a long comment explaining that the click path
 * could not be tested here. Its assertions are unchanged; only that comment
 * moved, since leaving it would have sent the next reader looking for a gap
 * that had been closed.
 *
 * Import order inside a test file does not matter, which is worth stating
 * because it looks as though it should. ES module imports are hoisted, so
 * `react-dom/client` is always evaluated before the registration below runs
 * whatever order the source is written in. That is measured to be fine:
 * `react-dom` reads the global scope when a root is created rather than when
 * it is loaded, so a module graph built against an empty global scope still
 * mounts once `document` exists.
 *
 * Registration is process-wide and deliberately never undone. Bun runs every
 * test file in one process, so an `unregister` in one file would pull the DOM
 * out from under a later one.
 *
 * That makes the blast radius the thing to measure, and the first version of
 * this file measured the wrong thing. It checked for `typeof window` and
 * `typeof document` sites elsewhere in the repo, found only local variables
 * named `window` that shadow the global, and concluded the registration was
 * contained. It was not. `GlobalRegistrator.register()` REPLACES 35 globals
 * that Bun already implements, the network and stream family among them, and
 * adds 488 more. Those two counts come from a probe that snapshots
 * `Object.getOwnPropertyNames(globalThis)` either side of the call and
 * compares with `Object.is`, not `!==`: `NaN` is a global and `NaN !== NaN`,
 * so a `!==` comparison reports it as replaced when nothing touched it. An
 * earlier version of this comment said 37 for that reason.
 *
 * The full suite caught the breakage: four `processResponse - SSE` tests in
 * `packages/providers` failed with
 *
 *     TypeError: The transform's 'readable' property must be a ReadableStream
 *
 * because `ReadableStream` stayed Bun's while `TransformStream` became
 * happy-dom's, and `pipeThrough` will not cross implementations. Those tests
 * pass alone and fail as soon as this module is loaded into the same process,
 * which is how the cause was pinned.
 *
 * So the registration is followed by restoring Bun's own implementations of
 * the globals the DOM does not need. The restore list is an explicit allowlist
 * rather than an exclusion list, so a future happy-dom release that starts
 * replacing something new leaves that one alone rather than silently keeping
 * a replacement nobody reviewed.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

/**
 * Globals Bun implements and the DOM does not need, restored after
 * registration so non-DOM code sharing the process keeps working.
 *
 * Streams are the ones that were measured to break. The rest are in the same
 * family and are restored for the same reason: a `Response` or a `Blob` that
 * crosses between implementations is the identical hazard waiting for the
 * first test that exercises it, and a test that fails only when two unrelated
 * files land in one Bun process is expensive to diagnose twice.
 *
 * Deliberately NOT restored, because happy-dom has to own them for React to
 * work: `Event`, `EventTarget`, `CustomEvent`, `ErrorEvent`, `MessageEvent`,
 * `CloseEvent`, `DOMException`, `navigator`, `addEventListener`,
 * `removeEventListener`, `dispatchEvent`, `postMessage`, `MessagePort`.
 *
 * `ReadableStream` is on the list and is a no-op today: happy-dom does not
 * replace it, which is exactly why `pipeThrough` broke. It is listed so that a
 * happy-dom release that starts replacing it does not reopen the same bug
 * silently.
 *
 * THE TIMERS CARRY A COST, and it is measured rather than suspected.
 * Restoring Bun's `setTimeout` takes those timers out of happy-dom's async
 * task manager, so `happyDOM.waitUntilComplete()` no longer waits for them. A
 * probe scheduling a 300ms timer and then awaiting `waitUntilComplete()` came
 * back in **1ms with the callback unfired**. So `waitUntilComplete`, and
 * anything else built on that task manager, will report "done" while work is
 * outstanding. **Do not use it. Use React's `act`, which `mount` and `click`
 * already do.**
 *
 * The trade was taken deliberately: Bun runs 391 test files in one process,
 * and handing all of them happy-dom's timers to keep one convenience API
 * working for a package that does not use it is the worse risk. A test that
 * silently passes is worse than an API that is documented as unavailable.
 */
const BUN_OWNED = [
	"ReadableStream",
	"WritableStream",
	"TransformStream",
	"fetch",
	"Request",
	"Response",
	"Headers",
	"Blob",
	"File",
	"FormData",
	"AbortController",
	"AbortSignal",
	"URL",
	"WebSocket",
	"atob",
	"btoa",
	"setTimeout",
	"clearTimeout",
	"setInterval",
	"clearInterval",
	"queueMicrotask",
] as const;

// Guarded because Bun runs every test file in one process: a second
// registration from a second test file throws.
if (typeof globalThis.document === "undefined") {
	const scope = globalThis as unknown as Record<string, unknown>;
	const native = new Map<string, unknown>();
	for (const name of BUN_OWNED) {
		if (name in scope) native.set(name, scope[name]);
	}

	GlobalRegistrator.register();

	for (const [name, value] of native) {
		if (scope[name] !== value) scope[name] = value;
	}
}

// React 19 requires this flag before `act` will flush updates outside a
// renderer's own test build. Without it every `act` call warns and the queue
// is flushed on a timer instead, which makes assertions race.
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
	/** The element the tree is rendered into, for `querySelector`. */
	host: HTMLElement;
	/** Unmount and detach. Call it in a `finally` so a failing assertion still cleans up. */
	unmount: () => Promise<void>;
}

/**
 * Render a React element into a detached host attached to `document.body`.
 *
 * `document.body` rather than a bare orphan element because Radix and other
 * portal-based components resolve their container from the document, and a
 * tree that is never in the document renders those as nothing.
 */
export async function mount(node: ReactElement): Promise<Mounted> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(node);
	});
	return {
		host,
		unmount: async () => {
			await act(async () => {
				root.unmount();
			});
			host.remove();
		},
	};
}

/**
 * Dispatch a real bubbling click and flush what it schedules.
 *
 * `element.click()` would also work for a plain button, but it does not bubble
 * from every element type, and React listens at the root rather than on the
 * node. Dispatching the event explicitly is the shape that works for both.
 */
export async function click(element: Element): Promise<void> {
	await act(async () => {
		element.dispatchEvent(
			new MouseEvent("click", { bubbles: true, cancelable: true }),
		);
	});
}

/** Every element whose trimmed text content is exactly `text`. */
export function byText(host: ParentNode, selector: string, text: string) {
	return Array.from(host.querySelectorAll(selector)).filter(
		(el) => el.textContent?.trim() === text,
	);
}
