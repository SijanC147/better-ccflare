#!/usr/bin/env bun
/**
 * SB23-3629 measurement: how a turn-anchor rule classifies real Anthropic
 * Messages traffic. Reads OpenObserve `_search` output (one or more JSON files
 * whose `hits` carry `_timestamp` and `requestbody`) and prints shapes and
 * counts only. It never prints a message, a session id or any other value
 * from a body, because a fixture built from production data is production
 * data.
 *
 * The rule under test: a turn is named by a digest of the session identity
 * plus `messages[0..k]` with `cache_control` stripped, where `k` is the last
 * `user` message holding any block that is not a `tool_result`.
 *
 * Usage: bun scripts/codex-turn-anchor-measure.ts <hits.json>...
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

type Block = { type?: string; [key: string]: unknown };
type Message = { role?: string; content?: unknown };
type Body = {
	model?: unknown;
	system?: unknown;
	tools?: unknown;
	metadata?: { user_id?: unknown };
	messages?: Message[];
};

interface Req {
	ts: number;
	body: Body;
	session: string | null;
	sessionSource: "json" | "legacy" | "none";
	messages: string[];
	anchor: number;
	key: string | null;
}

function stripCacheControl(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripCacheControl);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			if (k === "cache_control") continue;
			out[k] = stripCacheControl(v);
		}
		return out;
	}
	return value;
}

function blocks(message: Message): Block[] {
	const content = message.content;
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? (content as Block[]) : [];
}

function sessionOf(body: Body): Pick<Req, "session" | "sessionSource"> {
	const raw = body.metadata?.user_id;
	if (typeof raw !== "string") return { session: null, sessionSource: "none" };
	try {
		const parsed = JSON.parse(raw) as { session_id?: unknown };
		if (typeof parsed?.session_id === "string")
			return { session: parsed.session_id, sessionSource: "json" };
	} catch {
		// Older Claude Code: user_<hash>_account_<uuid>_session_<uuid>.
	}
	const legacy = /_session_([0-9a-f-]{36})$/i.exec(raw);
	return legacy
		? { session: legacy[1], sessionSource: "legacy" }
		: { session: null, sessionSource: "none" };
}

export function anchorIndex(messages: Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "user") continue;
		if (blocks(m).some((b) => b.type !== "tool_result")) return i;
	}
	return -1;
}

const SYSTEM_REMINDER = /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/;

function isReminder(b: Block): boolean {
	return b.type === "text" && SYSTEM_REMINDER.test(String(b.text ?? ""));
}

/** Shape of one user message: which block kinds it holds. */
function userShape(m: Message): string {
	const bs = blocks(m);
	const tr = bs.filter((b) => b.type === "tool_result").length;
	const sr = bs.filter(isReminder).length;
	const text = bs.filter((b) => b.type === "text" && !isReminder(b)).length;
	const other = bs.length - tr - sr - text;
	const parts = [];
	if (tr) parts.push("tool_result");
	if (sr) parts.push("reminder");
	if (text) parts.push("text");
	if (other) parts.push("other");
	return parts.join("+") || "empty";
}

/** A tool_result that carries words the user typed (a rejection with feedback). */
function carriesUserWords(m: Message): boolean {
	return blocks(m).some((b) => {
		if (b.type !== "tool_result") return false;
		const text = JSON.stringify(b.content ?? "");
		return /user (doesn't|does not) want|user said|rejected|interrupted/i.test(
			text,
		);
	});
}

function hasErrorResult(m: Message): boolean {
	return blocks(m).some((b) => b.type === "tool_result" && b.is_error === true);
}

function digest(...parts: string[]): string {
	const h = createHash("sha256");
	for (const p of parts) h.update(p).update("\0");
	return h.digest("hex");
}

