import { describe, expect, it } from "vitest";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
	createTaskStoragePaths,
	type ProjectStoragePaths,
} from "../storage/paths";
import { initializePlanFiles, updatePlanRecord } from "../storage/plan-store";
import {
	setActivePlan,
	upsertProjectPlanSummary,
} from "../storage/project-store";
import { createInitialPlanState, createPlanRecord } from "../storage/schema";
import { initializePlanState, savePlanState } from "../storage/state-store";
import { MockPlannerFs } from "../test/mock-fs";
import {
	executePlannerArtifactReadTool,
	PLANNER_READABLE_ARTIFACTS,
} from "./artifact-tools";

// planner_artifact_read is the sanctioned replacement for the built-in read
// tool on planner artifacts. The decoded pi-session showed a model in a
// security-restricted worktree fail to read request.md: the file lives in the
// extension storage dir, the worktree path 404s, and an approval extension can
// block reads outside the worktree. These tests pin that the wrapper resolves
// the extension path and returns content regardless of the worktree.

const AGENT_DIR = "/agent";
const PROJECT_ROOT = "/repo/app";
const PLAN_ID = "plan-a";

async function seedPlan(): Promise<{
	fs: MockPlannerFs;
	projectPaths: ProjectStoragePaths;
}> {
	const fs = new MockPlannerFs();
	const projectPaths = createProjectStoragePaths({
		agentDir: AGENT_DIR,
		projectRoot: PROJECT_ROOT,
	});
	const planPaths = createPlanStoragePaths(projectPaths, PLAN_ID);
	await upsertProjectPlanSummary(fs, projectPaths, {
		planId: PLAN_ID,
		title: PLAN_ID,
		status: "active",
	});
	await initializePlanFiles(
		fs,
		planPaths,
		createPlanRecord({ planId: PLAN_ID, title: PLAN_ID }),
	);
	await initializePlanState(
		fs,
		planPaths,
		createInitialPlanState({
			baseBranch: "main",
			planBranch: `plan/${PLAN_ID}`,
		}),
	);
	await setActivePlan(fs, projectPaths, PLAN_ID);
	return { fs, projectPaths };
}

/** Register a task id in the plan record so task-level reads can validate it. */
async function addTask(
	fs: MockPlannerFs,
	projectPaths: ProjectStoragePaths,
	taskId: string,
): Promise<void> {
	const planPaths = createPlanStoragePaths(projectPaths, PLAN_ID);
	await updatePlanRecord(fs, planPaths, (record) => ({
		...record,
		tasks: [...record.tasks, { taskId, title: taskId, status: "todo" }],
	}));
}

