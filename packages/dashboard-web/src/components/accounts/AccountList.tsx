import { LayoutGrid, List } from "lucide-react";
import { useState } from "react";
import type { Account } from "../../api";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { AccountListItem } from "./AccountListItem";

const LS_HIDE_PAUSED = "bcf:accounts:hidePaused";
const LS_ACTIVE_FIRST = "bcf:accounts:activeFirst";
const LS_COMPACT = "bcf:accounts:compact";

function readBool(key: string, defaultValue = false): boolean {
	try {
		const raw = localStorage.getItem(key);
		if (raw === null) return defaultValue;
		return raw === "true";
	} catch {
		return defaultValue;
	}
}

function writeBool(key: string, value: boolean): void {
	try {
		localStorage.setItem(key, String(value));
	} catch {
		// ignore
	}
}

interface AccountListProps {
	accounts: Account[] | undefined;
	onPauseToggle: (account: Account) => void;
	onForceResetRateLimit: (account: Account) => void;
	onRefreshUsage: (account: Account) => Promise<void>;
	onRemove: (name: string) => void;
	onRename: (account: Account) => void;
	onPriorityChange: (account: Account) => void;
	onAutoFallbackToggle: (account: Account) => void;
	onAutoRefreshToggle: (account: Account) => void;
	onBillingTypeToggle: (account: Account) => void;
	onAutoPauseOnOverageToggle?: (account: Account) => void;
	onPeakHoursPauseToggle?: (account: Account) => void;
	onCustomEndpointChange?: (account: Account) => void;
	onModelMappingsChange?: (account: Account) => void;
	onReauth?: (account: Account) => void;
	onAnthropicReauth?: (account: Account) => void;
	onCodexReauth?: (account: Account) => void;
}

export function AccountList({
	accounts,
	onPauseToggle,
	onForceResetRateLimit,
	onRefreshUsage,
	onRemove,
	onRename,
	onPriorityChange,
	onAutoFallbackToggle,
	onAutoRefreshToggle,
	onBillingTypeToggle,
	onAutoPauseOnOverageToggle,
	onPeakHoursPauseToggle,
	onCustomEndpointChange,
	onModelMappingsChange,
	onReauth,
	onAnthropicReauth,
	onCodexReauth,
}: AccountListProps) {
	const [hidePaused, setHidePaused] = useState(() => readBool(LS_HIDE_PAUSED));
	const [activeFirst, setActiveFirst] = useState(() =>
		readBool(LS_ACTIVE_FIRST),
	);
	const [compact, setCompact] = useState(() => readBool(LS_COMPACT));

	if (!accounts || accounts.length === 0) {
		return <p className="text-muted-foreground">No accounts configured</p>;
	}

	// Find the most recently used account
	const mostRecentAccountId = accounts.reduce(
		(mostRecent, account) => {
			if (!account.lastUsed) return mostRecent;
			if (!mostRecent) return account.id;

			const mostRecentAccount = accounts.find((a) => a.id === mostRecent);
			if (!mostRecentAccount?.lastUsed) return account.id;

			const mostRecentLastUsed = new Date(mostRecentAccount.lastUsed).getTime();
			const currentLastUsed = new Date(account.lastUsed).getTime();

			return currentLastUsed > mostRecentLastUsed ? account.id : mostRecent;
		},
		null as string | null,
	);

	// Apply filter: hide paused accounts when toggle is on
	let displayed = hidePaused
		? accounts.filter((a) => !a.paused)
		: [...accounts];

	// Apply sort: bring the active (most recently used) account to the top
	if (activeFirst && mostRecentAccountId) {
		displayed = [
			...displayed.filter((a) => a.id === mostRecentAccountId),
			...displayed.filter((a) => a.id !== mostRecentAccountId),
		];
	}

	const hasPaused = accounts.some((a) => a.paused);

	const toggleHidePaused = (val: boolean) => {
		setHidePaused(val);
		writeBool(LS_HIDE_PAUSED, val);
	};
	const toggleActiveFirst = (val: boolean) => {
		setActiveFirst(val);
		writeBool(LS_ACTIVE_FIRST, val);
	};
	const toggleCompact = () => {
		const next = !compact;
		setCompact(next);
		writeBool(LS_COMPACT, next);
	};

	return (
		<div className="space-y-3">
			{/* Toolbar */}
			<div className="flex items-center gap-4 flex-wrap">
				{hasPaused && (
					<div className="flex items-center gap-2">
						<Switch
							id="hide-paused"
							checked={hidePaused}
							onCheckedChange={toggleHidePaused}
						/>
						<label
							htmlFor="hide-paused"
							className="text-xs text-muted-foreground cursor-pointer select-none"
						>
							Hide paused
						</label>
					</div>
				)}
				<div className="flex items-center gap-2">
					<Switch
						id="active-first"
						checked={activeFirst}
						onCheckedChange={toggleActiveFirst}
					/>
					<label
						htmlFor="active-first"
						className="text-xs text-muted-foreground cursor-pointer select-none"
					>
						Active first
					</label>
				</div>
				<Button
					variant="ghost"
					size="sm"
					onClick={toggleCompact}
					title={
						compact ? "Switch to list layout" : "Switch to compact grid layout"
					}
					className="h-7 w-7 p-0"
				>
					{compact ? (
						<List className="h-4 w-4" />
					) : (
						<LayoutGrid className="h-4 w-4" />
					)}
				</Button>
			</div>

			{/* Account list / grid */}
			{displayed.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					No accounts match the current filters.
				</p>
			) : (
				<div
					className={
						compact
							? "grid grid-cols-2 md:grid-cols-2 xl:grid-cols-3 gap-2"
							: "space-y-2"
					}
				>
					{displayed.map((account) => (
						<AccountListItem
							key={account.name}
							account={account}
							isActive={account.id === mostRecentAccountId}
							compact={compact}
							onPauseToggle={onPauseToggle}
							onForceResetRateLimit={onForceResetRateLimit}
							onRefreshUsage={onRefreshUsage}
							onRemove={onRemove}
							onRename={onRename}
							onPriorityChange={onPriorityChange}
							onAutoFallbackToggle={onAutoFallbackToggle}
							onAutoRefreshToggle={onAutoRefreshToggle}
							onBillingTypeToggle={onBillingTypeToggle}
							onAutoPauseOnOverageToggle={onAutoPauseOnOverageToggle}
							onPeakHoursPauseToggle={onPeakHoursPauseToggle}
							onCustomEndpointChange={onCustomEndpointChange}
							onModelMappingsChange={onModelMappingsChange}
							onReauth={onReauth}
							onAnthropicReauth={onAnthropicReauth}
							onCodexReauth={onCodexReauth}
						/>
					))}
				</div>
			)}
		</div>
	);
}
