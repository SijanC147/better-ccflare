import { describe, expect, it } from "bun:test";
import {
	MAX_MIN_RESET_REMAINING_MS,
	MAX_RESET_HOURS,
	MS_PER_HOUR,
} from "@better-ccflare/types";
import { createSlotUpdateHandler } from "../combos";

/**
 * SB23-2061. `min_reset_remaining_ms` was validated with `Number.isInteger` and
 * `>= 0` and nothing else, so the handler accepted values it cannot store.
 *
 * `Number.isInteger(3.6e26)` is **true** — above `MAX_SAFE_INTEGER` the
 * spacing between representable doubles exceeds 1, so every double up there is
 * an "integer" by that test. `"1e20"` hours therefore passed the form, passed
 * this handler, and reached the database above int64.
 *
 * The dashboard field gained a ceiling in `#131`, but a client-side guard is
 * not a bound: the route is reachable with curl, and a value already stored
 * above the limit renders back into the hours field as invalid text nobody
 * typed, which is why `#131` needed an enabled-only escape in
 * `buildSlotUpdate` so such a slot could still be turned off.
 *
 * The handler rejects rather than clamps. A silent substitution is how
 * `retry_attempts: 0` became 3, the largest value in play
 * (`mem:validation-fallback-picks-the-aggressive-end`).
 */

type Slot = {
	id: string;
	combo_id: string;
	account_id: string;
	model: string;
	priority: number;
	enabled: boolean;
};

const slot: Slot = {
	id: "slot-1",
	combo_id: "combo-1",
	account_id: "acc-1",
	model: "claude-opus-5",
	priority: 0,
	enabled: true,
};

function makeDbOps() {
	const updated: Array<Record<string, unknown>> = [];
	return {
		updated,
		ops: {
			getCombo: async () => ({ id: "combo-1", name: "C", enabled: true }),
			getAccount: async (id: string) => ({
				id,
				name: "acc",
				provider: "anthropic",
			}),
			getComboSlots: async () => [slot],
			updateComboSlot: async (_id: string, fields: Record<string, unknown>) => {
				updated.push(fields);
				return { id: "slot-1", ...fields };
			},
		},
	};
}

// biome-ignore lint/suspicious/noExplicitAny: minimal DatabaseOperations mock
const asOps = (o: unknown) => o as any;

function put(body: unknown) {
	return new Request("http://local/api/combos/combo-1/slots/slot-1", {
		method: "PUT",
		body: JSON.stringify(body),
	});
}

async function update(body: unknown) {
	const db = makeDbOps();
	const res = await createSlotUpdateHandler(asOps(db.ops))(
		put(body),
		"combo-1",
		"slot-1",
	);
	return { res, updated: db.updated };
}

describe("PUT combo slot: min_reset_remaining_ms upper bound", () => {
	it("rejects 1e20 hours, the value Number.isInteger waves through", async () => {
		// The exact case from the #131 review. Not a round number chosen for the
		// test: 1e20 hours is what a fat-fingered exponent in the hours field
		// produces, and it is an "integer" by the check this replaces.
		const ms = 1e20 * MS_PER_HOUR;
		expect(Number.isInteger(ms)).toBe(true);
		expect(ms > Number.MAX_SAFE_INTEGER).toBe(true);

		const { res, updated } = await update({ min_reset_remaining_ms: ms });

		expect(res.status).toBe(400);
		// Nothing written: the refusal happens before the update, so a rejected
		// request cannot leave the slot half-changed.
		expect(updated).toHaveLength(0);
	});

	it("names both bounds in the error, not just the lower one", async () => {
		const { res } = await update({ min_reset_remaining_ms: -1 });
		const body = (await res.json()) as { error?: string };

		expect(res.status).toBe(400);
		expect(String(body.error)).toContain("0");
		expect(String(body.error)).toContain(String(MAX_MIN_RESET_REMAINING_MS));
	});

	it("accepts the ceiling itself", async () => {
		const { res, updated } = await update({
			min_reset_remaining_ms: MAX_MIN_RESET_REMAINING_MS,
		});

		expect(res.status).toBe(200);
		expect(updated).toEqual([
			{ min_reset_remaining_ms: MAX_MIN_RESET_REMAINING_MS },
		]);
	});

	it("rejects the ceiling plus one hour", async () => {
		// Plus one millisecond is not representable up there — MAX_SAFE_INTEGER
		// plus 1 rounds back to itself — so the smallest step that actually
		// produces a larger double is what the boundary has to be probed with.
		// A `+ 1` test here would pass against an unbounded handler.
		const { res, updated } = await update({
			min_reset_remaining_ms: MAX_MIN_RESET_REMAINING_MS + MS_PER_HOUR,
		});

		expect(res.status).toBe(400);
		expect(updated).toHaveLength(0);
	});

	it("still accepts 0, which means the reset clause never blocks", async () => {
		// 0 is a real setting, not an unset field, and the lower bound must not
		// creep to `> 0` while an upper bound is being added.
		const { res, updated } = await update({ min_reset_remaining_ms: 0 });

		expect(res.status).toBe(200);
		expect(updated).toEqual([{ min_reset_remaining_ms: 0 }]);
	});

	it("still accepts null, which clears the threshold", async () => {
		const { res, updated } = await update({ min_reset_remaining_ms: null });

		expect(res.status).toBe(200);
		expect(updated).toEqual([{ min_reset_remaining_ms: null }]);
	});

	it("accepts a realistic five-hour window", async () => {
		const fiveHours = 5 * MS_PER_HOUR;
		const { res, updated } = await update({
			min_reset_remaining_ms: fiveHours,
		});

		expect(res.status).toBe(200);
		expect(updated).toEqual([{ min_reset_remaining_ms: fiveHours }]);
	});
});

describe("the shared ceiling", () => {
	it("is the same number the dashboard's hours field enforces", async () => {
		// The point of moving MAX_RESET_HOURS into packages/types. If these two
		// ever diverge, the form accepts a value the API rejects, or worse the
		// reverse. Asserting the relationship rather than a literal is what makes
		// this survive a change to either.
		expect(MAX_MIN_RESET_REMAINING_MS).toBe(MAX_RESET_HOURS * MS_PER_HOUR);
		expect(MAX_MIN_RESET_REMAINING_MS).toBeLessThanOrEqual(
			Number.MAX_SAFE_INTEGER,
		);
	});

	it("leaves less than one hour of headroom below MAX_SAFE_INTEGER", async () => {
		// Proves the ceiling is the largest whole-hour value that fits, rather
		// than an arbitrary round number that happens to be safe. A mutation
		// halving MAX_RESET_HOURS passes the test above and fails this one.
		const headroom = Number.MAX_SAFE_INTEGER - MAX_MIN_RESET_REMAINING_MS;
		expect(headroom).toBeLessThan(MS_PER_HOUR);
	});
});
