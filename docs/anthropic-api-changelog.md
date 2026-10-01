# Anthropic API Changelog

This document tracks changes to the Anthropic API responses that affect better-ccflare.

## Usage API Endpoint

**Endpoint**: `GET https://api.anthropic.com/api/oauth/usage`

**Headers Required**:
```bash
Authorization: Bearer {access_token}
anthropic-beta: oauth-2025-04-20
Accept: application/json
```

### Version History

#### 2026-10-01 (Current)

**Last Verified**: 2026-10-01, read from better-ccflare's own usage cache
(`GET /api/accounts` on the host) across seven Anthropic OAuth accounts. No
Anthropic endpoint was called for this entry. Key names and JSON types only,
with how many of the seven carried each type where they differ. SB23-3266.

**Response Structure** (types, not values):
```text
five_hour, seven_day           object  {utilization: number, resets_at: string,
                                        limit_dollars: null, used_dollars: null,
                                        remaining_dollars: null, locked_reason: null}
seven_day_oauth_apps           null
seven_day_opus                 null
seven_day_sonnet               null
seven_day_cowork               null
seven_day_omelette             null
seven_day_breakdown            object on 4, null on 3
limits                         array of {kind: string, group: string,
                                        percent: number, severity: string,
                                        resets_at: string, scope: object | null,
                                        is_active: boolean}
                               kinds seen: session, weekly_all, weekly_scoped
extra_usage                    object  {is_enabled: boolean,
                                        monthly_limit: number | null,
                                        used_credits: number | null,
                                        utilization: number | null,
                                        currency: string | null,
                                        decimal_places: number | null,
                                        disabled_reason: string | null,
                                        user_disabled: boolean,
                                        spend_limit_reached: boolean,
                                        credits_ever_enabled: boolean,
                                        daily: null, weekly: null}
spend                          object  {used: {amount_minor: number, currency: string, exponent: number},
                                        limit: {amount_minor, currency, exponent} on 3, null on 4,
                                        cap: {money: {amount_minor, currency, exponent}, credits: null} on 3, null on 4,
                                        percent: number, severity: string,
                                        enabled: boolean,
                                        disabled_reason: string on 3, null on 4,
                                        balance: null, auto_reload: null,
                                        disclaimer: string,
                                        can_purchase_credits: boolean,
                                        can_toggle: boolean}
member_dashboard_available     boolean
omelette_promotional           null
iguana_necktie                 object on 3, null on 4
tangelo, nimbus_quill, cinder_cove, copper_kite, brass_thimble,
harbor_lantern, wattle_ember, amber_ladder, amber_cistern,
juniper_tide, cedar_ember, amber_gauge
                               null
```

**Changes from 2025-11-25**:
- `extra_usage` gained `currency`, `decimal_places`, `disabled_reason`,
  `user_disabled`, `spend_limit_reached`, `credits_ever_enabled`, `daily`
  and `weekly`.
- **`extra_usage.monthly_limit` and `used_credits` are minor units of
  `extra_usage.currency`, with `decimal_places` digits.** On all three accounts
  carrying a limit, `monthly_limit` equalled `spend.limit.amount_minor`,
  `used_credits` equalled `spend.used.amount_minor`, `decimal_places`
  equalled `spend.used.exponent`, and the currencies matched. The comparison
  printed booleans, never the amounts.
- `spend.enabled` agreed with `extra_usage.is_enabled` on all seven.
  The router still gives `spend.enabled` precedence
  (`packages/proxy/src/handlers/model-capacity.ts`), and the dashboard follows.
- `spend.cap.money` equalled `spend.limit` on all three that had one.
- New since 2025-11-25:
  - the `spend` and `limits` blocks;
  - `member_dashboard_available`, `omelette_promotional`, `seven_day_cowork`,
    `seven_day_omelette` and `seven_day_breakdown`;
  - the five-hour window's `*_dollars` and `locked_reason` keys;
  - the twelve codename keys listed above, besides `iguana_necktie`, which
    2025-11-25 already had.

**Resets and promotional credits**:
`GET /api/oauth/usage` is the only Anthropic endpoint better-ccflare reads for
usage, and nothing in it states when the extra-usage pool resets.
`extra_usage` has no `resets_at`; its `daily` and `weekly` keys were null on
every account. The only reset dates in the payload are the plan windows', in
`limits[].resets_at` and `five_hour` / `seven_day`. The renewal date the
dashboard shows beside the balance is the operator-set `renewalDay`, labelled
as such, and whether the pool renews on that day is unverified.

