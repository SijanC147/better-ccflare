import { useEffect, useState } from "react";
import { useRetryConfig, useSetRetryConfig } from "../../hooks/queries";
import { Button } from "../ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Input } from "../ui/input";

/**
 * Jitter ceiling for one delay, in milliseconds, used only until the server
 * answers. GET /api/config/retry now returns the RESOLVED ceiling as
 * `jitterCeilingMs`, because CCFLARE_OVERLOAD_RETRY_MAX_MS can move it away
 * from this default on a host the browser cannot inspect, and every wait shown
 * here would then be wrong with nothing on screen saying so (SB23-2018).
 *
 * Kept as the parameter default rather than deleted: retryWaitCeilingMs is
 * exported and tested directly, and a required argument there would make the
 * tests specify a number that is not the point of what they assert.
 */
const JITTER_CEILING_MS = 3000;

/**
 * The longest a request that keeps failing can spend waiting, in milliseconds.
 *
 * Mirrors the loop that actually runs. `forwardWithTransportRetry` calls
 * `retryDelayMs(cfg, attempt + 1)`, and `retryDelayMs` computes
 * `Math.min(baseMs * backoff ** attempt, maxMs)` and then draws uniformly from
 * `[0, cap]`. So the first delay's cap is `delayMs * backoff`, NOT `delayMs`,
 * and every cap is clipped at the ceiling.
 *
 * An earlier version of this function summed `delayMs * backoff ** retry` with
 * no ceiling. It was wrong in both directions: 5 attempts at 1000ms with
 * backoff 2 read as 15 seconds when the real ceiling sum is 11, and at a 100ms
 * base it understated. Exported so a test can pin the arithmetic against
 * `retryDelayMs` rather than against the number this file happens to print.
 */
export function retryWaitCeilingMs(
	attempts: number,
	delayMs: number,
	backoff: number,
	maxMs = JITTER_CEILING_MS,
): number | null {
	if (
		!Number.isFinite(attempts) ||
		!Number.isFinite(delayMs) ||
		!Number.isFinite(backoff)
	)
		return null;
	let total = 0;
	for (let retry = 1; retry <= Math.max(0, attempts - 1); retry++) {
		total += Math.min(delayMs * backoff ** retry, maxMs);
	}
	return total;
}

/**
 * Upstream retry settings: `retry_attempts`, `retry_delay_ms` and
 * `retry_backoff`.
 *
 * Every number on this card comes from the server. There is no `?? 3` here:
 * the config layer resolves the defaults and the handler owns the bounds, so a
 * second copy in this component could only drift from the one that rejects.
 *
 * `db_retry_*` is a separate chain and is deliberately absent.
 */
