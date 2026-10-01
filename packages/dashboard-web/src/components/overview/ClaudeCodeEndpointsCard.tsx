import {
	CLAUDE_CODE_PERMISSION_MODES,
	type ClaudeCodeEndpointConfig,
	type ClaudeCodeEndpointListing,
	type ClaudeCodePermissionMode,
	DEFAULT_CLAUDE_CODE_MAX_CONCURRENCY,
	DEFAULT_CLAUDE_CODE_MODELS,
	DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
	DEFAULT_CLAUDE_CODE_TIMEOUT_MS,
	isValidClaudeCodeEndpointName,
	MAX_CLAUDE_CODE_CONCURRENCY,
	MAX_CLAUDE_CODE_EXTRA_ARGS,
	MAX_CLAUDE_CODE_MODELS,
	MAX_CLAUDE_CODE_TIMEOUT_MS,
	MIN_CLAUDE_CODE_TIMEOUT_MS,
} from "@better-ccflare/types";
import { AlertTriangle, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
	useClaudeCodeEndpoints,
	useDeleteClaudeCodeEndpoint,
	useSaveClaudeCodeEndpoint,
} from "../../hooks/queries";
import { CopyButton } from "../CopyButton";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { SkippedConfigEntries } from "./SkippedConfigEntries";

export const BYPASS_PERMISSIONS_WARNING =
	"Anyone who can reach this endpoint can make Claude run commands and edit files in this directory.";

const MIN_TIMEOUT_SECONDS = MIN_CLAUDE_CODE_TIMEOUT_MS / 1000;
const MAX_TIMEOUT_SECONDS = MAX_CLAUDE_CODE_TIMEOUT_MS / 1000;
const DEFAULT_TIMEOUT_SECONDS = DEFAULT_CLAUDE_CODE_TIMEOUT_MS / 1000;

/**
 * The form holds text, exactly as typed. An empty string means "the user set
 * nothing", and the conversion below leaves that field out of the payload so
 * the server applies its own default.
 */
export interface EndpointFormState {
	name: string;
	directory: string;
	description: string;
	/** Comma separated. Empty means the server's default model list. */
	models: string;
	permissionMode: ClaudeCodePermissionMode;
	/** One CLI argument per line. */
	extraArgs: string;
	maxConcurrency: string;
	timeoutSeconds: string;
}

export type EndpointFormResult =
	| { ok: true; name: string; config: ClaudeCodeEndpointConfig }
	| { ok: false; error: string };

export function emptyEndpointForm(): EndpointFormState {
	return {
		name: "",
		directory: "",
		description: "",
		models: "",
		permissionMode: DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
		extraArgs: "",
		maxConcurrency: "",
		timeoutSeconds: "",
	};
}

/**
 * A listing row carries the fully defaulted values, so a value equal to the
 * server default is shown as unset. Saving the form then sends the same
 * document the operator would have typed from scratch.
 */
export function listingToForm(
	listing: ClaudeCodeEndpointListing,
): EndpointFormState {
	const modelsAreDefault =
		listing.models.length === DEFAULT_CLAUDE_CODE_MODELS.length &&
		listing.models.every((m, i) => m === DEFAULT_CLAUDE_CODE_MODELS[i]);
	return {
		name: listing.name,
		directory: listing.directory,
		description: listing.description ?? "",
		models: modelsAreDefault ? "" : listing.models.join(", "),
		permissionMode: listing.permission_mode,
		extraArgs: listing.extra_args.join("\n"),
		maxConcurrency:
			listing.max_concurrency === DEFAULT_CLAUDE_CODE_MAX_CONCURRENCY
				? ""
				: String(listing.max_concurrency),
		timeoutSeconds:
			listing.timeout_ms === DEFAULT_CLAUDE_CODE_TIMEOUT_MS
				? ""
				: String(listing.timeout_ms / 1000),
	};
}

const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/]|\\\\)/;

function parseWholeNumber(text: string): number | null {
	if (!/^\d+$/.test(text)) return null;
	return Number(text);
}