describe("planner_artifact_read", () => {
	it("reads a plan-level artifact from the extension dir, not the worktree", async () => {
		const { fs, projectPaths } = await seedPlan();
		const planPaths = createPlanStoragePaths(projectPaths, PLAN_ID);
		await fs.writeTextAtomic(planPaths.requestMd, "Improve the foo module.\n");

		const result = await executePlannerArtifactReadTool({
			fs,
			projectPaths,
			params: { artifact: "request" },
		});

		expect(result.status).toBe("applied");
		expect(result.text).toContain("Improve the foo module.");
		// The resolved path must be under the extension storage dir, never the
		// project worktree — that is the whole point of the tool.
		expect(result.details?.path).toContain("/agent/extensions/");
		expect(result.details?.path).not.toContain(PROJECT_ROOT);
		expect(result.details?.exists).toBe(true);
	});

	it("reports a not-yet-written artifact instead of erroring", async () => {
		const { fs, projectPaths } = await seedPlan();

		// final_summary.md is not pre-created by initializePlanFiles.
		const result = await executePlannerArtifactReadTool({
			fs,
			projectPaths,
			params: { artifact: "final_summary" },
		});

		expect(result.status).toBe("applied");
		expect(result.details?.exists).toBe(false);
		expect(result.text).toMatch(/has not been written yet/);
	});

	it("reports a pre-created but empty artifact distinctly", async () => {
		const { fs, projectPaths } = await seedPlan();

		// discovery.md is pre-created empty by initializePlanFiles.
		const result = await executePlannerArtifactReadTool({
			fs,
			projectPaths,
			params: { artifact: "discovery" },
		});

		expect(result.status).toBe("applied");
		expect(result.details?.exists).toBe(true);
		expect(result.text).toMatch(/exists but is empty/);
	});

	it("resolves a task-level artifact from the active task", async () => {
		const { fs, projectPaths } = await seedPlan();
		await addTask(fs, projectPaths, "task-1");
		const planPaths = createPlanStoragePaths(projectPaths, PLAN_ID);
		const taskPaths = createTaskStoragePaths(planPaths, "task-1");
		await fs.writeTextAtomic(taskPaths.tddMd, "# TDD for task-1\n");
		const state = createInitialPlanState({
			baseBranch: "main",
			planBranch: `plan/${PLAN_ID}`,
		});
		await savePlanState(fs, planPaths, { ...state, activeTaskId: "task-1" });

		const result = await executePlannerArtifactReadTool({
			fs,
			projectPaths,
			params: { artifact: "tdd" },
		});

		expect(result.status).toBe("applied");
		expect(result.text).toContain("# TDD for task-1");
		expect(result.details?.taskId).toBe("task-1");
	});

	it("honors an explicit taskId for task-level artifacts", async () => {
		const { fs, projectPaths } = await seedPlan();
		await addTask(fs, projectPaths, "task-2");
		const planPaths = createPlanStoragePaths(projectPaths, PLAN_ID);
		const taskPaths = createTaskStoragePaths(planPaths, "task-2");
		await fs.writeTextAtomic(taskPaths.taskMd, "# Task two\n");

		const result = await executePlannerArtifactReadTool({
			fs,
			projectPaths,
			params: { artifact: "task", taskId: "task-2" },
		});

		expect(result.status).toBe("applied");
		expect(result.text).toContain("# Task two");
		expect(result.details?.taskId).toBe("task-2");
	});

	it("blocks a non-existent taskId and lists the known task ids", async () => {
		const { fs, projectPaths } = await seedPlan();
		await addTask(fs, projectPaths, "task-1");

		const result = await executePlannerArtifactReadTool({
			fs,
			projectPaths,
			params: { artifact: "tdd", taskId: "task-99" },
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toMatch(/does not exist/);
		// Transparency: the model is told which task ids it can pick.
		expect(result.text).toContain("task-1");
	});

	it("blocks a task-level artifact when no task is selectable", async () => {
		const { fs, projectPaths } = await seedPlan();

		const result = await executePlannerArtifactReadTool({
			fs,
			projectPaths,
			params: { artifact: "refactor" },
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toMatch(/task-scoped/);
		expect(result.text).toMatch(/No tasks have been created yet/);
	});

	it("blocks an unknown artifact name and lists the valid choices", async () => {
		const { fs, projectPaths } = await seedPlan();

		const result = await executePlannerArtifactReadTool({
			fs,
			projectPaths,
			params: { artifact: "secrets" },
		});

		expect(result.status).toBe("blocked");
		// Every valid artifact name is offered so a local model can self-correct.
		for (const name of PLANNER_READABLE_ARTIFACTS) {
			expect(result.text).toContain(name);
		}
		// And the worktree-vs-extension boundary is spelled out.
		expect(result.text).toMatch(/extension storage dir/);
	});

	it("blocks when there is no ready active plan context", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: AGENT_DIR,
			projectRoot: PROJECT_ROOT,
		});

		const result = await executePlannerArtifactReadTool({
			fs,
			projectPaths,
			params: { artifact: "goal" },
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toMatch(/ready active plan context/);
	});

	it("resolves every declared readable artifact to an extension path", async () => {
		const { fs, projectPaths } = await seedPlan();
		const planPaths = createPlanStoragePaths(projectPaths, PLAN_ID);
		await savePlanState(fs, planPaths, {
			...createInitialPlanState({
				baseBranch: "main",
				planBranch: `plan/${PLAN_ID}`,
			}),
			activeTaskId: "task-1",
		});

		for (const artifact of PLANNER_READABLE_ARTIFACTS) {
			const result = await executePlannerArtifactReadTool({
				fs,
				projectPaths,
				params: { artifact },
			});
			// Either applied (resolved a path) — never an internal error.
			expect(result.status).toBe("applied");
			expect(result.details?.path).toContain("/agent/extensions/");
		}
	});
});
