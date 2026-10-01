import {
	ANTHROPIC_OAUTH_PROVIDER_KEY,
	isValidOpenAIGatewayName,
	type OpenAIGatewayConfig,
	type OpenAIGatewayListing,
	type OpenAIGatewayModelEntry,
	RESERVED_GATEWAY_ALIAS_NAMES,
} from "@better-ccflare/types";
import { ArrowRight, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import {
	useAccounts,
	useCombos,
	useDeleteOpenAIGateway,
	useOpenAIGateways,
	useSaveOpenAIGateway,
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
import { SkippedConfigEntries } from "./SkippedConfigEntries";

/**
 * One editable model row. `combo` is the empty string for "none". `id` only
 * keys the row for React, so removing a middle row keeps focus and input state
 * on the rows that remain; it never reaches the server.
 */
export interface GatewayModelRow {
	id: number;
	name: string;
	model: string;
	combo: string;
}

/** The form holds text as typed; the conversion below builds the `PUT` body. */
export interface GatewayFormState {
	name: string;
	description: string;
	excludeProviders: string[];
	models: GatewayModelRow[];
}

export type GatewayFormResult =
	| { ok: true; name: string; config: OpenAIGatewayConfig }
	| { ok: false; error: string };

let lastRowId = 0;
function nextRowId(): number {
	lastRowId += 1;
	return lastRowId;
}

export function emptyModelRow(): GatewayModelRow {
	return { id: nextRowId(), name: "", model: "", combo: "" };
}

export function emptyGatewayForm(): GatewayFormState {
	return { name: "", description: "", excludeProviders: [], models: [] };
}

export function listingToGatewayForm(
	listing: OpenAIGatewayListing,
): GatewayFormState {
	return {
		name: listing.name,
		description: listing.description ?? "",
		excludeProviders: [...listing.exclude_providers],
		models: listing.models.map((entry) => ({
			id: nextRowId(),
			name: entry.name,
			model: entry.model,
			combo: entry.combo ?? "",
		})),
	};
}

/**
 * Form text to the `PUT` body. A blank description, no exclusions and no model
 * rows are each left out, so the stored entry carries only what was set. A
 * missing `models` key is a passthrough gateway; the server refuses `[]`.
 */
export function formToGatewayConfig(form: GatewayFormState): GatewayFormResult {
	const name = form.name.trim();
	if (!isValidOpenAIGatewayName(name)) {
		return {
			ok: false,
			error:
				"Name must be 1 to 64 lowercase letters, digits, dashes or underscores, starting with a letter or digit.",
		};
	}

	const config: OpenAIGatewayConfig = {};

	const description = form.description.trim();
	if (description !== "") config.description = description;

	const excluded = [...new Set(form.excludeProviders)];
	if (excluded.length > 0) config.exclude_providers = excluded;

	const models: OpenAIGatewayModelEntry[] = [];
	for (const [index, row] of form.models.entries()) {
		const rowName = row.name.trim();
		const rowModel = row.model.trim();
		const rowCombo = row.combo.trim();
		if (rowName === "" && rowModel === "" && rowCombo === "") continue;
		if (rowName === "") {
			return { ok: false, error: `Model row ${index + 1} needs a name.` };
		}
		const entry: OpenAIGatewayModelEntry = {
			name: rowName,
			model: rowModel === "" ? rowName : rowModel,
		};
		if (rowCombo !== "") entry.combo = rowCombo;
		models.push(entry);
	}
	if (models.length > 0) config.models = models;

	return { ok: true, name, config };
}

/**
 * Both base URLs a client can configure. `short` is null when the name is a
 * reserved first path segment, because the server never routes
 * `/<reserved>/v1` to a gateway.
 */
export function gatewayBaseUrls(
	origin: string,
	gateway: Pick<OpenAIGatewayListing, "name" | "base_path">,
): { full: string; short: string | null } {
	return {
		full: `${origin}${gateway.base_path}`,
		short: RESERVED_GATEWAY_ALIAS_NAMES.has(gateway.name)
			? null
			: `${origin}/${gateway.name}/v1`,
	};
}

export interface ProviderOption {
	value: string;
	label: string;
	/** False for a stored value no account in the pool currently has. */
	inPool: boolean;
}

export function providerLabel(value: string): string {
	return value === ANTHROPIC_OAUTH_PROVIDER_KEY
		? "Anthropic OAuth accounts"
		: value;
}

/**
 * The providers a gateway can exclude: every distinct `provider` in the pool,
 * plus `anthropic-oauth` when the pool holds an Anthropic account. `keep` are
 * values already stored or selected; any of them the pool lacks is still
 * offered, so editing a gateway never silently drops an exclusion.
 */
export function excludeProviderOptions(
	accountProviders: readonly (string | null | undefined)[],
	keep: readonly string[],
): ProviderOption[] {
	const pool = [
		...new Set(
			accountProviders.filter(
				(p): p is string => typeof p === "string" && p !== "",
			),
		),
	].sort();
	const values = pool.includes("anthropic")
		? [ANTHROPIC_OAUTH_PROVIDER_KEY, ...pool]
		: pool;
	const options: ProviderOption[] = values.map((value) => ({
		value,
		label: providerLabel(value),
		inPool: true,
	}));
	for (const value of keep) {
		if (!options.some((o) => o.value === value)) {
			options.push({ value, label: providerLabel(value), inPool: false });
		}
	}
	return options;
}

export interface ComboOption {
	name: string;
	/** False for a stored combo name no existing combo carries. */
	exists: boolean;
	enabled: boolean;
}

/** Existing combos, plus any name in `keep` that no longer exists. */
export function gatewayComboOptions(
	combos: readonly { name: string; enabled: boolean }[],
	keep: readonly string[],
): ComboOption[] {
	const options: ComboOption[] = combos.map((c) => ({
		name: c.name,
		exists: true,
		enabled: c.enabled,
	}));
	for (const name of keep) {
		if (name !== "" && !options.some((o) => o.name === name)) {
			options.push({ name, exists: false, enabled: false });
		}
	}
	return options;
}

function currentOrigin(): string {
	return typeof window === "undefined" ? "" : window.location.origin;
}

const SELECT_CLASS =
	"flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

interface GatewayFormProps {
	form: GatewayFormState;
	onChange: (next: GatewayFormState) => void;
	editing: boolean;
	providerOptions: ProviderOption[];
	comboOptions: ComboOption[];
	disabled?: boolean;
}

export function GatewayForm({
	form,
	onChange,
	editing,
	providerOptions,
	comboOptions,
	disabled = false,
}: GatewayFormProps) {
	const set = <K extends keyof GatewayFormState>(
		key: K,
		value: GatewayFormState[K],
	) => onChange({ ...form, [key]: value });

	const toggleExclude = (value: string, checked: boolean) =>
		set(
			"excludeProviders",
			checked
				? [...form.excludeProviders.filter((v) => v !== value), value]
				: form.excludeProviders.filter((v) => v !== value),
		);

	const setRow = (id: number, patch: Partial<Omit<GatewayModelRow, "id">>) =>
		set(
			"models",
			form.models.map((row) => (row.id === id ? { ...row, ...patch } : row)),
		);

	const shownName = form.name.trim() || "name";

	return (
		<div className="space-y-4">
			<div className="space-y-1">
				<label className="text-sm font-medium" htmlFor="oag-name">
					Name
				</label>
				<Input
					id="oag-name"
					value={form.name}
					disabled={disabled || editing}
					autoComplete="off"
					onChange={(e) => set("name", e.target.value)}
					placeholder="work"
				/>
				<p className="text-xs text-muted-foreground">
					Clients use {"<origin>"}/v1/gateways/{shownName} or {"<origin>"}/
					{shownName}/v1 as their base URL.
				</p>
			</div>

			<div className="space-y-1">
				<label className="text-sm font-medium" htmlFor="oag-description">
					Description
				</label>
				<Input
					id="oag-description"
					value={form.description}
					disabled={disabled}
					onChange={(e) => set("description", e.target.value)}
					placeholder="optional"
				/>
			</div>

			<fieldset className="space-y-2">
				<legend className="text-sm font-medium">Excluded providers</legend>
				{providerOptions.length === 0 ? (
					<p className="text-xs text-muted-foreground">
						No accounts in the pool yet, so there is nothing to exclude.
					</p>
				) : (
					<div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
						{providerOptions.map((option) => {
							const id = `oag-exclude-${option.value}`;
							return (
								<div key={option.value} className="flex items-center gap-2">
									<input
										type="checkbox"
										id={id}
										checked={form.excludeProviders.includes(option.value)}
										disabled={disabled}
										onChange={(e) =>
											toggleExclude(option.value, e.target.checked)
										}
										className="h-4 w-4 rounded border-gray-300 disabled:cursor-not-allowed disabled:opacity-60"
									/>
									<label htmlFor={id} className="text-sm">
										{option.label}
										{option.label !== option.value && (
											<code className="ml-1 text-xs text-muted-foreground">
												{option.value}
											</code>
										)}
										{!option.inPool && (
											<span className="ml-1 text-xs text-muted-foreground">
												(not in pool)
											</span>
										)}
									</label>
								</div>
							);
						})}
					</div>
				)}
				<p className="text-xs text-muted-foreground">
					This gateway never routes to a checked provider. Anthropic OAuth
					accounts excludes Anthropic accounts signed in with OAuth and leaves
					Anthropic API-key accounts eligible.
				</p>
			</fieldset>

			<fieldset className="space-y-2">
				<legend className="text-sm font-medium">Models</legend>
				{form.models.length === 0 ? (
					<p className="text-xs text-muted-foreground">
						No models listed: this gateway passes through whatever model the
						client names. Add a model to restrict the gateway to a fixed set.
					</p>
				) : (
					<div className="space-y-2">
						{form.models.map((row, index) => (
							<div
								key={row.id}
								className="grid grid-cols-1 items-end gap-2 rounded-md border p-2 sm:grid-cols-[1fr_1fr_1fr_auto]"
							>
								<div className="space-y-1">
									<label
										className="text-xs font-medium"
										htmlFor={`oag-model-name-${row.id}`}
									>
										Client model id
									</label>
									<Input
										id={`oag-model-name-${row.id}`}
										value={row.name}
										disabled={disabled}
										autoComplete="off"
										onChange={(e) => setRow(row.id, { name: e.target.value })}
										placeholder="gpt-5.5"
									/>
								</div>
								<div className="space-y-1">
									<label
										className="text-xs font-medium"
										htmlFor={`oag-model-model-${row.id}`}
									>
										Upstream model
									</label>
									<Input
										id={`oag-model-model-${row.id}`}
										value={row.model}
										disabled={disabled}
										autoComplete="off"
										onChange={(e) => setRow(row.id, { model: e.target.value })}
										placeholder="same as client id"
									/>
								</div>
								<div className="space-y-1">
									<label
										className="text-xs font-medium"
										htmlFor={`oag-model-combo-${row.id}`}
									>
										Fallback combo
									</label>
									<select
										id={`oag-model-combo-${row.id}`}
										value={row.combo}
										disabled={disabled}
										onChange={(e) => setRow(row.id, { combo: e.target.value })}
										className={SELECT_CLASS}
									>
										<option value="">none</option>
										{comboOptions.map((combo) => (
											<option key={combo.name} value={combo.name}>
												{combo.name}
												{!combo.exists
													? " (not found)"
													: !combo.enabled
														? " (disabled)"
														: ""}
											</option>
										))}
									</select>
								</div>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									disabled={disabled}
									aria-label={`Remove model row ${index + 1}`}
									title={`Remove model row ${index + 1}`}
									onClick={() =>
										set(
											"models",
											form.models.filter((r) => r.id !== row.id),
										)
									}
								>
									<X className="h-4 w-4" />
								</Button>
							</div>
						))}
					</div>
				)}
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={disabled}
					onClick={() => set("models", [...form.models, emptyModelRow()])}
				>
					<Plus className="mr-1 h-4 w-4" />
					Add model
				</Button>
				<p className="text-xs text-muted-foreground">
					A blank upstream model uses the client id. A combo makes its slots the
					fallback ladder for that model, in slot order.
				</p>
			</fieldset>
		</div>
	);
}

interface GatewayRowProps {
	gateway: OpenAIGatewayListing;
	origin: string;
	onEdit: (gateway: OpenAIGatewayListing) => void;
	onDelete: (gateway: OpenAIGatewayListing) => void;
	disabled?: boolean;
}

export function GatewayRow({
	gateway,
	origin,
	onEdit,
	onDelete,
	disabled = false,
}: GatewayRowProps) {
	const urls = gatewayBaseUrls(origin, gateway);
	return (
		<div className="space-y-2 rounded-lg border p-3">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0 space-y-1">
					<p className="text-sm font-medium">{gateway.name}</p>
					{gateway.description && (
						<p className="text-xs text-muted-foreground">
							{gateway.description}
						</p>
					)}
				</div>
				<div className="flex shrink-0 gap-1">
					<Button
						variant="ghost"
						size="sm"
						disabled={disabled}
						aria-label={`Edit gateway ${gateway.name}`}
						title={`Edit gateway ${gateway.name}`}
						onClick={() => onEdit(gateway)}
					>
						<Pencil className="h-4 w-4" />
					</Button>
					<Button
						variant="ghost"
						size="sm"
						disabled={disabled}
						aria-label={`Delete gateway ${gateway.name}`}
						title={`Delete gateway ${gateway.name}`}
						onClick={() => onDelete(gateway)}
					>
						<Trash2 className="h-4 w-4" />
					</Button>
				</div>
			</div>

			<div className="flex items-center gap-1">
				<code className="min-w-0 break-all rounded bg-muted px-2 py-1 text-xs">
					{urls.full}
				</code>
				<CopyButton value={urls.full} title="Copy base URL" />
			</div>
			{urls.short === null ? (
				<p className="text-xs text-muted-foreground">
					No short URL: {gateway.name} is a reserved path segment.
				</p>
			) : (
				<div className="flex items-center gap-1">
					<code className="min-w-0 break-all rounded bg-muted px-2 py-1 text-xs">
						{urls.short}
					</code>
					<CopyButton value={urls.short} title="Copy short base URL" />
				</div>
			)}

			<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
				<dt>Excluded</dt>
				<dd className="flex flex-wrap gap-1">
					{gateway.exclude_providers.length === 0
						? "none"
						: gateway.exclude_providers.map((value) => (
								<Badge key={value} variant="secondary" title={value}>
									{providerLabel(value)}
								</Badge>
							))}
				</dd>
				<dt>Models</dt>
				<dd>
					{gateway.models.length === 0 ? (
						"passthrough: any model the client names"
					) : (
						<ul className="space-y-0.5">
							{gateway.models.map((entry) => (
								<li
									key={entry.name}
									className="flex flex-wrap items-center gap-1"
								>
									<code>{entry.name}</code>
									<ArrowRight className="h-3 w-3" aria-hidden="true" />
									<span className="sr-only">routes to</span>
									<code>{entry.model}</code>
									{entry.combo && (
										<Badge variant="outline">combo {entry.combo}</Badge>
									)}
								</li>
							))}
						</ul>
					)}
				</dd>
			</dl>
		</div>
	);
}

/**
 * Named OpenAI-compatible gateways: each is its own base URL with its own
 * provider exclusions and, optionally, a fixed model set with per-model
 * fallback combos.
 */
export function OpenAIGatewaysCard() {
	const { data, isLoading, error } = useOpenAIGateways();
	const { data: accounts } = useAccounts();
	const { data: combosData } = useCombos();
	const save = useSaveOpenAIGateway();
	const remove = useDeleteOpenAIGateway();

	const [form, setForm] = useState<GatewayFormState | null>(null);
	const [original, setOriginal] = useState<OpenAIGatewayListing | null>(null);
	const [formError, setFormError] = useState<string | null>(null);
	// `basePath` is null for a skipped entry, which is stored but not served.
	const [pendingDelete, setPendingDelete] = useState<{
		name: string;
		basePath: string | null;
	} | null>(null);

	const gateways = data?.gateways ?? [];
	const origin = currentOrigin();
	const busy = save.isPending || remove.isPending;
	const editing = original !== null;

	const providerOptions = excludeProviderOptions(
		(accounts ?? []).map((a) => a.provider),
		[...(original?.exclude_providers ?? []), ...(form?.excludeProviders ?? [])],
	);
	const comboOptions = gatewayComboOptions(combosData?.combos ?? [], [
		...(original?.models ?? []).map((m) => m.combo ?? ""),
		...(form?.models ?? []).map((m) => m.combo),
	]);

	function openAdd() {
		setForm(emptyGatewayForm());
		setOriginal(null);
		setFormError(null);
	}

	function openEdit(gateway: OpenAIGatewayListing) {
		setForm(listingToGatewayForm(gateway));
		setOriginal(gateway);
		setFormError(null);
	}

	function closeForm() {
		setForm(null);
		setOriginal(null);
		setFormError(null);
	}

	function handleSave() {
		if (!form) return;
		const result = formToGatewayConfig(form);
		if (!result.ok) {
			setFormError(result.error);
			return;
		}
		// A PUT to an existing name replaces it, so adding must not do that by
		// accident.
		if (!editing && gateways.some((g) => g.name === result.name)) {
			setFormError(
				`A gateway named ${result.name} already exists. Edit it instead.`,
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

	function openDelete(gateway: OpenAIGatewayListing) {
		remove.reset();
		setPendingDelete({ name: gateway.name, basePath: gateway.base_path });
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
						<CardTitle>OpenAI gateways</CardTitle>
						<CardDescription>
							Named OpenAI-compatible base URLs, each with its own excluded
							providers and optional model set. Configure one in a third-party
							app as a custom OpenAI provider.
						</CardDescription>
					</div>
					<Button
						variant="outline"
						size="sm"
						disabled={busy}
						aria-label="Add gateway"
						title="Add gateway"
						onClick={openAdd}
					>
						<Plus className="h-4 w-4" />
					</Button>
				</div>
			</CardHeader>
			<CardContent className="space-y-3">
				{isLoading && (
					<p className="text-sm text-muted-foreground">Loading gateways</p>
				)}

				{error && (
					<p className="text-xs text-destructive">
						Failed to load gateways:{" "}
						{error instanceof Error ? error.message : String(error)}
					</p>
				)}

				{!isLoading && !error && gateways.length === 0 && (
					<p className="text-sm text-muted-foreground">
						No gateways configured. The plain {origin}/v1 base URL applies no
						rules.
					</p>
				)}

				<div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
					{gateways.map((gateway) => (
						<GatewayRow
							key={gateway.name}
							gateway={gateway}
							origin={origin}
							disabled={busy}
							onEdit={openEdit}
							onDelete={openDelete}
						/>
					))}
				</div>

				{data && (
					<SkippedConfigEntries
						noun="gateway"
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
				<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[640px]">
					<DialogHeader>
						<DialogTitle>
							{editing ? "Edit gateway" : "Add gateway"}
						</DialogTitle>
						<DialogDescription>
							Saving replaces the whole gateway with what is shown here.
						</DialogDescription>
					</DialogHeader>
					{form && (
						<GatewayForm
							form={form}
							onChange={setForm}
							editing={editing}
							providerOptions={providerOptions}
							comboOptions={comboOptions}
							disabled={save.isPending}
						/>
					)}
					{formError && (
						<p role="alert" className="text-sm text-destructive">
							{formError}
						</p>
					)}
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
						<DialogTitle>Delete gateway</DialogTitle>
						<DialogDescription>
							{/* Null while the dialog fades out after a delete. */}
							{pendingDelete &&
								(pendingDelete.basePath
									? `Remove ${pendingDelete.name}? Clients using ${pendingDelete.basePath} or /${pendingDelete.name}/v1 will get an error.`
									: `Remove the skipped entry ${pendingDelete.name} from the config file? It is not being served now.`)}
						</DialogDescription>
					</DialogHeader>
					{remove.isError && (
						<p role="alert" className="text-sm text-destructive">
							Failed to delete gateway:{" "}
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
