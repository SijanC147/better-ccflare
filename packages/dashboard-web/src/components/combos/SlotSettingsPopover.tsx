import type { ComboSlot } from "@better-ccflare/types";
import { Settings2 } from "lucide-react";
import { useState } from "react";
import { useUpdateComboSlot } from "../../hooks/queries";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import {
	buildSlotUpdate,
	draftFromSlot,
	isDirty,
	MAX_RESET_HOURS,
	type SlotThrottleDraft,
	validateDraft,
} from "./slot-throttle-helpers";

interface SlotSettingsFormProps {
	slot: ComboSlot;
	comboId: string;
	onSaved: () => void;
}

/**
 * Lives inside PopoverContent so it mounts fresh on every open and seeds its
 * state from the slot once. Nothing syncs the draft back to the slot with an
 * effect: the same rule the add form in ComboSlotBuilder follows.
 */
function SlotSettingsForm({ slot, comboId, onSaved }: SlotSettingsFormProps) {
	const [draft, setDraft] = useState<SlotThrottleDraft>(() =>
		draftFromSlot(slot),
	);
	const updateSlot = useUpdateComboSlot();

	const { percent, resetMs } = validateDraft(draft);
	const update = buildSlotUpdate(slot, draft);
	const dirty = isDirty(update);
	// Stable ids so each field's message can be announced with the field it
	// belongs to, rather than leaving a screen reader with "invalid" and no
	// reason.
	const percentHintId = `slot-max-util-hint-${slot.id}`;
	const resetHintId = `slot-min-reset-hint-${slot.id}`;

	const handleSave = () => {
		if (!update || !dirty) return;
		updateSlot.mutate(
			{ comboId, slotId: slot.id, params: update },
			{ onSuccess: onSaved },
		);
	};

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between gap-3">
				<div className="space-y-0.5">
					<Label htmlFor={`slot-enabled-${slot.id}`}>Slot enabled</Label>
					<p className="text-[11px] text-muted-foreground">
						A disabled slot is passed over entirely.
					</p>
				</div>
				<Switch
					id={`slot-enabled-${slot.id}`}
					checked={draft.enabled}
					onCheckedChange={(enabled) => setDraft((d) => ({ ...d, enabled }))}
				/>
			</div>

			<div className="space-y-3 border-t pt-3">
				<div className="space-y-1">
					{/* A heading, not a label: it names the group rather than any one
					 * control, so an orphan <label> here would point at nothing. */}
					<p className="text-sm font-medium">Skip this slot when</p>
					{/*
					 * Settled 2026-09-14: only the configured conditions are
					 * evaluated, and every configured one must hold. Each field is
					 * independently settable and independently clearable, so the
					 * copy must not present them as a pair.
					 */}
					<p className="text-[11px] text-muted-foreground">
						Leave a field blank to ignore that condition. With both set, the
						slot is skipped only when both hold. With neither, the slot is never
						skipped. Skipping moves on to the next slot in the chain; it is not
						the global usage throttle, which fails the whole request.
					</p>
				</div>

				<div className="space-y-1.5">
					<Label htmlFor={`slot-max-util-${slot.id}`}>
						Account usage is at or above
					</Label>
					<div className="flex items-center gap-2">
						<Input
							id={`slot-max-util-${slot.id}`}
							inputMode="numeric"
							placeholder="off"
							value={draft.maxUtilizationPercent}
							onChange={(e) =>
								setDraft((d) => ({
									...d,
									maxUtilizationPercent: e.target.value,
								}))
							}
							className="w-24"
							aria-invalid={percent === "invalid"}
							aria-describedby={percentHintId}
						/>
						<span className="text-xs text-muted-foreground">
							percent (0-100)
						</span>
					</div>
					{percent === "invalid" && (
						<p id={percentHintId} className="text-[11px] text-destructive">
							Enter a whole number from 0 to 100, or clear the field to ignore
							this condition.
						</p>
					)}
					{percent === 0 && (
						<p id={percentHintId} className="text-[11px] text-muted-foreground">
							0 percent matches any usage, so this slot is always skipped while
							that is the only condition set.
						</p>
					)}
				</div>

				<div className="space-y-1.5">
					<Label htmlFor={`slot-min-reset-${slot.id}`}>
						And its usage window is still at least
					</Label>
					<div className="flex items-center gap-2">
						<Input
							id={`slot-min-reset-${slot.id}`}
							inputMode="decimal"
							placeholder="off"
							value={draft.minResetRemainingHours}
							onChange={(e) =>
								setDraft((d) => ({
									...d,
									minResetRemainingHours: e.target.value,
								}))
							}
							className="w-24"
							aria-invalid={resetMs === "invalid"}
							aria-describedby={resetHintId}
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
					{/* 0 hours is as slot-disabling here as 0 percent is above: the
					 * clause becomes "resetMs - now >= 0", which holds for any reset in
					 * the future, so the slot is skipped on every request. The percent
					 * field warns about its zero, so this one must too. */}
					{resetMs === 0 && (
						<p id={resetHintId} className="text-[11px] text-muted-foreground">
							0 hours matches any reset that is still ahead, so this slot is
							always skipped while that is the only condition set.
						</p>
					)}
					<p className="text-[11px] text-muted-foreground">
						A reset that is closer than this leaves the slot in play, because
						the account frees up shortly.
					</p>
				</div>

				{/* The cadence is usage-fetcher.ts:925, a 90s default with plus or
				 * minus 20 percent jitter (:806). On a failed fetch it backs off
				 * exponentially to 30 minutes (:813), so quoting 90 seconds alone
				 * would understate the worst case by a factor of twenty. */}
				<p className="text-[11px] text-muted-foreground">
					Usage figures come from a background poll, about every 90 seconds
					while a provider is answering and as little as every 30 minutes while
					it is failing. A threshold acts on the last cached figure, not a live
					one.
				</p>
			</div>

			{/* A failed save is otherwise silent to a screen reader: the button
			 * returns from "Saving..." to "Save" and nothing announces why. */}
			{updateSlot.isError && (
				<p role="alert" className="text-[11px] text-destructive">
					{updateSlot.error instanceof Error
						? updateSlot.error.message
						: "Could not save the slot."}
				</p>
			)}

			<div className="flex justify-end">
				<Button
					size="sm"
					onClick={handleSave}
					disabled={!dirty || updateSlot.isPending}
				>
					{updateSlot.isPending ? "Saving..." : "Save"}
				</Button>
			</div>
		</div>
	);
}

interface SlotSettingsPopoverProps {
	slot: ComboSlot;
	comboId: string;
	accountName: string;
}

export function SlotSettingsPopover({
	slot,
	comboId,
	accountName,
}: SlotSettingsPopoverProps) {
	const [open, setOpen] = useState(false);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className="shrink-0 text-muted-foreground hover:text-foreground"
					aria-label={`Slot settings for ${accountName}`}
				>
					<Settings2 className="h-4 w-4" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-80" align="end">
				{open && (
					<SlotSettingsForm
						slot={slot}
						comboId={comboId}
						onSaved={() => setOpen(false)}
					/>
				)}
			</PopoverContent>
		</Popover>
	);
}
