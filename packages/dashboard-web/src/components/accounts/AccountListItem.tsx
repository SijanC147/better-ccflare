import { supportsUsagePauseThreshold } from "@better-ccflare/core";
import { AccountPresenter } from "@better-ccflare/ui-common";
import {
	AlertCircle,
	CalendarClock,
	Edit2,
	Ellipsis,
	Gauge,
	Globe,
	Hash,
	KeyRound,
	Pause,
	Play,
	RefreshCw,
	Replace,
	Trash2,
	Zap,
} from "lucide-react";
import type { ComponentType } from "react";
import { useState } from "react";
import type { Account } from "../../api";
import {
	providerShowsCreditsBalance,
	providerShowsWeeklyUsage,
} from "../../utils/provider-utils";
import {
	formatRenewalBadge,
	formatRenewalDate,
	viewerRenewal,
} from "../../utils/renewal";
import { OAuthTokenStatusWithBoundary } from "../OAuthTokenStatus";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
	type AccountMenuActionId,
	type AccountMenuCallbacks,
	accountMenuActions,
	accountMenuToggles,
	bindAccountMenuHandlers,
	menuHandlersFrom,
} from "./account-menu-items";
import { RateLimitProgress } from "./RateLimitProgress";

const ACTION_ICONS: Record<
	AccountMenuActionId,
	ComponentType<{ className?: string }>
> = {
	rename: Edit2,
	priority: Zap,
	"renewal-day": CalendarClock,
	"custom-endpoint": Globe,
	"usage-thresholds": Gauge,
	"model-mappings": Hash,
	"request-transformer": Replace,
	reauth: KeyRound,
};

function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function formatPauseReason(reason: string | null): string | null {
	if (!reason) return null;
	return reason.replaceAll("_", " ");
}

interface AccountListItemProps {
	account: Account;
	isPrimary?: boolean;
	compact?: boolean;
	onPauseToggle: (account: Account) => void;
	onForceResetRateLimit: (account: Account) => void;
	onRefreshUsage: (account: Account) => Promise<void>;
	onRemove: (account: Account) => void;
	onRename: (account: Account) => void;
	onPriorityChange: (account: Account) => void;
	onRenewalDayChange?: (account: Account) => void;
	onAutoFallbackToggle: (account: Account) => void;
	onAutoRefreshToggle: (account: Account) => void;
	onBillingTypeToggle: (account: Account) => void;
	onAutoPauseOnOverageToggle?: (account: Account) => void;
	onPeakHoursPauseToggle?: (account: Account) => void;
	onUsageThresholdsChange?: (account: Account) => void;
	onCustomEndpointChange?: (account: Account) => void;
	onModelMappingsChange?: (account: Account) => void;
	onRequestTransformerChange?: (account: Account) => void;
	onReauth?: (account: Account) => void;
	onAnthropicReauth?: (account: Account) => void;
	onCodexReauth?: (account: Account) => void;
}

