/**
 * One Anthropic OAuth call per OpenAI-gateway request (SB23-2781).
 *
 * Measured 2026-09-23T22:42:40Z: a single `/v1/chat/completions` request was
 * refused with a windowless 429 by six OAuth accounts in combo order, then by
 * the same six again in the SessionStrategy fallback, before a Codex account
 * answered it. Claude Code requests on the same accounts got 200s in the same
 * seconds, so the refusal is about the request. Twelve calls bought nothing.
 *
 * So once an OAuth account refuses a gateway request that way, the request
 * skips every remaining account that would present an OAuth bearer to
 * api.anthropic.com. Nothing is benched, because the accounts are healthy for
 * every other request. API-key accounts and other providers stay eligible.
 *
 * "Gateway request" is read from the inbound-format marker the Chat
 * Completions and Responses handlers set on their synthetic request
 * (SB23-2727), never from the path, which is `/v1/messages` for both. The
 * server drops a client's copy, so a Claude Code request never carries it and
 * its routing is unchanged.
 *
 * "OAuth account" is `sendsOAuthBearer` (#238): the same question, whether a
 * request on this account carries an OAuth bearer to api.anthropic.com. It
 * differs from the `anthropic-oauth` exclusion string on one row shape, an
 * OAuth account behind a `custom_endpoint`, which talks to some other gateway
 * and was not part of the measurement.
 */
import type { Account, RequestMeta } from "@better-ccflare/types";
import type { InboundMarker } from "../inbound-marker";
import { sendsOAuthBearer } from "./openai-compat-path";

/**
 * Records a windowless 429 from `account`. Marks the request when the account
 * is OAuth and the request was translated by the OpenAI gateway (`inbound` is
 * the marker `proxyWithAccount` already read from the request); returns
 * whether it did, so the caller can say so in its log line.
 */
export function noteWindowlessOAuthRefusal(
	meta: RequestMeta,
	account: Account,
	inbound: InboundMarker,
): boolean {
	if (!sendsOAuthBearer(account)) return false;
	if (inbound.format === null) return false;
	meta.gatewayOAuthRefused = true;
	return true;
}

/** True when this request must not be sent to `account` any more. */
export function isSkippedAfterOAuthRefusal(
	meta: RequestMeta,
	account: Account,
): boolean {
	return meta.gatewayOAuthRefused === true && sendsOAuthBearer(account);
}
