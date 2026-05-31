import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ProjectStoragePaths } from "../storage/paths";
import type { PlannerStage, PlanStateRecord } from "../storage/schema";
import {
	checkRawGitAllowed,
	type GitWatcherDecision,
	type GitWatcherState,
	PLANNER_STATUS_TOOL_NAME,
} from "./git-watcher";

export type PlannerBuiltinToolCall =
	| { toolName: "write" | "edit"; path: string }
	| { toolName: "bash"; command: string };

export interface PlannerBuiltinGuardState extends GitWatcherState {
	projectPaths: Pick<ProjectStoragePaths, "projectRoot"> | null;
	planState: Pick<PlanStateRecord, "stage" | "step" | "worktreePath"> | null;
}

export interface PlannerBuiltinGuardInput {
	cwd: string;
	tool: PlannerBuiltinToolCall;
	state: PlannerBuiltinGuardState;
}

export interface PlannerBuiltinGuardDecision {
	allow: boolean;
	reason: string | null;
}

const PROJECT_WRITE_BLOCKED_STAGES = new Set<PlannerStage>([
	"init",
	"discovery",
	"planning",
]);

export function checkPlannerBuiltinToolAllowed(
	input: PlannerBuiltinGuardInput,
): PlannerBuiltinGuardDecision {
	if (!input.state.active) {
		return allow();
	}

	if (input.tool.toolName === "bash") {
		return checkRawGitAllowed({
			command: input.tool.command,
			state: input.state,
		});
	}

	if (input.state.planState === null) {
		return blockProjectWrite(input.state, input.tool.toolName);
	}

	if (
		PROJECT_WRITE_BLOCKED_STAGES.has(input.state.planState.stage) &&
		isProjectPath(input.cwd, input.tool.path, input.state)
	) {
		return blockProjectWrite(input.state, input.tool.toolName);
	}

	return allow();
}

function isProjectPath(
	cwd: string,
	path: string,
	state: PlannerBuiltinGuardState,
): boolean {
	const target = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
	return [
		state.projectPaths?.projectRoot ?? null,
		state.planState?.worktreePath ?? null,
	].some((root) => root !== null && isPathInside(root, target));
}

function isPathInside(root: string, target: string): boolean {
	const path = relative(resolve(root), target);
	return (
		path === "" ||
		(path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
	);
}

function blockProjectWrite(
	state: PlannerBuiltinGuardState,
	toolName: "write" | "edit",
): PlannerBuiltinGuardDecision {
	const position = state.planState
		? `${state.planState.stage}/${state.planState.step}`
		: "(planner state unavailable)";
	return {
		allow: false,
		reason: [
			`Built-in Pi ${toolName} cannot modify project files during ${position}.`,
			`Active planner plan: ${state.activePlanId ?? "(unknown)"}.`,
			"",
			"Project writes become available after discovery and planning are complete.",
			"Planner artifacts outside the project directory remain writable.",
			`Call ${PLANNER_STATUS_TOOL_NAME} and follow the current stage instruction.`,
		].join("\n"),
	};
}

function allow(): GitWatcherDecision {
	return { allow: true, reason: null };
}
