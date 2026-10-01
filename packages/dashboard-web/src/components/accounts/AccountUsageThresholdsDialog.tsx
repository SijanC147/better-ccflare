import { useEffect, useState } from "react";
import type { Account } from "../../api";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import {
	draftFromSetting,
	getThresholdLabels,
	MAX_RESET_HOURS,
	settingFromDraft,
	storedWindowSettings,
	type UsagePauseWindowDraft,
	type UsagePauseWindowSetting,
	validateWindowDraft,
} from "./usage-pause-helpers";

// Re-exported: the dialog's tests and earlier callers import it from here.
export { getThresholdLabels };

interface AccountUsageThresholdsDialogProps {
	account: Account | null;
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	onUpdateThresholds: (
		accountId: string,
		fiveHour: UsagePauseWindowSetting,
		weekly: UsagePauseWindowSetting,
	) => Promise<void>;
}

/**
 * Per-account usage pause thresholds: bench the account while a usage window
 * meets its conditions, and let it back in when they stop holding.
 *
 * Each window has the combo slot popover's two conditions (SB23-2575): usage
 * at or above a percentage, and the window still at least some hours from
 * resetting. A blank field means that condition is off; only the conditions
 * that are set are considered, and with both set both must hold. Both windows
 * are saved together.
 */
