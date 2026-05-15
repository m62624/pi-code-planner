import type {
	ToolCallEvent,
	ToolCallEventResult,
	UserBashEvent,
	UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import type { GitCore } from "./core";
import { analyzeGitToolCall, type GitToolBlocked } from "./tool-call-guard";

function formatBlockedMessage(blocked: GitToolBlocked): string {
	return `${blocked.message}\n\nBlocked command: ${blocked.command}\nMatched pattern: ${blocked.pattern}`;
}

export function checkPlannerToolCall(
	core: GitCore,
	event: ToolCallEvent,
): ToolCallEventResult | undefined {
	const result = analyzeGitToolCall({
		activePlan: core.state.isActive(),
		toolName: event.toolName,
		input: event.input as Record<string, unknown>,
		settings: core.settings.settings.git,
	});

	if (!result.blocked) return undefined;

	return {
		block: true,
		reason: formatBlockedMessage(result),
	};
}

export function checkPlannerUserBash(
	core: GitCore,
	event: UserBashEvent,
): UserBashEventResult | undefined {
	const result = analyzeGitToolCall({
		activePlan: core.state.isActive(),
		toolName: "bash",
		input: { command: event.command },
		settings: core.settings.settings.git,
	});

	if (!result.blocked) return undefined;

	return {
		result: {
			output: formatBlockedMessage(result),
			exitCode: 1,
			cancelled: false,
			truncated: false,
		},
	};
}
