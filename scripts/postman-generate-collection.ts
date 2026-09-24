#!/usr/bin/env bun
/**
 * Writes the "better-ccflare API" Postman collection (git-native v3 YAML)
 * under `postman/collections/`, from the route catalog in
 * `packages/types/src/api-catalog.ts`, plus two hand-written folders:
 *
 * - `Smoke`: checks that reach no account (the catalog, the gateway list, two
 *   refusals the OpenAI gateway answers before routing). Safe against 8080
 *   on v3.28.0 or later; before v3.28.0 the two POSTs fall through to accounts.
 * - `OpenAI gateway`: `/v1/models` and `/v1/chat/completions`, plain and
 *   named-gateway. These route to real accounts on a real server.
 *
 * Regenerate after any catalog change, then `postman workspace push`:
 *
 *   bun run scripts/postman-generate-collection.ts
 *
 * The collection directory is deleted and rewritten on every run, so edit
 * this script rather than the generated files. `/v1/*` is absent from the
 * catalog on purpose (see its header), which is why that folder is here.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	API_CATEGORIES,
	API_ROUTES,
	type ApiRoute,
	pathParams,
} from "../packages/types/src/api-catalog";

const ROOT = resolve(import.meta.dir, "..");
const COLLECTION = "better-ccflare API";
const OUT = join(ROOT, "postman", "collections", COLLECTION);

/** Single-quoted YAML scalar. */
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** `|-` block scalar, indented under a key at `indent` spaces. */
const block = (s: string, indent: number) =>
	`|-\n${s
		.split("\n")
		.map((line) => `${" ".repeat(indent)}${line}`)
		.join("\n")}`;

