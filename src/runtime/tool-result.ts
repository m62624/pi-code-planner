/**
 * Common shape of a planner wrapper-tool execution result: an applied/blocked
 * status, the originating tool name, human-readable text, and an opaque
 * details payload. Each tool module aliases this with `Name` narrowed to its
 * own tool-name union (e.g. PlannerGitToolName).
 */
export interface PlannerToolResult<Name extends string> {
	status: "applied" | "blocked";
	toolName: Name;
	text: string;
	details: unknown;
}
