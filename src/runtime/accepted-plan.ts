import { outputBranchName } from "../git/branches";
import { exportPlanToOutputBranch } from "../git/planner-ops";
import type { GitRunner } from "../git/runner";
import { createPiSessionDir } from "../session/handoff";
import type { PlannerFs } from "../storage/fs";
import {
	createPlanStoragePaths,
	type ProjectStoragePaths,
} from "../storage/paths";
import { readPlanRecord } from "../storage/plan-store";
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
	createdFromSessionFile: string | null;
	lastRootSessionFile: string | null;
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
			`Planner finish requires plan branch ${state.activeBranches.plan}, but worktree is on ${actualBranch}.`,
		);
	}
	const status = await input.git.statusPorcelain({ repoRoot: worktreePath });
	if (status.trim().length > 0) {
		throw new Error(
			"Planner finish requires a clean worktree. Commit the accepted result through planner tools first.",
		);
	}
	const worktreeIndex = await readWorktreeProjectIndexIfExists({
		fs: input.fs,
		agentDir: input.projectPaths.agentDir,
		worktreePath,
	});
	const createdFromSessionFile = worktreeIndex?.createdFromSessionFile ?? null;
	const lastRootSessionFile = worktreeIndex?.lastRootSessionFile ?? null;
	const originalSessionFile = lastRootSessionFile ?? createdFromSessionFile;
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
		createdFromSessionFile,
		lastRootSessionFile,
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
	const planPaths = createPlanStoragePaths(input.projectPaths, preview.planId);
	const message =
		input.message ??
		(await buildAcceptedPlanCommitMessage({
			fs: input.fs,
			planPaths,
			planId: preview.planId,
			outputBranch: preview.outputBranch,
		}));
	await exportPlanToOutputBranch({
		git: input.git,
		state: preview.state,
		projectRoot: input.projectPaths.projectRoot,
		planId: preview.planId,
		message,
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
		force: true,
	});

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

// No commitLanguage here on purpose: this export message is assembled
// deterministically (no model call), so there is nothing to translate. Its
// prose comes from final_summary.md — already written in the user's language —
// and the rest (feat:, Summary:, Verification:) are technical tokens.
async function buildAcceptedPlanCommitMessage(input: {
	fs: PlannerFs;
	planPaths: ReturnType<typeof createPlanStoragePaths>;
	planId: string;
	outputBranch: string;
}): Promise<string> {
	const plan = await readPlanRecord(input.fs, input.planPaths);
	const finalSummary = await readOptionalText(
		input.fs,
		input.planPaths.planDir,
		["final_summary.md", "verify.md"],
	);
	const planMarkdown = await readOptionalText(
		input.fs,
		input.planPaths.planDir,
		["plan.md"],
	);
	const completedTasks = plan.tasks
		.filter((task) => task.status === "done")
		.map((task) => task.title || task.taskId);
	const title = normalizeCommitTitle(plan.title || input.planId);
	const summaryLines = summarizeAcceptedPlan({
		finalSummary,
		planMarkdown,
		completedTasks,
	});
	const verificationLines = summarizeVerification(finalSummary);
	return [
		`feat: export ${title}`,
		"",
		`Planner plan: ${plan.title || input.planId} (${input.planId})`,
		`Output branch: ${input.outputBranch}`,
		"",
		"Summary:",
		...summaryLines.map((line) => `- ${line}`),
		...(verificationLines.length > 0
			? ["", "Verification:", ...verificationLines.map((line) => `- ${line}`)]
			: []),
	].join("\n");
}

async function readOptionalText(
	fs: PlannerFs,
	dir: string,
	names: string[],
): Promise<string> {
	for (const name of names) {
		const path = `${dir}/${name}`;
		if (await fs.exists(path)) {
			return await fs.readText(path);
		}
	}
	return "";
}

function normalizeCommitTitle(value: string): string {
	const title = value.replace(/\s+/g, " ").trim();
	if (!title) return "accepted";
	return title.length <= 52 ? title : `${title.slice(0, 49).trimEnd()}...`;
}

