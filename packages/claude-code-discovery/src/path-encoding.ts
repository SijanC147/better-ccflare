import * as nodePath from "node:path";

/**
 * Naive decode of a Claude project encoded-name back to an absolute path.
 *
 * Encoding rule: every `/` in the original absolute path is replaced with `-`.
 * The leading `/` becomes a leading `-`, so encoded names always start with `-`.
 *
 * Decode: replace the leading `-` with `/`, then replace every remaining `-`
 * with `/`.  This is lossy — hyphens that were in directory names are
 * indistinguishable from path separators — so callers must mark the result
 * `ambiguous: true` when they fall back to this function.
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
