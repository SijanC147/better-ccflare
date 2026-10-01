import { describe, expect, it } from "bun:test";
import {
	CODEX_TURN_METADATA_HEADER,
	CODEX_TURN_STATE_HEADER,
	CodexTurnStateStore,
	codexTurnId,
	type MessagesTurn,
	messagesTurn,
	turnAnchorIndex,
} from "./turn-state";

// SB23-2370. The store files a token under the account that issued it and the
// keys the client's next request carries; these pin each half of that.

function client(opts: { turnId?: string; token?: string } = {}): Headers {
	const headers = new Headers();
	if (opts.turnId)
		headers.set(
			CODEX_TURN_METADATA_HEADER,
			JSON.stringify({ turn_id: opts.turnId, sandbox: "none" }),
		);
	if (opts.token) headers.set(CODEX_TURN_STATE_HEADER, opts.token);
	return headers;
}

function clock(start = 1_000_000) {
	let now = start;
	return {
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("codexTurnId", () => {
	it("reads turn_id from the metadata JSON", () => {
		expect(codexTurnId(client({ turnId: "turn-1" }))).toBe("turn-1");
	});

	it("is null when the header is absent, malformed, or turn_id is not a usable string", () => {
		expect(codexTurnId(new Headers())).toBeNull();
		expect(codexTurnId(undefined)).toBeNull();
		for (const raw of [
			"{not json",
			"null",
			'"turn-1"',
			'{"turn_id":7}',
			'{"turn_id":""}',
			JSON.stringify({ turn_id: "x".repeat(257) }),
		]) {
			expect(
				codexTurnId(new Headers({ [CODEX_TURN_METADATA_HEADER]: raw })),
			).toBeNull();
		}
		expect(
			codexTurnId(
				new Headers({
					[CODEX_TURN_METADATA_HEADER]: JSON.stringify({
						turn_id: "x".repeat(256),
					}),
				}),
			),
		).toBe("x".repeat(256));
	});
});

describe("CodexTurnStateStore", () => {
	it("sends nothing for a token it never saw issued", () => {
		const store = new CodexTurnStateStore();
		expect(store.resolve(client({ token: "forged" }), "acc-a")).toBeNull();
		expect(
			store.resolve(client({ turnId: "t1", token: "forged" }), "acc-a"),
		).toBeNull();
	});

	it("sends nothing when there is no account to vouch for", () => {
		const store = new CodexTurnStateStore();
		store.record(client({ turnId: "t1" }), "acc-a", "ts-a");
		expect(store.resolve(client({ turnId: "t1" }), undefined)).toBeNull();
	});

	it("replays a token to the account that issued it, keyed by turn_id or by the token itself", () => {
		const store = new CodexTurnStateStore();
		store.record(client({ turnId: "t1" }), "acc-a", "ts-a");
		expect(store.resolve(client({ turnId: "t1" }), "acc-a")).toBe("ts-a");
		store.record(client(), "acc-a", "ts-x");
		expect(store.resolve(client({ token: "ts-x" }), "acc-a")).toBe("ts-x");
	});

	it("does not pull an earlier turn's entry into a new turn when upstream re-issues the same value", () => {
		const store = new CodexTurnStateStore();
		store.record(client({ turnId: "t1" }), "acc-a", "same");
		store.record(client({ turnId: "t1", token: "same" }), "acc-b", "ts-b1");
		expect(
			store.resolve(client({ turnId: "t1", token: "same" }), "acc-b"),
		).toBe("ts-b1");
		// Turn t2: A issued "same" again; B has not answered in t2 yet.
		expect(
			store.resolve(client({ turnId: "t2", token: "same" }), "acc-b"),
		).toBeNull();
	});

	it("never replays one account's token to another", () => {
		const store = new CodexTurnStateStore();
		store.record(client({ turnId: "t1" }), "acc-a", "ts-a");
		expect(store.resolve(client({ turnId: "t1" }), "acc-b")).toBeNull();
		expect(
			store.resolve(client({ turnId: "t1", token: "ts-a" }), "acc-b"),
		).toBeNull();
	});

	it("does not carry a turn's token into another turn", () => {
		const store = new CodexTurnStateStore();
		store.record(client({ turnId: "t1" }), "acc-a", "ts-a");
		expect(store.resolve(client({ turnId: "t2" }), "acc-a")).toBeNull();
	});

	it("files account B's token under the token the client still holds (no turn metadata)", () => {
		// The client keeps its first token for the whole turn. After A's token
		// is stripped on B, B's own token must come back for the next request.
		const store = new CodexTurnStateStore();
		store.record(client(), "acc-a", "ts-a");
		expect(store.resolve(client({ token: "ts-a" }), "acc-b")).toBeNull();
		store.record(client({ token: "ts-a" }), "acc-b", "ts-b");
		expect(store.resolve(client({ token: "ts-a" }), "acc-b")).toBe("ts-b");
		expect(store.resolve(client({ token: "ts-a" }), "acc-a")).toBe("ts-a");
	});

	it("keeps the first value per key: a re-issue or an in-place retry cannot rotate it", () => {
		const store = new CodexTurnStateStore();
		store.record(client({ turnId: "t1" }), "acc-a", "ts-a");
		store.record(client({ turnId: "t1" }), "acc-a", "ts-a2");
		expect(store.resolve(client({ turnId: "t1" }), "acc-a")).toBe("ts-a");
	});

	it("ignores an absent or oversized issued value", () => {
		const store = new CodexTurnStateStore();
		store.record(client({ turnId: "t1" }), "acc-a", null);
		store.record(client({ turnId: "t2" }), "acc-a", "x".repeat(4097));
		store.record(client({ turnId: "t3" }), undefined, "ts-a");
		expect(store.size).toBe(0);
		store.record(client({ turnId: "t4" }), "acc-a", "x".repeat(4096));
		expect(store.resolve(client({ turnId: "t4" }), "acc-a")).toBe(
			"x".repeat(4096),
		);
	});

	it("expires an entry after the TTL, and a read slides it", () => {
		const c = clock();
		const store = new CodexTurnStateStore(1000, 100, c.now);
		store.record(client({ turnId: "t1" }), "acc-a", "ts-a");
		c.advance(900);
		expect(store.resolve(client({ turnId: "t1" }), "acc-a")).toBe("ts-a");
		c.advance(900);
		expect(store.resolve(client({ turnId: "t1" }), "acc-a")).toBe("ts-a");
		c.advance(1000);
		expect(store.resolve(client({ turnId: "t1" }), "acc-a")).toBeNull();
	});

	it("evicts the least recently used entry past the cap", () => {
		const store = new CodexTurnStateStore(60_000, 4);
		// Two keys each: the turn_id and the issued token's own digest.
		store.record(client({ turnId: "t1" }), "acc-a", "ts-1");
		store.record(client({ turnId: "t2" }), "acc-a", "ts-2");
		expect(store.size).toBe(4);
		// Touch t1 so t2 is the oldest, then add a third turn.
		expect(store.resolve(client({ turnId: "t1" }), "acc-a")).toBe("ts-1");
		store.record(client({ turnId: "t3" }), "acc-a", "ts-3");
		expect(store.size).toBe(4);
		expect(store.resolve(client({ turnId: "t2" }), "acc-a")).toBeNull();
		expect(store.resolve(client({ turnId: "t1" }), "acc-a")).toBe("ts-1");
		expect(store.resolve(client({ turnId: "t3" }), "acc-a")).toBe("ts-3");
	});

	it("scope sets the account's own token and removes anything else", () => {
		const store = new CodexTurnStateStore();
		store.record(client({ turnId: "t1" }), "acc-a", "ts-a");
		const toA = new Headers({ [CODEX_TURN_STATE_HEADER]: "stale" });
		store.scope(toA, client({ turnId: "t1", token: "stale" }), "acc-a");
		expect(toA.get(CODEX_TURN_STATE_HEADER)).toBe("ts-a");
		const toB = new Headers({ [CODEX_TURN_STATE_HEADER]: "ts-a" });
		store.scope(toB, client({ turnId: "t1", token: "ts-a" }), "acc-b");
		expect(toB.has(CODEX_TURN_STATE_HEADER)).toBe(false);
	});
});

// SB23-3629: turns derived from an Anthropic Messages body.
describe("messagesTurn", () => {
	const session = "5e550000-0000-4000-8000-000000000001";
	const body = (over: Record<string, unknown> = {}) => ({
		model: "m",
		metadata: { user_id: JSON.stringify({ session_id: session }) },
		messages: [{ role: "user", content: "hi" }],
		...over,
	});

	it("is null without a UUID session id, without messages, or without an anchor", () => {
		expect(messagesTurn(body({ metadata: undefined }))).toBeNull();
		expect(
			messagesTurn(
				body({ metadata: { user_id: JSON.stringify({ session_id: "nope" }) } }),
			),
		).toBeNull();
		expect(messagesTurn(body({ messages: [] }))).toBeNull();
		expect(
			messagesTurn(
				body({
					messages: [
						{
							role: "user",
							content: [
								{ type: "tool_result", tool_use_id: "t", content: "x" },
							],
						},
					],
				}),
			),
		).toBeNull();
	});

	it("names the turn by session and model, and ignores system and cache_control", () => {
		const base = messagesTurn(body());
		expect(base).not.toBeNull();
		expect(messagesTurn(body({ system: "changed every request" }))?.key).toBe(
			base?.key,
		);
		expect(
			messagesTurn(
				body({
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text: "hi",
									cache_control: { type: "ephemeral" },
								},
							],
						},
					],
				}),
			)?.key,
		).toBe(base?.key);
		expect(messagesTurn(body({ model: "other" }))?.key).not.toBe(base?.key);
		expect(
			messagesTurn(
				body({
					metadata: {
						user_id: JSON.stringify({
							session_id: "5e550000-0000-4000-8000-000000000002",
						}),
					},
				}),
			)?.key,
		).not.toBe(base?.key);
	});

	it("anchors on the last user message holding anything but a tool_result", () => {
		const tr = { type: "tool_result", tool_use_id: "t", content: "x" };
		expect(
			turnAnchorIndex([
				{ role: "user", content: "a" },
				{ role: "assistant", content: "b" },
				{ role: "user", content: [tr] },
			]),
		).toBe(0);
		expect(
			turnAnchorIndex([
				{ role: "user", content: "a" },
				{ role: "assistant", content: "b" },
				{ role: "user", content: [tr, { type: "text", text: "c" }] },
			]),
		).toBe(2);
	});
});

