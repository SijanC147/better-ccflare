import { registerUIRefresh } from "@better-ccflare/core";
import { format } from "date-fns";
import { useEffect, useMemo, useState } from "react";
import { useAccounts } from "../hooks/queries";
import {
	computePoolUsage,
	computeScopedPoolUsage,
	formatFamilyLabel,
	formatRelativeReset,
	type PoolUsageResult,
} from "../lib/pool-usage";

export interface KioskPool {
	id: string;
	title: string;
	result: PoolUsageResult;
}

/**
 * Colour band for a usage percentage. Deliberately coarse: the whole point of
 * a kiosk is that the state reads at a glance from across a room, so there are
 * three states and no gradient between them.
 */
export function kioskUsageTone(
	pct: number | null,
): "idle" | "ok" | "warn" | "hot" {
	if (pct === null) return "idle";
	if (pct >= 90) return "hot";
	if (pct >= 70) return "warn";
	return "ok";
}

const TONE_TEXT: Record<ReturnType<typeof kioskUsageTone>, string> = {
	idle: "text-muted-foreground",
	ok: "text-emerald-400",
	warn: "text-amber-400",
	hot: "text-red-400",
};

const TONE_BAR: Record<ReturnType<typeof kioskUsageTone>, string> = {
	idle: "bg-muted-foreground/40",
	ok: "bg-emerald-500",
	warn: "bg-amber-500",
	hot: "bg-red-500",
};

/**
 * The headline number for a pool. `average` is the pool-wide figure the
 * dashboard's own pool capacity section leads with; null means no account
 * currently contributes to this window, which is a real state (nothing is
 * limited) and not an error.
 */
export function kioskHeadlinePct(result: PoolUsageResult): number | null {
	return result.average;
}

function KioskPoolRow({ pool, now }: { pool: KioskPool; now: number }) {
	const pct = kioskHeadlinePct(pool.result);
	const tone = kioskUsageTone(pct);
	const reset = formatRelativeReset(pool.result.earliestResetMs, now);
	const worst = pool.result.worst;

	return (
		<div className="flex flex-col gap-3 border-b border-border/40 py-6 last:border-b-0">
			<div className="flex items-baseline justify-between gap-6">
				<span className="text-3xl font-medium tracking-tight md:text-4xl">
					{pool.title}
				</span>
				<span
					className={`text-6xl font-bold tabular-nums md:text-8xl ${TONE_TEXT[tone]}`}
				>
					{pct === null ? "--" : `${Math.round(pct)}%`}
				</span>
			</div>

			<div className="h-5 w-full overflow-hidden rounded-full bg-muted md:h-6">
				<div
					className={`h-full rounded-full transition-all duration-500 ${TONE_BAR[tone]}`}
					style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }}
				/>
			</div>

			<div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-1 text-xl text-muted-foreground md:text-2xl">
				<span>
					{worst
						? `Highest ${worst.name} ${Math.round(worst.pct)}%`
						: "No account contributing"}
				</span>
				{reset ? <span>Resets {reset}</span> : null}
			</div>
		</div>
	);
}

/**
 * Fullscreen ambient display for the overview's pool capacity section.
 *
 * Reached at /kiosk, rendered outside the navigation shell so there is no
 * sidebar, header or chrome competing with the numbers. Everything here is
 * sized to be read from across a room rather than from a desk.
 *
 * Two things make this work as a display left running for days:
 *
 *  1. useAccounts is asked for backgroundRefresh, so React Query keeps polling
 *     while the tab is hidden. An unfocused tab is the NORMAL state for a
 *     kiosk, and it is exactly the state polling stops in by default.
 *  2. The interval stays whatever useAccounts already uses (60s). A display
 *     left up for days multiplies whatever interval is chosen, so this polls
 *     no harder than the dashboard section it mirrors.
 *
 * It reads the same /api/accounts data the pool capacity section does, and
 * deliberately touches neither /api/health nor /api/version: both proxy to
 * real accounts and answer 503 on a healthy install, which would paint a
 * permanent red state here.
 */
export function KioskTab() {
	const { data: accounts, isLoading } = useAccounts({
		backgroundRefresh: true,
	});

	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		return registerUIRefresh({
			id: "kiosk-clock",
			callback: () => setNow(Date.now()),
			seconds: 30,
			description: "Kiosk relative-time refresh",
		});
	}, []);

	const pools: KioskPool[] = useMemo(() => {
		const list = accounts ?? [];
		return [
			{
				id: "five_hour",
				title: "5h Pool",
				result: computePoolUsage(list, "five_hour", now),
			},
			{
				id: "seven_day",
				title: "7d Pool",
				result: computePoolUsage(list, "seven_day", now),
			},
			...computeScopedPoolUsage(list, now).map(({ family, result }) => ({
				id: `scoped:${family}`,
				title: `${formatFamilyLabel(family)} pool`,
				result,
			})),
		];
	}, [accounts, now]);

	return (
		<div className="min-h-screen bg-background px-8 py-8 text-foreground md:px-16 md:py-12">
			<div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-6xl flex-col">
				<div className="mb-4 flex items-baseline justify-between gap-6">
					<h1 className="text-4xl font-bold tracking-tight md:text-5xl">
						Pool capacity
					</h1>
					<span className="text-2xl tabular-nums text-muted-foreground md:text-3xl">
						{format(now, "HH:mm")}
					</span>
				</div>

				{isLoading && pools.length === 0 ? (
					<p className="text-3xl text-muted-foreground">Loading…</p>
				) : (
					<div className="flex-1">
						{pools.map((pool) => (
							<KioskPoolRow key={pool.id} pool={pool} now={now} />
						))}
					</div>
				)}
			</div>
		</div>
	);
}
