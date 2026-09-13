import {
	Activity,
	BarChart3,
	Bot,
	FileText,
	FolderOpen,
	History,
	Key,
	LayoutDashboard,
	Lightbulb,
	LogOut,
	Menu,
	PanelLeftClose,
	PanelLeftOpen,
	Settings,
	Shield,
	Users,
	X,
	Zap,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAlerts } from "../hooks/queries";
import { cn } from "../lib/utils";
import { ThemeToggle } from "./theme-toggle";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import { VersionFooterLine, VersionStatusCards } from "./version-status";

interface NavItem {
	label: string;
	icon: React.ComponentType<{ className?: string }>;
	path: string;
	badge?: string;
}

const _navItems: NavItem[] = [
	{ label: "Overview", icon: LayoutDashboard, path: "/" },
	{ label: "Analytics", icon: BarChart3, path: "/analytics" },
	{ label: "Insights", icon: Lightbulb, path: "/insights" },
	{ label: "Requests", icon: Activity, path: "/requests" },
	{ label: "Accounts", icon: Users, path: "/accounts" },
	{ label: "Combos", icon: Zap, path: "/combos" },
	{ label: "Agents", icon: Bot, path: "/agents" },
	{ label: "API Keys", icon: Key, path: "/api-keys" },
	{ label: "Logs", icon: FileText, path: "/logs" },
	{ label: "Settings", icon: Settings, path: "/settings" },
];

interface NavigationProps {
	onLogout?: () => void;
	isCollapsed?: boolean;
	onToggleCollapse?: () => void;
}

