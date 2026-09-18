import { useEffect, useState } from "react";
import {
	OPENOBSERVE_LOG_MIN_LEVELS,
	type OpenObserveLogMinLevel,
} from "../../api";
import {
	useOpenObserveConfig,
	useSetOpenObserveConfig,
} from "../../hooks/queries";
import { Button } from "../ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Input } from "../ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";

/**
 * OpenObserve shipping.
 *
 * No restart button, unlike the Postgres card beside it: the server installs a
 * getter and the exporter reads it on every decision, so a save takes effect on
 * the next request.
 */
export function OpenObserveCard() {
	const { data, isLoading } = useOpenObserveConfig();
	const setConfig = useSetOpenObserveConfig();

	const [url, setUrl] = useState("");
	const [org, setOrg] = useState("default");
	const [user, setUser] = useState("");
	const [token, setToken] = useState("");
	const [logStream, setLogStream] = useState("better_ccflare_logs");
	const [requestStream, setRequestStream] = useState("better_ccflare_requests");
	const [shipPayloads, setShipPayloads] = useState(false);
	// Empty means "not read from the server yet", not a level. The default level
	// lives in the config layer; repeating it here would be a second source of
	// truth. An empty value is omitted from the save, which leaves the stored
	// level alone.
	const [logMinLevel, setLogMinLevel] = useState<OpenObserveLogMinLevel | "">(
		"",
	);

	useEffect(() => {
		if (!data) return;
		setUrl(data.url);
		setOrg(data.org);
		setUser(data.user);
		setLogStream(data.logStream);
		setRequestStream(data.requestStream);
		setShipPayloads(data.shipPayloads);
		setLogMinLevel(data.logMinLevel);
		// The token is never pre-filled — the server never returns it.
	}, [data]);

	const busy = isLoading || setConfig.isPending;
	// The environment wins over the stored value, so saving here would look like
	// a no-op. Say so rather than letting the operator wonder.
	const tokenOverridden = data?.tokenFromEnvironment ?? false;
	const endpointOverridden = data?.endpointFromEnvironment ?? false;

	// Every save posts the whole card, so the level has to travel with it: an
	// absent logMinLevel leaves the stored one alone rather than resetting it.
	function currentState(): Parameters<typeof setConfig.mutate>[0] {
		const body: Parameters<typeof setConfig.mutate>[0] = {
			url,
			org,
			user,
			logStream,
			requestStream,
			shipPayloads,
		};
		if (logMinLevel !== "") body.logMinLevel = logMinLevel;
		return body;
	}

	function handleSave() {
		const body = currentState();
		// Absent leaves the stored token alone. Sending an empty string here would
		// clear it on every unrelated save.
		if (token.length > 0) body.token = token;
		setConfig.mutate(body, { onSuccess: () => setToken("") });
	}

	return (
		<Card className="card-hover">
			<CardHeader>
				<CardTitle>OpenObserve</CardTitle>
				<CardDescription>
					Ships application log lines and one record per proxied request to an
					OpenObserve instance. The base URL is the switch: empty means nothing
					is sent and no connection is opened. Changes take effect on the next
					request, with no restart.
				</CardDescription>
				<CardDescription>
					Delivery is best effort and buffered in memory only. A batch the
					endpoint refuses for a transient reason is retried, but it keeps its
					place in time, so it is discarded before newer records are. Nothing is
					written outside that buffer, so an endpoint that stays down costs a
					fixed amount of memory and loses the oldest records first. Treat this
					stream as telemetry, never as a billing or audit record.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="flex items-center justify-between">
					<p className="text-sm font-medium">
						{data?.enabled ? "Shipping enabled" : "Shipping disabled"}
					</p>
					{endpointOverridden && (
						<p className="text-xs text-muted-foreground">
							overridden by environment
						</p>
					)}
				</div>

				<div className="space-y-1">
					<label className="text-sm font-medium" htmlFor="oo-url">
						Base URL
					</label>
					<Input
						id="oo-url"
						value={url}
						disabled={busy}
						onChange={(e) => setUrl(e.target.value)}
						placeholder="http://host:5080"
					/>
				</div>

				<div className="grid grid-cols-2 gap-3">
					<div className="space-y-1">
						<label className="text-sm font-medium" htmlFor="oo-org">
							Organization
						</label>
						<Input
							id="oo-org"
							value={org}
							disabled={busy}
							onChange={(e) => setOrg(e.target.value)}
							placeholder="default"
						/>
					</div>

					<div className="space-y-1">
						<label className="text-sm font-medium" htmlFor="oo-user">
							User
						</label>
						<Input
							id="oo-user"
							autoComplete="off"
							value={user}
							disabled={busy}
							onChange={(e) => setUser(e.target.value)}
							placeholder="optional"
						/>
					</div>

					<div className="space-y-1">
						<label className="text-sm font-medium" htmlFor="oo-log-stream">
							Log stream
						</label>
						<Input
							id="oo-log-stream"
							value={logStream}
							disabled={busy}
							onChange={(e) => setLogStream(e.target.value)}
							placeholder="better_ccflare_logs"
						/>
					</div>

					<div className="space-y-1">
						<label className="text-sm font-medium" htmlFor="oo-request-stream">
							Request stream
						</label>
						<Input
							id="oo-request-stream"
							value={requestStream}
							disabled={busy}
							onChange={(e) => setRequestStream(e.target.value)}
							placeholder="better_ccflare_requests"
						/>
					</div>
				</div>

				<div className="space-y-1">
					<label className="text-sm font-medium" htmlFor="oo-token">
						Token
					</label>
					<Input
						id="oo-token"
						type="password"
						autoComplete="off"
						placeholder={data?.tokenSet ? "Replace token" : "Not configured"}
						value={token}
						disabled={busy}
						onChange={(e) => setToken(e.target.value)}
					/>
					<p className="text-xs text-muted-foreground">
						{data?.tokenSet ? "Token configured" : "No token configured"}. Left
						blank, the stored token is kept.
					</p>
				</div>

				<div className="space-y-1">
					<label className="text-sm font-medium" htmlFor="oo-log-min-level">
						Minimum log level
					</label>
					<Select
						value={logMinLevel}
						disabled={busy}
						onValueChange={(v) => setLogMinLevel(v as OpenObserveLogMinLevel)}
					>
						<SelectTrigger id="oo-log-min-level">
							<SelectValue placeholder="Loading" />
						</SelectTrigger>
						<SelectContent>
							{OPENOBSERVE_LOG_MIN_LEVELS.map((level) => (
								<SelectItem key={level} value={level}>
									{level}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<p className="text-xs text-muted-foreground">
						Log lines below this level are not shipped. The exporter's buffers
						are bounded and drop the oldest first, so a burst of DEBUG can evict
						the ERROR records worth keeping.
					</p>
				</div>

				{/* A separate decision from shipping log lines: request bodies leaving
				    the box is not the same as log lines leaving it. */}
				<div className="flex items-center justify-between">
					<div>
						<p className="text-sm font-medium">Ship request payloads</p>
						<p className="text-xs text-muted-foreground">
							Includes the request and response bodies in each request record.
							Off by default: bodies carry prompt and completion text.
						</p>
					</div>
					<Switch
						checked={shipPayloads}
						disabled={busy}
						onCheckedChange={setShipPayloads}
					/>
				</div>

				<div className="flex gap-2">
					<Button disabled={busy} onClick={handleSave}>
						Save
					</Button>
					{data?.tokenSet && (
						<Button
							variant="outline"
							size="sm"
							disabled={busy}
							onClick={() => setConfig.mutate({ ...currentState(), token: "" })}
						>
							Clear stored token
						</Button>
					)}
				</div>

				{tokenOverridden && (
					<p className="text-xs text-muted-foreground">
						BETTER_CCFLARE_OPENOBSERVE_TOKEN is set in the server environment
						and takes precedence. A token saved here is stored but not used
						until that variable is removed.
					</p>
				)}

				{endpointOverridden && (
					<p className="text-xs text-muted-foreground">
						BETTER_CCFLARE_OPENOBSERVE_URL is set in the server environment and
						takes precedence over the URL saved here.
					</p>
				)}

				{setConfig.isError && (
					<p className="text-xs text-destructive">
						Failed to save — check server logs.
					</p>
				)}
			</CardContent>
		</Card>
	);
}