/**
 * Form text to the `PUT` body. Only fields the operator set are included, and
 * a permission mode equal to the server default is left out so the endpoint
 * keeps following that default.
 */
export function formToEndpointConfig(
	form: EndpointFormState,
): EndpointFormResult {
	const name = form.name.trim();
	if (!isValidClaudeCodeEndpointName(name)) {
		return {
			ok: false,
			error:
				"Name must be 1 to 64 lowercase letters, digits, dashes or underscores, starting with a letter or digit, and not a reserved word.",
		};
	}

	const directory = form.directory.trim();
	if (directory === "") return { ok: false, error: "Directory is required." };
	if (!ABSOLUTE_PATH.test(directory)) {
		return { ok: false, error: "Directory must be an absolute path." };
	}

	const config: ClaudeCodeEndpointConfig = { directory };

	const description = form.description.trim();
	if (description !== "") config.description = description;

	const models = form.models
		.split(",")
		.map((m) => m.trim())
		.filter((m) => m !== "");
	if (models.length > MAX_CLAUDE_CODE_MODELS) {
		return {
			ok: false,
			error: `At most ${MAX_CLAUDE_CODE_MODELS} models.`,
		};
	}
	if (models.length > 0) config.models = models;

	if (form.permissionMode !== DEFAULT_CLAUDE_CODE_PERMISSION_MODE) {
		config.permission_mode = form.permissionMode;
	}

	const extraArgs = form.extraArgs
		.split("\n")
		.map((a) => a.trim())
		.filter((a) => a !== "");
	if (extraArgs.length > MAX_CLAUDE_CODE_EXTRA_ARGS) {
		return {
			ok: false,
			error: `At most ${MAX_CLAUDE_CODE_EXTRA_ARGS} extra arguments.`,
		};
	}
	if (extraArgs.length > 0) config.extra_args = extraArgs;

	const concurrencyText = form.maxConcurrency.trim();
	if (concurrencyText !== "") {
		const concurrency = parseWholeNumber(concurrencyText);
		if (
			concurrency === null ||
			concurrency < 1 ||
			concurrency > MAX_CLAUDE_CODE_CONCURRENCY
		) {
			return {
				ok: false,
				error: `Max concurrency must be a whole number from 1 to ${MAX_CLAUDE_CODE_CONCURRENCY}.`,
			};
		}
		config.max_concurrency = concurrency;
	}

	const timeoutText = form.timeoutSeconds.trim();
	if (timeoutText !== "") {
		const seconds = parseWholeNumber(timeoutText);
		if (
			seconds === null ||
			seconds < MIN_TIMEOUT_SECONDS ||
			seconds > MAX_TIMEOUT_SECONDS
		) {
			return {
				ok: false,
				error: `Timeout must be a whole number of seconds from ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS}.`,
			};
		}
		config.timeout_ms = seconds * 1000;
	}

	return { ok: true, name, config };
}

export function endpointBaseUrl(origin: string, basePath: string): string {
	return `${origin}${basePath}`;
}

function currentOrigin(): string {
	return typeof window === "undefined" ? "" : window.location.origin;
}

interface EndpointFormProps {
	form: EndpointFormState;
	onChange: (next: EndpointFormState) => void;
	editing: boolean;
	disabled?: boolean | undefined;
}

