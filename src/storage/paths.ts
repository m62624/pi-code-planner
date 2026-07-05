import { basename, join, normalize } from "node:path";
import { EXTENSION_NAME } from "../constants";
import { createProjectId } from "./ids";

export interface ProjectStoragePaths {
	agentDir: string;
	extensionDir: string;
	projectRoot: string;
	projectId: string;
	displayName: string;
	projectDir: string;
	projectJson: string;
	compactTimingJson: string;
	plansDir: string;
	instructionsDir: string;
	projectLocalDir: string;
}

export interface PlanStoragePaths {
	planDir: string;
	planJson: string;
	stateJson: string;
	requestMd: string;
	goalMd: string;
	planMd: string;
	discoveryMd: string;
	questionsMd: string;
	decisionsMd: string;
	verifyMd: string;
	tasksDir: string;
	contractsDir: string;
	contractsManifestJson: string;
	contractsBaselineDir: string;
	diagnosticsDir: string;
	elenchusDir: string;
}

export interface TaskStoragePaths {
	taskDir: string;
	taskJson: string;
	taskMd: string;
	tddMd: string;
	refactorMd: string;
}

export function createProjectStoragePaths(input: {
	agentDir: string;
	projectRoot: string;
}): ProjectStoragePaths {
	const projectRoot = normalize(input.projectRoot);
	const projectId = createProjectId(projectRoot);
	const extensionDir = join(input.agentDir, "extensions", EXTENSION_NAME);
	const projectDir = join(extensionDir, "projects", projectId);

	return {
		agentDir: input.agentDir,
		extensionDir,
		projectRoot,
		projectId,
		displayName: basename(projectRoot),
		projectDir,
		projectJson: join(projectDir, "project.json"),
		// Rolling compaction-duration history for the empirical ETA indicator.
		compactTimingJson: join(projectDir, "compact-timing.json"),
		// Plans live INSIDE the project dir so everything owned by a project
		// (project.json, skills, plans) sits under projects/<projectId>/ instead
		// of a flat extensionDir/plans shared across every project.
		plansDir: join(projectDir, "plans"),
		instructionsDir: join(extensionDir, "instructions"),
		projectLocalDir: join(projectRoot, ".pi", EXTENSION_NAME),
	};
}

export function createPlanStoragePaths(
	projectPaths: ProjectStoragePaths,
	planId: string,
): PlanStoragePaths {
	const planDir = join(projectPaths.plansDir, planId);
	return {
		planDir,
		planJson: join(planDir, "plan.json"),
		stateJson: join(planDir, "state.json"),
		requestMd: join(planDir, "request.md"),
		goalMd: join(planDir, "goal.md"),
		planMd: join(planDir, "plan.md"),
		discoveryMd: join(planDir, "discovery.md"),
		questionsMd: join(planDir, "questions.md"),
		decisionsMd: join(planDir, "decisions.md"),
		verifyMd: join(planDir, "verify.md"),
		tasksDir: join(planDir, "tasks"),
		contractsDir: join(planDir, "contracts"),
		contractsManifestJson: join(planDir, "contracts", "manifest.json"),
		contractsBaselineDir: join(planDir, "contracts", "baseline"),
		diagnosticsDir: join(planDir, "diagnostics"),
		elenchusDir: join(planDir, "elenchus"),
	};
}

export function createPlansDirectory(
	projectPaths: ProjectStoragePaths,
): string {
	return projectPaths.plansDir;
}

export function createTaskStoragePaths(
	planPaths: PlanStoragePaths,
	taskId: string,
): TaskStoragePaths {
	const taskDir = join(planPaths.tasksDir, taskId);
	return {
		taskDir,
		taskJson: join(taskDir, "task.json"),
		taskMd: join(taskDir, "task.md"),
		tddMd: join(taskDir, "tdd.md"),
		refactorMd: join(taskDir, "refactor.md"),
	};
}
