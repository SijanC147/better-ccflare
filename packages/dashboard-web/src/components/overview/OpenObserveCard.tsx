import { useEffect, useState } from "react";
import {
	OPENOBSERVE_LOG_MIN_LEVELS,
	type OpenObserveConfig,
	type OpenObserveConfigUpdate,
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

/** Every field the card edits except the token, which is handled apart. */
export interface OpenObserveFormState {
	url: string;
	org: string;
	user: string;
	logStream: string;
	requestStream: string;
	metricsStream: string;
	shipPayloads: boolean;
	// Empty means "not read from the server yet", not a level. The default level
	// lives in the config layer; repeating it here would be a second source of
	// truth. An empty value is omitted from the save, which leaves the stored
	// level alone.
	logMinLevel: OpenObserveLogMinLevel | "";
}

/** What the card shows before the server's values have been read. */
export const INITIAL_OPENOBSERVE_FORM: OpenObserveFormState = {
	url: "",
	org: "default",
	user: "",
	logStream: "better_ccflare_logs",
	requestStream: "better_ccflare_requests",
	metricsStream: "better_ccflare_exporter_metrics",
	shipPayloads: false,
	logMinLevel: "",
};

/** The form seeded from a server read. The token is never pre-filled: the server never returns it. */
export function formFromConfig(data: OpenObserveConfig): OpenObserveFormState {
	return {
		url: data.url,
		org: data.org,
		user: data.user,
		logStream: data.logStream,
		requestStream: data.requestStream,
		metricsStream: data.metricsStream,
		shipPayloads: data.shipPayloads,
		logMinLevel: data.logMinLevel,
	};
}

/**
 * Every save posts the whole card, so the level has to travel with it: an
 * absent logMinLevel leaves the stored one alone rather than resetting it.
 *
 * `loaded` is whether the server's values have been read. The metrics stream
 * is sent only once they have, so a save made before the read lands cannot
 * overwrite a configured stream with the placeholder. Once read, an emptied
 * field is sent as empty, which the server reads as the default, the same as
 * the two streams above it.
 */
export function buildOpenObserveUpdate(
	form: OpenObserveFormState,
	loaded: boolean,
): OpenObserveConfigUpdate {
	const body: OpenObserveConfigUpdate = {
		url: form.url,
		org: form.org,
		user: form.user,
		logStream: form.logStream,
		requestStream: form.requestStream,
		shipPayloads: form.shipPayloads,
	};
	if (form.logMinLevel !== "") body.logMinLevel = form.logMinLevel;
	if (loaded) body.metricsStream = form.metricsStream;
	return body;
}

/**
 * The Save button's body. An absent token leaves the stored one alone, so an
 * empty field must stay absent: sending an empty string here would clear the
 * token on every unrelated save.
 */
export function buildOpenObserveSave(
	form: OpenObserveFormState,
	loaded: boolean,
	token: string,
): OpenObserveConfigUpdate {
	const body = buildOpenObserveUpdate(form, loaded);
	if (token.length > 0) body.token = token;
	return body;
}

/** The "Clear stored token" button's body: the whole card, plus an empty token. */
export function buildOpenObserveClearToken(
	form: OpenObserveFormState,
	loaded: boolean,
): OpenObserveConfigUpdate {
	return { ...buildOpenObserveUpdate(form, loaded), token: "" };
}

export interface OpenObserveCardViewProps {
	/** The server's read, or undefined until it lands. */
	data: OpenObserveConfig | undefined;
	form: OpenObserveFormState;
	token: string;
	/** Loading or saving: every control is disabled. */
	busy: boolean;
	/** The last save failed. */
	isError: boolean;
	onFieldChange: <K extends keyof OpenObserveFormState>(
		field: K,
		value: OpenObserveFormState[K],
	) => void;
	onTokenChange: (token: string) => void;
	onSave: () => void;
	onClearToken: () => void;
}

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

	const [form, setForm] = useState<OpenObserveFormState>(
		INITIAL_OPENOBSERVE_FORM,
	);
	const [token, setToken] = useState("");

	useEffect(() => {
		if (!data) return;
		setForm(formFromConfig(data));
	}, [data]);

	const loaded = data !== undefined;

	return (
		<OpenObserveCardView
			data={data}
			form={form}
			token={token}
			busy={isLoading || setConfig.isPending}
			isError={setConfig.isError}
			onFieldChange={(field, value) =>
				setForm((current) => {
					const next = { ...current };
					next[field] = value;
					return next;
				})
			}
			onTokenChange={setToken}
			onSave={() =>
				setConfig.mutate(buildOpenObserveSave(form, loaded, token), {
					onSuccess: () => setToken(""),
				})
			}
			onClearToken={() =>
				setConfig.mutate(buildOpenObserveClearToken(form, loaded))
			}
		/>
	);
}