export function AccountListItem({
	account,
	isPrimary = false,
	compact = false,
	onPauseToggle,
	onForceResetRateLimit,
	onRefreshUsage,
	onRemove,
	onRename,
	onPriorityChange,
	onRenewalDayChange,
	onAutoFallbackToggle,
	onAutoRefreshToggle,
	onBillingTypeToggle,
	onAutoPauseOnOverageToggle,
	onPeakHoursPauseToggle,
	onUsageThresholdsChange,
	onCustomEndpointChange,
	onModelMappingsChange,
	onRequestTransformerChange,
	onReauth,
	onAnthropicReauth,
	onCodexReauth,
}: AccountListItemProps) {
	const [isRefreshingUsage, setIsRefreshingUsage] = useState(false);
	const presenter = new AccountPresenter(account);
	// Recomputed in the browser's zone rather than read from the response, whose
	// nextRenewalAt and daysUntilRenewal are UTC-anchored. See utils/renewal.ts.
	const renewal = viewerRenewal(account.renewalDay);
	// Only hard-limit statuses mean the account is actually blocked; soft warnings
	// like "allowed_warning" / "queueing_soft" mean the account is still usable.
	const HARD_LIMIT_PREFIXES = [
		"rate_limited",
		"blocked",
		"queueing_hard",
		"payment_required",
	];
	const isHardLimited = HARD_LIMIT_PREFIXES.some((prefix) =>
		presenter.rateLimitStatus.toLowerCase().startsWith(prefix),
	);
	// Also show Force Reset when rate_limited_until is in the future even if
	// rate_limit_status is soft/OK — the selector still skips the account.
	const isBlockedByLegacyLock =
		typeof account.rateLimitedUntil === "number" &&
		account.rateLimitedUntil > Date.now();
	const showForceReset =
		(isHardLimited || isBlockedByLegacyLock) && !presenter.isPaused;
	// staleLockDetected only fires when numeric usage data exists (Anthropic accounts);
	// Zai/NanoGPT accounts have usageUtilization === null and are correctly excluded
	const staleLockDetected =
		showForceReset &&
		typeof account.usageUtilization === "number" &&
		account.usageUtilization < 100;
	const isUsageThrottled =
		typeof account.usageThrottledUntil === "number" &&
		account.usageThrottledUntil > Date.now();

	// Parse Bedrock profile and region from custom_endpoint
	let bedrockProfile: string | null = null;
	let bedrockRegion: string | null = null;
	let bedrockCrossRegionMode: string | null = null;
	if (account.provider === "bedrock" && account.customEndpoint) {
		const match = account.customEndpoint.match(/^bedrock:([^:]+):(.+)$/);
		if (match) {
			bedrockProfile = match[1];
			bedrockRegion = match[2];
		}
		bedrockCrossRegionMode = account.crossRegionMode || "geographic";
	}

	// One object, passed to both the item builders and the binder, so the item
	// list and the callback each id fires cannot drift apart.
	const menuCallbacks: AccountMenuCallbacks = {
		onRename,
		onPriorityChange,
		onRenewalDayChange,
		onCustomEndpointChange,
		onUsageThresholdsChange,
		onModelMappingsChange,
		onRequestTransformerChange,
		onReauth,
		onAnthropicReauth,
		onCodexReauth,
		onAutoFallbackToggle,
		onAutoRefreshToggle,
		onBillingTypeToggle,
		onAutoPauseOnOverageToggle,
		onPeakHoursPauseToggle,
	};
	const menuHandlers = menuHandlersFrom(menuCallbacks);
	const menuToggles = accountMenuToggles(account, menuHandlers);
	const menuActions = accountMenuActions(account, menuHandlers);
	const bound = bindAccountMenuHandlers(account, menuCallbacks);

	return (
		<div
			className={`border rounded-lg transition-colors space-y-4 ${compact ? "p-2" : "p-4"} ${
				isPrimary
					? "border-primary bg-primary/5 shadow-sm"
					: "border-border hover:border-muted-foreground/50"
			}`}
		>
			<div className="space-y-2">
				{/* Identity row: name, Primary, Priority, token status. Kept to four
				    items so it cannot wrap; the switches that used to wrap it now
				    live in the overflow menu. */}
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<p className="font-medium">{account.name}</p>
					{isPrimary && (
						<span className="px-2 py-0.5 text-xs font-medium bg-primary text-primary-foreground rounded-full">
							Primary
						</span>
					)}
					<span className="px-2 py-0.5 text-xs font-medium bg-secondary text-secondary-foreground rounded-full">
						Priority: {account.priority}
					</span>
					<OAuthTokenStatusWithBoundary
						accountName={account.name}
						hasRefreshToken={account.hasRefreshToken}
					/>
				</div>
				{/* Provider row */}
				<div className="flex flex-wrap items-center gap-2">
					<p className="text-sm text-muted-foreground">{account.provider}</p>
					{account.provider === "bedrock" && bedrockProfile && (
						<>
							<span className="text-sm text-muted-foreground">•</span>
							<p className="text-sm text-muted-foreground">
								Profile: {bedrockProfile}
							</p>
							{bedrockRegion && (
								<>
									<span className="text-sm text-muted-foreground">•</span>
									<div
										className="flex items-center gap-1"
										title={`Region: ${bedrockRegion}`}
									>
										<Globe className="h-3 w-3 text-muted-foreground" />
										<p className="text-sm text-muted-foreground">
											{bedrockRegion}
										</p>
									</div>
								</>
							)}
							{bedrockCrossRegionMode && (
								<>
									<span className="text-sm text-muted-foreground">•</span>
									<p
										className="text-sm text-muted-foreground"
										title="Cross-region inference mode"
									>
										{bedrockCrossRegionMode}
									</p>
								</>
							)}
						</>
					)}
				</div>
				{/* Status row, with the actions pushed flush right by ml-auto so a
				    wrapped actions line lands at the right edge rather than the left,
				    which is what justify-between did before. */}
				<div className="flex flex-wrap items-center gap-2">
					<div className="flex flex-wrap items-center gap-2">
						{presenter.isRateLimited && (
							<span title="Account is rate-limited - requests will be rejected until the limit resets">
								<AlertCircle className="h-4 w-4 text-yellow-600" />
							</span>
						)}
						<span className="whitespace-nowrap text-sm">
							{presenter.requestCount} requests
						</span>
						<span className="text-sm text-muted-foreground">
							{presenter.sessionInfo}
						</span>
						{account.requiresReauth ? (
							<Badge
								variant="destructive"
								title="Refresh token invalid — re-authenticate"
							>
								Needs authentication
							</Badge>
						) : (
							presenter.isPaused && (
								<span className="text-sm text-muted-foreground">
									Paused
									{formatPauseReason(account.pauseReason)
										? ` (${formatPauseReason(account.pauseReason)})`
										: ""}
								</span>
							)
						)}
						{!account.requiresReauth &&
							(account.reauthDeadlineStatus === "warning" ||
								account.reauthDeadlineStatus === "critical" ||
								account.reauthDeadlineStatus === "expired") && (
								<span
									className="text-sm text-amber-600"
									title={`Empirically observed ~28-day OAuth reauthentication deadline. Run: bun run cli --reauthenticate "${account.name}"`}
								>
									{account.reauthDeadlineStatus === "expired"
										? Math.abs(account.hoursUntilReauthRequired ?? 0) < 24
											? `Reauth overdue by ${Math.abs(account.hoursUntilReauthRequired ?? 0)}h`
											: `Reauth overdue by ${Math.abs(account.daysUntilReauthRequired ?? 0)}d`
										: (account.hoursUntilReauthRequired ?? Infinity) < 24
											? `Reauth in ${account.hoursUntilReauthRequired}h`
											: `Reauth in ${account.daysUntilReauthRequired}d`}
								</span>
							)}
						{renewal && (
							<span
								className="text-sm text-muted-foreground"
								title={`Subscription renews on ${formatRenewalDate(renewal)}${
									renewal.clamped
										? `. Day ${account.renewalDay} does not exist in that month, so it renews on its last day.`
										: ""
								}`}
							>
								{formatRenewalBadge(renewal)}
							</span>
						)}
						{!presenter.isPaused && presenter.rateLimitStatus !== "OK" && (
							<span
								className={`text-sm ${
									presenter.rateLimitStatus
										.toLowerCase()
										.startsWith("allowed_warning")
										? "text-amber-600"
										: presenter.rateLimitStatus
													.toLowerCase()
													.startsWith("allowed")
											? "text-green-600"
											: "text-destructive"
								}`}
							>
								{presenter.rateLimitStatus}
							</span>
						)}
						{staleLockDetected && (
							<span
								className="text-sm text-amber-600"
								title="Stale lock detected: usage data shows available capacity but account is still rate-limited"
							>
								Stale lock detected
							</span>
						)}
						{isUsageThrottled && (
							<span
								className="text-sm text-amber-600"
								title="Usage throttling is delaying requests for this account until pacing catches up"
							>
								Usage throttled
							</span>
						)}
					</div>
					{/* Actions. Only controls an operator reaches for while watching a
					    card stay visible; configuration and the destructive Remove are
					    in the overflow menu. */}
					<div className="ml-auto flex flex-wrap items-center gap-2">
						{(account.provider === "anthropic" ||
							account.provider === "codex") && (
							<Button
								variant="ghost"
								size="sm"
								className="h-8 gap-1 text-xs"
								disabled={isRefreshingUsage}
								onClick={async () => {
									setIsRefreshingUsage(true);
									try {
										await onRefreshUsage(account);
									} finally {
										setIsRefreshingUsage(false);
									}
								}}
								aria-label="Refresh usage data"
								title={
									account.provider === "codex"
										? "Refresh usage data (sends one minimal Codex request — consumes a small slice of quota)"
										: "Refresh usage data (restarts usage polling and refreshes token if expired)"
								}
							>
								<RefreshCw
									className={`h-3.5 w-3.5 ${isRefreshingUsage ? "animate-spin" : ""}`}
								/>
							</Button>
						)}
						{showForceReset && (
							<Button
								variant="outline"
								size="sm"
								className="h-8 gap-1 text-xs"
								onClick={() => onForceResetRateLimit(account)}
								title={
									staleLockDetected
										? "Reset stale rate limit lock (usage shows capacity available)"
										: "Force clear rate limit state from database"
								}
							>
								<RefreshCw className="h-3.5 w-3.5" />
								Force Reset
							</Button>
						)}
						<Button
							variant="ghost"
							size="sm"
							onClick={() => onPauseToggle(account)}
							aria-label={account.paused ? "Resume account" : "Pause account"}
							title={account.paused ? "Resume account" : "Pause account"}
						>
							{account.paused ? (
								<Play className="h-4 w-4" />
							) : (
								<Pause className="h-4 w-4" />
							)}
						</Button>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="ghost" size="sm" title="More">
									<Ellipsis className="h-4 w-4" />
									<span className="sr-only">
										More actions for {account.name}
									</span>
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-64">
								{menuToggles.map((toggle) => (
									<DropdownMenuCheckboxItem
										key={toggle.id}
										checked={toggle.checked}
										title={toggle.title}
										// Keep the menu open so several toggles can be set in one
										// visit; without this Radix closes on every select.
										onSelect={(event) => event.preventDefault()}
										onCheckedChange={bound.toggle[toggle.id]}
									>
										{toggle.label}
									</DropdownMenuCheckboxItem>
								))}
								{menuToggles.length > 0 && <DropdownMenuSeparator />}
								{menuActions.map((action) => {
									const Icon = ACTION_ICONS[action.id];
									return (
										<DropdownMenuItem
											key={action.id}
											title={action.title}
											onClick={bound.action[action.id]}
										>
											<Icon
												className={`mr-2 h-4 w-4 ${action.configured ? "text-primary" : ""}`}
											/>
											<span>{action.label}</span>
											{action.configured && (
												<span className="ml-auto pl-2 text-xs text-primary">
													Configured
												</span>
											)}
										</DropdownMenuItem>
									);
								})}
								<DropdownMenuSeparator />
								<DropdownMenuItem
									className="text-destructive focus:text-destructive"
									onClick={() => onRemove(account)}
									title="Remove account"
								>
									<Trash2 className="mr-2 h-4 w-4" />
									<span>Remove</span>
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</div>
			</div>
			{account.sessionStats && (
				<div className="text-xs text-muted-foreground">
					Session: {account.sessionStats.requests} req
					{" · "}↑{formatTokenCount(account.sessionStats.inputTokens)} in
					{" · "}✦
					{formatTokenCount(account.sessionStats.cacheCreationInputTokens)}{" "}
					cache↑
					{" · "}✦{formatTokenCount(account.sessionStats.cacheReadInputTokens)}{" "}
					cache↓
					{" · "}↓{formatTokenCount(account.sessionStats.outputTokens)} out
					{account.sessionStats.planCostUsd > 0 && (
						<>
							{" · "}${account.sessionStats.planCostUsd.toFixed(2)} plan
						</>
					)}
					{account.sessionStats.apiCostUsd > 0 && (
						<>
							{" · "}${account.sessionStats.apiCostUsd.toFixed(2)} api
						</>
					)}
				</div>
			)}
			{(account.rateLimitReset ||
				account.usageData ||
				account.usageRateLimitedUntil ||
				// Codex quota data only arrives piggybacked on real traffic (no usage
				// polling endpoint), so gaps are routine. Mount the bar anyway: it
				// renders the weekly window as "Data unavailable" instead of
				// disappearing, and a missing quota bar reads as "no limit".
				account.provider === "codex" ||
				providerShowsCreditsBalance(account.provider)) && (
				<RateLimitProgress
					resetIso={account.rateLimitReset}
					usageUtilization={account.usageUtilization}
					usageWindow={account.usageWindow}
					usageData={account.usageData}
					usageRateLimitedUntil={account.usageRateLimitedUntil}
					usageThrottledUntil={account.usageThrottledUntil}
					usageThrottledWindows={account.usageThrottledWindows}
					provider={account.provider}
					showWeekly={providerShowsWeeklyUsage(account.provider)}
					pauseThresholdFiveHour={
						supportsUsagePauseThreshold(account.provider) &&
						account.usagePauseFiveHourEnabled
							? account.usagePauseFiveHourThreshold
							: null
					}
					pauseThresholdWeekly={
						supportsUsagePauseThreshold(account.provider) &&
						account.usagePauseWeeklyEnabled
							? account.usagePauseWeeklyThreshold
							: null
					}
				/>
			)}
		</div>
	);
}
