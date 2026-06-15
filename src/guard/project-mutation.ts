import { isAbsolute, join, relative, resolve, sep } from "node:path";
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
	planPaths?: Pick<
		PlanStoragePaths,
		"planDir" | "requestMd" | "goalMd" | "questionsMd" | "tasksDir"
	> | null;
	planState: Pick<
		PlanStateRecord,
		"stage" | "step" | "worktreePath" | "activeTaskId"
	> | null;
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

	const protectedArtifact = matchProtectedPlannerArtifact(
		input.cwd,
		input.tool.path,
		input.state,
	);
	if (protectedArtifact) {
		return {
			allow: false,
			reason: [
				`Built-in Pi ${input.tool.toolName} cannot modify the planner-managed file ${protectedArtifact.label} directly.`,
				`Use ${protectedArtifact.tool} instead — it fills the artifact from structured arguments and validates the required sections.`,
				`Call ${PLANNER_STATUS_TOOL_NAME} if you need the current wrapper.`,
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

interface ProtectedArtifact {
	label: string;
	tool: string;
}

/**
 * Planner artifacts that must only be written through a dedicated wrapper tool.
 * request.md/goal.md/questions.md and the active task's tdd.md have structured
 * wrappers; built-in edit/write would bypass their validation. Open-ended,
 * append-heavy artifacts (plan.md, discovery.md, final_summary.md) intentionally
 * stay editable so the model can append across the lifecycle.
 */
function matchProtectedPlannerArtifact(
	cwd: string,
	path: string,
	state: PlannerBuiltinGuardState,
): ProtectedArtifact | null {
	if (!state.planPaths) return null;
	const target = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
	if (target === resolve(state.planPaths.requestMd)) {
		return { label: "request.md", tool: "the planner intake flow" };
	}
	if (target === resolve(state.planPaths.goalMd)) {
		return { label: "goal.md", tool: "planner_goal_submit" };
	}
	if (
		state.planPaths.questionsMd &&
		target === resolve(state.planPaths.questionsMd)
	) {
		return { label: "questions.md", tool: "planner_questions_submit" };
	}
	const activeTaskId = state.planState?.activeTaskId;
	if (activeTaskId && state.planPaths.tasksDir) {
		const tddPath = resolve(
			join(state.planPaths.tasksDir, activeTaskId, "tdd.md"),
		);
		if (target === tddPath) {
			return { label: "tdd.md", tool: "planner_tdd_submit" };
		}
	}
	return null;
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
