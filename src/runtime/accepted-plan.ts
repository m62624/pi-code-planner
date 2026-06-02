import { outputBranchName } from "../git/branches";
import { exportPlanToOutputBranch } from "../git/planner-ops";
import type { GitRunner } from "../git/runner";
import { createPiSessionDir } from "../session/handoff";
import type { PlannerFs } from "../storage/fs";
import {
	createPlanStoragePaths,
	type ProjectStoragePaths,
} from "../storage/paths";
import {
	readProjectRecordIfExists,
	saveProjectRecord,
} from "../storage/project-store";
import type { PlanStateRecord, ProjectRecord } from "../storage/schema";
import { readPlanStateIfExists } from "../storage/state-store";
import {
	createWorktreeProjectIndexPath,
	readWorktreeProjectIndexIfExists,
	type WorktreeProjectIndexRecord,
} from "../storage/worktree-index";
import { PLANNER_SYSTEM_INSTRUCTIONS_HEADER } from "./compact";

export interface AcceptedPlanPreview {
	project: ProjectRecord;
	planId: string;
	state: PlanStateRecord;
	worktreePath: string;
	worktreeSessionDir: string;
	outputBranch: string;
	worktreeIndex: WorktreeProjectIndexRecord | null;
	originalSessionFile: string | null;
	originalSessionExists: boolean;
}

export interface FinalizedAcceptedPlan extends AcceptedPlanPreview {
	removedPlanDir: string;
	removedChildBranches: string[];
}

export async function inspectAcceptedPlan(input: {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
}): Promise<AcceptedPlanPreview> {
	const project = await readProjectRecordIfExists(input.fs, input.projectPaths);
	if (!project?.activePlanId) {
		throw new Error("No active planner plan to accept.");
	}
	const planId = project.activePlanId;
	if (!project.plans.some((plan) => plan.planId === planId)) {
		throw new Error(
			`Active planner plan is missing from project.json: ${planId}.`,
		);
	}
	const planPaths = createPlanStoragePaths(input.projectPaths, planId);
	const state = await readPlanStateIfExists(input.fs, planPaths);
	if (!state) {
		throw new Error(`Planner state is missing: ${planPaths.stateJson}.`);
	}
	assertAcceptedPlanReady(state);
	const worktreePath = requireWorktreePath(state);
	if (!(await input.fs.exists(worktreePath))) {
		throw new Error(`Planner worktree is missing: ${worktreePath}.`);
	}
	const actualBranch = await input.git.currentBranch({
		repoRoot: worktreePath,
	});
	if (actualBranch !== state.activeBranches.plan) {
		throw new Error(
			`Planner accept requires plan branch ${state.activeBranches.plan}, but worktree is on ${actualBranch}.`,
		);
	}
	const status = await input.git.statusPorcelain({ repoRoot: worktreePath });
	if (status.trim().length > 0) {
		throw new Error(
			"Planner accept requires a clean worktree. Commit the accepted result through planner tools first.",
		);
	}
	const worktreeIndex = await readWorktreeProjectIndexIfExists({
		fs: input.fs,
		agentDir: input.projectPaths.agentDir,
		worktreePath,
	});
	const originalSessionFile = worktreeIndex?.originalSessionFile ?? null;
	return {
		project,
		planId,
		state,
		worktreePath,
		worktreeSessionDir: createPiSessionDir({
			agentDir: input.projectPaths.agentDir,
			cwd: worktreePath,
		}),
		outputBranch: outputBranchName(planId),
		worktreeIndex,
		originalSessionFile,
		originalSessionExists: originalSessionFile
			? await input.fs.exists(originalSessionFile)
			: false,
	};
}

