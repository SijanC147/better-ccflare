import { RENEWAL_DAY_MAX, RENEWAL_DAY_MIN } from "@better-ccflare/types";
import { useEffect, useState } from "react";
import type { Account } from "../../api";
import { formatRenewalDate, viewerRenewal } from "../../utils/renewal";
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

interface AccountRenewalDayDialogProps {
	account: Account | null;
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	onUpdateRenewalDay: (
		accountId: string,
		renewalDay: number | null,
	) => Promise<void>;
}

/**
 * Sets or clears the subscription renewal day (SB23-2055).
 *
 * The bounds come from packages/types rather than from literals typed here, so
 * the dialog and the handler that answers 400 cannot drift apart. This is what
 * `#137` did with MAX_RESET_HOURS: `packages/dashboard-web` cannot import from
 * `packages/http-api` without pulling database, proxy and providers into the
 * browser bundle, so a shared constant goes down into types.
 */
export function AccountRenewalDayDialog({
	account,
	isOpen,
	onOpenChange,
	onUpdateRenewalDay,
}: AccountRenewalDayDialogProps) {
	const [value, setValue] = useState(account?.renewalDay?.toString() ?? "");
	const [isUpdating, setIsUpdating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setValue(account?.renewalDay?.toString() ?? "");
		setError(null);
	}, [account]);

	const trimmed = value.trim();
	const parsed = trimmed === "" ? null : Number(trimmed);
	const isValid =
		parsed === null ||
		(Number.isInteger(parsed) &&
			parsed >= RENEWAL_DAY_MIN &&
			parsed <= RENEWAL_DAY_MAX);

	// Previewed from the value being typed, not from the stored one, so the
	// operator sees February's clamp before committing to a 31.
	const preview = isValid && parsed !== null ? viewerRenewal(parsed) : null;

	const handleUpdate = async () => {
		if (!account || !isValid) return;

		setIsUpdating(true);
		setError(null);
		try {
			await onUpdateRenewalDay(account.id, parsed);
			onOpenChange(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setIsUpdating(false);
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[425px]">
				<DialogHeader>
					<DialogTitle>Subscription Renewal Day</DialogTitle>
					<DialogDescription>
						The day of the month {account?.name}'s subscription renews, from{" "}
						{RENEWAL_DAY_MIN} to {RENEWAL_DAY_MAX}. Leave it empty to clear it.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-4 py-4">
					<div className="grid grid-cols-4 items-center gap-4">
						<Label htmlFor="renewalDay" className="text-right">
							Renewal day
						</Label>
						<Input
							id="renewalDay"
							type="number"
							min={RENEWAL_DAY_MIN}
							max={RENEWAL_DAY_MAX}
							value={value}
							placeholder="Not set"
							onChange={(e) => setValue(e.target.value)}
							className="col-span-3"
						/>
					</div>
					{!isValid && (
						<div className="text-sm text-destructive">
							Enter a whole number between {RENEWAL_DAY_MIN} and{" "}
							{RENEWAL_DAY_MAX}, or leave it empty.
						</div>
					)}
					{preview && (
						<div className="text-sm text-muted-foreground">
							Next renewal: {formatRenewalDate(preview)}
							{preview.clamped
								? ` (day ${parsed} does not exist in that month, so it renews on the last day)`
								: ""}
						</div>
					)}
					{isValid && parsed === null && (
						<div className="text-sm text-muted-foreground">
							No renewal day. The account card shows no countdown.
						</div>
					)}
					{error && <div className="text-sm text-destructive">{error}</div>}
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
						disabled={isUpdating || !isValid}
					>
						{isUpdating ? "Saving..." : "Save"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
