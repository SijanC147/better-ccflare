import { useRequestStorage, useSetRequestStorage } from "../../hooks/queries";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Switch } from "../ui/switch";

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
							When enabled, request/response bodies are excluded from the log.
							Headers are always stored.
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

				{setRequestStorage.isError && (
					<p className="text-xs text-destructive">
						Failed to update setting — check server logs.
					</p>
				)}
			</CardContent>
		</Card>
	);
}
