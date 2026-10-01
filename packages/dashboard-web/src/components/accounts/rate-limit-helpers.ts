/**
 * Pure, testable display helpers for RateLimitProgress.
 *
 * The usage-window row builder (`collectAnthropicUsageRows` and the helpers it
 * uses) lives in `@better-ccflare/core` so the CLI's `tui overview` renders the
 * same rows as this dashboard (SB23-2259); it is re-exported here so existing
 * imports keep working. What remains below is dashboard-only.
 */
import type { AnthropicUsageData } from "@better-ccflare/types";

export {
	collectAnthropicLimitRows,
	collectAnthropicUsageRows,
	displayLabel,
	formatWindowName,
	isUsageWindow,
	isWeeklyWindow,
	severityColor,
	type UsageDisplay,
} from "@better-ccflare/core";

/**
 * The unit an extra-usage amount is counted in. `null` means the payload gave
 * no currency, so the amount is a bare number and must be shown without one.
 */
export interface ExtraUsageUnit {
	currency: string;
	exponent: number;
}

/**
 * What the "Extra usage" block shows for one Anthropic account (SB23-3266).
 *
 * `absent`: neither `spend.enabled` nor `extra_usage.is_enabled` is a boolean,
 * so the payload says nothing and the block renders nothing. `off`: extra usage
 * is disabled, which must read as "Off" and never as a balance of zero. `on`:
 * amounts are in minor units of `unit`; any of them may be null, and a null is
 * shown as missing rather than as zero.
 */
export type ExtraUsageDisplay =
	| { kind: "absent" }
	| { kind: "off"; reason: string | null }
	| {
			kind: "on";
			used: number | null;
			limit: number | null;
			remaining: number | null;
			percent: number | null;
			unit: ExtraUsageUnit | null;
			limitReached: boolean;
	  };

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** A money object, or null when any of its three fields is unusable. */
function readMoney(
	value: unknown,
): { amount: number; unit: ExtraUsageUnit } | null {
	if (value === null || typeof value !== "object") return null;
	const money = value as Record<string, unknown>;
	const amount = finiteNumber(money.amount_minor);
	const currency = nonEmptyString(money.currency);
	const exponent = validExponent(money.exponent);
	if (amount === null || currency === null || exponent === null) return null;
	return { amount, unit: { currency, exponent } };
}

/**
 * A usable exponent: a whole number from 0 to 20. `toFixed()` throws above 100
 * and below 0, and a throw in render unmounts the whole dashboard, which has no
 * error boundary. Live exponents are 2; 20 leaves room for any real currency.
 */
function validExponent(value: unknown): number | null {
	const n = finiteNumber(value);
	return n !== null && Number.isInteger(n) && n >= 0 && n <= 20 ? n : null;
}

function sameUnit(a: ExtraUsageUnit, b: ExtraUsageUnit): boolean {
	return a.currency === b.currency && a.exponent === b.exponent;
}

interface AmountReading {
	used: number | null;
	limit: number | null;
	unit: ExtraUsageUnit | null;
}

/** `spend.used` / `spend.limit`, or null when neither is usable or they disagree on unit. */
function spendReading(
	usedValue: unknown,
	limitValue: unknown,
): AmountReading | null {
	const used = readMoney(usedValue);
	const limit = readMoney(limitValue);
	if (!used && !limit) return null;
	if (used && limit && !sameUnit(used.unit, limit.unit)) return null;
	return {
		used: used?.amount ?? null,
		limit: limit?.amount ?? null,
		unit: (used ?? limit)?.unit ?? null,
	};
}

/** `extra_usage` figures, in its own currency when it names a usable one. */
function extraReading(
	extra: NonNullable<AnthropicUsageData["extra_usage"]>,
): AmountReading | null {
	const used = finiteNumber(extra.used_credits);
	const limit = finiteNumber(extra.monthly_limit);
	if (used === null && limit === null) return null;
	const currency = nonEmptyString(extra.currency);
	const exponent = validExponent(extra.decimal_places);
	const unit =
		currency !== null && exponent !== null ? { currency, exponent } : null;
	return { used, limit, unit };
}

