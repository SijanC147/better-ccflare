import { createHash } from "node:crypto";

/**
 * Codex's sticky-routing token (SB23-2370). Upstream `openai/codex`
 * `codex-rs/core/src/client.rs` defines it: the server issues it as a response
 * header at turn start, and the client sends the same value back on every
 * later request of that turn. An auth-owner change clears it "so the new owner
 * gets fresh routing state".
 *
 * This proxy changes the owner mid-turn on every failover and rotation while
 * the client keeps replaying, so the value is scoped to the account that
 * issued it: a token goes upstream only to that account, and any other value
 * the client presents is stripped. What upstream does with a foreign token,
 * and what the affinity buys, are both unmeasured.
 */
export const CODEX_TURN_STATE_HEADER = "x-codex-turn-state";

/** JSON carrying the client's `turn_id` (upstream `turn_metadata.rs`). */
export const CODEX_TURN_METADATA_HEADER = "x-codex-turn-metadata";

/**
 * Set by the proxy, after it has verified the internal probe secret, on a
 * request it generated itself (a cache keepalive, an auto-refresh probe).
 * Those replay a client's body and are not a step in anyone's turn, so they
 * take no part in turns derived from the body (SB23-3629). Stripped before
 * the request leaves ccflare.
 */
export const CODEX_INTERNAL_REPLAY_HEADER = "x-better-ccflare-internal-replay";

/** Long enough for a turn paused on a tool approval; refreshed on each use. */
export const CODEX_TURN_STATE_TTL_MS = 2 * 60 * 60 * 1000;
export const CODEX_TURN_STATE_MAX_ENTRIES = 5000;
/** A value past this is not stored, so one response cannot pin memory. */
const MAX_TOKEN_LENGTH = 4096;
const MAX_TURN_ID_LENGTH = 256;

interface Entry {
	token: string;
	expiresAt: number;
}

/**
 * A turn derived from an Anthropic Messages body (SB23-3629). `token` is null
 * once the key has been poisoned. `length` and `prefix` name the last request
 * this account answered in the turn: the next one must extend it.
 */
interface DerivedEntry {
	token: string | null;
	length: number;
	prefix: string;
	expiresAt: number;
}

/**
 * How a request's body related to the turn the account had on file:
 * `fresh` when there was none, `extends` when it strictly extends the last
 * request answered, `other` for anything else under the same key (a rewind, a
 * fork, a byte-identical re-send), and `poisoned` when an earlier `other`
 * already ruled the key out.
 */
export type MessagesTurnMatch = "fresh" | "extends" | "other" | "poisoned";

/** What a request's lookup saw, carried to the response that records it. */
export interface MessagesTurnLookup {
	key: string;
	length: number;
	prefix: string;
	match: MessagesTurnMatch;
	token: string | null;
	/** The position an `extends` lookup extended, so a record can tell whether another request moved it since. */
	from?: { length: number; prefix: string };
}

/**
 * A turn named by an Anthropic Messages body. `prefixes[i]` digests
 * `messages[0..i]`, so request B extends request A exactly when B is longer
 * and `B.prefixes[A.length - 1]` equals A's last prefix.
 */
export interface MessagesTurn {
	key: string;
	prefixes: string[];
}

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The session id Claude Code puts in `metadata.user_id`, a JSON string
 * carrying `session_id`, or null when there is none or it is not a UUID.
 */
export function messagesSessionId(body: unknown): string | null {
	const rawUserId = (body as { metadata?: { user_id?: unknown } } | null)
		?.metadata?.user_id;
	if (typeof rawUserId !== "string") return null;
	try {
		const metadata = JSON.parse(rawUserId) as unknown;
		if (!metadata || typeof metadata !== "object") return null;
		const sessionId = (metadata as Record<string, unknown>).session_id;
		return typeof sessionId === "string" && UUID.test(sessionId)
			? sessionId.toLowerCase()
			: null;
	} catch {
		return null;
	}
}

function contentBlocks(message: unknown): unknown[] {
	const content = (message as { content?: unknown } | null)?.content;
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? content : [];
}

function stripCacheControl(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripCacheControl);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			if (k !== "cache_control") out[k] = stripCacheControl(v);
		}
		return out;
	}
	return value;
}

/**
 * One message as compared across requests. A client writes its newest
 * message as a block array to hang `cache_control` on it, and the same
 * message as a plain string once it is older, so string content is read as
 * its one text block and `cache_control` is dropped. Without this, measured
 * on real traffic, no follow-up ever matches the request before it.
 */
export function normalizeMessage(message: unknown): string {
	const base =
		message !== null && typeof message === "object"
			? (message as Record<string, unknown>)
			: {};
	return JSON.stringify(
		stripCacheControl({ ...base, content: contentBlocks(message) }),
	);
}

/**
 * Claude Code's text for a tool call the user refused. With feedback, the
 * user's words follow it inside the `tool_result`, so typed text arrives
 * without a text block of its own.
 */
const CLAUDE_CODE_REJECTION =
	"The user doesn't want to proceed with this tool use";

