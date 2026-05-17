import { useEffect, useState } from "react";
import {
	useAdminRestart,
	usePostgresConfig,
	useSetPostgresConfig,
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
import { Switch } from "../ui/switch";

type SslMode = "disable" | "require" | "verify-ca" | "verify-full";

const SSL_MODES: SslMode[] = ["disable", "require", "verify-ca", "verify-full"];

export function PostgresConfigCard() {
	const { data, isLoading } = usePostgresConfig();
	const setPostgresConfig = useSetPostgresConfig();
	const adminRestart = useAdminRestart();

	const [enabled, setEnabled] = useState(false);
	const [host, setHost] = useState("localhost");
	const [port, setPort] = useState(5432);
	const [database, setDatabase] = useState("better_ccflare");
	const [user, setUser] = useState("postgres");
	const [password, setPassword] = useState("");
	const [sslMode, setSslMode] = useState<SslMode>("disable");
	const [restartPhase, setRestartPhase] = useState<
		"idle" | "restarting" | "polling" | "done" | "error"
	>("idle");
	const [restartError, setRestartError] = useState<string | null>(null);

	useEffect(() => {
		if (!data) return;
		setEnabled(data.enabled);
		setHost(data.host);
		setPort(data.port);
		setDatabase(data.database);
		setUser(data.user);
		setSslMode(data.sslMode);
		// Don't pre-fill password — server never returns it
	}, [data]);

	const isBusy =
		isLoading ||
		setPostgresConfig.isPending ||
		restartPhase === "restarting" ||
		restartPhase === "polling";

	const portValid = Number.isFinite(port) && port >= 1 && port <= 65535;

	async function pollHealth(timeoutMs = 30_000): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 1_000));
			try {
				const res = await fetch("/health");
				if (res.ok) return true;
			} catch {
				// server not yet up — keep polling
			}
		}
		return false;
	}

	async function handleSave() {
		setRestartPhase("idle");
		setRestartError(null);

		const body: Parameters<typeof setPostgresConfig.mutate>[0] = {
			enabled,
			host,
			port,
			database,
			user,
			sslMode,
		};
		if (password.length > 0) body.password = password;

		setPostgresConfig.mutate(body, {
			onSuccess: async () => {
				// Prompt user that server will restart
				setRestartPhase("restarting");
				try {
					await adminRestart.mutateAsync();
				} catch {
					// 202 still triggers network error in some fetch impls — that's fine
				}
				setRestartPhase("polling");
				const recovered = await pollHealth(30_000);
				if (recovered) {
					setRestartPhase("done");
					// Give the user a moment to read the message, then reload
					setTimeout(() => {
						window.location.reload();
					}, 1_500);
				} else {
					setRestartPhase("error");
					setRestartError(
						"Server did not respond within 30 s — check your supervisor logs.",
					);
				}
			},
			onError: (err) => {
				setRestartPhase("idle");
				setRestartError(err instanceof Error ? err.message : String(err));
			},
		});
	}

	return (
		<Card className="card-hover">
			<CardHeader>
				<CardTitle>PostgreSQL Backend</CardTitle>
				<CardDescription>
					Switch the database backend from SQLite to PostgreSQL. A server
					restart is required for changes to take effect.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{/* Enabled toggle */}
				<div className="flex items-center justify-between">
					<div>
						<p className="text-sm font-medium">Enable PostgreSQL</p>
						<p className="text-xs text-muted-foreground">
							When enabled, the server will connect to the configured PostgreSQL
							instance instead of the local SQLite database.
						</p>
					</div>
					<Switch
						checked={enabled}
						disabled={isBusy}
						onCheckedChange={setEnabled}
					/>
				</div>

				<div className="grid grid-cols-2 gap-3">
					{/* Host */}
					<div className="space-y-1">
						<label className="text-sm font-medium" htmlFor="pg-host">
							Host
						</label>
						<Input
							id="pg-host"
							value={host}
							disabled={isBusy}
							onChange={(e) => setHost(e.target.value)}
							placeholder="localhost"
						/>
					</div>

					{/* Port */}
					<div className="space-y-1">
						<label className="text-sm font-medium" htmlFor="pg-port">
							Port
						</label>
						<Input
							id="pg-port"
							type="number"
							min={1}
							max={65535}
							value={port}
							disabled={isBusy}
							onChange={(e) => setPort(parseInt(e.target.value || "5432", 10))}
						/>
					</div>

					{/* Database */}
					<div className="space-y-1">
						<label className="text-sm font-medium" htmlFor="pg-database">
							Database
						</label>
						<Input
							id="pg-database"
							value={database}
							disabled={isBusy}
							onChange={(e) => setDatabase(e.target.value)}
							placeholder="better_ccflare"
						/>
					</div>

					{/* User */}
					<div className="space-y-1">
						<label className="text-sm font-medium" htmlFor="pg-user">
							User
						</label>
						<Input
							id="pg-user"
							value={user}
							disabled={isBusy}
							onChange={(e) => setUser(e.target.value)}
							placeholder="postgres"
						/>
					</div>

					{/* Password */}
					<div className="space-y-1">
						<label className="text-sm font-medium" htmlFor="pg-password">
							Password
						</label>
						<Input
							id="pg-password"
							type="password"
							value={password}
							disabled={isBusy}
							onChange={(e) => setPassword(e.target.value)}
							placeholder={
								data?.passwordSet ? "••••••• (stored)" : "leave blank if none"
							}
						/>
					</div>

					{/* SSL Mode */}
					<div className="space-y-1">
						<label className="text-sm font-medium" htmlFor="pg-ssl">
							SSL Mode
						</label>
						<select
							id="pg-ssl"
							value={sslMode}
							disabled={isBusy}
							onChange={(e) => setSslMode(e.target.value as SslMode)}
							className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
						>
							{SSL_MODES.map((m) => (
								<option key={m} value={m}>
									{m}
								</option>
							))}
						</select>
					</div>
				</div>

				<div className="pt-1">
					<Button
						size="sm"
						disabled={isBusy || !portValid}
						onClick={handleSave}
					>
						{restartPhase === "restarting"
							? "Restarting…"
							: restartPhase === "polling"
								? "Waiting for server…"
								: restartPhase === "done"
									? "Reloading…"
									: setPostgresConfig.isPending
										? "Saving…"
										: "Save & Restart"}
					</Button>
				</div>

				{restartPhase === "restarting" || restartPhase === "polling" ? (
					<p className="text-xs text-muted-foreground">
						Server will restart — waiting for it to come back online…
					</p>
				) : null}

				{restartPhase === "done" && (
					<p className="text-xs text-green-600">
						Server restarted successfully. Reloading page…
					</p>
				)}

				{(restartError || setPostgresConfig.isError) && (
					<p className="text-xs text-destructive">
						{restartError ||
							(setPostgresConfig.error instanceof Error
								? setPostgresConfig.error.message
								: "An error occurred. Check server logs.")}
					</p>
				)}
			</CardContent>
		</Card>
	);
}