function summarizeAcceptedPlan(input: {
	finalSummary: string;
	planMarkdown: string;
	completedTasks: string[];
}): string[] {
	const lines = [
		...extractSectionLines(input.finalSummary, ["Results"]),
		...extractSectionLines(input.finalSummary, ["Architecture"]).slice(0, 5),
	];
	if (input.completedTasks.length > 0) {
		lines.push(
			`Completed ${input.completedTasks.length} planned task${input.completedTasks.length === 1 ? "" : "s"}: ${input.completedTasks.slice(0, 8).join(", ")}${input.completedTasks.length > 8 ? ", ..." : ""}.`,
		);
	}
	const normalized = normalizeSummaryLines(lines).slice(0, 8);
	if (normalized.length > 0) {
		return normalized;
	}
	const unstructuredSummary = normalizeSummaryLines(input.finalSummary).slice(
		0,
		5,
	);
	if (unstructuredSummary.length > 0) {
		return unstructuredSummary;
	}
	const fallback = normalizeSummaryLines(
		extractSectionLines(input.planMarkdown, [
			"Goal",
			"Implementation Strategy",
		]),
	).slice(0, 5);
	return fallback.length > 0
		? fallback
		: ["Exported the accepted planner result."];
}

function summarizeVerification(content: string): string[] {
	return normalizeSummaryLines(
		extractSectionLines(content, ["Verification", "Checks", "Doubt Review"]),
	).slice(0, 4);
}

function extractSectionLines(content: string, headings: string[]): string[] {
	const wanted = new Set(headings.map((heading) => heading.toLowerCase()));
	const lines = content.split(/\r?\n/);
	const collected: string[] = [];
	let collecting = false;
	for (const line of lines) {
		const heading = /^(#{2,6})\s+(\S.*)$/.exec(line);
		if (heading) {
			const title = heading[2]
				.replace(/[#*_`]/g, "")
				.trim()
				.toLowerCase();
			if (collecting) {
				collecting = false;
			}
			if (wanted.has(title)) {
				collecting = true;
				continue;
			}
		}
		if (collecting) {
			collected.push(line);
		}
	}
	return collected;
}

function normalizeSummaryLines(lines: string | string[]): string[] {
	const sourceLines = Array.isArray(lines) ? lines : lines.split(/\r?\n/);
	const normalized = sourceLines
		.flatMap((line) => line.split(/\r?\n/))
		.map((line) =>
			line
				.replace(/^[-*]\s*/, "")
				.replace(/^\d+\.\s*/, "")
				.replace(/\*\*(.+?)\*\*/g, "$1")
				.replace(/`/g, "")
				.trim(),
		)
		.filter(
			(line) =>
				line.length > 0 &&
				!line.startsWith("#") &&
				!line.startsWith("|") &&
				!/^[-:|\s]+$/.test(line),
		);
	return [...new Set(normalized)];
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
			`Planner finish is allowed only after result presentation at done/present_result or done/await_user_acceptance, not ${state.stage}/${state.step}.`,
		);
	}
	if (state.stepStatus === "blocked" || state.stepStatus === "failed") {
		throw new Error(
			`Planner finish is blocked while ${state.stage}/${state.step} is ${state.stepStatus}.`,
		);
	}
	if (state.broken || state.requiresUserDecision) {
		throw new Error("Planner finish is blocked until recovery is complete.");
	}
	if (state.requiresCompact) {
		throw new Error(
			"Planner finish is blocked until required compact completes.",
		);
	}
	if (state.activeTaskId) {
		throw new Error("Planner finish is blocked while a task is active.");
	}
	if (state.currentBranch !== state.activeBranches.plan) {
		throw new Error(
			"Planner finish requires state.json to point at the plan branch.",
		);
	}
}

function requireWorktreePath(state: PlanStateRecord): string {
	if (!state.worktreePath) {
		throw new Error("Planner finish requires state.worktreePath.");
	}
	return state.worktreePath;
}

function managedChildBranches(state: PlanStateRecord): string[] {
	const branches = [
		state.activeBranches.currentTask,
		...Object.values(state.managedBranches.tasks).flatMap((registry) => [
			registry.task,
			registry.refactor,
		]),
	].filter((branch): branch is string => Boolean(branch));
	return [...new Set(branches)].filter((branch) => !branch.startsWith("plan/"));
}
