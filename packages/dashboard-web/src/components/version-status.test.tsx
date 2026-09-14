import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { VersionStatusResponse } from "../api";
import { ForkCard } from "./version-status";

/**
 * These tests exist because of SB23-1790, where the recheck control sat inside
 * the `!remote.available && !status.fork` early return. Once any snapshot
 * exists `status.fork` is non-null, so the control never rendered in the stale
 * state — the one state that needs it.
 *
 * That defect is invisible to a reader and to the type-checker: the code is
 * present, the branch is not taken. The only thing that catches it is asserting
 * the control per-state rather than assuming it exists because it is in the
 * file.
 */

function render(status: VersionStatusResponse): string {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<ForkCard status={status} />
		</QueryClientProvider>,
	);
}

const base: VersionStatusResponse = {
	local: { version: "3.14.0", commit: "abc1234" },
	remote: {
		available: true,
		stale: false,
		error: null,
	},
	fork: {
		latestTag: "3.14.0",
		releaseUrl: "https://github.com/SijanC147/better-ccflare/releases",
	},
	upstream: null,
	capabilities: { selfUpdate: false, upgradeCommand: "brew upgrade" },
} as unknown as VersionStatusResponse;

function withRemote(
	over: Partial<VersionStatusResponse["remote"]>,
	fork: VersionStatusResponse["fork"] = base.fork,
): VersionStatusResponse {
	return {
		...base,
		fork,
		remote: { ...base.remote, ...over },
	} as VersionStatusResponse;
}

describe("ForkCard recheck control", () => {
	test("renders in the stale state, which is where it was missing", () => {
		const html = render(
			withRemote({ stale: true, error: "GitHub rate limit exceeded" }),
		);
		expect(html).toContain("Check again");
	});

	test("shows why the last check failed instead of a bare stale number", () => {
		// A stale snapshot renders a version that looks authoritative. Without
		// the reason, a recheck that legitimately returns the same snapshot is
		// indistinguishable from a dead button.
		const html = render(
			withRemote({ stale: true, error: "GitHub rate limit exceeded" }),
		);
		expect(html).toContain("GitHub rate limit exceeded");
	});

	test("renders in the fresh state too, not only when something is wrong", () => {
		const html = render(withRemote({ stale: false, error: null }));
		expect(html).toContain("Check again");
	});

	test("renders in the unreachable-and-no-snapshot state", () => {
		// The original branch, and the only one where the control used to live.
		const html = render(
			withRemote(
				{
					available: false,
					stale: false,
					error: "GitHub could not be reached.",
				},
				null as unknown as VersionStatusResponse["fork"],
			),
		);
		expect(html).toContain("Check again");
	});

	test("falls back to a readable reason when the server sent none", () => {
		const html = render(withRemote({ stale: true, error: null }));
		expect(html).toContain("the previous result");
	});
});
