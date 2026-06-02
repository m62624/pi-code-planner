import { isAbsolute, relative, resolve, sep } from "node:path";
import { getPlannerStageStepBehavior } from "../runtime/stage-behavior";
import type { PlanStoragePaths, ProjectStoragePaths } from "../storage/paths";
import type { PlanStateRecord } from "../storage/schema";
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
	planPaths?: Pick<PlanStoragePaths, "planDir" | "requestMd" | "goalMd"> | null;
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

	if (isProtectedPlannerArtifact(input.cwd, input.tool.path, input.state)) {
		return {
			allow: false,
			reason: [
				`Built-in Pi ${input.tool.toolName} cannot modify planner-managed intake files directly.`,
				"Use the exact planner wrapper reported by planner_status.",
				`Call ${PLANNER_STATUS_TOOL_NAME} before continuing.`,
			].join("\n"),
		};
	}

	if (isOriginalCheckoutPath(input.cwd, input.tool.path, input.state)) {
		return {
			allow: false,
			reason: [
				`Built-in Pi ${input.tool.toolName} cannot modify the original checkout while a planner worktree is active.`,
				`Planner worktree: ${input.state.planState.worktreePath ?? "(missing)"}.`,
				`Call ${PLANNER_STATUS_TOOL_NAME} and continue inside the planner worktree session.`,
			].join("\n"),
		};
	}

	const behavior = getPlannerStageStepBehavior(input.state.planState);
	if (
		!allowsProjectWrite(behavior.projectAccess) &&
		isProjectPath(input.cwd, input.tool.path, input.state)
	) {
		return blockProjectWrite(input.state, input.tool.toolName);
	}

	return allow();
}

function isOriginalCheckoutPath(
	cwd: string,
	path: string,
	state: PlannerBuiltinGuardState,
): boolean {
	if (!state.projectPaths?.projectRoot || !state.planState?.worktreePath) {
		return false;
	}
	const target = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
	return (
		isPathInside(state.projectPaths.projectRoot, target) &&
		!isPathInside(state.planState.worktreePath, target)
	);
}

function allowsProjectWrite(
	projectAccess: ReturnType<
		typeof getPlannerStageStepBehavior
	>["projectAccess"],
): boolean {
	return projectAccess === "test_edits" || projectAccess === "production_edits";
}

function isProtectedPlannerArtifact(
	cwd: string,
	path: string,
	state: PlannerBuiltinGuardState,
): boolean {
	if (!state.planPaths) return false;
	const target = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
	return (
		target === resolve(state.planPaths.requestMd) ||
		target === resolve(state.planPaths.goalMd)
	);
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
			"Project writes are allowed only in the exact execution steps reported by planner_status.",
			"Planner artifacts outside the project directory remain writable.",
			`Call ${PLANNER_STATUS_TOOL_NAME} and follow the current stage instruction.`,
		].join("\n"),
	};
}

function allow(): GitWatcherDecision {
	return { allow: true, reason: null };
}
