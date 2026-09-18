import { describe, expect, test } from "bun:test";
import type { AlertEvent } from "@better-ccflare/types";
import { renderToStaticMarkup } from "react-dom/server";
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

/** The four hourly ICLD alerts of the screenshot, plus two acknowledged rows. */
function screenshotAlerts(): AlertEvent[] {
	const base = Date.UTC(2026, 8, 17, 5, 21, 4);
	const icld = [3, 2, 1, 0].map((n) =>
		makeAlert({
			id: `auth_failure:ICLD:${1000 + n}`,
			timestamp: base + n * HOUR,
		}),
	);
	return [
		...icld,
		// Two acknowledged members under ONE key. With a single acknowledged
		// alert, counting groups and counting rows both give 1, so the count
		// assertion could not tell them apart and a mutation counting groups
		// survived. Two under one key makes it falsifying.
		makeAlert({
			id: "upstream_error:4:PRTN\u001f4xx:900",
			type: "upstream_error",
			title: "Upstream client errors",
			message: "3 client error (4xx) responses for account PRTN",
			account: "PRTN",
			timestamp: base - HOUR,
			acknowledged: true,
		}),
		makeAlert({
			id: "upstream_error:4:PRTN\u001f4xx:899",
			type: "upstream_error",
			title: "Upstream client errors",
			message: "3 client error (4xx) responses for account PRTN",
			account: "PRTN",
			timestamp: base - 2 * HOUR,
			acknowledged: true,
		}),
	];
}

function render(node: React.ReactElement): string {
	return renderToStaticMarkup(node);
}

describe("AlertsList", () => {
	test("renders four same-key alerts as one group row", () => {
		const html = render(
			<AlertsList alerts={screenshotAlerts()} unacknowledgedCount={4} />,
		);

		// The title appears once in the summary, not once per member card.
		// Members are behind the fold, so they are in the markup too; what
		// matters is that there is exactly one group row, which the <details>
		// count pins.
		expect(html.match(/Acknowledge group/g)).toBeNull();
		expect(html.match(/Account authentication failed/g)?.length).toBe(5);
		expect(html).toContain("4 of the last 6 loaded");
	});

	test("puts the member count in the summary line, ahead of the fold", () => {
		const html = render(
			<AlertsList alerts={screenshotAlerts()} unacknowledgedCount={4} />,
		);

		// Everything before the first </summary> is what an operator sees
		// without expanding. The count has to be in there: a group row that
		// hides its count reads as one event.
		const firstSummary = html.slice(0, html.indexOf("</summary>"));
		expect(firstSummary).toContain("4 of the last 6 loaded");
		expect(firstSummary).toContain("Account authentication failed");
	});

	test("renders the acknowledged section collapsed, with its own count", () => {
		const html = render(
			<AlertsList alerts={screenshotAlerts()} unacknowledgedCount={4} />,
		);

		expect(html).toContain("Acknowledged (2 of the last 6 loaded)");
		// Collapsed by default is the absence of the open attribute on every
		// <details>, the group rows included.
		expect(html).not.toContain("<details open");
		expect(html).toContain("<details");
	});

	test("shows each member with its own timestamp and message", () => {
		const html = render(
			<AlertsList alerts={screenshotAlerts()} unacknowledgedCount={4} />,
		);

		// Four members of one group, each rendering its own card, so the
		// shared message text appears once per member.
		expect(
			html.match(/requires re-authentication: invalid_grant/g)?.length,
		).toBe(4);
	});

	test("renders an acknowledge-group button when a handler is supplied", () => {
		const html = render(
			<AlertsList
				alerts={screenshotAlerts()}
				unacknowledgedCount={4}
				onAcknowledgeGroup={() => {}}
			/>,
		);

		// One open group means one group button. The acknowledged section
		// never gets one.
		expect(html.match(/Acknowledge group/g)?.length).toBe(1);
	});

	// The click itself is not asserted here. renderToStaticMarkup cannot
	// dispatch events and this package has no DOM renderer, so a test that
	// mounted the list and then checked a callback it never triggered would
	// assert nothing while reading as though it did.
	//
	// An earlier version of this comment claimed the ids the button sends were
	// pinned in packages/types/src/alerts.test.ts. That was false: those tests
	// pinned what a group CONTAINS, never what the button DOES with it, and a
	// reviewer's mutation sending only members[0].id survived every test here.
	// The expression now lives in groupMemberIds, which that file does pin.
	// That fix is partial and measured as partial. Extracting the expression
	// pins what groupMemberIds RETURNS, and a mutation truncating it now dies.
	// A mutation replacing the call with `[group.members[0].id]` at this button
	// still SURVIVES all 41 tests, because nothing here observes which
	// expression the handler receives. The same gap, one level up.
	//
	// So the wiring is untested: that this button calls the handler at all,
	// that it passes groupMemberIds(group) rather than a truncation, that it
	// passes group.key, and the fan-out in useAcknowledgeAlerts. Closing any of
	// them needs a DOM renderer in this package, which nothing here has.

	test("disables only the pending group's button", () => {
		const alerts = [
			...screenshotAlerts(),
			makeAlert({
				id: "auth_failure:OTHER:1",
				account: "OTHER",
				timestamp: Date.UTC(2026, 8, 17, 4, 0, 0),
			}),
		];

		const html = render(
			<AlertsList
				alerts={alerts}
				unacknowledgedCount={5}
				onAcknowledgeGroup={() => {}}
				pendingGroupKey="auth_failure:ICLD"
			/>,
		);

		// Two open groups, two group buttons, exactly one of them disabled.
		expect(html.match(/Acknowledge group/g)?.length).toBe(2);
		expect(html.match(/disabled=""/g)?.length).toBe(1);
	});

	test("renders the empty state when there are no alerts", () => {
		const html = render(<AlertsList alerts={[]} unacknowledgedCount={0} />);

		expect(html).toContain("No alerts yet.");
		expect(html).not.toContain("<details");
	});

	test("omits the acknowledged section when nothing is acknowledged", () => {
		const alerts = screenshotAlerts().filter((a) => !a.acknowledged);
		const html = render(<AlertsList alerts={alerts} unacknowledgedCount={4} />);

		expect(html).not.toContain("Acknowledged (");
		expect(html).toContain("4 of the last 4 loaded");
	});

	test("keeps the header counting rows, not groups", () => {
		const html = render(
			<AlertsList alerts={screenshotAlerts()} unacknowledgedCount={25} />,
		);

		// The sidebar badge and this header both report row counts. Grouping
		// four rows into one must not change the 25.
		expect(html).toContain("Unacknowledged: ");
		expect(html).toContain("25");
	});
});