export function RetryCard() {
	const { data, isLoading } = useRetryConfig();
	const setConfig = useSetRetryConfig();

	// Strings, not numbers, so a half-typed value is not silently coerced. Empty
	// means "not read from the server yet"; it is never posted.
	const [attempts, setAttempts] = useState("");
	const [delayMs, setDelayMs] = useState("");
	const [backoff, setBackoff] = useState("");

	useEffect(() => {
		if (!data) return;
		setAttempts(String(data.attempts));
		setDelayMs(String(data.delayMs));
		setBackoff(String(data.backoff));
	}, [data]);

	const busy = isLoading || setConfig.isPending;

	function fieldError(
		raw: string,
		bound: { min: number; max: number } | undefined,
		integer: boolean,
	): string | null {
		if (!bound || raw === "") return null;
		const value = Number(raw);
		if (!Number.isFinite(value)) return "Must be a number";
		if (integer && !Number.isInteger(value)) return "Must be a whole number";
		if (value < bound.min || value > bound.max)
			return `Must be between ${bound.min} and ${bound.max}`;
		return null;
	}

	const attemptsError = fieldError(attempts, data?.bounds.attempts, true);
	const delayError = fieldError(delayMs, data?.bounds.delayMs, true);
	const backoffError = fieldError(backoff, data?.bounds.backoff, false);
	const hasError = Boolean(attemptsError || delayError || backoffError);

	// The whole card is posted on every save, so each field carries its current
	// value: an absent field leaves the stored key alone, which would make a
	// save look like a silent no-op.
	function handleSave() {
		if (hasError) return;
		if (attempts === "" || delayMs === "" || backoff === "") return;
		setConfig.mutate({
			attempts: Number(attempts),
			delayMs: Number(delayMs),
			backoff: Number(backoff),
		});
	}

	const wait = hasError
		? null
		: retryWaitCeilingMs(
				Number(attempts),
				Number(delayMs),
				Number(backoff),
				data?.jitterCeilingMs ?? JITTER_CEILING_MS,
			);
	const attemptsNumber = Number(attempts);
	const worstCaseFetches = Number.isFinite(attemptsNumber)
		? Math.max(1, attemptsNumber) ** 2
		: null;

	return (
		<Card>
			<CardHeader>
				<CardTitle>Upstream retry</CardTitle>
				<CardDescription>
					How often a failed upstream request is retried, and how long the proxy
					waits between attempts. Only a request that threw is retried: a
					connection, DNS or TLS failure, never a response of any status.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="space-y-1">
					<label className="text-sm font-medium" htmlFor="retry-attempts">
						Attempts
					</label>
					<Input
						id="retry-attempts"
						type="number"
						inputMode="numeric"
						value={attempts}
						disabled={busy}
						min={data?.bounds.attempts.min}
						max={data?.bounds.attempts.max}
						step={1}
						onChange={(e) => setAttempts(e.target.value)}
					/>
					<p className="text-xs text-muted-foreground">
						Total attempts for one request, the first attempt included, so 1
						means no retry.
						{data ? ` Maximum ${data.bounds.attempts.max}.` : ""} Two retry
						layers read this key and can stack on one request, so the worst case
						is attempts squared
						{worstCaseFetches !== null
							? `, which is ${worstCaseFetches} upstream fetches at this setting`
							: ""}
						.
					</p>
					{attemptsError && (
						<p className="text-xs text-destructive">{attemptsError}</p>
					)}
				</div>

				<div className="space-y-1">
					<label className="text-sm font-medium" htmlFor="retry-delay">
						Base delay (ms)
					</label>
					<Input
						id="retry-delay"
						type="number"
						inputMode="numeric"
						value={delayMs}
						disabled={busy}
						min={data?.bounds.delayMs.min}
						max={data?.bounds.delayMs.max}
						step={100}
						onChange={(e) => setDelayMs(e.target.value)}
					/>
					<p className="text-xs text-muted-foreground">
						Milliseconds before the first retry. Each individual delay is drawn
						under a jittered ceiling of{" "}
						{data ? `${data.jitterCeilingMs}ms` : "3000ms"}, set by
						CCFLARE_OVERLOAD_RETRY_MAX_MS.
					</p>
					{delayError && (
						<p className="text-xs text-destructive">{delayError}</p>
					)}
				</div>

				<div className="space-y-1">
					<label className="text-sm font-medium" htmlFor="retry-backoff">
						Backoff multiplier
					</label>
					<Input
						id="retry-backoff"
						type="number"
						inputMode="decimal"
						value={backoff}
						disabled={busy}
						min={data?.bounds.backoff.min}
						max={data?.bounds.backoff.max}
						step={0.5}
						onChange={(e) => setBackoff(e.target.value)}
					/>
					<p className="text-xs text-muted-foreground">
						A multiplier, not a duration: the delay is multiplied by it on every
						retry. 1 keeps the delay constant.
					</p>
					{backoffError && (
						<p className="text-xs text-destructive">{backoffError}</p>
					)}
				</div>

				{wait !== null && (
					<p className="text-xs text-muted-foreground">
						At these settings a request that keeps failing waits at most about{" "}
						{(wait / 1000).toFixed(1)} seconds before it gives up. Each delay is
						drawn uniformly from zero up to its own ceiling, so the average is
						around half that.
					</p>
				)}

				{data?.restartRequired && (
					<p className="text-xs text-muted-foreground">
						The proxy reads these once at startup, so a saved value takes effect
						on the next restart.
					</p>
				)}

				{data && data.environmentKeys.length > 0 && (
					<p className="text-xs text-muted-foreground">
						{data.environmentKeys.join(", ")} set in the environment. A value
						saved here outranks them.
					</p>
				)}

				{data && data.overloadEnvironmentKeys.length > 0 && (
					<p className="text-xs text-destructive">
						{data.overloadEnvironmentKeys.join(", ")} set in the environment.
						These are deprecated and they override what you save here on the 529
						and ZAI 1305 retry loops. Unset them for this card to govern those
						paths.
					</p>
				)}

				{setConfig.isError && (
					<p className="text-xs text-destructive">
						{setConfig.error instanceof Error
							? setConfig.error.message
							: "Save failed"}
					</p>
				)}

				<Button size="sm" disabled={busy || hasError} onClick={handleSave}>
					{setConfig.isPending ? "Saving" : "Save"}
				</Button>
			</CardContent>
		</Card>
	);
}