/** Filename stem: no `/ \ : * ? " < > |`. */
const stem = (name: string) => name.replace(/[/\\:*?"<>|]/g, "-");

interface RequestSpec {
	name: string;
	method: string;
	url: string;
	order: number;
	description?: string;
	headers?: { key: string; value: string }[];
	queryParams?: { key: string; value: string; disabled?: boolean }[];
	pathVariables?: { key: string; value: string; description?: string }[];
	body?: string;
	tests?: string;
}

function requestYaml(r: RequestSpec): string {
	const lines = ["$kind: http-request"];
	if (stem(r.name) !== r.name) lines.push(`name: ${q(r.name)}`);
	if (r.description) lines.push(`description: ${block(r.description, 2)}`);
	lines.push(`method: ${r.method}`, `url: ${q(r.url)}`, `order: ${r.order}`);
	if (r.headers?.length) {
		lines.push("headers:");
		for (const h of r.headers)
			lines.push(`  - key: ${q(h.key)}`, `    value: ${q(h.value)}`);
	}
	if (r.queryParams?.length) {
		lines.push("queryParams:");
		for (const p of r.queryParams) {
			lines.push(`  - key: ${q(p.key)}`, `    value: ${q(p.value)}`);
			if (p.disabled) lines.push("    disabled: true");
		}
	}
	if (r.pathVariables?.length) {
		lines.push("pathVariables:");
		for (const v of r.pathVariables) {
			lines.push(`  - key: ${q(v.key)}`, `    value: ${q(v.value)}`);
			if (v.description) lines.push(`    description: ${q(v.description)}`);
		}
	}
	if (r.body !== undefined)
		lines.push("body:", "  type: json", `  content: ${block(r.body, 4)}`);
	if (r.tests)
		lines.push(
			"scripts:",
			"  - type: afterResponse",
			"    language: text/javascript",
			`    code: ${block(r.tests, 6)}`,
		);
	return `${lines.join("\n")}\n`;
}

function definitionYaml(
	fields: { name?: string; description?: string; order?: number },
	extra: string[] = [],
): string {
	const lines = ["$kind: collection"];
	if (fields.name) lines.push(`name: ${q(fields.name)}`);
	if (fields.description)
		lines.push(`description: ${block(fields.description, 2)}`);
	lines.push(...extra);
	if (fields.order !== undefined) lines.push(`order: ${fields.order}`);
	return `${lines.join("\n")}\n`;
}

function writeFolder(
	dir: string,
	def: string,
	requests: RequestSpec[],
): void {
	mkdirSync(join(dir, ".resources"), { recursive: true });
	writeFileSync(join(dir, ".resources", "definition.yaml"), def);
	const seen = new Set<string>();
	for (const r of requests) {
		const file = `${stem(r.name)}.request.yaml`;
		if (seen.has(file.toLowerCase()))
			throw new Error(`duplicate request file in ${dir}: ${file}`);
		seen.add(file.toLowerCase());
		writeFileSync(join(dir, file), requestYaml(r));
	}
}

const JSON_HEADER = [{ key: "Content-Type", value: "application/json" }];

const chatBody = (extra: Record<string, unknown> = {}) =>
	JSON.stringify(
		{
			model: "{{model}}",
			messages: [{ role: "user", content: "Reply with the single word: pong" }],
			max_tokens: 16,
			...extra,
		},
		null,
		2,
	);

const statusTest = (code: number) =>
	`pm.test("status is ${code}", () => pm.response.to.have.status(${code}));`;

const openAIErrorTest = (code: number, errorCode: string, param?: string) =>
	[
		statusTest(code),
		`pm.test("OpenAI-shaped error with code ${errorCode}", () => {`,
		"  const body = pm.response.json();",
		'  pm.expect(body).to.have.property("error");',
		`  pm.expect(body.error.code).to.eql("${errorCode}");`,
		...(param ? [`  pm.expect(body.error.param).to.eql("${param}");`] : []),
		"});",
	].join("\n");

const chatCompletionTest = [
	statusTest(200),
	'pm.test("chat.completion with assistant text", () => {',
	"  const body = pm.response.json();",
	'  pm.expect(body.object).to.eql("chat.completion");',
	'  pm.expect(body.choices[0].message.role).to.eql("assistant");',
	'  pm.expect(body.choices[0].message.content).to.be.a("string").and.not.empty;',
	"});",
].join("\n");

const streamTest = [
	statusTest(200),
	'pm.test("SSE chunks ending in [DONE]", () => {',
	"  const text = pm.response.text();",
	'  pm.expect(text).to.include("chat.completion.chunk");',
	'  pm.expect(text.trim().endsWith("data: [DONE]")).to.be.true;',
	"});",
].join("\n");

const smoke: RequestSpec[] = [
	{
		name: "Route catalog",
		method: "GET",
		url: "{{baseUrl}}/api/meta/routes",
		order: 1000,
		description: "Reaches no account.",
		tests: [
			statusTest(200),
			'pm.test("collection is current with the server catalog (regenerate if this fails)", () => {',
			"  const body = pm.response.json();",
			`  pm.expect(body.count).to.eql(${API_ROUTES.length});`,
			`  pm.expect(body.routes).to.have.lengthOf(${API_ROUTES.length});`,
			"});",
		].join("\n"),
	},
	{
		name: "Named gateways",
		method: "GET",
		url: "{{baseUrl}}/api/openai-gateways",
		order: 2000,
		description: "Reaches no account.",
		tests: [
			statusTest(200),
			'pm.test("gateways and errors are arrays", () => {',
			"  const body = pm.response.json();",
			'  pm.expect(body.gateways).to.be.an("array");',
			'  pm.expect(body.errors).to.be.an("array");',
			"});",
		].join("\n"),
	},
	{
		name: "Chat completion refuses n=2",
		method: "POST",
		url: "{{baseUrl}}/v1/chat/completions",
		order: 3000,
		description:
			"Refused by the request translator before routing, so it reaches no account. The `n` check is the only gate on this path: if this test fails, the request may have reached an account, which is why `max_tokens` is 1.",
		headers: JSON_HEADER,
		body: chatBody({ n: 2, max_tokens: 1 }),
		tests: openAIErrorTest(400, "unsupported_value", "n"),
	},
	{
		name: "Invalid gateway name is 404",
		method: "POST",
		url: "{{baseUrl}}/v1/gateways/Postman-Smoke-Invalid/chat/completions",
		order: 4000,
		description:
			"Upper case fails the gateway name pattern, so no configuration can make this name valid. It must refuse, never fall through to the unrestricted route. Reaches no account.",
		headers: JSON_HEADER,
		body: chatBody(),
		tests: openAIErrorTest(404, "gateway_not_found"),
	},
];

const gateway: RequestSpec[] = [
	{
		name: "List models",
		method: "GET",
		url: "{{baseUrl}}/v1/models",
		order: 1000,
		tests: [
			statusTest(200),
			'pm.test("list of models", () => pm.expect(pm.response.json().data).to.be.an("array"));',
		].join("\n"),
	},
	{
		name: "Chat completion",
		method: "POST",
		url: "{{baseUrl}}/v1/chat/completions",
		order: 2000,
		description:
			"Routes to a real account on a real server. Set `model` first.",
		headers: JSON_HEADER,
		body: chatBody(),
		tests: chatCompletionTest,
	},
	{
		name: "Chat completion (stream)",
		method: "POST",
		url: "{{baseUrl}}/v1/chat/completions",
		order: 3000,
		description: "Routes to a real account on a real server.",
		headers: JSON_HEADER,
		body: chatBody({ stream: true }),
		tests: streamTest,
	},
	{
		name: "Chat completion via named gateway",
		method: "POST",
		url: "{{baseUrl}}/v1/gateways/{{gateway}}/chat/completions",
		order: 4000,
		description:
			"Set `gateway` to a name from `GET /api/openai-gateways`. The gateway's `exclude_providers` apply.",
		headers: JSON_HEADER,
		body: chatBody(),
		tests: chatCompletionTest,
	},
];

function catalogRequest(route: ApiRoute, order: number): RequestSpec {
	const notes = [route.summary];
	if (route.dangerous)
		notes.push("DANGEROUS: irreversible or disruptive. Never run in a batch.");
	if (route.note) notes.push(route.note);
	if (route.bodyHint) notes.push(`Body: ${route.bodyHint}`);
	if (route.stream) notes.push("Server-Sent Events.");
	return {
		name: `${route.dangerous ? "[dangerous] " : ""}${route.method} ${route.path}`,
		method: route.method,
		url: `{{baseUrl}}${route.path}`,
		order,
		description: notes.join("\n\n"),
		headers: route.method === "GET" ? undefined : JSON_HEADER,
		queryParams: route.query?.map((key) => ({
			key,
			value: "",
			disabled: true,
		})),
		pathVariables: pathParams(route.path).map((key) => ({ key, value: "" })),
		body: route.method === "GET" ? undefined : "{}",
	};
}

rmSync(OUT, { recursive: true, force: true });

writeFolder(
	OUT,
	definitionYaml(
		{
			name: COLLECTION,
			description: [
				"Generated by `scripts/postman-generate-collection.ts` from `packages/types/src/api-catalog.ts`. Edit the script, not these files.",
				"`baseUrl` defaults to the production server on 8080. For automated runs point it at an isolated server on 8081 (`--env-var baseUrl=http://127.0.0.1:8081`).",
				"Only `Smoke` is safe to run as a batch against 8080, and only on v3.28.0 or later. `OpenAI gateway` spends real account quota, and the catalog folders include mutating and dangerous routes.",
			].join("\n\n"),
		},
		[
			"variables:",
			`  - key: baseUrl`,
			`    value: ${q("http://localhost:8080")}`,
			`  - key: model`,
			`    value: ${q("claude-opus-5-5")}`,
			`  - key: gateway`,
			`    value: ${q("no-oauth")}`,
			"auth:",
			"  type: bearer",
			"  credentials:",
			"    - key: token",
			`      value: ${q("{{ApiKey}}")}`,
		],
	),
	[],
);

writeFolder(
	join(OUT, "Smoke"),
	definitionYaml({
		description:
			"Checks that reach no account. Safe to run against 8080 on v3.28.0 or later.",
		order: 1000,
	}),
	smoke,
);

writeFolder(
	join(OUT, "OpenAI gateway"),
	definitionYaml({
		description:
			"The OpenAI-compatible endpoint. These requests route to real accounts.",
		order: 2000,
	}),
	gateway,
);

API_CATEGORIES.forEach((category, i) => {
	const routes = API_ROUTES.filter((r) => r.category === category);
	writeFolder(
		join(OUT, category),
		definitionYaml({ order: 3000 + i * 1000 }),
		routes.map((r, j) => catalogRequest(r, (j + 1) * 1000)),
	);
});

const written = API_ROUTES.length + smoke.length + gateway.length;
console.log(`wrote ${written} requests to ${OUT}`);
