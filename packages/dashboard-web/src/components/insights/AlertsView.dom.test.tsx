/**
 * What the acknowledge-group button DOES, as opposed to what it renders.
 *
 * Split from AlertsView.test.tsx rather than added to it because that file
 * renders with `renderToStaticMarkup` and this one needs a live DOM. Keeping
 * them apart leaves every existing assertion in its original shape.
 *
 * Each test here is written against a mutation that survived the full suite
 * before the file existed. The mutation is named in the test's own comment so
 * a later reader can re-run it rather than trust this one.
 */
import { describe, expect, test } from "bun:test";
import type { AlertEvent } from "@better-ccflare/types";
import { byText, click, mount } from "../../test/dom";
import { AlertsList } from "./AlertsView";

function makeAlert(
	overrides: Partial<AlertEvent> & { id: string },
): AlertEvent {
	return {
		timestamp: Date.UTC(2026, 8, 17, 5, 21, 4),
		type: "auth_failure",
		severity: "warning",
		title: "Account authentication failed",
		message:
			"Account ICLD (anthropic) requires re-authentication: invalid_grant",
		value: null,
		threshold: null,
		account: "ICLD",
		model: null,
		project: null,
		requestId: null,
		acknowledged: false,
		...overrides,
	};
}

const HOUR = 60 * 60 * 1000;
const BASE = Date.UTC(2026, 8, 17, 5, 21, 4);

/**
 * Four hourly alerts sharing one key.
 *
 * Four rather than two because the mutations under test truncate to the first
 * element. With two members a truncation drops one id, which an equality
 * assertion catches but a length assertion barely does. With four the gap is
 * unambiguous in the failure output.
 */
function fourInOneGroup(): AlertEvent[] {
	return [3, 2, 1, 0].map((n) =>
		makeAlert({
			id: `auth_failure:ICLD:${1000 + n}`,
			timestamp: BASE + n * HOUR,
		}),
	);
}

/** The single acknowledge-group button of a one-group list. */
function groupButton(host: ParentNode): Element {
	const buttons = byText(host, "button", "Acknowledge group");
	expect(buttons.length).toBe(1);
	return buttons[0];
}

describe("AlertsList acknowledge-group click", () => {
	test("sends every member id, newest first, and the group key", async () => {
		const seen: Array<[string, string[]]> = [];
		const mounted = await mount(
			<AlertsList
				alerts={fourInOneGroup()}
				unacknowledgedCount={4}
				onAcknowledgeGroup={(key, ids) => seen.push([key, ids])}
			/>,
		);

		try {
			await click(groupButton(mounted.host));

			// Kills three mutations at once, all of which passed the full suite
			// before this file existed:
			//
			//   1. `onAcknowledgeGroup(groupMemberIds(group))` replaced by
			//      `onAcknowledgeGroup([group.members[0].id])`, which would
			//      acknowledge one member of a four-member group and let the
			//      other three silently return.
			//   2. the same call truncated to `groupMemberIds(group).slice(0, 1)`.
			//   3. `onAcknowledgeGroup(group.key, ids)` in the AlertsList
			//      wrapper replaced by `onAcknowledgeGroup("", ids)`.
			//
			// The assertion is a whole-value equality rather than a length or a
			// `toContain`, because a truncation to the first id passes both of
			// those when the first id is the one you happened to check.
			expect(seen).toEqual([
				[
					"auth_failure:ICLD",
					[
						"auth_failure:ICLD:1003",
						"auth_failure:ICLD:1002",
						"auth_failure:ICLD:1001",
						"auth_failure:ICLD:1000",
					],
				],
			]);
		} finally {
			await mounted.unmount();
		}
	});

	test("clicks one group's button without firing the other's", async () => {
		const seen: Array<[string, string[]]> = [];
		const alerts = [
			...fourInOneGroup(),
			makeAlert({
				id: "auth_failure:OTHER:1",
				account: "OTHER",
				timestamp: Date.UTC(2026, 8, 17, 4, 0, 0),
			}),
		];

		const mounted = await mount(
			<AlertsList
				alerts={alerts}
				unacknowledgedCount={5}
				onAcknowledgeGroup={(key, ids) => seen.push([key, ids])}
			/>,
		);

		try {
			const buttons = byText(mounted.host, "button", "Acknowledge group");
			expect(buttons.length).toBe(2);

			// Each row closes over its own group. A wrapper that read the key
			// from the wrong closure, or hoisted one group out of the map,
			// would send the same key from both buttons and this catches it.
			await click(buttons[0]);
			await click(buttons[1]);

			const keys = seen.map(([key]) => key);
			expect(new Set(keys).size).toBe(2);
			expect(keys).toContain("auth_failure:ICLD");
			expect(keys).toContain("auth_failure:OTHER");
		} finally {
			await mounted.unmount();
		}
	});

	test("a disabled pending button sends nothing", async () => {
		const seen: Array<[string, string[]]> = [];
		const mounted = await mount(
			<AlertsList
				alerts={fourInOneGroup()}
				unacknowledgedCount={4}
				onAcknowledgeGroup={(key, ids) => seen.push([key, ids])}
				pendingGroupKey="auth_failure:ICLD"
			/>,
		);

		try {
			// The existing markup test pins that exactly one button carries the
			// disabled attribute. It cannot pin that the attribute stops the
			// handler, which is the property an operator depends on: a second
			// acknowledgement of an in-flight group is a duplicate write.
			await click(groupButton(mounted.host));
			expect(seen).toEqual([]);
		} finally {
			await mounted.unmount();
		}
	});

	test("acknowledge-all fires once per click", async () => {
		let calls = 0;
		const mounted = await mount(
			<AlertsList
				alerts={fourInOneGroup()}
				unacknowledgedCount={4}
				onAcknowledgeAll={() => {
					calls += 1;
				}}
			/>,
		);

		try {
			const buttons = byText(mounted.host, "button", "Acknowledge all");
			expect(buttons.length).toBe(1);
			await click(buttons[0]);
			expect(calls).toBe(1);
		} finally {
			await mounted.unmount();
		}
	});
});
