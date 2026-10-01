/**
 * `openobserve_metrics_stream` (SB23-1760): the stream the exporter posts its
 * own counters to. Resolved like the log and request streams: environment
 * first, then the config file, then a default, so an upgraded install starts
 * reporting with no setting changed.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

const ENV_KEYS = [
	"BETTER_CCFLARE_OPENOBSERVE_URL",
	"BETTER_CCFLARE_OPENOBSERVE_METRICS_STREAM",
] as const;
const saved = new Map<string, string | undefined>();
const created: string[] = [];

function configWith(data: Record<string, unknown>): {
	config: Config;
	path: string;
} {
	const dir = mkdtempSync(join(tmpdir(), "ccflare-oo-metrics-stream-"));
	created.push(dir);
	const path = join(dir, "config.json");
	writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
	return { config: new Config(path), path };
}

beforeEach(() => {
	for (const key of ENV_KEYS) {
		saved.set(key, process.env[key]);
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = saved.get(key);
		// Assigning undefined would store the string "undefined" on Bun.
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const dir of created.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const URL_ONLY = { openobserve_url: "http://openobserve.invalid:5080" };

describe("openobserve metrics stream", () => {
	it("defaults when nothing names it", () => {
		const { config } = configWith(URL_ONLY);
		expect(config.getOpenObserveSettings()?.metricsStream).toBe(
			"better_ccflare_exporter_metrics",
		);
	});

	it("reads the config file", () => {
		const { config } = configWith({
			...URL_ONLY,
			openobserve_metrics_stream: " file_metrics ",
		});
		expect(config.getOpenObserveSettings()?.metricsStream).toBe("file_metrics");
	});

	it("lets the environment win over the file", () => {
		process.env.BETTER_CCFLARE_OPENOBSERVE_METRICS_STREAM = "env_metrics";
		const { config } = configWith({
			...URL_ONLY,
			openobserve_metrics_stream: "file_metrics",
		});
		expect(config.getOpenObserveSettings()?.metricsStream).toBe("env_metrics");
	});

	it("reads an empty value as the default, like its siblings", () => {
		const { config } = configWith({
			...URL_ONLY,
			openobserve_metrics_stream: "",
		});
		expect(config.getOpenObserveSettings()?.metricsStream).toBe(
			"better_ccflare_exporter_metrics",
		);
	});

	it("is persisted by setOpenObserveEndpoint", () => {
		const { config, path } = configWith(URL_ONLY);
		config.setOpenObserveEndpoint({
			url: "http://openobserve.invalid:5080",
			org: "default",
			user: "",
			logStream: "better_ccflare_logs",
			requestStream: "better_ccflare_requests",
			metricsStream: "saved_metrics",
			shipPayloads: false,
			logMinLevel: "INFO",
		});
		const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<
			string,
			unknown
		>;
		expect(onDisk.openobserve_metrics_stream).toBe("saved_metrics");
		expect(config.getOpenObserveSettings()?.metricsStream).toBe(
			"saved_metrics",
		);
	});
});
