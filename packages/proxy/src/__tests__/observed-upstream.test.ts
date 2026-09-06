import { expect, test } from "bun:test";
import type {
	Provider,
	UpstreamObservationContext,
} from "@better-ccflare/providers";
import { forwardObservedUpstream } from "../handlers/observed-upstream";

test("dispatch observer sees final body on each send; failures cannot change inference or retry decisions", async () => {
	const context = {
		requestId: "request",
		account: null,
		sourceBody: null,
		sourceHeaders: new Headers(),
		nativeResponses: false,
		signal: new AbortController().signal,
	} satisfies UpstreamObservationContext;
	const observed: unknown[] = [],
		sent: unknown[] = [];
	const provider = {
		async observeUpstream(request: Request) {
			observed.push(await request.clone().json());
			return {
				response(response: Response) {
					observed.push(response.status);
					return response;
				},
				error(error: unknown) {
					observed.push(error);
				},
			};
		},
	} as unknown as Provider;
	for (let retry = 0; retry < 3; retry++) {
		const request = new Request("https://example.invalid/", {
			method: "POST",
			body: JSON.stringify({ final: retry }),
		});
		const response = await forwardObservedUpstream(
			provider,
			request,
			context,
			async (wire) => {
				sent.push(await wire.json());
				return new Response("unchanged", { status: retry === 0 ? 429 : 200 });
			},
		);
		expect(await response.text()).toBe("unchanged");
	}
	expect(sent).toEqual([{ final: 0 }, { final: 1 }, { final: 2 }]);
	expect(observed).toEqual([
		{ final: 0 },
		429,
		{ final: 1 },
		200,
		{ final: 2 },
		200,
	]);
	const failure = new Error("synthetic upstream failure");
	await expect(
		forwardObservedUpstream(
			provider,
			new Request("https://example.invalid/", { method: "POST", body: "{}" }),
			context,
			async () => {
				throw failure;
			},
		),
	).rejects.toBe(failure);
	expect(observed.at(-1)).toBe(failure);
	for (const observer of [
		async () => {
			throw new Error("PRIVATE-OBSERVER-ERROR");
		},
		async () => ({
			response() {
				throw new Error("PRIVATE-OBSERVER-ERROR");
			},
			error() {},
		}),
	]) {
		const upstream = new Response("unchanged");
		expect(
			await forwardObservedUpstream(
				{ observeUpstream: observer } as unknown as Provider,
				new Request("https://example.invalid/"),
				context,
				async () => upstream,
			),
		).toBe(upstream);
	}
});
