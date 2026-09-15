export type ComboFamily = "fable" | "opus" | "sonnet" | "haiku";

// Database row types (snake_case, INTEGER booleans — match SQLite storage)
export interface ComboRow {
	id: string;
	name: string;
	description: string | null;
	enabled: number; // 0 or 1
	created_at: number;
	updated_at: number;
}

export interface ComboSlotRow {
	id: string;
	combo_id: string;
	account_id: string;
	model: string;
	priority: number;
	enabled: number; // 0 or 1
	// Per-slot throttle thresholds. NULL means "no threshold", which is the
	// only state that leaves routing exactly as it was before the feature.
	max_utilization_percent: number | null; // 0-100
	min_reset_remaining_ms: number | null; // milliseconds
}

export interface ComboFamilyAssignmentRow {
	family: string;
	combo_id: string | null;
	enabled: number; // 0 or 1
}

// Domain model types (camelCase, proper booleans)
export interface Combo {
	id: string;
	name: string;
	description: string | null;
	enabled: boolean;
	created_at: number;
	updated_at: number;
}

export interface ComboSlot {
	id: string;
	combo_id: string;
	account_id: string;
	model: string;
	priority: number;
	enabled: boolean;
	/**
	 * Utilization clause of the per-slot throttle rule: the slot is a skip
	 * candidate while the account's representative utilization is at or above
	 * this percentage (0-100).
	 *
	 * Only the CONFIGURED conditions are evaluated, and every configured one
	 * must hold. This field set alone skips on utilization alone; null here
	 * with `min_reset_remaining_ms` set skips on the reset clause alone; null
	 * on both leaves routing exactly as it was before the feature. An earlier
	 * version of this comment described a conjunction requiring both columns,
	 * which was the behaviour `#107` shipped and `#112` corrected.
	 */
	max_utilization_percent: number | null;
	/**
	 * Reset clause of the per-slot throttle rule: the slot is only skipped
	 * while the representative usage window is still at least this many
	 * milliseconds from resetting. A reset that is closer than this means the
	 * account frees up shortly, so there is nothing to route around.
	 */
	min_reset_remaining_ms: number | null;
}

export interface ComboFamilyAssignment {
	family: ComboFamily;
	combo_id: string | null;
	enabled: boolean;
}

// Extended type with slots populated
export interface ComboWithSlots extends Combo {
	slots: ComboSlot[];
}

// Converter functions (Row -> Domain)
export function toCombo(row: ComboRow): Combo {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		enabled: !!row.enabled,
		created_at: Number(row.created_at),
		updated_at: Number(row.updated_at),
	};
}

export function toComboSlot(row: ComboSlotRow): ComboSlot {
	return {
		id: row.id,
		combo_id: row.combo_id,
		account_id: row.account_id,
		model: row.model,
		priority: Number(row.priority),
		enabled: !!row.enabled,
		// Postgres and SQLite both hand these back as null when unset; the
		// Number() coercion is deliberately inside the null guard so a stored
		// 0 stays 0 rather than becoming null.
		max_utilization_percent:
			row.max_utilization_percent === null ||
			row.max_utilization_percent === undefined
				? null
				: Number(row.max_utilization_percent),
		min_reset_remaining_ms:
			row.min_reset_remaining_ms === null ||
			row.min_reset_remaining_ms === undefined
				? null
				: Number(row.min_reset_remaining_ms),
	};
}

export function toComboFamilyAssignment(
	row: ComboFamilyAssignmentRow,
): ComboFamilyAssignment {
	return {
		family: row.family as ComboFamily,
		combo_id: row.combo_id,
		enabled: !!row.enabled,
	};
}