export function AccountUsageThresholdsDialog({
	account,
	isOpen,
	onOpenChange,
	onUpdateThresholds,
}: AccountUsageThresholdsDialogProps) {
	const [fiveHour, setFiveHour] = useState<UsagePauseWindowDraft>(() =>
		draftFromSetting(storedWindowSettings(account).fiveHour),
	);
	const [weekly, setWeekly] = useState<UsagePauseWindowDraft>(() =>
		draftFromSetting(storedWindowSettings(account).weekly),
	);
	const [isUpdating, setIsUpdating] = useState(false);
	const { fiveHourLabel, weeklyLabel } = getThresholdLabels(account);

	// Reset the fields whenever the dialog is pointed at another account.
	useEffect(() => {
		setFiveHour(
			draftFromSetting({
				enabled: account?.usagePauseFiveHourEnabled ?? false,
				percent: account?.usagePauseFiveHourThreshold ?? null,
				minResetRemainingMs:
					account?.usagePauseFiveHourMinResetRemainingMs ?? null,
			}),
		);
	}, [
		account?.usagePauseFiveHourThreshold,
		account?.usagePauseFiveHourEnabled,
		account?.usagePauseFiveHourMinResetRemainingMs,
	]);
	useEffect(() => {
		setWeekly(
			draftFromSetting({
				enabled: account?.usagePauseWeeklyEnabled ?? false,
				percent: account?.usagePauseWeeklyThreshold ?? null,
				minResetRemainingMs:
					account?.usagePauseWeeklyMinResetRemainingMs ?? null,
			}),
		);
	}, [
		account?.usagePauseWeeklyThreshold,
		account?.usagePauseWeeklyEnabled,
		account?.usagePauseWeeklyMinResetRemainingMs,
	]);

	const fiveHourSetting = settingFromDraft(fiveHour);
	const weeklySetting = settingFromDraft(weekly);
	const hasError = fiveHourSetting === null || weeklySetting === null;

	const handleUpdate = async () => {
		if (!account || fiveHourSetting === null || weeklySetting === null) {
			return;
		}

		setIsUpdating(true);
		try {
			await onUpdateThresholds(account.id, fiveHourSetting, weeklySetting);
			onOpenChange(false);
		} catch (error) {
			console.error("Failed to update usage pause thresholds:", error);
		} finally {
			setIsUpdating(false);
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[560px]">
				<DialogHeader>
					<DialogTitle>Usage Pause Thresholds</DialogTitle>
					<DialogDescription>
						Pause {account?.name} while a usage window meets its conditions, and
						resume it automatically when they stop holding. Leave a field blank
						to ignore that condition; with both set, the window pauses only when
						both hold. Each window is switched on separately, and a window that
						is off keeps its numbers for next time.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-5 py-4">
					<ThresholdRow
						id="usage-threshold-5h"
						label={fiveHourLabel}
						draft={fiveHour}
						onDraftChange={setFiveHour}
					/>
					<ThresholdRow
						id="usage-threshold-weekly"
						label={weeklyLabel}
						draft={weekly}
						onDraftChange={setWeekly}
					/>
					<div className="text-sm text-muted-foreground">
						A pause from a threshold is lifted by the usage poller once no
						window that is on still meets its conditions, including when a reset
						that was far away comes near. Pausing the account by hand is never
						overridden. Usage figures come from a background poll, about every
						90 seconds while a provider is answering.
					</div>
				</div>
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						type="button"
						onClick={handleUpdate}
						disabled={isUpdating || hasError}
					>
						{isUpdating ? "Saving..." : "Save Thresholds"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

interface ThresholdRowProps {
	id: string;
	label: string;
	draft: UsagePauseWindowDraft;
	onDraftChange: (next: UsagePauseWindowDraft) => void;
}

/**
 * One window: a switch that says whether it is in force, then its two
 * conditions in the combo slot popover's wording and controls.
 *
 * Both fields stay editable while the switch is off, so numbers can be written
 * down before the window is switched on, and the ones already stored stay
 * visible instead of disappearing when the window is turned off.
 */
function ThresholdRow({ id, label, draft, onDraftChange }: ThresholdRowProps) {
	const { percent, resetMs, error } = validateWindowDraft(draft);
	const percentHintId = `${id}-percent-hint`;
	const resetHintId = `${id}-reset-hint`;
	const muted = draft.enabled ? "" : "text-muted-foreground";

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between gap-3">
				<p className={`text-sm font-medium ${muted}`}>{label} window</p>
				<Switch
					checked={draft.enabled}
					onCheckedChange={(enabled) => onDraftChange({ ...draft, enabled })}
					title={`Pause on the ${label.toLowerCase()} window`}
					aria-label={`Pause on the ${label.toLowerCase()} window`}
				/>
			</div>

			<div className="space-y-1.5 pl-1">
				<Label htmlFor={id} className={muted}>
					Account usage is at or above
				</Label>
				<div className="flex items-center gap-2">
					<Input
						id={id}
						inputMode="numeric"
						placeholder="off"
						value={draft.percent}
						onChange={(e) =>
							onDraftChange({ ...draft, percent: e.target.value })
						}
						className="w-24"
						aria-invalid={percent === "invalid"}
						aria-describedby={percent === "invalid" ? percentHintId : undefined}
					/>
					<span className="text-xs text-muted-foreground">percent (1-100)</span>
				</div>
				{percent === "invalid" && (
					<p id={percentHintId} className="text-[11px] text-destructive">
						Enter a whole number from 1 to 100, or clear the field to ignore
						this condition.
					</p>
				)}
			</div>

			<div className="space-y-1.5 pl-1">
				<Label htmlFor={`${id}-reset`} className={muted}>
					And its usage window is still at least
				</Label>
				<div className="flex items-center gap-2">
					<Input
						id={`${id}-reset`}
						inputMode="decimal"
						placeholder="off"
						value={draft.minResetHours}
						onChange={(e) =>
							onDraftChange({ ...draft, minResetHours: e.target.value })
						}
						className="w-24"
						aria-invalid={resetMs === "invalid"}
						aria-describedby={
							resetMs === "invalid" || resetMs === 0
								? resetHintId
								: `${resetHintId}-note`
						}
					/>
					<span className="text-xs text-muted-foreground">
						hours from resetting
					</span>
				</div>
				{resetMs === "invalid" && (
					<p id={resetHintId} className="text-[11px] text-destructive">
						Enter a number of hours between 0 and{" "}
						{MAX_RESET_HOURS.toLocaleString()}, or clear the field to ignore
						this condition.
					</p>
				)}
				{/* 0 hours holds for any reset still ahead, the same warning the
				 * slot popover gives for its zero. */}
				{resetMs === 0 && (
					<p id={resetHintId} className="text-[11px] text-muted-foreground">
						0 hours matches any reset that is still ahead, so this window pauses
						the account on every poll while that is the only condition set.
					</p>
				)}
				<p
					id={`${resetHintId}-note`}
					className="text-[11px] text-muted-foreground"
				>
					A reset that is closer than this leaves the account in play, because
					the window frees up shortly.
				</p>
			</div>

			{error === "on-without-condition" && (
				<p role="alert" className="text-[11px] text-destructive">
					A window that is switched on needs a percentage, an hours-to-reset, or
					both.
				</p>
			)}
		</div>
	);
}
