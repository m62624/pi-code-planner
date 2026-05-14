import type { GitSettings } from "../settings/schema";

export type GitToolBlockKind = "direct_commit" | "dangerous_git_operation";

export interface GitToolGuardInput {
	activePlan: boolean;
	toolName: string;
	input: Record<string, unknown>;
	settings: GitSettings;
}

export interface GitToolAllowed {
	blocked: false;
}

export interface GitToolBlocked {
	blocked: true;
	kind: GitToolBlockKind;
	message: string;
	pattern: string;
	command: string;
}

export type GitToolGuardResult = GitToolAllowed | GitToolBlocked;

export function isShellToolCall(
	toolName: string,
	settings: Pick<GitSettings, "shellToolNames">,
): boolean {
	return settings.shellToolNames.includes(toolName);
}

function getCommand(input: Record<string, unknown>): string | null {
	const command = input.command;
	return typeof command === "string" ? command : null;
}

function findMatchingPattern(
	command: string,
	patterns: string[],
): string | null {
	for (const pattern of patterns) {
		if (new RegExp(pattern).test(command)) {
			return pattern;
		}
	}
	return null;
}

export function analyzeGitToolCall({
	activePlan,
	toolName,
	input,
	settings,
}: GitToolGuardInput): GitToolGuardResult {
	if (!activePlan) return { blocked: false };
	if (!isShellToolCall(toolName, settings)) return { blocked: false };

	const command = getCommand(input);
	if (!command) return { blocked: false };

	const commitPattern = findMatchingPattern(
		command,
		settings.blockedCommitPatterns,
	);
	if (commitPattern) {
		return {
			blocked: true,
			kind: "direct_commit",
			message:
				"Direct git commit is forbidden while a planner plan is active. Verify the work item, then call planner.finish_step so the planner can commit, update state, and compact safely.",
			pattern: commitPattern,
			command,
		};
	}

	const dangerousPattern = findMatchingPattern(
		command,
		settings.blockedDangerousPatterns,
	);
	if (dangerousPattern) {
		return {
			blocked: true,
			kind: "dangerous_git_operation",
			message:
				"This git operation is managed by planner recovery or branch tools while a planner plan is active. Use the appropriate planner tool instead.",
			pattern: dangerousPattern,
			command,
		};
	}

	return { blocked: false };
}
