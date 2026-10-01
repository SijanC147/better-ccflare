import { ArrowLeftRight } from "lucide-react";
import { inboundLabel, inboundPath } from "../lib/inbound";
import { Badge } from "./ui/badge";

/**
 * Marks a history row that arrived on an OpenAI-shaped API and was translated
 * into `/v1/messages` (SB23-2727), naming the gateway when there was one.
 * Renders nothing for Claude Code traffic.
 */
export function InboundBadge({
	format,
	gateway,
	className = "text-xs",
}: {
	format?: string | null | undefined;
	gateway?: string | null | undefined;
	className?: string | undefined;
}) {
	const label = inboundLabel(format, gateway);
	if (label === null) return null;
	const path = inboundPath(format, gateway);
	const title = `Arrived on ${path}, translated to /v1/messages`;
	return (
		<Badge
			variant="outline"
			className={`${className} border-sky-500 text-sky-600 dark:text-sky-400`}
			title={title}
			aria-label={`${label}. ${title}`}
		>
			<ArrowLeftRight className="h-3 w-3 mr-1" aria-hidden="true" />
			{label}
		</Badge>
	);
}
