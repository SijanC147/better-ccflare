import { AlertTriangle, Play, Radio, Search, Square } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type RawResponse } from "../api";
import {
	API_CATEGORIES,
	API_ROUTES,
	type ApiRoute,
	fillPath,
	isMutating,
	pathParams,
} from "../lib/api-catalog";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

/** How many stream events to keep before dropping the oldest. */
const STREAM_BUFFER = 200;

const METHOD_STYLES: Record<string, string> = {
	GET: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
	POST: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30",
	PUT: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
	PATCH:
		"bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/30",
	DELETE: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30",
};

function routeKey(route: ApiRoute): string {
	return `${route.method}:${route.path}`;
}

function statusTone(status: number): string {
	if (status >= 200 && status < 300) return "text-emerald-600 dark:text-emerald-400";
	if (status >= 300 && status < 400) return "text-blue-600 dark:text-blue-400";
	if (status >= 400 && status < 500) return "text-amber-600 dark:text-amber-400";
	return "text-red-600 dark:text-red-400";
}

/** Pretty-print JSON, or hand back the original text when it is not JSON. */
function formatBody(body: string): string {
	const trimmed = body.trim();
	if (!trimmed) return "";
	try {
		return JSON.stringify(JSON.parse(trimmed), null, 2);
	} catch {
		return body;
	}
}

function MethodBadge({ method }: { method: string }) {
	return (
		<span
			className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
				METHOD_STYLES[method] ?? "bg-muted text-muted-foreground border-border"
			}`}
		>
			{method}
		</span>
	);
}

export const ApiPlaygroundTab = React.memo(() => {
	const [selectedKey, setSelectedKey] = useState(routeKey(API_ROUTES[0]));
	const [filter, setFilter] = useState("");

	const selected = useMemo(
		() => API_ROUTES.find((route) => routeKey(route) === selectedKey) ?? API_ROUTES[0],
		[selectedKey],
	);

	const grouped = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		return API_CATEGORIES.map((category) => ({
			category,
			routes: API_ROUTES.filter(
				(route) =>
					route.category === category &&
					(needle === "" ||
						route.path.toLowerCase().includes(needle) ||
						route.method.toLowerCase().includes(needle) ||
						route.summary.toLowerCase().includes(needle)),
			),
		})).filter((group) => group.routes.length > 0);
	}, [filter]);

	return (
		<div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
			<Card className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-6rem)] lg:overflow-hidden flex flex-col">
				<CardHeader className="pb-3">
					<CardTitle className="text-base">
						Endpoints
						<span className="ml-2 text-xs font-normal text-muted-foreground">
							{API_ROUTES.length} routes
						</span>
					</CardTitle>
					<div className="relative mt-2">
						<Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
						<Input
							value={filter}
							onChange={(event) => setFilter(event.target.value)}
							placeholder="Filter by path or method"
							className="h-8 pl-8 text-xs"
						/>
					</div>
				</CardHeader>
				<CardContent className="flex-1 overflow-y-auto pt-0">
					{grouped.length === 0 && (
						<p className="py-6 text-center text-xs text-muted-foreground">
							Nothing matches “{filter}”.
						</p>
					)}
					{grouped.map((group) => (
						<div key={group.category} className="mb-4">
							<p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
								{group.category}
							</p>
							<div className="space-y-0.5">
								{group.routes.map((route) => {
									const key = routeKey(route);
									return (
										<button
											key={key}
											type="button"
											onClick={() => setSelectedKey(key)}
											className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors ${
												key === selectedKey
													? "bg-primary/10 text-foreground"
													: "hover:bg-muted/60"
											}`}
										>
											<MethodBadge method={route.method} />
											<span className="truncate font-mono text-[11px]">
												{route.path}
											</span>
											{route.stream && (
												<Radio className="ml-auto h-3 w-3 shrink-0 text-blue-500" />
											)}
											{route.dangerous && (
												<AlertTriangle className="ml-auto h-3 w-3 shrink-0 text-red-500" />
											)}
										</button>
									);
								})}
							</div>
						</div>
					))}
				</CardContent>
			</Card>

			<RequestPanel key={selectedKey} route={selected} />
		</div>
	);
});