export function Navigation({
	onLogout,
	isCollapsed = false,
	onToggleCollapse,
}: NavigationProps = {}) {
	const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
	const { data: alertData } = useAlerts();
	const unacknowledgedCount = alertData?.unacknowledgedCount ?? 0;
	const location = useLocation();

	// Build nav items with the current alert badge
	const navItems: NavItem[] = useMemo(() => {
		const baseItems: NavItem[] = [
			{ label: "Overview", icon: LayoutDashboard, path: "/" },
			{ label: "Analytics", icon: BarChart3, path: "/analytics" },
			{
				label: "Insights",
				icon: Lightbulb,
				path: "/insights",
				badge:
					unacknowledgedCount > 0 ? String(unacknowledgedCount) : undefined,
			},
			{ label: "Requests", icon: Activity, path: "/requests" },
			{ label: "Accounts", icon: Users, path: "/accounts" },
			{ label: "Projects", icon: FolderOpen, path: "/projects" },
			{ label: "Usage History", icon: History, path: "/usage-history" },
		];

		baseItems.push({ label: "Combos", icon: Zap, path: "/combos" });

		// Add remaining items
		baseItems.push(
			{ label: "Agents", icon: Bot, path: "/agents" },
			{ label: "API Keys", icon: Key, path: "/api-keys" },
			{ label: "Logs", icon: FileText, path: "/logs" },
			{ label: "Settings", icon: Settings, path: "/settings" },
		);

		return baseItems;
	}, [unacknowledgedCount]);

	return (
		<>
			{/* Mobile header */}
			<div className="lg:hidden fixed top-0 left-0 right-0 z-50 h-16 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-b px-4 flex items-center justify-between">
				<div className="flex items-center gap-3">
					<Shield className="h-6 w-6 text-primary" />
					<span className="font-semibold text-lg">better-ccflare</span>
				</div>
				<div className="flex items-center gap-2">
					<ThemeToggle />
					<Button
						variant="ghost"
						size="sm"
						onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
					>
						{isMobileMenuOpen ? (
							<X className="h-5 w-5" />
						) : (
							<Menu className="h-5 w-5" />
						)}
					</Button>
				</div>
			</div>

			{/* Mobile menu overlay */}
			{isMobileMenuOpen && (
				<button
					type="button"
					className="lg:hidden fixed inset-0 z-40 bg-background/80 backdrop-blur-sm cursor-default"
					onClick={() => setIsMobileMenuOpen(false)}
					aria-label="Close menu"
				/>
			)}

			{/* Sidebar */}
			<aside
				className={cn(
					"fixed left-0 top-0 z-40 h-screen bg-card border-r transition-all duration-300 lg:translate-x-0",
					isCollapsed ? "w-16" : "w-64",
					isMobileMenuOpen
						? "translate-x-0"
						: "-translate-x-full lg:translate-x-0",
				)}
			>
				<div className="flex h-full flex-col relative">
					{/* Logo */}
					<div className="p-6 pb-4">
						<div className="flex items-center gap-3">
							<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
								<Shield className="h-6 w-6 text-primary" />
							</div>
							{!isCollapsed && (
								<div>
									<h1 className="font-semibold text-lg">better-ccflare</h1>
									<p className="text-xs text-muted-foreground">
										Powerful proxy for Claude Code
									</p>
								</div>
							)}
						</div>
					</div>

					{/* Collapse Toggle Button */}
					<div className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 z-50">
						<button
							type="button"
							onClick={onToggleCollapse}
							className="h-6 w-6 rounded-full bg-background border shadow-sm flex items-center justify-center hover:bg-muted transition-colors"
							aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
						>
							{isCollapsed ? (
								<PanelLeftOpen className="h-4 w-4" />
							) : (
								<PanelLeftClose className="h-4 w-4" />
							)}
						</button>
					</div>

					<Separator />

					{/* Navigation */}
					<nav className="flex-1 space-y-1 p-4">
						{navItems.map((item) => {
							const Icon = item.icon;
							const isActive = location.pathname === item.path;
							return (
								<Link
									key={item.path}
									to={item.path}
									onClick={() => setIsMobileMenuOpen(false)}
								>
									<Button
										variant={isActive ? "secondary" : "ghost"}
										className={cn(
											"w-full transition-all",
											isCollapsed ? "justify-center" : "justify-start gap-3",
											isActive &&
												"bg-primary/10 text-primary hover:bg-primary/20",
										)}
										title={isCollapsed ? item.label : undefined}
									>
										<Icon className="h-4 w-4" />
										{!isCollapsed && (
											<>
												{item.label}
												{item.badge && (
													<span className="ml-auto rounded-full bg-primary/20 px-2 py-0.5 text-xs font-medium">
														{item.badge}
													</span>
												)}
											</>
										)}
									</Button>
								</Link>
							);
						})}
						{onLogout && (
							<Button
								variant="ghost"
								className={cn(
									"w-full transition-all text-muted-foreground hover:text-destructive",
									isCollapsed ? "justify-center" : "justify-start gap-3",
								)}
								onClick={() => {
									setIsMobileMenuOpen(false);
									onLogout();
								}}
								title={isCollapsed ? "Log Out" : undefined}
							>
								<LogOut className="h-4 w-4" />
								{!isCollapsed && "Log Out"}
							</Button>
						)}
					</nav>

					<Separator />

					{/* Footer */}
					{!isCollapsed && (
						<div className="p-4 space-y-4">
							<div className="rounded-lg bg-muted/50 p-3">
								<div className="flex items-center gap-2 text-sm">
									<Zap className="h-4 w-4 text-primary" />
									<span className="font-medium">Status</span>
								</div>
								<p className="mt-1 text-xs text-muted-foreground">
									All systems operational
								</p>
							</div>

							{/* Fork release + upstream sync status */}
							<VersionStatusCards />

							{/* The identity line shows at every width: the sidebar is a
							    fixed 256px drawer on mobile, so it has the same room
							    there. The theme toggle stays desktop-only because the
							    mobile header already carries one. */}
							<div className="flex items-center justify-between gap-2">
								<VersionFooterLine />
								<div className="hidden lg:block">
									<ThemeToggle />
								</div>
							</div>
						</div>
					)}

					{/* Collapsed Footer - Theme Toggle Only */}
					{isCollapsed && (
						<div className="p-4 flex justify-center">
							<ThemeToggle />
						</div>
					)}
				</div>
			</aside>
		</>
	);
}
