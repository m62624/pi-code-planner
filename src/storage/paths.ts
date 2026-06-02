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
	tasksDir: string;
}

export interface TaskStoragePaths {
	taskDir: string;
	taskJson: string;
	taskMd: string;
	tddMd: string;
	testsMd: string;
	implementationMd: string;
	refactorMd: string;
	verifyMd: string;
	experimentsDir: string;
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
		tasksDir: join(planDir, "tasks"),
	};
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
		testsMd: join(taskDir, "tests.md"),
		implementationMd: join(taskDir, "implementation.md"),
		refactorMd: join(taskDir, "refactor.md"),
		verifyMd: join(taskDir, "verify.md"),
		experimentsDir: join(taskDir, "experiments"),
	};
}