One key names a promotion: `omelette_promotional`, null on all seven. Others
that could carry a grant or a balance were null everywhere too: `spend.balance`,
`spend.auto_reload`, `spend.cap.credits` and the five-hour window's
`*_dollars` keys. A key that has only ever been null has no shape to type, so
none of these is typed or rendered. To go further, a human has to read the
claude.ai billing page for an account holding a promotional grant, and file the
field name and shape. Probing any other Anthropic endpoint with an account's
OAuth token is out of bounds for automation (CLAUDE.md).

#### 2025-11-25

**Last Verified**: 2025-11-25

**Response Structure**:
```json
{
  "five_hour": {
    "utilization": 19.0,
    "resets_at": "2025-11-25T22:00:00.288792+00:00"
  },
  "seven_day": {
    "utilization": 7.0,
    "resets_at": "2025-12-01T21:00:00.288804+00:00"
  },
  "seven_day_oauth_apps": {
    "utilization": 0.0,
    "resets_at": null
  },
  "seven_day_opus": null,
  "seven_day_sonnet": null,
  "iguana_necktie": null,
  "extra_usage": {
    "is_enabled": false,
    "monthly_limit": null,
    "used_credits": null,
    "utilization": null
  }
}
```

**Changes from Previous Version**:
- ✨ **NEW**: `seven_day_sonnet` field - Tracks Sonnet-specific weekly usage limits
- ✨ **NEW**: `iguana_necktie` field - Purpose unknown, possibly internal Anthropic field
- ✨ **NEW**: `extra_usage` object - Tracks additional/purchased usage credits
  - `is_enabled`: Whether extra usage credits are enabled for this account
  - `monthly_limit`: Monthly credit limit (if applicable)
  - `used_credits`: Credits used in current period
  - `utilization`: Percentage of extra credits used (0-100)

**Notes**:
- All fields can be `null` when not applicable to the account tier
- `utilization` values are percentages from 0-100
- `resets_at` timestamps are in ISO 8601 format with timezone
- Fields may be absent, `null`, or contain data depending on account configuration

#### Pre-2025-11 (Legacy)

**Response Structure**:
```json
{
  "five_hour": {
    "utilization": 0.0,
    "resets_at": "2025-11-25T20:00:00.000000+00:00"
  },
  "seven_day": {
    "utilization": 0.0,
    "resets_at": "2025-12-01T19:00:00.000000+00:00"
  },
  "seven_day_oauth_apps": {
    "utilization": 0.0,
    "resets_at": null
  },
  "seven_day_opus": {
    "utilization": 0.0,
    "resets_at": "2025-12-01T19:00:00.000000+00:00"
  }
}
```

**Fields**:
- `five_hour`: 5-hour rolling window usage limit
- `seven_day`: 7-day rolling window usage limit
- `seven_day_oauth_apps`: OAuth app-specific 7-day limit
- `seven_day_opus`: Opus model-specific 7-day limit

---

## Implementation Notes

### How better-ccflare Handles API Changes

The usage fetcher in `packages/providers/src/usage-fetcher.ts` is designed to be resilient to API changes:

1. **Dynamic Field Iteration**: Instead of hardcoding field names, we iterate through all properties to find `UsageWindow` objects
2. **Optional Fields**: All fields except `five_hour` and `seven_day` are optional in the TypeScript interface
3. **Index Signature**: The interface includes `[key: string]` to allow unknown fields
4. **Null-Safe**: All code checks for `null` and `undefined` before accessing nested properties

### Testing API Changes

To test the current API response:

```bash
# Get an access token from the database
sqlite3 ~/.config/better-ccflare/better-ccflare.db "SELECT access_token FROM accounts WHERE name = 'claude' LIMIT 1;"

# Test the API endpoint
curl -v -X GET "https://api.anthropic.com/api/oauth/usage" \
  -H "Authorization: Bearer {token}" \
  -H "anthropic-beta: oauth-2025-04-20" \
  -H "Accept: application/json"
```

### When to Update This Document

Update this changelog when:
1. New fields appear in the API response
2. Existing fields are removed or deprecated
3. Field types or validation rules change
4. API headers or authentication methods change
5. Rate limit behavior changes

---

## Related Files

- `packages/providers/src/usage-fetcher.ts` - Main usage fetching and parsing logic
- `packages/dashboard-web/src/components/accounts/RateLimitProgress.tsx` - Dashboard UI for displaying usage data
- `packages/types/src/account.ts` - TypeScript type definitions

---

## References

- [Anthropic API Documentation](https://docs.anthropic.com/)
- [OAuth 2.0 Specification](https://oauth.net/2/)
