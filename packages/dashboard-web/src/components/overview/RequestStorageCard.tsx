import type { PayloadPersistence } from "@better-ccflare/types";
import { useRequestStorage, useSetRequestStorage } from "../../hooks/queries";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Switch } from "../ui/switch";

const PERSISTS_LABEL: Record<PayloadPersistence, string> = {
	full: "Headers, bodies and metadata are stored for each request.",
	headers: "Headers and metadata are stored for each request; bodies are not.",
	none: "No headers or bodies are stored. Payload storage and headers-only mode are both off.",
};

export function RequestStorageCard() {
	const { data, isLoading } = useRequestStorage();
	const setRequestStorage = useSetRequestStorage();

	const disabled = isLoading || setRequestStorage.isPending;

	return (
		<Card className="card-hover">
			<CardHeader>
				<CardTitle>Request Storage</CardTitle>
				<CardDescription>
					Control how much of each request and response is persisted in the log.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				<div className="flex items-center justify-between">
					<div>
						<p className="text-sm font-medium">Headers-only mode</p>
						<p className="text-xs text-muted-foreground">
							When enabled, each request keeps its headers and metadata and
							drops both bodies, whether or not payload storage is on.
							Credential headers are stored as [redacted].
						</p>
					</div>
					<Switch
						checked={data?.headersOnly ?? false}
						disabled={disabled}
						onCheckedChange={(checked) =>
							setRequestStorage.mutate({ headersOnly: checked })
						}
					/>
				</div>

				{data?.persists && (
					<p className="text-xs text-muted-foreground">
						{PERSISTS_LABEL[data.persists]}
					</p>
				)}

				{setRequestStorage.isError && (
					<p className="text-xs text-destructive">
						Failed to update setting — check server logs.
					</p>
				)}
			</CardContent>
		</Card>
	);
}
