import {
	Activity,
	AlertTriangle,
	Bell,
	BellOff,
	CloudOff,
	Gauge,
	Send,
	UserX,
} from "lucide-react";
import { useState } from "react";
import { useNotifications } from "../contexts/notifications-context";
import {
	NOTIFICATION_CATALOGUE,
	NOTIFICATION_CATEGORIES,
	type NotificationCategory,
	type NotificationPermissionState,
} from "../lib/notifications";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";
import { Switch } from "./ui/switch";

const CATEGORY_ICONS: Record<
	NotificationCategory,
	React.ComponentType<{ className?: string }>
> = {
	serviceOutage: CloudOff,
	rateLimit: Gauge,
	accountHealth: UserX,
	errorBurst: Activity,
};

/** Why the browser cannot notify, or null when it can be asked or already has. */
export function permissionProblem(
	permission: NotificationPermissionState,
): string | null {
	switch (permission) {
		case "unsupported":
			return "This browser does not support desktop notifications.";
		case "insecure":
			return "Browsers only allow notifications on HTTPS or localhost. Open the dashboard over HTTPS, or from this machine at localhost, to turn them on.";
		case "denied":
			return "Notifications are blocked for this site. Allow them in the browser's site settings, then reload this page.";
		default:
			return null;
	}
}

const PERMISSION_LABEL: Record<NotificationPermissionState, string> = {
	unsupported: "Unsupported",
	insecure: "Needs HTTPS",
	default: "Not yet allowed",
	granted: "Allowed",
	denied: "Blocked",
};

export function NotificationsTab() {
	const { prefs, permission, active, enable, disable, setCategory, notify } =
		useNotifications();
	const [requesting, setRequesting] = useState(false);
	const [testResult, setTestResult] = useState<string | null>(null);
	const problem = permissionProblem(permission);
	const blocked = problem !== null;

	const handleEnable = async () => {
		setRequesting(true);
		try {
			await enable();
		} finally {
			setRequesting(false);
		}
	};

	const handleTest = () => {
		const shown = notify({
			title: "better-ccflare test notification",
			body: "Notifications from this dashboard will look like this.",
			tag: "better-ccflare:test",
		});
		setTestResult(
			shown
				? "Sent. If nothing appeared, check the operating system's notification settings for this browser."
				: "The browser did not accept the notification.",
		);
	};

	return (
		<div className="space-y-6">
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						{active ? (
							<Bell className="h-5 w-5 text-primary" />
						) : (
							<BellOff className="h-5 w-5 text-muted-foreground" />
						)}
						Browser notifications
					</CardTitle>
					<CardDescription>
						Desktop notifications while this dashboard is open in a tab, even a
						background one. Nothing is sent when the tab is closed. Only changes
						seen while a tab is watching are notified: reloading sends nothing,
						and opening the page after it was closed starts from what it reads
						then rather than catching up on what changed meanwhile.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="flex flex-wrap items-center gap-3">
						<span className="text-sm text-muted-foreground">
							Browser permission
						</span>
						<Badge
							variant={permission === "granted" ? "default" : "secondary"}
							data-testid="notification-permission"
						>
							{PERMISSION_LABEL[permission]}
						</Badge>
						<span className="text-sm text-muted-foreground">Status</span>
						<Badge
							variant={active ? "default" : "secondary"}
							data-testid="notification-status"
						>
							{active ? "On" : "Off"}
						</Badge>
					</div>
					{problem ? (
						<div
							role="status"
							className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm"
						>
							<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" />
							<p>{problem}</p>
						</div>
					) : null}
					<div className="flex flex-wrap gap-2">
						{active ? (
							<Button variant="outline" onClick={disable}>
								<BellOff className="mr-2 h-4 w-4" />
								Turn off notifications
							</Button>
						) : (
							<Button
								onClick={handleEnable}
								disabled={blocked || requesting}
								aria-disabled={blocked || requesting}
							>
								<Bell className="mr-2 h-4 w-4" />
								{permission === "granted"
									? "Turn on notifications"
									: "Enable notifications"}
							</Button>
						)}
						<Button
							variant="outline"
							onClick={handleTest}
							disabled={permission !== "granted"}
						>
							<Send className="mr-2 h-4 w-4" />
							Send test notification
						</Button>
					</div>
					{testResult ? (
						<p className="text-sm text-muted-foreground">{testResult}</p>
					) : null}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Notification types</CardTitle>
					<CardDescription>
						Each type can be switched off on its own. Choices are kept in this
						browser.
					</CardDescription>
				</CardHeader>
				<CardContent className="grid gap-4 lg:grid-cols-2">
					{NOTIFICATION_CATEGORIES.map((id) => {
						const info = NOTIFICATION_CATALOGUE[id];
						const Icon = CATEGORY_ICONS[id];
						const switchId = `notification-category-${id}`;
						return (
							<div
								key={id}
								className="flex items-start justify-between gap-4 rounded-lg border p-4"
							>
								<div className="flex items-start gap-3">
									<Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
									<div className="space-y-1">
										<label htmlFor={switchId} className="font-medium">
											{info.label}
										</label>
										<p className="text-sm text-muted-foreground">
											{info.description}
										</p>
										<p className="text-xs text-muted-foreground">
											Source: {info.source}
										</p>
									</div>
								</div>
								<Switch
									id={switchId}
									checked={prefs.categories[id]}
									disabled={blocked}
									onCheckedChange={(on) => setCategory(id, on)}
									aria-label={`${info.label} notifications`}
								/>
							</div>
						);
					})}
				</CardContent>
			</Card>
		</div>
	);
}