function opensTurn(block: unknown): boolean {
	const b = block as { type?: unknown; content?: unknown } | null;
	if (b?.type !== "tool_result") return true;
	// Bias toward a new turn: a refusal may carry a new instruction. Measured
	// at 0 of 154 real follow-ups, so this costs no observed replay.
	return JSON.stringify(b.content ?? "").includes(CLAUDE_CODE_REJECTION);
}

/**
 * The index of the last `user` message that opens a turn: one holding any
 * block that is not a `tool_result`, or a `tool_result` recording a refusal.
 * A tool-loop follow-up adds only ordinary `tool_result` blocks, so the anchor
 * stays put; typed text, an interrupt marker, a `<system-reminder>` beside the
 * results or a refusal moves it, which reads as a new turn. -1 when no
 * message qualifies.
 */
export function turnAnchorIndex(messages: readonly unknown[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if ((messages[i] as { role?: unknown } | null)?.role !== "user") continue;
		if (contentBlocks(messages[i]).some(opensTurn)) return i;
	}
	return -1;
}

/**
 * The turn an Anthropic Messages body belongs to: a digest of its session id,
 * its model and `messages[0..k]` at the anchor. Null without a session id,
 * because a key from the messages alone collides across clients sending the
 * same prompt. `system` is left out because Claude Code changes it on almost
 * every request of a turn (131 of 132 measured follow-ups).
 */
export function messagesTurn(body: unknown): MessagesTurn | null {
	const session = messagesSessionId(body);
	const messages = (body as { messages?: unknown } | null)?.messages;
	if (!session || !Array.isArray(messages) || messages.length === 0)
		return null;
	const anchor = turnAnchorIndex(messages);
	if (anchor < 0) return null;
	const prefixes: string[] = [];
	let prefix = "";
	for (const message of messages) {
		prefix = digest("prefix", `${prefix}\0${normalizeMessage(message)}`);
		prefixes.push(prefix);
	}
	const model = (body as { model?: unknown }).model;
	return {
		key: digest(
			"messages-turn",
			`${session}\0${typeof model === "string" ? model : ""}\0${prefixes[anchor]}`,
		),
		prefixes,
	};
}

function digest(kind: string, value: string): string {
	return createHash("sha256")
		.update(`better-ccflare:codex-turn-state:v1\0${kind}\0`)
		.update(value)
		.digest("hex");
}

/** The client's `turn_id`, or null when the header is absent or malformed. */
export function codexTurnId(headers: Headers | undefined): string | null {
	const raw = headers?.get(CODEX_TURN_METADATA_HEADER);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as unknown;
		const turnId =
			parsed !== null && typeof parsed === "object"
				? (parsed as { turn_id?: unknown }).turn_id
				: undefined;
		return typeof turnId === "string" &&
			turnId.length > 0 &&
			turnId.length <= MAX_TURN_ID_LENGTH
			? turnId
			: null;
	} catch {
		return null;
	}
}

/**
 * Turn-state tokens per (account, turn). A turn is named by whatever the
 * client's next request will carry: its `turn_id`, and the token it holds.
 * The client keeps its first token for the whole turn (a `OnceLock`), so
 * after a failover account B's token is filed under the token the client
 * still sends, and the next request to B carries B's own value.
 */
export class CodexTurnStateStore {
	private readonly entries = new Map<string, Entry>();
	private readonly derived = new Map<string, DerivedEntry>();

	constructor(
		private readonly ttlMs = CODEX_TURN_STATE_TTL_MS,
		private readonly maxEntries = CODEX_TURN_STATE_MAX_ENTRIES,
		private readonly now: () => number = Date.now,
	) {}

	get size(): number {
		return this.entries.size;
	}

	/**
	 * A token key. With a `turn_id` the key carries it, so a value upstream
	 * happened to issue in an earlier turn cannot pull that turn's entry into
	 * this one.
	 */
	private tokenKey(turnId: string | null, token: string): string {
		return digest("token", turnId ? `${turnId}\0${token}` : token);
	}

	/** Lookup keys, most specific first, for a client request's headers. */
	private requestKeys(headers: Headers | undefined): string[] {
		const keys: string[] = [];
		const turnId = codexTurnId(headers);
		if (turnId) keys.push(digest("turn", turnId));
		const presented = headers?.get(CODEX_TURN_STATE_HEADER);
		if (presented) keys.push(this.tokenKey(turnId, presented));
		return keys;
	}

	private slot(accountId: string, key: string): string {
		return `${accountId}\0${key}`;
	}

	private read(slot: string): string | null {
		const entry = this.entries.get(slot);
		if (!entry) return null;
		if (entry.expiresAt <= this.now()) {
			this.entries.delete(slot);
			return null;
		}
		// Re-insert to move it to the most-recently-used end, and slide the TTL.
		this.entries.delete(slot);
		entry.expiresAt = this.now() + this.ttlMs;
		this.entries.set(slot, entry);
		return entry.token;
	}

