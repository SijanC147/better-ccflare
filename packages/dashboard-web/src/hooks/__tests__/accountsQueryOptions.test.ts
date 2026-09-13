import { describe, expect, it } from "bun:test";
import { accountsQueryOptions } from "../queries";

// The kiosk view (/kiosk) is an ambient display: an unfocused tab is its
// normal state, and that is exactly the state React Query stops polling in.
// These assertions read the option value directly rather than observing a
// running query, so they stay fault-sensitive -- flipping the default, or
// dropping the argument through, fails here immediately.
describe("accountsQueryOptions -- background refresh", () => {
	it("does not poll in the background by default", () => {
		expect(accountsQueryOptions().refetchIntervalInBackground).toBe(false);
	});

	it("does not poll in the background when the options object omits the flag", () => {
		expect(accountsQueryOptions({}).refetchIntervalInBackground).toBe(false);
	});

	it("does not poll in the background when the flag is explicitly false", () => {
		expect(
			accountsQueryOptions({ backgroundRefresh: false })
				.refetchIntervalInBackground,
		).toBe(false);
	});

	it("polls in the background when the kiosk asks for it", () => {
		expect(
			accountsQueryOptions({ backgroundRefresh: true })
				.refetchIntervalInBackground,
		).toBe(true);
	});

	it("keeps the same 60s interval whether or not background refresh is on", () => {
		// A kiosk left running for days multiplies whatever interval is chosen,
		// so the kiosk must not poll harder than the dashboard section it
		// mirrors. Both cases assert the literal so a bumped interval is a
		// deliberate edit here, not a silent one.
		expect(accountsQueryOptions().refetchInterval).toBe(60000);
		expect(
			accountsQueryOptions({ backgroundRefresh: true }).refetchInterval,
		).toBe(60000);
	});

	it("uses the same query key either way, so the cache is shared", () => {
		expect(accountsQueryOptions({ backgroundRefresh: true }).queryKey).toEqual(
			accountsQueryOptions().queryKey,
		);
	});
});
