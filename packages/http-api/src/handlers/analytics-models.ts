/**
 * `GET /api/analytics/models` — per-model usage from the request log.
 *
 * Why this exists next to `/api/analytics` rather than inside it: that
 * endpoint answers the per-model question three times, and every one of them
 * is capped at ten rows and shaped for a particular chart.
 * `model_distribution` returns counts only, `cost_by_model` filters
 * `COALESCE(cost_usd, 0) > 0` and so omits every plan-billed model, and
 * `modelPerformance` returns latency. None returns the token split, and the
 * dashboard reassembles the pieces client-side by joining two independently
 * capped lists on the model name.
 *
 * This route returns one row per model with no `LIMIT`, so a caller gets the
 * whole window rather than its top ten, and gets tokens, cost and counts from
 * one query instead of a name join over three.
 */

import {
	BadRequest,
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import type {
	AnalyticsModelRow,
	AnalyticsModelsGroupBy,
	AnalyticsModelsResponse,
} from "@better-ccflare/types";
import { NO_ACCOUNT_ID } from "@better-ccflare/types";
import type { APIContext } from "../types";
import { buildRequestFilters, getRangeConfig } from "../utils/query-filters";

const log = new Logger("AnalyticsModelsHandler");

const GROUP_BY_VALUES: readonly AnalyticsModelsGroupBy[] = [
	"model",
	"account",
	"project",
];

/**
 * A row as SQL returns it. Both engines are in play: SQLite hands back plain
 * numbers, PostgreSQL hands `bigint` sums back as strings, so every numeric
 * field is widened here and narrowed once in `toNumber`.
 */
type ModelSqlRow = {
	model: string;
	account_name: string | null;
	project: string | null;
	requests: number | string | null;
	success_requests: number | string | null;
	input_tokens: number | string | null;
	cache_read_input_tokens: number | string | null;
	cache_creation_input_tokens: number | string | null;
	output_tokens: number | string | null;
	total_tokens: number | string | null;
	plan_cost_usd: number | string | null;
	api_cost_usd: number | string | null;
	total_cost_usd: number | string | null;
	avg_total_tokens_per_success: number | string | null;
	avg_tokens_per_second: number | string | null;
};

function toNumber(value: number | string | null | undefined): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

/**
 * For the two averages, which carry a meaning `toNumber` would destroy: SQL
 * returns NULL when the denominator is zero, and that is "no answer", not
 * zero. Collapsing it to 0 would report a model that never succeeded as
 * having succeeded with no tokens.
 */
function toNullableNumber(
	value: number | string | null | undefined,
): number | null {
	if (value === null || value === undefined) return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

/** Returns null for an unrecognized value; the caller turns that into a 400. */
function parseGroupBy(raw: string | null): AnalyticsModelsGroupBy | null {
	if (raw === null || raw === "") return "model";
	if ((GROUP_BY_VALUES as readonly string[]).includes(raw)) {
		return raw as AnalyticsModelsGroupBy;
	}
	return null;
}

export function createAnalyticsModelsHandler(context: APIContext) {
	return async (params: URLSearchParams): Promise<Response> => {
		const db = context.dbOps.getAdapter();

		// Rejected rather than ignored. Silently falling back to "model" would
		// return one row per model to a caller that asked for one row per
		// account, which reads as "every request came from one account".
		const groupBy = parseGroupBy(params.get("groupBy"));
		if (groupBy === null) {
			return errorResponse(
				BadRequest(
					`Unknown groupBy. Expected one of: ${GROUP_BY_VALUES.join(", ")}`,
				),
			);
		}

		// `range` is normalized here so meta.range reports the window actually
		// used; an unknown value becomes 24h rather than erroring.
		const { startMs, range } = getRangeConfig(params.get("range") ?? "24h");

		// The shared clause: timestamp window, accounts, models, apiKeys,
		// status, projects. Nothing about the window or the filters is written
		// by hand here, so this endpoint and /api/analytics can never
		// interpret the same query string two ways.
		const { whereClause, params: queryParams } = buildRequestFilters(
			params,
			startMs,
		);

		// The second grouping dimension, when one was asked for.
		//
		// `a.name` is selected raw and the unattributed bucket is named in TS
		// rather than with a COALESCE bind parameter. A parameter in the
		// SELECT list would sit ahead of the WHERE clause's parameters in the
		// statement text, and BunSqlAdapter numbers PostgreSQL placeholders by
		// position, so it would renumber every filter parameter.
		const join =
			groupBy === "account"
				? "LEFT JOIN accounts a ON a.id = r.account_used"
				: "";
		const dimensionSelect =
			groupBy === "account"
				? "a.name AS account_name, CAST(NULL AS TEXT) AS project"
				: groupBy === "project"
					? "CAST(NULL AS TEXT) AS account_name, r.project AS project"
					: "CAST(NULL AS TEXT) AS account_name, CAST(NULL AS TEXT) AS project";
		const dimensionGroup =
			groupBy === "account"
				? ", a.name"
				: groupBy === "project"
					? ", r.project"
					: "";
		// `NULLS LAST` on both, and it is not cosmetic. Each dimension column
		// is nullable — `r.project` by column definition, `a.name` because the
		// LEFT JOIN yields NULL for a request with no account and for one whose
		// `account_used` names a row no longer in `accounts` — and the default
		// placement of a NULL under ASC differs by engine. Measured
		// 2026-09-18 on SQLite 3.54.0 (bun:sqlite) and PostgreSQL 18.6 with
		// three rows, one of them NULL: SQLite returned the NULL first,
		// PostgreSQL returned it last. So the same window returned rows in two
		// different orders on the two engines until this clause, and a caller
		// diffing the response across a backend migration saw a change that
		// was not there. Both engines accept `NULLS LAST` (SQLite since 3.30),
		// and with it both returned a-proj, b-proj, NULL.
		const dimensionOrder =
			groupBy === "account"
				? ", a.name ASC NULLS LAST"
				: groupBy === "project"
					? ", r.project ASC NULLS LAST"
					: "";

		try {
			const rows = await db.query<ModelSqlRow>(
				`
				SELECT
					r.model AS model,
					${dimensionSelect},
					COUNT(*) AS requests,
					SUM(CASE WHEN r.success = TRUE THEN 1 ELSE 0 END) AS success_requests,
					SUM(COALESCE(r.input_tokens, 0)) AS input_tokens,
					SUM(COALESCE(r.cache_read_input_tokens, 0)) AS cache_read_input_tokens,
					SUM(COALESCE(r.cache_creation_input_tokens, 0)) AS cache_creation_input_tokens,
					SUM(COALESCE(r.output_tokens, 0)) AS output_tokens,
					SUM(COALESCE(r.total_tokens, 0)) AS total_tokens,
					SUM(CASE WHEN r.billing_type = 'plan' THEN COALESCE(r.cost_usd, 0) ELSE 0 END) AS plan_cost_usd,
					SUM(CASE WHEN r.billing_type != 'plan' THEN COALESCE(r.cost_usd, 0) ELSE 0 END) AS api_cost_usd,
					SUM(COALESCE(r.cost_usd, 0)) AS total_cost_usd,
					-- Denominator named on purpose. A failed request stores 0
					-- tokens rather than NULL, so COUNT(*) here would report a
					-- model as using fewer tokens the more often it fails.
					SUM(CASE WHEN r.success = TRUE THEN COALESCE(r.total_tokens, 0) ELSE 0 END) * 1.0
						/ NULLIF(SUM(CASE WHEN r.success = TRUE THEN 1 ELSE 0 END), 0)
						AS avg_total_tokens_per_success,
					-- The one column with no DEFAULT 0, so NULL-skipping in AVG
					-- is what we want, and only here.
					-- This comment deliberately contains no apostrophe and no
					-- question mark. convertPlaceholders in BunSqlAdapter scans
					-- the raw statement and skips neither comments nor
					-- apostrophes inside them, so either character here
					-- corrupts the whole placeholder rewrite.
					AVG(r.output_tokens_per_second) AS avg_tokens_per_second
				FROM requests r
				${join}
				WHERE ${whereClause} AND r.model IS NOT NULL
				GROUP BY r.model${dimensionGroup}
				ORDER BY requests DESC, r.model ASC${dimensionOrder}
			`,
				queryParams,
			);

			const models: AnalyticsModelRow[] = rows.map((row) => {
				const requests = toNumber(row.requests);
				const successRequests = toNumber(row.success_requests);
				const base: AnalyticsModelRow = {
					model: row.model,
					requests,
					successRequests,
					errorRequests: requests - successRequests,
					inputTokens: toNumber(row.input_tokens),
					cacheReadInputTokens: toNumber(row.cache_read_input_tokens),
					cacheCreationInputTokens: toNumber(row.cache_creation_input_tokens),
					outputTokens: toNumber(row.output_tokens),
					totalTokens: toNumber(row.total_tokens),
					planCostUsd: toNumber(row.plan_cost_usd),
					apiCostUsd: toNumber(row.api_cost_usd),
					totalCostUsd: toNumber(row.total_cost_usd),
					avgTotalTokensPerSuccess: toNullableNumber(
						row.avg_total_tokens_per_success,
					),
					avgTokensPerSecond: toNullableNumber(row.avg_tokens_per_second),
				};

				if (groupBy === "account") {
					// The sentinel the accounts filter also uses, but NOT a
					// value that always round-trips. Two different rows reach
					// this bucket: a request with a NULL account_used, and a
					// request whose account_used names a row no longer in
					// `accounts`, which the LEFT JOIN also yields as NULL.
					// `buildRequestFilters` matches only the first
					// (query-filters.ts:128-131), so feeding this value back as
					// `accounts=no_account` returns the NULL-attributed
					// requests and not the orphaned ones.
					base.account = row.account_name ?? NO_ACCOUNT_ID;
				} else if (groupBy === "project") {
					// Left null rather than given a placeholder name: "no
					// project" is a real state here, and inventing "Unknown"
					// would collide with a project actually called that.
					base.project = row.project ?? null;
				}

				return base;
			});

			const response: AnalyticsModelsResponse = {
				meta: {
					range,
					groupBy,
					modelColumn: "model",
					excludesNullModel: true,
				},
				models,
			};

			return jsonResponse(response);
		} catch (error) {
			log.error("Failed to compute per-model analytics:", error);
			return errorResponse(
				InternalServerError("Failed to compute per-model analytics"),
			);
		}
	};
}