export function EndpointForm({
	form,
	onChange,
	editing,
	disabled = false,
}: EndpointFormProps) {
	const set = <K extends keyof EndpointFormState>(
		key: K,
		value: EndpointFormState[K],
	) => onChange({ ...form, [key]: value });

	return (
		<div className="space-y-3">
			<div className="space-y-1">
				<label className="text-sm font-medium" htmlFor="cce-name">
					Name
				</label>
				<Input
					id="cce-name"
					value={form.name}
					disabled={disabled || editing}
					autoComplete="off"
					onChange={(e) => set("name", e.target.value)}
					placeholder="myproject"
				/>
				<p className="text-xs text-muted-foreground">
					Clients use {"<origin>"}/{form.name.trim() || "name"}/v1 as their base
					URL.
				</p>
			</div>

			<div className="space-y-1">
				<label className="text-sm font-medium" htmlFor="cce-directory">
					Directory
				</label>
				<Input
					id="cce-directory"
					value={form.directory}
					disabled={disabled}
					autoComplete="off"
					onChange={(e) => set("directory", e.target.value)}
					placeholder="/Users/me/Code/myproject"
				/>
				<p className="text-xs text-muted-foreground">
					Absolute path to an existing directory on this host.
				</p>
			</div>

			<div className="space-y-1">
				<label className="text-sm font-medium" htmlFor="cce-description">
					Description
				</label>
				<Input
					id="cce-description"
					value={form.description}
					disabled={disabled}
					onChange={(e) => set("description", e.target.value)}
					placeholder="optional"
				/>
			</div>

			<div className="space-y-1">
				<label className="text-sm font-medium" htmlFor="cce-models">
					Models
				</label>
				<Input
					id="cce-models"
					value={form.models}
					disabled={disabled}
					autoComplete="off"
					onChange={(e) => set("models", e.target.value)}
					placeholder={DEFAULT_CLAUDE_CODE_MODELS.join(", ")}
				/>
				<p className="text-xs text-muted-foreground">
					Comma separated. Left empty, the default list is offered.
				</p>
			</div>

			<div className="space-y-1">
				<label className="text-sm font-medium" htmlFor="cce-permission-mode">
					Permission mode
				</label>
				<Select
					value={form.permissionMode}
					disabled={disabled}
					onValueChange={(v) =>
						set("permissionMode", v as ClaudeCodePermissionMode)
					}
				>
					<SelectTrigger id="cce-permission-mode">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{CLAUDE_CODE_PERMISSION_MODES.map((mode) => (
							<SelectItem key={mode} value={mode}>
								{mode}
								{mode === DEFAULT_CLAUDE_CODE_PERMISSION_MODE
									? " (default)"
									: ""}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{form.permissionMode === "bypassPermissions" && (
					<div
						role="alert"
						className="flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive"
					>
						<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
						<p>{BYPASS_PERMISSIONS_WARNING}</p>
					</div>
				)}
			</div>

			<div className="space-y-1">
				<label className="text-sm font-medium" htmlFor="cce-extra-args">
					Extra CLI arguments
				</label>
				<textarea
					id="cce-extra-args"
					value={form.extraArgs}
					disabled={disabled}
					onChange={(e) => set("extraArgs", e.target.value)}
					rows={3}
					placeholder={"--allowedTools\nRead"}
					className="flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
				/>
				<p className="text-xs text-muted-foreground">
					One argument per line, appended to the claude command as given. Never
					passed through a shell.
				</p>
			</div>

			<div className="grid grid-cols-2 gap-3">
				<div className="space-y-1">
					<label className="text-sm font-medium" htmlFor="cce-concurrency">
						Max concurrency
					</label>
					<Input
						id="cce-concurrency"
						type="number"
						min={1}
						max={MAX_CLAUDE_CODE_CONCURRENCY}
						value={form.maxConcurrency}
						disabled={disabled}
						onChange={(e) => set("maxConcurrency", e.target.value)}
						placeholder={String(DEFAULT_CLAUDE_CODE_MAX_CONCURRENCY)}
					/>
				</div>
				<div className="space-y-1">
					<label className="text-sm font-medium" htmlFor="cce-timeout">
						Timeout (seconds)
					</label>
					<Input
						id="cce-timeout"
						type="number"
						min={MIN_TIMEOUT_SECONDS}
						max={MAX_TIMEOUT_SECONDS}
						value={form.timeoutSeconds}
						disabled={disabled}
						onChange={(e) => set("timeoutSeconds", e.target.value)}
						placeholder={String(DEFAULT_TIMEOUT_SECONDS)}
					/>
				</div>
			</div>
		</div>
	);
}

interface EndpointRowProps {
	endpoint: ClaudeCodeEndpointListing;
	origin: string;
	onEdit: (endpoint: ClaudeCodeEndpointListing) => void;
	onDelete: (endpoint: ClaudeCodeEndpointListing) => void;
	disabled?: boolean | undefined;
}

export function EndpointRow({
	endpoint,
	origin,
	onEdit,
	onDelete,
	disabled = false,
}: EndpointRowProps) {
	const baseUrl = endpointBaseUrl(origin, endpoint.base_path);
	return (
		<div className="space-y-2 rounded-lg border p-3">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0 space-y-1">
					<p className="text-sm font-medium">{endpoint.name}</p>
					{endpoint.description && (
						<p className="text-xs text-muted-foreground">
							{endpoint.description}
						</p>
					)}
				</div>
				<div className="flex shrink-0 gap-1">
					<Button
						variant="ghost"
						size="sm"
						disabled={disabled}
						aria-label={`Edit endpoint ${endpoint.name}`}
						title={`Edit endpoint ${endpoint.name}`}
						onClick={() => onEdit(endpoint)}
					>
						<Pencil className="h-4 w-4" />
					</Button>
					<Button
						variant="ghost"
						size="sm"
						disabled={disabled}
						aria-label={`Delete endpoint ${endpoint.name}`}
						title={`Delete endpoint ${endpoint.name}`}
						onClick={() => onDelete(endpoint)}
					>
						<Trash2 className="h-4 w-4" />
					</Button>
				</div>
			</div>

			<div className="flex items-center gap-1">
				<code className="min-w-0 break-all rounded bg-muted px-2 py-1 text-xs">
					{baseUrl}
				</code>
				<CopyButton value={baseUrl} title="Copy base URL" />
			</div>

			<div className="flex flex-wrap items-center gap-2 text-xs">
				<code className="break-all">{endpoint.directory}</code>
				{!endpoint.directory_exists && (
					<Badge variant="destructive">directory missing</Badge>
				)}
			</div>

			<dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
				<dt>Permission mode</dt>
				<dd>{endpoint.permission_mode}</dd>
				<dt>Models</dt>
				<dd className="break-words">{endpoint.models.join(", ")}</dd>
				<dt>Max concurrency</dt>
				<dd>{endpoint.max_concurrency}</dd>
				<dt>Timeout</dt>
				<dd>{endpoint.timeout_ms / 1000} s</dd>
			</dl>
		</div>
	);
}

/**
 * Claude Code project endpoints: an endpoint name mapped to a directory on
 * this host. OpenAI clients use `<origin>/<name>/v1` as their base URL and the
 * server answers by running `claude -p` in that directory.
 */
export function ClaudeCodeEndpointsCard() {
	const { data, isLoading, error } = useClaudeCodeEndpoints();
	const save = useSaveClaudeCodeEndpoint();
	const remove = useDeleteClaudeCodeEndpoint();

	const [form, setForm] = useState<EndpointFormState | null>(null);
	const [editing, setEditing] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	// `basePath` is null for a skipped entry, which is stored but not served.
	const [pendingDelete, setPendingDelete] = useState<{
		name: string;
		basePath: string | null;
	} | null>(null);

	const endpoints = data?.endpoints ?? [];
	const origin = currentOrigin();
	const busy = save.isPending || remove.isPending;

	function openAdd() {
		setForm(emptyEndpointForm());
		setEditing(false);
		setFormError(null);
	}

	function openEdit(endpoint: ClaudeCodeEndpointListing) {
		setForm(listingToForm(endpoint));
		setEditing(true);
		setFormError(null);
	}

	function closeForm() {
		setForm(null);
		setFormError(null);
	}

	function handleSave() {
		if (!form) return;
		const result = formToEndpointConfig(form);
		if (!result.ok) {
			setFormError(result.error);
			return;
		}
		// A PUT to an existing name replaces it, so adding must not do that by
		// accident.
		if (!editing && endpoints.some((e) => e.name === result.name)) {
			setFormError(
				`An endpoint named ${result.name} already exists. Edit it instead.`,
			);
			return;
		}
		setFormError(null);
		save.mutate(
			{ name: result.name, config: result.config },
			{
				onSuccess: closeForm,
				onError: (err) =>
					setFormError(err instanceof Error ? err.message : String(err)),
			},
		);
	}

	function openDelete(endpoint: ClaudeCodeEndpointListing) {
		remove.reset();
		setPendingDelete({ name: endpoint.name, basePath: endpoint.base_path });
	}

	function openDeleteSkipped(name: string) {
		remove.reset();
		setPendingDelete({ name, basePath: null });
	}

	function handleDelete() {
		if (!pendingDelete) return;
		remove.mutate(pendingDelete.name, {
			onSuccess: () => setPendingDelete(null),
		});
	}

	return (
		<Card className="card-hover lg:col-span-2">
			<CardHeader>
				<div className="flex items-start justify-between gap-2">
					<div className="space-y-1.5">
						<CardTitle>Claude Code endpoints</CardTitle>
						<CardDescription>
							OpenAI-compatible endpoints answered by running{" "}
							<code>claude -p</code> in a project directory on this host.
						</CardDescription>
					</div>
					<Button
						variant="outline"
						size="sm"
						disabled={busy}
						aria-label="Add endpoint"
						title="Add endpoint"
						onClick={openAdd}
					>
						<Plus className="h-4 w-4" />
					</Button>
				</div>
			</CardHeader>
			<CardContent className="space-y-3">
				{isLoading && (
					<p className="text-sm text-muted-foreground">Loading endpoints</p>
				)}

				{error && (
					<p className="text-xs text-destructive">
						Failed to load endpoints:{" "}
						{error instanceof Error ? error.message : String(error)}
					</p>
				)}

				{!isLoading && !error && endpoints.length === 0 && (
					<p className="text-sm text-muted-foreground">
						No endpoints configured. Add one to serve a project directory to
						OpenAI clients.
					</p>
				)}

				<div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
					{endpoints.map((endpoint) => (
						<EndpointRow
							key={endpoint.name}
							endpoint={endpoint}
							origin={origin}
							disabled={busy}
							onEdit={openEdit}
							onDelete={openDelete}
						/>
					))}
				</div>

				{data && (
					<SkippedConfigEntries
						noun="endpoint"
						errors={data.errors}
						invalid={data.invalid}
						disabled={busy}
						onDelete={openDeleteSkipped}
					/>
				)}
			</CardContent>

			<Dialog
				open={form !== null}
				onOpenChange={(open) => {
					if (!open) closeForm();
				}}
			>
				<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[520px]">
					<DialogHeader>
						<DialogTitle>
							{editing ? "Edit endpoint" : "Add endpoint"}
						</DialogTitle>
						<DialogDescription>
							Fields left empty use the server's defaults.
						</DialogDescription>
					</DialogHeader>
					{form && (
						<EndpointForm
							form={form}
							onChange={setForm}
							editing={editing}
							disabled={save.isPending}
						/>
					)}
					{formError && <p className="text-sm text-destructive">{formError}</p>}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={closeForm}>
							Cancel
						</Button>
						<Button
							type="button"
							disabled={save.isPending}
							onClick={handleSave}
						>
							{save.isPending ? "Saving..." : "Save"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) setPendingDelete(null);
				}}
			>
				<DialogContent className="sm:max-w-[425px]">
					<DialogHeader>
						<DialogTitle>Delete endpoint</DialogTitle>
						<DialogDescription>
							{/* Null while the dialog fades out after a delete. */}
							{pendingDelete &&
								(pendingDelete.basePath
									? `Remove ${pendingDelete.name}? Clients using ${pendingDelete.basePath} will get an error. The directory is not touched.`
									: `Remove the skipped entry ${pendingDelete.name} from the config file? It is not being served now. The directory is not touched.`)}
						</DialogDescription>
					</DialogHeader>
					{remove.isError && (
						<p className="text-sm text-destructive">
							Failed to delete endpoint:{" "}
							{remove.error instanceof Error
								? remove.error.message
								: String(remove.error)}
						</p>
					)}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setPendingDelete(null)}
						>
							Cancel
						</Button>
						<Button
							type="button"
							variant="destructive"
							disabled={remove.isPending}
							onClick={handleDelete}
						>
							{remove.isPending ? "Deleting..." : "Delete"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</Card>
	);
}
