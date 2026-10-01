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
		const now = this.now();
		// Map order is least-recently-used first, and every write or read sets
		// expiresAt to now + ttl, so it is also soonest-expiring first.
		for (const [slot, entry] of this.entries) {
			if (this.entries.size <= this.maxEntries && entry.expiresAt > now) break;
			this.entries.delete(slot);
		}
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
