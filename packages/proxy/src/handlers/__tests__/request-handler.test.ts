/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { describe, expect, it } from "bun:test";
import {
	CodexProvider,
	OpenAICompatibleProvider,
} from "@better-ccflare/providers";
import { validateProviderPath } from "../request-handler";

describe("validateProviderPath", () => {
	it("rejects count_tokens for OpenAI-compatible provider", () => {
		// /v1/messages/count_tokens has no OpenAI-compatible equivalent and
		// buildUrl only translates /v1/messages -> /v1/chat/completions, so
		// canHandle now returns false for count_tokens (Codex P2).
		expect(() =>
			validateProviderPath(
				new OpenAICompatibleProvider(),
				"/v1/messages/count_tokens",
			),
		).toThrow();
	});

	it("rejects count_tokens for Codex provider", () => {
		expect(() =>
			validateProviderPath(new CodexProvider(), "/v1/messages/count_tokens"),
		).toThrow();
	});
});
