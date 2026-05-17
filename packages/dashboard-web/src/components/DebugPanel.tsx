import { useEffect, useRef, useState } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

interface DebugLog {
	id: string;
	timestamp: string;
	level: "info" | "warn" | "error" | "debug";
	message: string;
	details?: unknown;
}

const STORAGE_KEY = "bcf:debug:size";
const DEFAULT_SIZE = { w: "95vw", h: "384px" };
const MIN_W = 280;
const MIN_H = 180;

function loadSize(): { w: string; h: string } {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as { w: string; h: string };
			if (parsed.w && parsed.h) return parsed;
		}
	} catch {
		// ignore
	}
	return DEFAULT_SIZE;
}

export function DebugPanel() {
	const [logs, setLogs] = useState<DebugLog[]>([]);
	const [isVisible, setIsVisible] = useState(false);
	const [size, setSize] = useState<{ w: string; h: string }>(loadSize);
	const cardRef = useRef<HTMLDivElement>(null);

	// Persist size whenever it changes
	useEffect(() => {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(size));
		} catch {
			// ignore
		}
	}, [size]);

	// Observe resize events on the card element so state stays in sync
	useEffect(() => {
		const el = cardRef.current;
		if (!el) return;

		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const { width, height } = entry.contentRect;
				if (width > 0 && height > 0) {
					setSize({
						w: `${Math.round(width)}px`,
						h: `${Math.round(height)}px`,
					});
				}
			}
		});

		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		if (!isVisible) return;

		const originalConsole = { ...console };

		// Override console methods to capture logs
		const logLevels: Array<"info" | "warn" | "error" | "debug"> = [
			"info",
			"warn",
			"error",
			"debug",
		];

		logLevels.forEach((level) => {
			const originalMethod = console[level] as (...args: unknown[]) => void;
			console[level] = (...args: unknown[]) => {
				const logEntry: DebugLog = {
					id: Math.random().toString(36).substr(2, 9),
					timestamp: new Date().toISOString(),
					level,
					message: args.join(" "),
					details: args.length > 1 ? args : undefined,
				};
				setLogs((prev) => [logEntry, ...prev.slice(0, 99)]); // Keep last 100 logs
				if (originalMethod) {
					originalMethod(...args);
				}
			};
		});

		return () => {
			Object.assign(console, originalConsole);
		};
	}, [isVisible]);

	if (!isVisible) {
		return (
			<Button
				onClick={() => setIsVisible(true)}
				className="fixed bottom-4 right-4 z-50"
				size="sm"
			>
				🐛 Debug
			</Button>
		);
	}

	const getLogColor = (level: string) => {
		switch (level) {
			case "error":
				return "text-destructive";
			case "warn":
				return "text-yellow-600";
			case "info":
				return "text-blue-600";
			case "debug":
				return "text-muted-foreground";
			default:
				return "";
		}
	};

	return (
		<Card
			ref={cardRef}
			className="fixed bottom-4 right-4 z-50 overflow-auto"
			style={{
				width: size.w,
				height: size.h,
				minWidth: `${MIN_W}px`,
				minHeight: `${MIN_H}px`,
				maxWidth: "98vw",
				maxHeight: "90vh",
				resize: "both",
			}}
		>
			<CardHeader className="pb-2">
				<div className="flex items-center justify-between">
					<CardTitle className="text-sm">Debug Panel</CardTitle>
					<Button onClick={() => setIsVisible(false)} variant="ghost" size="sm">
						✕
					</Button>
				</div>
			</CardHeader>
			<CardContent className="pt-0 h-[calc(100%-3.5rem)] overflow-auto">
				<div className="space-y-1 h-full overflow-y-auto text-xs font-mono">
					{logs.length === 0 ? (
						<p className="text-muted-foreground">No logs yet...</p>
					) : (
						logs.map((log) => (
							<div key={log.id} className="flex gap-2">
								<span className="text-muted-foreground">
									{new Date(log.timestamp).toLocaleTimeString()}
								</span>
								<Badge
									variant="outline"
									className={`text-xs ${getLogColor(log.level)}`}
								>
									{log.level}
								</Badge>
								<span className="flex-1 break-all">{log.message}</span>
							</div>
						))
					)}
				</div>
			</CardContent>
		</Card>
	);
}