export async function finalizeAcceptedPlan(input: {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
	message?: string;
}): Promise<FinalizedAcceptedPlan> {
	const preview = await inspectAcceptedPlan(input);
	await exportPlanToOutputBranch({
		git: input.git,
		state: preview.state,
		projectRoot: input.projectPaths.projectRoot,
		planId: preview.planId,
		message:
			input.message ?? `feat: export accepted planner result ${preview.planId}`,
	});

	const childBranches = managedChildBranches(preview.state);
	for (const branch of childBranches) {
		await input.git.deleteBranch({
			repoRoot: input.projectPaths.projectRoot,
			branch,
			force: true,
		});
	}
	await input.git.worktreeRemove({
		repoRoot: input.projectPaths.projectRoot,
		path: preview.worktreePath,
		force: false,
	});
	await input.git.deleteBranch({
		repoRoot: input.projectPaths.projectRoot,
		branch: preview.state.activeBranches.plan,
		force: false,
	});

	const planPaths = createPlanStoragePaths(input.projectPaths, preview.planId);
	await input.fs.removeFile(
		createWorktreeProjectIndexPath({
			agentDir: input.projectPaths.agentDir,
			worktreePath: preview.worktreePath,
		}),
	);
	await input.fs.removeDir(planPaths.planDir);
	await saveProjectRecord(input.fs, input.projectPaths, {
		...preview.project,
		activePlanId: null,
		plans: preview.project.plans.filter(
			(plan) => plan.planId !== preview.planId,
		),
	});

	return {
		...preview,
		removedPlanDir: planPaths.planDir,
		removedChildBranches: childBranches,
	};
}

export function buildAcceptedPlanCompletionPrompt(input: {
	planId: string;
	outputBranch: string;
	originalSessionMissing: boolean;
	preservedWorktreeChatDir?: string | null;
}): string {
	return [
		PLANNER_SYSTEM_INSTRUCTIONS_HEADER,
		"",
		`Planner plan ${input.planId} is complete.`,
		`Accepted result branch: ${input.outputBranch}`,
		"Temporary planner worktree, plan artifacts, worktree index, plan branch, and managed child branches were removed.",
		"The accepted output branch remains in the original Git repository for user review.",
		input.originalSessionMissing
			? "Warning: the original Pi JSONL session was missing. A replacement project-root session was created."
			: "Pi returned to the original project JSONL session.",
		input.preservedWorktreeChatDir
			? `Completed worktree chat history was preserved at: ${input.preservedWorktreeChatDir}`
			: "Completed worktree chat history was removed.",
		"",
		"Do not continue planner execution for this completed plan.",
		"Report the output branch to the user and wait for the next request.",
	].join("\n");
}

function assertAcceptedPlanReady(state: PlanStateRecord): void {
	const acceptsExplicitUserCommand =
		state.stage === "done" &&
		((state.step === "present_result" && state.stepStatus !== "pending") ||
			state.step === "await_user_acceptance");
	if (!acceptsExplicitUserCommand) {
		throw new Error(
			`Planner accept is allowed only after result presentation at done/present_result or done/await_user_acceptance, not ${state.stage}/${state.step}.`,
		);
	}
	if (state.stepStatus === "blocked" || state.stepStatus === "failed") {
		throw new Error(
			`Planner accept is blocked while ${state.stage}/${state.step} is ${state.stepStatus}.`,
		);
	}
	if (state.broken || state.requiresUserDecision) {
		throw new Error("Planner accept is blocked until recovery is complete.");
	}
	if (state.requiresMemoryUpdate) {
		throw new Error(
			"Planner accept is blocked until planner memory is synchronized.",
		);
	}
	if (state.requiresCompact) {
		throw new Error(
			"Planner accept is blocked until required compact completes.",
		);
	}
	if (state.activeTaskId || state.activeExperimentId) {
		throw new Error(
			"Planner accept is blocked while a task or experiment is active.",
		);
	}
	if (state.currentBranch !== state.activeBranches.plan) {
		throw new Error(
			"Planner accept requires state.json to point at the plan branch.",
		);
	}
}

function requireWorktreePath(state: PlanStateRecord): string {
	if (!state.worktreePath) {
		throw new Error("Planner accept requires state.worktreePath.");
	}
	return state.worktreePath;
}

function managedChildBranches(state: PlanStateRecord): string[] {
	const branches = [
		state.activeBranches.currentTask,
		state.activeBranches.currentExperiment,
		state.activeBranches.selectedExperiment,
		...Object.values(state.managedBranches.tasks).flatMap((registry) => [
			registry.task,
			...registry.experiments,
			registry.selectedExperiment,
			registry.refactor,
		]),
	].filter((branch): branch is string => Boolean(branch));
	return [...new Set(branches)].filter((branch) => !branch.startsWith("plan/"));
}
