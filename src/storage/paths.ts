import { join } from "node:path";
import type { SettingsPaths } from "../settings/paths";
import { createProjectKey } from "./ids";

export interface PlannerStoragePathInput {
	paths: Pick<SettingsPaths, "globalDir">;
	projectPath: string;
	planId?: string;
	workItemId?: string;
	attemptId?: string;
}

export interface ProjectStoragePaths {
	projectsRoot: string;
	projectKey: string;
	projectDir: string;
	projectRecord: string;
	projectMemoryDir: string;
	plansDir: string;
}

export interface PlanStoragePaths extends ProjectStoragePaths {
	planId: string;
	planDir: string;
	planRecord: string;
	planMarkdown: string;
	planDiscovery: string;
	planQuestions: string;
	planDecisions: string;
	workItemsDir: string;
}

export interface WorkItemStoragePaths extends PlanStoragePaths {
	workItemId: string;
	workItemDir: string;
	workItemRecord: string;
	workItemTddPlan: string;
	workItemTestsSummary: string;
	workItemRefactorNotes: string;
	experimentsDir: string;
}

export interface AttemptStoragePaths extends WorkItemStoragePaths {
	attemptId: string;
	attemptDir: string;
	attemptPlan: string;
	attemptPrompt: string;
	attemptSummary: string;
	attemptScore: string;
	attemptVerification: string;
	attemptChangedFiles: string;
}

export function getProjectsRoot(
	paths: Pick<SettingsPaths, "globalDir">,
): string {
	return join(paths.globalDir, "projects");
}

export function getProjectStoragePaths(
	input: PlannerStoragePathInput,
): ProjectStoragePaths {
	const projectsRoot = getProjectsRoot(input.paths);
	const projectKey = createProjectKey(input.projectPath);
	const projectDir = join(projectsRoot, projectKey);
	return {
		projectsRoot,
		projectKey,
		projectDir,
		projectRecord: join(projectDir, "project.json"),
		projectMemoryDir: join(projectDir, "memory"),
		plansDir: join(projectDir, "plans"),
	};
}

export function getPlanStoragePaths(
	input: PlannerStoragePathInput & { planId: string },
): PlanStoragePaths {
	const project = getProjectStoragePaths(input);
	const planDir = join(project.plansDir, input.planId);
	return {
		...project,
		planId: input.planId,
		planDir,
		planRecord: join(planDir, "plan.json"),
		planMarkdown: join(planDir, "plan.md"),
		planDiscovery: join(planDir, "discovery.md"),
		planQuestions: join(planDir, "questions.md"),
		planDecisions: join(planDir, "decisions.md"),
		workItemsDir: join(planDir, "work_items"),
	};
}

export function getWorkItemStoragePaths(
	input: PlannerStoragePathInput & { planId: string; workItemId: string },
): WorkItemStoragePaths {
	const plan = getPlanStoragePaths(input);
	const workItemDir = join(plan.workItemsDir, input.workItemId);
	return {
		...plan,
		workItemId: input.workItemId,
		workItemDir,
		workItemRecord: join(workItemDir, "work_item.json"),
		workItemTddPlan: join(workItemDir, "tdd_plan.md"),
		workItemTestsSummary: join(workItemDir, "tests_summary.md"),
		workItemRefactorNotes: join(workItemDir, "refactor_notes.md"),
		experimentsDir: join(workItemDir, "experiments"),
	};
}

export function getAttemptStoragePaths(
	input: PlannerStoragePathInput & {
		planId: string;
		workItemId: string;
		attemptId: string;
	},
): AttemptStoragePaths {
	const workItem = getWorkItemStoragePaths(input);
	const attemptDir = join(workItem.experimentsDir, input.attemptId);
	return {
		...workItem,
		attemptId: input.attemptId,
		attemptDir,
		attemptPlan: join(attemptDir, "plan.md"),
		attemptPrompt: join(attemptDir, "prompt.md"),
		attemptSummary: join(attemptDir, "summary.md"),
		attemptScore: join(attemptDir, "score.json"),
		attemptVerification: join(attemptDir, "verification.json"),
		attemptChangedFiles: join(attemptDir, "changed_files.json"),
	};
}
