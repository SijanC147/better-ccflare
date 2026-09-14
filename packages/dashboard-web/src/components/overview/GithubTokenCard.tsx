import { useState } from "react";
import { useGithubTokenConfig, useSetGithubToken } from "../../hooks/queries";
import { Button } from "../ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Input } from "../ui/input";

export function GithubTokenCard() {
	const { data, isLoading } = useGithubTokenConfig();
	const setToken = useSetGithubToken();
	const [value, setValue] = useState("");

	const busy = isLoading || setToken.isPending;
	// The environment wins over the stored value, so saving here would look like
	// a no-op. Say so rather than letting the operator wonder.
	const overridden = data?.tokenFromEnvironment ?? false;

	return (
		<Card className="card-hover">
			<CardHeader>
				<CardTitle>GitHub token</CardTitle>
				<CardDescription>
					Raises the rate limit for the version and upstream checks in the
					sidebar. Unauthenticated, GitHub allows 60 requests an hour per IP,
					shared with every other tool on this machine; with a token it is
					5,000. The token needs no scopes: it only reads public releases and
					commits.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				<div className="flex items-center justify-between">
					<p className="text-sm font-medium">
						{data?.tokenSet ? "Token configured" : "No token configured"}
					</p>
					{overridden && (
						<p className="text-xs text-muted-foreground">
							overridden by environment
						</p>
					)}
				</div>

				<div className="flex gap-2">
					<Input
						type="password"
						autoComplete="off"
						placeholder={data?.tokenSet ? "Replace token" : "ghp_..."}
						value={value}
						disabled={busy}
						onChange={(e) => setValue(e.target.value)}
					/>
					<Button
						disabled={busy || value.trim().length === 0}
						onClick={() => {
							setToken.mutate(value, { onSuccess: () => setValue("") });
						}}
					>
						Save
					</Button>
				</div>

				{data?.tokenSet && (
					<Button
						variant="outline"
						size="sm"
						disabled={busy}
						onClick={() => setToken.mutate("")}
					>
						Clear stored token
					</Button>
				)}

				{overridden && (
					<p className="text-xs text-muted-foreground">
						BETTER_CCFLARE_GITHUB_TOKEN is set in the server environment and
						takes precedence. A token saved here is stored but not used until
						that variable is removed.
					</p>
				)}

				{setToken.isError && (
					<p className="text-xs text-destructive">
						Failed to save the token — check server logs.
					</p>
				)}
			</CardContent>
		</Card>
	);
}
