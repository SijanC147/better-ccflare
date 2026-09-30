/**
 * In-memory map from "the conversation so far" to the Claude Code session that
 * holds it, so a follow-up request resumes the session instead of replaying
 * the whole history. Lost on restart by design: a miss just starts a new
 * session with the history flattened into the prompt.
 */
const MAX_SESSIONS = 500;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

interface SessionEntry {
	sessionId: string;
	storedAt: number;
}

// Map iteration order is insertion order, so re-inserting on every hit makes
// the first key the least recently used.
const sessions = new Map<string, SessionEntry>();

export function getClaudeCodeSession(
	key: string,
	now: number = Date.now(),
): string | null {
	const entry = sessions.get(key);
	if (!entry) return null;
	sessions.delete(key);
	if (now - entry.storedAt > SESSION_TTL_MS) return null;
	sessions.set(key, entry);
	return entry.sessionId;
}

export function putClaudeCodeSession(
	key: string,
	sessionId: string,
	now: number = Date.now(),
): void {
	sessions.delete(key);
	sessions.set(key, { sessionId, storedAt: now });
	while (sessions.size > MAX_SESSIONS) {
		const oldest = sessions.keys().next().value;
		if (oldest === undefined) break;
		sessions.delete(oldest);
	}
}

export function resetClaudeCodeSessions(): void {
	sessions.clear();
}

export function claudeCodeSessionCount(): number {
	return sessions.size;
}
