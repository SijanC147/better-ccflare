/**
 * The metrics stream field on `/api/config/openobserve` (SB23-1760).
 *
 * It takes the posture of `logMinLevel`, not of the required strings: an absent
 * field leaves the stored value alone, so a dashboard built before the field
 * existed can still save the rest of the form. Those required strings answer a
 * missing field with a 400, which is the failure this posture avoids.
 */
import { describe, expect, it } from "bun:test";
import type { Config } from "@better-ccflare/config";
import type { OpenObserveSettings } from "@better-ccflare/logger";
import { createOpenObserveConfigHandlers } from "../config-openobserve";

type EndpointWrite = Parameters<Config["setOpenObserveEndpoint"]>[0];

function configStub(stored: Partial<OpenObserveSettings> | null) {
	const writes: EndpointWrite[] = [];
	const config = {
		getOpenObserveSettings: () =>
			stored === null
				? null
				: ({
						baseUrl: "http://openobserve.invalid:5080",
						org: "default",
						user: "",
						token: "",
						logStream: "better_ccflare_logs",
						requestStream: "better_ccflare_requests",
						metricsStream: "better_ccflare_exporter_metrics",
						shipPayloads: false,
						logMinLevel: "INFO",
						...stored,
					} satisfies OpenObserveSettings),
		hasOpenObserveToken: () => false,
		openObserveTokenFromEnvironment: () => false,
		setOpenObserveEndpoint: (settings: EndpointWrite) => {
			writes.push(settings);
		},
		setOpenObserveToken: () => {},
	} as unknown as Config;
	return { config, writes };
}

/** The form a dashboard sends, without the metrics stream field. */
const FORM = {
	url: "http://openobserve.invalid:5080",
	org: "default",
	user: "",
	logStream: "better_ccflare_logs",
	requestStream: "better_ccflare_requests",
	shipPayloads: false,
};

function post(body: unknown): Request {
	return new Request("http://localhost/api/config/openobserve", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

describe("GET /api/config/openobserve metricsStream", () => {
	it("reports the configured stream", async () => {
		const { config } = configStub({ metricsStream: "custom_metrics" });
		const body = (await createOpenObserveConfigHandlers(config)
			.getOpenObserveConfig()
			.json()) as { metricsStream: string };
		expect(body.metricsStream).toBe("custom_metrics");
	});

	it("reports the default when the exporter is off", async () => {
		const { config } = configStub(null);
		const body = (await createOpenObserveConfigHandlers(config)
			.getOpenObserveConfig()
			.json()) as { metricsStream: string };
		expect(body.metricsStream).toBe("better_ccflare_exporter_metrics");
	});
});

describe("POST /api/config/openobserve metricsStream", () => {
	it("stores a supplied stream, trimmed", async () => {
		const { config, writes } = configStub({ metricsStream: "old_metrics" });
		const response = await createOpenObserveConfigHandlers(
			config,
		).updateOpenObserveConfig(
			post({ ...FORM, metricsStream: "  new_metrics\n" }),
		);
		expect(response.status).toBe(204);
		expect(writes).toHaveLength(1);
		expect(writes[0].metricsStream).toBe("new_metrics");
	});

	it("leaves the stored stream alone when the field is absent", async () => {
		const { config, writes } = configStub({ metricsStream: "kept_metrics" });
		const response = await createOpenObserveConfigHandlers(
			config,
		).updateOpenObserveConfig(post(FORM));
		expect(response.status).toBe(204);
		expect(writes[0].metricsStream).toBe("kept_metrics");
	});

	it("reads an emptied field as the default, like the other two streams", async () => {
		const { config, writes } = configStub({ metricsStream: "old_metrics" });
		await createOpenObserveConfigHandlers(config).updateOpenObserveConfig(
			post({ ...FORM, metricsStream: "   " }),
		);
		expect(writes[0].metricsStream).toBe("better_ccflare_exporter_metrics");
	});

	it("rejects a value that is not a string, and writes nothing", async () => {
		const { config, writes } = configStub({});
		const response = await createOpenObserveConfigHandlers(
			config,
		).updateOpenObserveConfig(post({ ...FORM, metricsStream: 7 }));
		expect(response.status).toBe(400);
		expect(writes).toHaveLength(0);
	});
});
