import { describe, expect, test } from "bun:test";
import { createRequestByIdHandler } from "../requests";

type Summary = Awaited<
	ReturnType<
		Parameters<typeof createRequestByIdHandler>[0]["getRequestById"]
	>
>;

const row = {
	id: "req_1",
	timestamp: 1_700_000_000_000,
	method: "POST",
	path: "/v1/messages",
	account_used: "acct_a",
	status_code: 200,
	success: true,
	response_time_ms: 42,
};

/** Only the one method the handler reaches. */
function stubDbOps(result: Summary, seen: string[] = []) {
	return {
		getRequestById: async (id: string) => {
			seen.push(id);
			return result;
		},
	} as unknown as Parameters<typeof createRequestByIdHandler>[0];
}

describe("createRequestByIdHandler", () => {
	test("returns the summary row for a known id", async () => {
		const handler = createRequestByIdHandler(stubDbOps(row));
		const res = await handler("req_1");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(row);
	});

	test("404s for an unknown id rather than returning an empty body", async () => {
		// A 200 with null would make "no such request" indistinguishable from a
		// request whose fields are all null, which is what the list routes return
		// for a row still in flight.
		const handler = createRequestByIdHandler(stubDbOps(null));
		const res = await handler("nope");
		expect(res.status).toBe(404);
	});

	test("passes the id through unaltered", async () => {
		const seen: string[] = [];
		const handler = createRequestByIdHandler(stubDbOps(row, seen));
		await handler("req_with-mixed.Chars_1");
		expect(seen).toEqual(["req_with-mixed.Chars_1"]);
	});

	test("does not reach for the payload", async () => {
		// The payload lives at /api/requests/payload/:id. Capture is optional and
		// long-running requests have theirs released, so joining it here would
		// make an ordinary request look broken. A stub with no getRequestPayload
		// throws if the handler ever calls it.
		const handler = createRequestByIdHandler(stubDbOps(row));
		const res = await handler("req_1");
		expect(res.status).toBe(200);
		expect(Object.keys(await res.json())).not.toContain("payload");
	});
});