ApiPlaygroundTab.displayName = "ApiPlaygroundTab";

function RequestPanel({ route }: { route: ApiRoute }) {
	const params = useMemo(() => pathParams(route.path), [route.path]);
	const [paramValues, setParamValues] = useState<Record<string, string>>({});
	const [queryValues, setQueryValues] = useState<Record<string, string>>({});
	const [extraQuery, setExtraQuery] = useState("");
	const [body, setBody] = useState("");
	const [response, setResponse] = useState<RawResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [armed, setArmed] = useState(false);
	const [confirmText, setConfirmText] = useState("");

	// Streaming state
	const [events, setEvents] = useState<string[]>([]);
	const [streaming, setStreaming] = useState(false);
	const abortRef = useRef<AbortController | null>(null);

	const mutating = isMutating(route);
	const needsTypedConfirm = route.dangerous === true;

	const url = useMemo(() => {
		const filled = fillPath(route.path, paramValues);
		const search = new URLSearchParams();
		for (const [name, value] of Object.entries(queryValues)) {
			if (value !== "") search.set(name, value);
		}
		const extra = extraQuery.trim().replace(/^\?/, "");
		if (extra) {
			for (const [name, value] of new URLSearchParams(extra)) {
				search.set(name, value);
			}
		}
		const qs = search.toString();
		return qs ? `${filled}?${qs}` : filled;
	}, [route.path, paramValues, queryValues, extraQuery]);

	const missingParams = params.filter((name) => !paramValues[name]);

	// Never leave a stream open behind us.
	useEffect(() => {
		return () => abortRef.current?.abort();
	}, []);

	const stopStream = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		setStreaming(false);
	}, []);

	const startStream = useCallback(async () => {
		setError(null);
		setEvents([]);
		setStreaming(true);

		const controller = new AbortController();
		abortRef.current = controller;

		try {
			// streamUrl mints the short-lived single-use token these routes
			// need (#379). The durable API key must never travel in a query
			// string, and EventSource cannot set headers.
			const authed = await api.streamUrl(url);
			const streamResponse = await fetch(authed, {
				headers: { Accept: "text/event-stream" },
				signal: controller.signal,
			});

			setResponse({
				status: streamResponse.status,
				statusText: streamResponse.statusText,
				headers: Object.fromEntries(streamResponse.headers.entries()),
				body: null,
				omitted: null,
				durationMs: 0,
			});

			if (!streamResponse.ok || !streamResponse.body) {
				setStreaming(false);
				return;
			}

			const reader = streamResponse.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });

				// SSE frames are separated by a blank line.
				const frames = buffer.split("\n\n");
				buffer = frames.pop() ?? "";
				for (const frame of frames) {
					if (!frame.trim()) continue;
					setEvents((previous) =>
						[...previous, frame.trim()].slice(-STREAM_BUFFER),
					);
				}
			}
		} catch (streamError) {
			if ((streamError as Error).name !== "AbortError") {
				setError((streamError as Error).message);
			}
		} finally {
			setStreaming(false);
			abortRef.current = null;
		}
	}, [url]);

	const send = useCallback(async () => {
		setPending(true);
		setError(null);
		setResponse(null);
		try {
			const result = await api.rawRequest(route.method, url, {
				body: mutating ? body : undefined,
			});
			setResponse(result);
		} catch (sendError) {
			setError((sendError as Error).message);
		} finally {
			setPending(false);
			setArmed(false);
			setConfirmText("");
		}
	}, [route.method, url, body, mutating]);

	const canFire =
		missingParams.length === 0 &&
		(!needsTypedConfirm || confirmText === "CONFIRM");

	return (
		<div className="space-y-4">
			<Card>
				<CardHeader className="pb-3">
					<div className="flex flex-wrap items-center gap-2">
						<MethodBadge method={route.method} />
						<code className="font-mono text-sm">{route.path}</code>
						<Badge variant="outline" className="text-[10px]">
							{route.category}
						</Badge>
						{route.stream && (
							<Badge variant="outline" className="text-[10px]">
								stream
							</Badge>
						)}
					</div>
					<p className="pt-1 text-sm text-muted-foreground">{route.summary}</p>
					{route.note && (
						<p className="pt-1 text-xs text-amber-600 dark:text-amber-400">
							{route.note}
						</p>
					)}
				</CardHeader>

				<CardContent className="space-y-4">
					{params.length > 0 && (
						<div className="space-y-2">
							<Label className="text-xs uppercase tracking-wide text-muted-foreground">
								Path parameters
							</Label>
							<div className="grid gap-2 sm:grid-cols-2">
								{params.map((name) => (
									<div key={name}>
										<Label htmlFor={`param-${name}`} className="text-xs">
											{name}
										</Label>
										<Input
											id={`param-${name}`}
											value={paramValues[name] ?? ""}
											onChange={(event) =>
												setParamValues((previous) => ({
													...previous,
													[name]: event.target.value,
												}))
											}
											placeholder={name}
											className="h-8 font-mono text-xs"
										/>
									</div>
								))}
							</div>
						</div>
					)}

					<div className="space-y-2">
						<Label className="text-xs uppercase tracking-wide text-muted-foreground">
							Query
						</Label>
						{route.query && route.query.length > 0 && (
							<div className="grid gap-2 sm:grid-cols-3">
								{route.query.map((name) => (
									<div key={name}>
										<Label htmlFor={`query-${name}`} className="text-xs">
											{name}
										</Label>
										<Input
											id={`query-${name}`}
											value={queryValues[name] ?? ""}
											onChange={(event) =>
												setQueryValues((previous) => ({
													...previous,
													[name]: event.target.value,
												}))
											}
											className="h-8 font-mono text-xs"
										/>
									</div>
								))}
							</div>
						)}
						<Input
							value={extraQuery}
							onChange={(event) => setExtraQuery(event.target.value)}
							placeholder="Additional query string, e.g. foo=1&bar=2"
							className="h-8 font-mono text-xs"
						/>
					</div>

					{mutating && (
						<div className="space-y-1">
							<Label
								htmlFor="request-body"
								className="text-xs uppercase tracking-wide text-muted-foreground"
							>
								JSON body
							</Label>
							{route.bodyHint && (
								<p className="font-mono text-[11px] text-muted-foreground">
									{route.bodyHint}
								</p>
							)}
							<textarea
								id="request-body"
								value={body}
								onChange={(event) => setBody(event.target.value)}
								rows={7}
								spellCheck={false}
								placeholder="{}"
								className="w-full resize-y rounded border border-input bg-background p-2 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
							/>
						</div>
					)}

					<div className="rounded border border-border bg-muted/40 p-2">
						<p className="break-all font-mono text-[11px] text-muted-foreground">
							{route.method} {url}
						</p>
					</div>

					{missingParams.length > 0 && (
						<p className="text-xs text-amber-600 dark:text-amber-400">
							Fill in {missingParams.join(", ")} before sending.
						</p>
					)}

					{needsTypedConfirm && (
						<div className="space-y-1 rounded border border-red-500/40 bg-red-500/5 p-3">
							<p className="flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400">
								<AlertTriangle className="h-3.5 w-3.5" />
								This is destructive and cannot be undone.
							</p>
							<Input
								value={confirmText}
								onChange={(event) => setConfirmText(event.target.value)}
								placeholder="Type CONFIRM to enable the button"
								className="h-8 font-mono text-xs"
							/>
						</div>
					)}

					<div className="flex items-center gap-2">
						{route.stream ? (
							streaming ? (
								<Button onClick={stopStream} variant="destructive" size="sm">
									<Square className="mr-1.5 h-3.5 w-3.5" />
									Stop stream
								</Button>
							) : (
								<Button
									onClick={startStream}
									size="sm"
									disabled={missingParams.length > 0}
								>
									<Radio className="mr-1.5 h-3.5 w-3.5" />
									Start stream
								</Button>
							)
						) : mutating && !armed ? (
							// Every non-GET takes two clicks. The playground can reach
							// routes that change configuration or delete records, and a
							// single stray click should never be enough.
							<Button
								onClick={() => setArmed(true)}
								size="sm"
								variant="outline"
								disabled={!canFire || pending}
							>
								<Play className="mr-1.5 h-3.5 w-3.5" />
								Send {route.method}…
							</Button>
						) : (
							<>
								<Button onClick={send} size="sm" disabled={!canFire || pending}>
									<Play className="mr-1.5 h-3.5 w-3.5" />
									{pending
										? "Sending…"
										: armed
											? `Confirm ${route.method}`
											: "Send"}
								</Button>
								{armed && (
									<Button
										onClick={() => {
											setArmed(false);
											setConfirmText("");
										}}
										size="sm"
										variant="ghost"
									>
										Cancel
									</Button>
								)}
							</>
						)}
					</div>
				</CardContent>
			</Card>

			{error && (
				<Card className="border-red-500/40">
					<CardContent className="pt-6">
						<p className="font-mono text-xs text-red-600 dark:text-red-400">
							{error}
						</p>
					</CardContent>
				</Card>
			)}

			{response && (
				<Card>
					<CardHeader className="pb-3">
						<CardTitle className="flex items-center gap-3 text-base">
							<span className={`font-mono ${statusTone(response.status)}`}>
								{response.status} {response.statusText}
							</span>
							{response.durationMs > 0 && (
								<span className="text-xs font-normal text-muted-foreground">
									{response.durationMs} ms
								</span>
							)}
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3">
						<details>
							<summary className="cursor-pointer text-xs text-muted-foreground">
								Response headers ({Object.keys(response.headers).length})
							</summary>
							<pre className="mt-2 overflow-x-auto rounded bg-muted/50 p-2 font-mono text-[11px]">
								{Object.entries(response.headers)
									.map(([name, value]) => `${name}: ${value}`)
									.join("\n")}
							</pre>
						</details>

						{response.omitted ? (
							<p className="text-xs text-muted-foreground">
								Body not shown:{" "}
								{response.omitted.reason === "not-text"
									? `content type is ${response.omitted.contentType}`
									: "the response is too large to render"}
								{response.omitted.bytes !== null &&
									` (${response.omitted.bytes.toLocaleString()} bytes)`}
								.
							</p>
						) : (
							<pre className="max-h-[28rem] overflow-auto rounded bg-muted/50 p-3 font-mono text-[11px]">
								{response.body ? formatBody(response.body) : "(empty body)"}
							</pre>
						)}
					</CardContent>
				</Card>
			)}

			{route.stream && (streaming || events.length > 0) && (
				<Card>
					<CardHeader className="pb-3">
						<CardTitle className="flex items-center gap-2 text-base">
							<Radio
								className={`h-4 w-4 ${streaming ? "animate-pulse text-blue-500" : "text-muted-foreground"}`}
							/>
							Events
							<span className="text-xs font-normal text-muted-foreground">
								{events.length}
								{events.length >= STREAM_BUFFER && ` (last ${STREAM_BUFFER})`}
							</span>
						</CardTitle>
					</CardHeader>
					<CardContent>
						<pre className="max-h-[28rem] overflow-auto rounded bg-muted/50 p-3 font-mono text-[11px]">
							{events.length > 0
								? events.join("\n\n")
								: "Waiting for the first event…"}
						</pre>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