function load(paths: string[]): Req[] {
	const out: Req[] = [];
	for (const path of paths) {
		const json = JSON.parse(readFileSync(path, "utf8")) as {
			hits?: { _timestamp: number; requestbody?: string }[];
		};
		for (const hit of json.hits ?? []) {
			if (!hit.requestbody) continue;
			let body: Body;
			try {
				body = JSON.parse(hit.requestbody) as Body;
			} catch {
				continue;
			}
			const raw = Array.isArray(body.messages) ? body.messages : [];
			// A client writes the newest message as a block array to hang
			// cache_control on it and the same message as a plain string once it
			// is older, so string content is compared as its one text block.
			const messages = raw.map((m) =>
				JSON.stringify(stripCacheControl({ ...m, content: blocks(m) })),
			);
			const anchor = anchorIndex(raw);
			const { session, sessionSource } = sessionOf(body);
			const key =
				session && anchor >= 0
					? digest(session, ...messages.slice(0, anchor + 1))
					: null;
			out.push({
				ts: hit._timestamp,
				body,
				session,
				sessionSource,
				messages,
				anchor,
				key,
			});
		}
	}
	return out.sort((a, b) => a.ts - b.ts);
}

function isStrictPrefix(a: string[], b: string[]): boolean {
	if (a.length >= b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

function same(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((m, i) => m === b[i]);
}

function bump(map: Map<string, number>, key: string) {
	map.set(key, (map.get(key) ?? 0) + 1);
}

function main() {
	const reqs = load(process.argv.slice(2));
	const report: Record<string, unknown> = {};
	report.requests = reqs.length;
	const sources = new Map<string, number>();
	for (const r of reqs) bump(sources, r.sessionSource);
	report.sessionSource = Object.fromEntries(sources);
	report.sessions = new Set(reqs.map((r) => r.session).filter(Boolean)).size;
	report.noAnchor = reqs.filter((r) => r.anchor < 0).length;

	// Extension pairs: B and its latest earlier request P in the same session
	// whose messages are a strict prefix of B's. Ground truth is read from
	// what B added on top of P.
	const pairs = new Map<string, number>();
	const unsafe = new Map<string, number>();
	const drift = new Map<string, number>();
	const errors = new Map<string, number>();
	let extension = 0;
	let roots = 0;
	for (let i = 0; i < reqs.length; i++) {
		const b = reqs[i];
		let p: Req | undefined;
		for (let j = i - 1; j >= 0; j--) {
			const c = reqs[j];
			if (c.session !== b.session) continue;
			if (isStrictPrefix(c.messages, b.messages)) {
				p = c;
				break;
			}
		}
		if (!p) {
			roots++;
			continue;
		}
		extension++;
		const added = b.messages
			.slice(p.messages.length)
			.map((m) => JSON.parse(m) as Message);
		const lastUser = [...added].reverse().find((m) => m.role === "user");
		const assistant = added.find((m) => m.role === "assistant");
		const toolUse = assistant
			? blocks(assistant).some((x) => x.type === "tool_use")
			: false;
		const shape = lastUser ? userShape(lastUser) : "no-user";
		const truth =
			shape === "tool_result" && toolUse
				? carriesUserWords(lastUser as Message)
					? "tool-loop(user-words-in-result)"
					: "tool-loop"
				: shape.includes("tool_result") && !shape.includes("text")
					? "tool-loop+reminder"
					: shape.includes("tool_result")
						? "ambiguous(tool_result+typed-text)"
						: "new-prompt";
		const rule = b.key !== null && b.key === p.key ? "same" : "new";
		if (lastUser && hasErrorResult(lastUser)) bump(errors, `is_error | ${truth}`);
		bump(
			pairs,
			`${truth} | added=${added.map((m) => m.role?.[0]).join("")} | last-user=${shape} | rule=${rule}`,
		);
		if (rule === "same" && truth !== "tool-loop") bump(unsafe, truth);
		if (JSON.stringify(b.body.model) !== JSON.stringify(p.body.model))
			bump(drift, "model");
		if (JSON.stringify(b.body.system) !== JSON.stringify(p.body.system))
			bump(drift, "system");
		if (JSON.stringify(b.body.tools) !== JSON.stringify(p.body.tools))
			bump(drift, "tools");
	}
	report.extensionPairs = extension;
	report.roots = roots;
	report.pairs = Object.fromEntries([...pairs].sort((a, b) => b[1] - a[1]));
	report.ruleSameOnNonToolLoop = Object.fromEntries(unsafe);
	report.extensionPairsWhereFieldChanged = Object.fromEntries(drift);
	report.errorResults = Object.fromEntries(errors);

	// The shipped guard, simulated with every response answered before the
	// next request: replay only to a strict extension of the last request
	// answered in the turn; anything else under a known key poisons it.
	const sim = new Map<string, number>();
	const state = new Map<string, { len: number; prefix: string } | "poison">();
	const seen: Req[] = [];
	for (const r of reqs) {
		if (!r.key) {
			bump(sim, "no key");
			continue;
		}
		const entry = state.get(r.key);
		if (entry === undefined) {
			bump(sim, "fresh");
			state.set(r.key, { len: r.messages.length, prefix: r.messages.join("\n") });
		} else if (entry === "poison") {
			bump(sim, "poisoned");
		} else if (
			r.messages.length > entry.len &&
			r.messages.slice(0, entry.len).join("\n") === entry.prefix
		) {
			const added = r.messages
				.slice(entry.len)
				.map((m) => JSON.parse(m) as Message)
				.filter((m) => m.role === "user");
			const words = added.some(carriesUserWords);
			bump(sim, words ? "replay(user-words-in-result)" : "replay");
			state.set(r.key, { len: r.messages.length, prefix: r.messages.join("\n") });
		} else {
			const earlier = seen.filter((s) => s.key === r.key);
			const identical = earlier.some((s) => same(s.messages, r.messages));
			bump(sim, identical ? "conflict(identical)" : "conflict(rewind/fork)");
			state.set(r.key, "poison");
		}
		seen.push(r);
	}
	report.simulatedGuard = Object.fromEntries(sim);

	// Collisions: a later request sharing an earlier request's key without
	// extending it. Identical bodies are retries (same turn); anything else is
	// a rewind, a fork or a sibling, which the rule would call the same turn.
	const collisions = new Map<string, number>();
	const byKey = new Map<string, Req[]>();
	for (const r of reqs) {
		if (!r.key) continue;
		const earlier = byKey.get(r.key) ?? [];
		const last = earlier[earlier.length - 1];
		if (last) {
			const kind = same(last.messages, r.messages)
				? "identical(retry)"
				: isStrictPrefix(last.messages, r.messages)
					? "extends-latest"
					: isStrictPrefix(r.messages, last.messages)
						? "prefix-of-latest(rewind)"
						: "diverges(fork/sibling)";
			const sameModel =
				JSON.stringify(last.body.model) === JSON.stringify(r.body.model);
			const sameSystem =
				JSON.stringify(last.body.system) === JSON.stringify(r.body.system);
			bump(
				collisions,
				`${kind} | model ${sameModel ? "same" : "differs"} | system ${sameSystem ? "same" : "differs"} | gap ${Math.round((r.ts - last.ts) / 1e6)}s`.replace(
					/gap \d+s/,
					(g) => (Number(g.slice(4, -1)) > 300 ? "gap >5m" : "gap <=5m"),
				),
			);
		}
		earlier.push(r);
		byKey.set(r.key, earlier);
	}
	report.keyReuse = Object.fromEntries(collisions);
	report.distinctKeys = byKey.size;

	// Without a session id the key is the messages alone: how many requests
	// from different sessions would then collide.
	const bare = new Map<string, Set<string>>();
	for (const r of reqs) {
		if (r.anchor < 0) continue;
		const k = digest(...r.messages.slice(0, r.anchor + 1));
		const s = bare.get(k) ?? new Set<string>();
		s.add(r.session ?? `none:${r.ts}`);
		bare.set(k, s);
	}
	report.sessionlessKeysSharedAcrossSessions = [...bare.values()].filter(
		(s) => s.size > 1,
	).length;

	console.log(JSON.stringify(report, null, 2));
}

if (import.meta.main) main();