/**
 * Resolve the extra-usage pool of an Anthropic usage payload for display.
 *
 * Enabled-ness follows the router's precedence (`resolveOverageStatus` in
 * `packages/proxy/src/handlers/model-capacity.ts`): `spend.enabled` outranks
 * `extra_usage.is_enabled`, so the card never says "on" for an account the
 * router treats as off.
 *
 * Amounts come from `spend.used` / `spend.limit` (money objects in one unit)
 * or from `extra_usage.used_credits` / `monthly_limit` (in
 * `extra_usage.currency` when it names one). The two sources are never mixed
 * in one reading, because a used figure from one and a limit from the other
 * would subtract numbers that need not share a unit.
 *
 * The payload is cast, not parsed, on its way to the browser, so every field
 * is checked here rather than trusted from its type.
 */
export function resolveExtraUsageDisplay(
	usageData: AnthropicUsageData | null | undefined,
): ExtraUsageDisplay {
	if (usageData == null || typeof usageData !== "object") {
		return { kind: "absent" };
	}
	const spend =
		usageData.spend != null && typeof usageData.spend === "object"
			? usageData.spend
			: null;
	const extra =
		usageData.extra_usage != null && typeof usageData.extra_usage === "object"
			? usageData.extra_usage
			: null;

	const enabled =
		typeof spend?.enabled === "boolean"
			? spend.enabled
			: typeof extra?.is_enabled === "boolean"
				? extra.is_enabled
				: null;
	if (enabled === null) return { kind: "absent" };
	if (!enabled) {
		return {
			kind: "off",
			reason:
				nonEmptyString(spend?.disabled_reason) ??
				nonEmptyString(extra?.disabled_reason),
		};
	}

	const fromSpend = spendReading(spend?.used, spend?.limit);
	const fromExtra = extra ? extraReading(extra) : null;
	// A reading with both figures wins over one with a figure missing; between
	// two complete readings, `spend` wins because it carries its own unit.
	const complete = (r: AmountReading | null) =>
		r !== null && r.used !== null && r.limit !== null;
	const reading =
		(complete(fromSpend) ? fromSpend : null) ??
		(complete(fromExtra) ? fromExtra : null) ??
		fromSpend ??
		fromExtra;
	const used = reading?.used ?? null;
	const limit = reading?.limit ?? null;
	const unit = reading?.unit ?? null;

	// Overspend is real (a live fixture reads 1123 used of 1000), so remaining
	// clamps at zero while the raw pair stays visible beside it.
	const remaining =
		used !== null && limit !== null ? Math.max(0, limit - used) : null;
	// The percent comes from the same source as the amounts, so the bar can
	// never disagree with the numbers beside it. With no amounts at all, either
	// source's own percent is all there is.
	const sourcePercent =
		reading === null
			? (finiteNumber(spend?.percent) ?? finiteNumber(extra?.utilization))
			: reading === fromSpend
				? finiteNumber(spend?.percent)
				: finiteNumber(extra?.utilization);
	const percent =
		sourcePercent ??
		(used !== null && limit !== null && limit > 0
			? (used / limit) * 100
			: null);

	return {
		kind: "on",
		used,
		limit,
		remaining,
		percent,
		unit,
		limitReached:
			extra?.spend_limit_reached === true ||
			(used !== null && limit !== null && used >= limit),
	};
}

/**
 * One extra-usage amount as text. With a unit it is the currency code and the
 * major-unit value at the unit's precision ("USD 12.34"), formatted by hand so
 * the output does not move with the viewer's locale. Without one it is the bare
 * number: no unit was reported, so none is invented.
 */
export function formatExtraUsageAmount(
	amount: number,
	unit: ExtraUsageUnit | null,
): string {
	if (unit === null) return String(amount);
	return `${unit.currency} ${(amount / 10 ** unit.exponent).toFixed(unit.exponent)}`;
}