describe("CodexTurnStateStore messages turns", () => {
	const session = "5e550000-0000-4000-8000-000000000003";
	const turn = (n: number) =>
		messagesTurn({
			model: "m",
			metadata: { user_id: JSON.stringify({ session_id: session }) },
			messages: [
				{ role: "user", content: "go" },
				...Array.from({ length: n }, (_, i) => [
					{
						role: "assistant",
						content: [{ type: "tool_use", id: `t${i}`, name: "x", input: {} }],
					},
					{
						role: "user",
						content: [
							{ type: "tool_result", tool_use_id: `t${i}`, content: "" },
						],
					},
				]).flat(),
			],
		}) as MessagesTurn;

	it("replays only to a strict extension of the last answered request", () => {
		const store = new CodexTurnStateStore();
		const l0 = store.lookupMessagesTurn(turn(0), "A");
		expect(l0.match).toBe("fresh");
		store.recordMessagesTurn(l0, "A", "tok");
		const l1 = store.lookupMessagesTurn(turn(1), "A");
		expect([l1.match, l1.token]).toEqual(["extends", "tok"]);
		store.recordMessagesTurn(l1, "A", null);
		const l2 = store.lookupMessagesTurn(turn(2), "A");
		expect(l2.token).toBe("tok");
		// A shorter body under the same key is a rewind: poisoned from here on.
		expect(store.lookupMessagesTurn(turn(1), "A").match).toBe("other");
		expect(store.lookupMessagesTurn(turn(3), "A").match).toBe("poisoned");
	});

	it("does not replay to a longer body that does not extend the answered one", () => {
		const store = new CodexTurnStateStore();
		store.recordMessagesTurn(
			store.lookupMessagesTurn(turn(1), "A"),
			"A",
			"tok",
		);
		const fork = { ...turn(3), prefixes: [...turn(3).prefixes] };
		// Index 2 is the chain digest over the three messages A answered.
		fork.prefixes[2] = "not-the-answered-history";
		expect(store.lookupMessagesTurn(fork, "A")).toMatchObject({
			match: "other",
			token: null,
		});
	});

	it("keeps accounts apart", () => {
		const store = new CodexTurnStateStore();
		store.recordMessagesTurn(
			store.lookupMessagesTurn(turn(0), "A"),
			"A",
			"tok",
		);
		expect(store.lookupMessagesTurn(turn(1), "B")).toMatchObject({
			match: "fresh",
			token: null,
		});
	});

	it("poisons a key two fresh starts raced on", () => {
		const store = new CodexTurnStateStore();
		const first = store.lookupMessagesTurn(turn(0), "A");
		const second = store.lookupMessagesTurn(turn(0), "A");
		store.recordMessagesTurn(first, "A", "tok-1");
		store.recordMessagesTurn(second, "A", "tok-2");
		expect(store.lookupMessagesTurn(turn(1), "A").match).toBe("poisoned");
	});

	it("poisons a key two follow-ups of one position raced on", () => {
		const store = new CodexTurnStateStore();
		store.recordMessagesTurn(
			store.lookupMessagesTurn(turn(0), "A"),
			"A",
			"tok",
		);
		const x = store.lookupMessagesTurn(turn(1), "A");
		const y = store.lookupMessagesTurn(turn(2), "A");
		store.recordMessagesTurn(x, "A", null);
		store.recordMessagesTurn(y, "A", null);
		expect(store.lookupMessagesTurn(turn(3), "A").match).toBe("poisoned");
	});

	it("forgets a turn after the TTL and files no oversized token", () => {
		const c = clock();
		const store = new CodexTurnStateStore(1000, 100, c.now);
		store.recordMessagesTurn(
			store.lookupMessagesTurn(turn(0), "A"),
			"A",
			"tok",
		);
		c.advance(1001);
		expect(store.lookupMessagesTurn(turn(1), "A").match).toBe("fresh");
		store.recordMessagesTurn(
			store.lookupMessagesTurn(turn(0), "B"),
			"B",
			"x".repeat(4097),
		);
		expect(store.lookupMessagesTurn(turn(1), "B").match).toBe("fresh");
	});
});
