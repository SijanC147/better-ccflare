import type { ZaiUsageData } from "../zai-usage-fetcher";

/**
 * Build a complete `ZaiUsageData` for tests.
 *
 * Every field the interface requires is given a default here, so a caller
 * supplies only the windows its assertions care about. That is the point: the
 * twelve literals this replaces each listed `time_limit` and `tokens_limit`
 * and none of them listed `tokens_limit_weekly`, so the field added for the
 * weekly window broke all twelve at once (SB23-2443).
 *
 * The defaults are inert. All three windows default to `null`, which is the
 * shape `fetchZaiUsageData` starts from before it assigns what the API sent,
 * so a test that does not name a window is not relying on a value some other
 * test chose.
 *
 * There is no `as ZaiUsageData` here on purpose. The return type is checked
 * against the interface, so the next window added to `ZaiUsageData` fails this
 * one file at compile time instead of reopening the fixtures.
 */
export function makeZaiUsage(
	overrides: Partial<ZaiUsageData> = {},
): ZaiUsageData {
	return {
		time_limit: null,
		tokens_limit: null,
		tokens_limit_weekly: null,
		...overrides,
	};
}
