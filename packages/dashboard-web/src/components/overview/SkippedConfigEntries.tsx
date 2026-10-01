import type { InvalidConfigEntry } from "@better-ccflare/types";
import { Trash2 } from "lucide-react";
import { Button } from "../ui/button";

/**
 * The `errors` lines that belong to no stored entry, such as the config key
 * not holding an object. An entry's own line is shown beside its delete
 * control instead; the server sends it byte-identical in both lists.
 */
export function unattachedErrors(
	errors: readonly string[],
	invalid: readonly InvalidConfigEntry[],
): string[] {
	const owned = new Set(invalid.map((entry) => entry.error));
	return errors.filter((message) => !owned.has(message));
}

/**
 * Stored config entries the server skipped (SB23-3557). Each entry gets a
 * delete control, because the DELETE route removes a stored key whether or not
 * it is valid and is the only API route that can clear one.
 */
export function SkippedConfigEntries({
	noun,
	errors,
	invalid,
	disabled,
	onDelete,
}: {
	/** "gateway" or "endpoint", for the control's accessible name. */
	noun: string;
	errors: readonly string[];
	invalid: readonly InvalidConfigEntry[];
	disabled: boolean;
	onDelete: (name: string) => void;
}) {
	const other = unattachedErrors(errors, invalid);
	if (invalid.length === 0 && other.length === 0) return null;
	return (
		<div className="space-y-1" role="alert">
			<p className="text-xs font-medium text-destructive">
				Skipped config entries
			</p>
			{invalid.map((entry) => (
				<div key={entry.name} className="flex items-center gap-2">
					<p className="min-w-0 flex-1 break-words text-xs text-destructive">
						{entry.error}
					</p>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="shrink-0"
						disabled={disabled}
						aria-label={`Delete skipped ${noun} ${entry.name}`}
						title={`Delete skipped ${noun} ${entry.name}`}
						onClick={() => onDelete(entry.name)}
					>
						<Trash2 className="h-4 w-4" />
					</Button>
				</div>
			))}
			{other.map((message) => (
				<p key={message} className="text-xs text-destructive">
					{message}
				</p>
			))}
		</div>
	);
}
