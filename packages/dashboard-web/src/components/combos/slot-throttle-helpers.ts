import type { ComboSlot } from "@better-ccflare/types";

const MS_PER_HOUR = 3_600_000;

/**
 * A field the operator left blank is `null` (clear the threshold), a field
 * holding a number is that number, and anything else is `"invalid"`.
 *
 * The blank check happens BEFORE any numeric coercion on purpose: `Number("")`
 * and `Number("  ")` are both `0`, and `max_utilization_percent: 0` means "skip
 * whenever utilization is at or above 0", which disables the slot. Clearing a
 * field and typing a zero have to stay distinguishable all the way to the
 * payload (SB23-1269).
 */
export type ParsedField = number | null | "invalid";

export function parseIntegerField(raw: string): ParsedField {
	if (raw.trim().length === 0) return null;
	const value = Number(raw);
	if (!Number.isFinite(value) || !Number.isInteger(value)) return "invalid";
	return value;
}

export function parsePercentField(raw: string): ParsedField {
	const parsed = parseIntegerField(raw);
	if (parsed === null || parsed === "invalid") return parsed;
	if (parsed < 0 || parsed > 100) return "invalid";
	return parsed;
}

/**
 * The reset threshold is stored in milliseconds and an operator thinks in
 * hours, so the form takes hours. Fractional hours are allowed on the way in
 * and rounded on the way out, because the handler rejects a non-integer
 * millisecond value.
 */
export function parseHoursField(raw: string): ParsedField {
	if (raw.trim().length === 0) return null;
	const hours = Number(raw);
	if (!Number.isFinite(hours) || hours < 0) return "invalid";
	return Math.round(hours * MS_PER_HOUR);
}

/**
 * Render a stored millisecond value for the hours field. Deliberately exact
 * rather than rounded to two places: a value set through the API that is not a
 * whole number of hours must not render as something the form would then write
 * back as a different number.
 */
export function msToHoursInput(ms: number | null): string {
	if (ms === null) return "";
	return String(ms / MS_PER_HOUR);
}

export function numberToInput(value: number | null): string {
	if (value === null) return "";
	return String(value);
}

export interface SlotThrottleDraft {
	enabled: boolean;
	maxUtilizationPercent: string;
	minResetRemainingHours: string;
}

export interface SlotThrottleUpdate {
	enabled?: boolean;
	max_utilization_percent?: number | null;
	min_reset_remaining_ms?: number | null;
}

export function draftFromSlot(slot: ComboSlot): SlotThrottleDraft {
	return {
		enabled: slot.enabled,
		maxUtilizationPercent: numberToInput(slot.max_utilization_percent),
		minResetRemainingHours: msToHoursInput(slot.min_reset_remaining_ms),
	};
}

export interface DraftValidation {
	percent: ParsedField;
	resetMs: ParsedField;
	hasInvalidField: boolean;
}

export function validateDraft(draft: SlotThrottleDraft): DraftValidation {
	const percent = parsePercentField(draft.maxUtilizationPercent);
	const resetMs = parseHoursField(draft.minResetRemainingHours);
	return {
		percent,
		resetMs,
		hasInvalidField: percent === "invalid" || resetMs === "invalid",
	};
}

/**
 * Only the keys that actually changed. The handler reads three states from
 * each field: absent means leave the stored value alone, `null` clears it, and
 * a number sets it. Sending an unchanged field would be harmless for equal
 * values but is not harmless for the hours field, where a stored value that is
 * not a whole number of hours could be written back rounded.
 *
 * Returns `null` when a field is invalid, so a caller cannot send a partial
 * payload built from a half-parsed form.
 */
export function buildSlotUpdate(
	slot: ComboSlot,
	draft: SlotThrottleDraft,
): SlotThrottleUpdate | null {
	const { percent, resetMs, hasInvalidField } = validateDraft(draft);
	if (hasInvalidField) return null;

	const update: SlotThrottleUpdate = {};
	if (draft.enabled !== slot.enabled) {
		update.enabled = draft.enabled;
	}
	if (percent !== slot.max_utilization_percent) {
		update.max_utilization_percent = percent as number | null;
	}
	if (resetMs !== slot.min_reset_remaining_ms) {
		update.min_reset_remaining_ms = resetMs as number | null;
	}
	return update;
}

export function isDirty(update: SlotThrottleUpdate | null): boolean {
	if (update === null) return false;
	return Object.keys(update).length > 0;
}

/**
 * The one-line summary shown on the collapsed row, so an operator can see that
 * a slot carries a rule without opening the popover. Mirrors the settled
 * semantics: only the configured conditions are evaluated, and every
 * configured one must hold.
 */
export function describeSlotThrottle(slot: ComboSlot): string | null {
	const clauses: string[] = [];
	if (slot.max_utilization_percent !== null) {
		clauses.push(`usage >= ${slot.max_utilization_percent}%`);
	}
	if (slot.min_reset_remaining_ms !== null) {
		clauses.push(
			`reset >= ${msToHoursInput(slot.min_reset_remaining_ms)}h away`,
		);
	}
	if (clauses.length === 0) return null;
	return `skip when ${clauses.join(" and ")}`;
}