/** The card itself, with no hooks, so every state renders in a test. */
export function OpenObserveCardView({
	data,
	form,
	token,
	busy,
	isError,
	onFieldChange,
	onTokenChange,
	onSave,
	onClearToken,
}: OpenObserveCardViewProps) {
	// The environment wins over the stored value, so saving here would look like
	// a no-op. Say so rather than letting the operator wonder.
	const tokenOverridden = data?.tokenFromEnvironment ?? false;
	const endpointOverridden = data?.endpointFromEnvironment ?? false;

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
						value={form.url}
						disabled={busy}
						onChange={(e) => onFieldChange("url", e.target.value)}
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
							value={form.org}
							disabled={busy}
							onChange={(e) => onFieldChange("org", e.target.value)}
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
							value={form.user}
							disabled={busy}
							onChange={(e) => onFieldChange("user", e.target.value)}
							placeholder="optional"
						/>
					</div>

					<div className="space-y-1">
						<label className="text-sm font-medium" htmlFor="oo-log-stream">
							Log stream
						</label>
						<Input
							id="oo-log-stream"
							value={form.logStream}
							disabled={busy}
							onChange={(e) => onFieldChange("logStream", e.target.value)}
							placeholder="better_ccflare_logs"
						/>
					</div>

					<div className="space-y-1">
						<label className="text-sm font-medium" htmlFor="oo-request-stream">
							Request stream
						</label>
						<Input
							id="oo-request-stream"
							value={form.requestStream}
							disabled={busy}
							onChange={(e) => onFieldChange("requestStream", e.target.value)}
							placeholder="better_ccflare_requests"
						/>
					</div>

					<div className="space-y-1">
						<label className="text-sm font-medium" htmlFor="oo-metrics-stream">
							Metrics stream
						</label>
						<Input
							id="oo-metrics-stream"
							value={form.metricsStream}
							disabled={busy}
							onChange={(e) => onFieldChange("metricsStream", e.target.value)}
							placeholder="better_ccflare_exporter_metrics"
						/>
						<p className="text-xs text-muted-foreground">
							The exporter's own counters, posted once a minute: records
							shipped, deferred for retry, evicted and dropped, per stream.
						</p>
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
						onChange={(e) => onTokenChange(e.target.value)}
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
						value={form.logMinLevel}
						disabled={busy}
						onValueChange={(v) =>
							onFieldChange("logMinLevel", v as OpenObserveLogMinLevel)
						}
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
						checked={form.shipPayloads}
						disabled={busy}
						onCheckedChange={(checked) =>
							onFieldChange("shipPayloads", checked)
						}
					/>
				</div>

				<div className="flex gap-2">
					<Button disabled={busy} onClick={onSave}>
						Save
					</Button>
					{data?.tokenSet && (
						<Button
							variant="outline"
							size="sm"
							disabled={busy}
							onClick={onClearToken}
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

				{isError && (
					<p className="text-xs text-destructive">
						Failed to save — check server logs.
					</p>
				)}
			</CardContent>
		</Card>
	);
}
