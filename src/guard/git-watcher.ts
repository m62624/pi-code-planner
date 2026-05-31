export const PLANNER_STATUS_TOOL_NAME = "planner_status";

export interface GitWatcherState {
	activePlanId: string | null;
	active: boolean;
}

export interface GitWatcherDecision {
	allow: boolean;
	reason: string | null;
}

export function analyzeRawGitCommand(command: string): boolean {
	return splitShellLikeSegments(command).some((segment) =>
		segmentStartsWithGit(segment),
	);
}

export function checkRawGitAllowed(input: {
	command: string;
	state: GitWatcherState;
}): GitWatcherDecision {
	if (!input.state.active) {
		return { allow: true, reason: null };
	}

	if (!analyzeRawGitCommand(input.command)) {
		return { allow: true, reason: null };
	}

	return {
		allow: false,
		reason: buildRawGitBlockedReason(input.state.activePlanId, input.command),
	};
}

export function buildRawGitBlockedReason(
	planId: string | null,
	command: string,
): string {
	const planLine = planId
		? `Active planner plan: ${planId}`
		: "A planner plan is active.";
	return [
		"Raw git is blocked while pi-code-planner is active.",
		planLine,
		"",
		"The git command was not executed:",
		command,
		"",
		"Use planner git wrapper tools instead of shell git.",
		`If you are unsure what is allowed now, call ${PLANNER_STATUS_TOOL_NAME}.`,
		"The status tool will point you to the current stage markdown and list the allowed planner tools.",
	].join("\n");
}

function splitShellLikeSegments(command: string): string[] {
	return command
		.split(/&&|\|\||[;|()]/g)
		.map((segment) => segment.trim())
		.filter(Boolean);
}

function segmentStartsWithGit(segment: string): boolean {
	const tokens = segment.match(/[^\s]+/g) ?? [];
	stripCommandPrefixes(tokens);
	const executable = tokens[0]?.split("/").at(-1);
	if (executable === "git") {
		return true;
	}
	return (
		executable !== undefined &&
		["bash", "eval", "fish", "find", "sh", "xargs", "zsh"].includes(
			executable,
		) &&
		tokens.slice(1).some(isGitToken)
	);
}

function stripCommandPrefixes(tokens: string[]): void {
	let changed = true;
	while (changed) {
		changed = false;
		while (tokens[0] && /^[A-Za-z_][A-Za-z0-9_]*=\S+$/.test(tokens[0])) {
			tokens.shift();
			changed = true;
		}
		if (tokens[0] === "command") {
			tokens.shift();
			changed = true;
		}
		if (tokens[0] === "env" || tokens[0] === "sudo") {
			tokens.shift();
			while (
				tokens[0] &&
				(tokens[0].startsWith("-") ||
					/^[A-Za-z_][A-Za-z0-9_]*=\S+$/.test(tokens[0]))
			) {
				tokens.shift();
			}
			changed = true;
		}
	}
}

function isGitToken(token: string): boolean {
	const normalized = token.replace(/^[`"'([{]+|[`"',;)\]}]+$/g, "");
	return normalized === "git" || normalized.endsWith("/git");
}