	/**
	 * The value to send to `accountId` for a request carrying `clientHeaders`,
	 * or null to send none. Never the client's own value unless this account
	 * issued it.
	 */
	resolve(
		clientHeaders: Headers | undefined,
		accountId: string | undefined,
	): string | null {
		if (!accountId) return null;
		for (const key of this.requestKeys(clientHeaders)) {
			const token = this.read(this.slot(accountId, key));
			if (token) return token;
		}
		return null;
	}

	/**
	 * Files a token `accountId` issued, under every key the client's next
	 * request in this turn can carry. The first value per key is kept, as the
	 * client keeps its first: an in-place retry or an echo cannot rotate it.
	 */
	record(
		clientHeaders: Headers | undefined,
		accountId: string | undefined,
		issued: string | null,
	): void {
		if (!accountId || !issued || issued.length > MAX_TOKEN_LENGTH) return;
		const keys = [
			...this.requestKeys(clientHeaders),
			this.tokenKey(codexTurnId(clientHeaders), issued),
		];
		for (const key of keys) {
			const slot = this.slot(accountId, key);
			if (this.read(slot) !== null) continue;
			this.entries.set(slot, {
				token: issued,
				expiresAt: this.now() + this.ttlMs,
			});
		}
		this.evict();
	}

	private evict(): void {
		this.evictFrom(this.entries);
	}

	private evictFrom(map: Map<string, { expiresAt: number }>): void {
		const now = this.now();
		// Map order is least-recently-used first, and every write or read sets
		// expiresAt to now + ttl, so it is also soonest-expiring first.
		for (const [slot, entry] of map) {
			if (map.size <= this.maxEntries && entry.expiresAt > now) break;
			map.delete(slot);
		}
	}

	/** A live derived entry, moved to the most-recently-used end with its TTL slid. */
	private readDerived(slot: string): DerivedEntry | undefined {
		const entry = this.derived.get(slot);
		if (!entry) return undefined;
		this.derived.delete(slot);
		if (entry.expiresAt <= this.now()) return undefined;
		entry.expiresAt = this.now() + this.ttlMs;
		this.derived.set(slot, entry);
		return entry;
	}

	/**
	 * The token to replay to `accountId` for a request whose body names
	 * `turn` (SB23-3629). Only a request that strictly extends the last one
	 * this account answered in the turn gets one. Anything else under a key
	 * the account has on file poisons that key for the TTL: a rewind that
	 * resends the same prompt, a fork, or a byte-identical re-send cannot be
	 * told from a different turn, and not replaying is the old behaviour.
	 */
	lookupMessagesTurn(
		turn: MessagesTurn,
		accountId: string,
	): MessagesTurnLookup {
		const length = turn.prefixes.length;
		const base = { key: turn.key, length, prefix: turn.prefixes[length - 1] };
		const entry = this.readDerived(this.slot(accountId, turn.key));
		if (!entry) return { ...base, match: "fresh", token: null };
		if (entry.token === null)
			return { ...base, match: "poisoned", token: null };
		if (
			length > entry.length &&
			turn.prefixes[entry.length - 1] === entry.prefix
		)
			return {
				...base,
				match: "extends",
				token: entry.token,
				from: { length: entry.length, prefix: entry.prefix },
			};
		entry.token = null;
		return { ...base, match: "other", token: null };
	}

	/**
	 * Records a 2xx answer to a request looked up with `lookupMessagesTurn`.
	 * A fresh turn files the token `accountId` issued; a follow-up moves the
	 * turn's position forward and keeps the first token, as the Codex client
	 * keeps its first. Two requests racing on one key, two fresh starts or
	 * two follow-ups of one position, poison it: siblings look like that.
	 */
	recordMessagesTurn(
		lookup: MessagesTurnLookup,
		accountId: string,
		issued: string | null,
	): void {
		const slot = this.slot(accountId, lookup.key);
		const entry = this.readDerived(slot);
		if (lookup.match === "fresh") {
			if (entry) {
				entry.token = null;
				return;
			}
			if (!issued || issued.length > MAX_TOKEN_LENGTH) return;
			this.derived.set(slot, {
				token: issued,
				length: lookup.length,
				prefix: lookup.prefix,
				expiresAt: this.now() + this.ttlMs,
			});
			this.evictFrom(this.derived);
			return;
		}
		if (lookup.match !== "extends" || !entry || entry.token === null) return;
		if (
			!lookup.from ||
			entry.token !== lookup.token ||
			entry.length !== lookup.from.length ||
			entry.prefix !== lookup.from.prefix
		) {
			entry.token = null;
			return;
		}
		entry.length = lookup.length;
		entry.prefix = lookup.prefix;
	}

	/**
	 * Sets or removes the turn-state header on an outbound request to
	 * `accountId`. Mutates `outbound` in place.
	 */
	scope(
		outbound: Headers,
		clientHeaders: Headers | undefined,
		accountId: string | undefined,
	): void {
		const token = this.resolve(clientHeaders, accountId);
		if (token) outbound.set(CODEX_TURN_STATE_HEADER, token);
		else outbound.delete(CODEX_TURN_STATE_HEADER);
	}
}
