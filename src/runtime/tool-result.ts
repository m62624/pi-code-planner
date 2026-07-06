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

/**
 * Shared factories for the two wrapper-tool outcomes. Every `*-tools.ts` module
 * used to hand-roll its own `blocked`/`applied` returning this exact shape; the
 * factories replace those ~27 copies. `status` is a literal so a result narrows
 * to the specific outcome, and `Details` is generic so a module with a narrower
 * `details` type (e.g. an artifacts record instead of `unknown`) stays
 * assignable to its own result interface.
 */
export function blockedResult<Name extends string, Details = null>(
	toolName: Name,
	text: string,
	details: Details = null as Details,
): { status: "blocked"; toolName: Name; text: string; details: Details } {
	return { status: "blocked", toolName, text, details };
}

export function appliedResult<Name extends string, Details = null>(
	toolName: Name,
	text: string,
	details: Details = null as Details,
): { status: "applied"; toolName: Name; text: string; details: Details } {
	return { status: "applied", toolName, text, details };
}
