export type Role = "user" | "assistant" | "system";

export interface ToolUse {
	id?: string | undefined;
	name: string;
	input?: Record<string, unknown> | undefined;
}

export interface ToolResult {
	tool_use_id: string;
	content: string;
}

export enum ContentBlockType {
	Text = "text",
	ToolUse = "tool_use",
	ToolResult = "tool_result",
	Thinking = "thinking",
}

export interface ContentBlock {
	type: ContentBlockType;
	text?: string;
	thinking?: string | undefined;
	id?: string | undefined;
	name?: string | undefined;
	input?: Record<string, unknown> | undefined;
	tool_use_id?: string | undefined;
	content?: string | undefined;
}

export interface MessageData {
	role: Role;
	content: string;
	contentBlocks?: ContentBlock[];
	tools?: ToolUse[];
	toolResults?: ToolResult[];
}
