import * as fs from "node:fs";
import * as nodePath from "node:path";

/**
 * Encode an absolute path the way Claude Code names its `~/.claude/projects`
 * directories: every `/`, `_` and `.` becomes `-`.
 *
 * This is the ONLY direction the mapping is defined in. Three characters map
 * onto one, so the result cannot be inverted: nothing in the encoded string
 * records which `-` came from which character. Compare forward instead
 * (`encodePath(realDirectory) === encodedName`), never backward.
 *
 * @param absolutePath  e.g. "/Users/foo/Code/claude-meta"
 * @returns  e.g. "-Users-foo-Code-claude-meta"
 */
export function encodePath(absolutePath: string): string {
	return absolutePath.replace(/[/_.]/g, "-");
}

/** Encode a single path segment (no separators). */
function encodeSegment(segment: string): string {
	return segment.replace(/[_.]/g, "-");
}

/**
 * Naive decode of a Claude project encoded-name back to an absolute path.
 *
 * WRONG BY CONSTRUCTION, and kept only as the last-resort fallback when
 * `resolveEncodedName` cannot find a real directory. The encoder maps `/`, `_`
 * and `.` all to `-`, so replacing every `-` with `/` invents directory levels
 * for any path containing an underscore or a dot. Callers must mark the result
 * `ambiguous: true`.
 *
 * @param encodedName  e.g. "-Users-foo-Code-my-project"
 * @returns  e.g. "/Users/foo/Code/my/project"   (ambiguous!)
 */
export function naiveDecode(encodedName: string): string {
	if (!encodedName.startsWith("-")) {
		// Unexpected shape; return as-is rather than crashing.
		return encodedName;
	}
	// Replace leading `-` with `/`, then every subsequent `-` with `/`.
	return `/${encodedName.slice(1).replace(/-/g, "/")}`;
}

/** Directory lister, injectable so tests need no filesystem. */
export type ReadDirFn = (dir: string) => string[];

const defaultReadDir: ReadDirFn = (dir) => {
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch {
		return [];
	}
};

/** Hard ceiling on directories visited, so a pathological name cannot hang a scan. */
const MAX_VISITS = 20_000;

/**
 * Resolve a Claude project encoded-name to the real absolute path it was
 * generated from, by descending the filesystem and encoding each real
 * directory name forward.
 *
 * At every level the remaining encoded text is matched against
 * `encodeSegment(realChildName)`. A child is followed only when the remainder
 * equals its encoding (a complete match) or starts with that encoding plus a
 * `-` (more path to come). The encoded string is never taken apart, so the
 * `/` vs `_` vs `.` ambiguity never has to be guessed.
 *
 * @returns the absolute path when exactly one real directory encodes to
 *   `encodedName`; null when none does, or when several do and the name is
 *   genuinely ambiguous on this host.
 */
export function resolveEncodedName(
	encodedName: string,
	readDir: ReadDirFn = defaultReadDir,
): string | null {
	if (!encodedName.startsWith("-")) return null;

	const matches: string[] = [];
	let visits = 0;

	const descend = (currentDir: string, remainder: string): void => {
		// Two complete matches already: the name is ambiguous, stop early.
		if (matches.length > 1) return;
		if (visits >= MAX_VISITS) return;
		visits++;

		for (const child of readDir(currentDir)) {
			const encoded = encodeSegment(child);
			if (encoded.length === 0) continue;
			const childPath = nodePath.join(currentDir, child);

			if (remainder === encoded) {
				matches.push(childPath);
				if (matches.length > 1) return;
				continue;
			}
			if (remainder.startsWith(`${encoded}-`)) {
				descend(childPath, remainder.slice(encoded.length + 1));
				if (matches.length > 1) return;
			}
		}
	};

	descend(nodePath.sep, encodedName.slice(1));

	return matches.length === 1 ? matches[0] : null;
}

/**
 * Returns true when a canonical absolute path looks like a Claude Code worktree
 * under a known convention.
 *
 * Built-in heuristic (seeds `detectedAsWorktree`; does NOT override user rules):
 *
 *   A path matches if:
 *   1. Any path segment equals exactly `worktrees`, OR
 *   2. Any path segment equals exactly `.worktrees`, OR
 *   3. Any path segment starts with `.` AND the immediately-following segment
 *      equals `worktrees`.
 *
 * This catches:
 *   - `.maestro/worktrees/…`
 *   - `.ralph/worktrees/…`
 *   - `.claude/worktrees/…`
 *   - `.omc/worktrees/…`
 *   - `worktrees/…`  (bare convention)
 *   - `.worktrees/…`  (dotfile convention)
 *
 * It intentionally does NOT match plain paths like `/tmp/foo-worktree-bar`.
 */
export function isLikelyWorktreePath(path: string): boolean {
	// Normalise separators and split into segments, filtering empty strings
	// (leading slash, double slashes, trailing slash).
	const segments = nodePath.normalize(path).split(nodePath.sep).filter(Boolean);

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];

		// Rule 1 + 2: segment is exactly `worktrees` or `.worktrees`
		if (seg === "worktrees" || seg === ".worktrees") {
			return true;
		}

		// Rule 3: segment starts with `.` and the next segment is `worktrees`
		if (
			seg.startsWith(".") &&
			seg.length > 1 &&
			i + 1 < segments.length &&
			segments[i + 1] === "worktrees"
		) {
			return true;
		}
	}

	return false;
}
