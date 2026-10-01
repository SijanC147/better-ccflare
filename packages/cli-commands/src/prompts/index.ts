import { stdPromptAdapter } from "./std-adapter";

// Re-export adapter types
export type { PromptAdapter } from "./adapter";
export { StdPromptAdapter, stdPromptAdapter } from "./std-adapter";

/**
 * Prompt user to select account mode
 */
export async function promptAccountMode(): Promise<"claude-oauth" | "console"> {
	return stdPromptAdapter.select(
		"What type of account would you like to add?",
		[
			{ label: "Claude CLI OAuth account", value: "claude-oauth" },
			{ label: "Claude Console account", value: "console" },
		],
	);
}

/**
 * Prompt user to enter authorization code
 */
export async function promptAuthorizationCode(): Promise<string> {
	return stdPromptAdapter.input("\nEnter the authorization code: ");
}
