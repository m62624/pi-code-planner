import { describe, expect, it } from "vitest";
import type {
	GitBranchInput,
	GitCommitInput,
	GitCreateBranchInput,
	GitDeleteBranchInput,
	GitMergeInput,
	GitRepoInput,
	GitRunner,
	GitSwitchBranchInput,
	GitWorktreeAddInput,
	GitWorktreeRemoveInput,
} from "../git/runner";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "../storage/paths";
import { initializePlanFiles, readPlanRecord } from "../storage/plan-store";
import {
	ensureProjectRecord,
	readProjectRecord,
	setActivePlan,
	upsertProjectPlanSummary,
} from "../storage/project-store";
import { createInitialPlanState, createPlanRecord } from "../storage/schema";
import { initializePlanState, readPlanState } from "../storage/state-store";
import { MockPlannerFs } from "../test/mock-fs";
import { executePlannerGoalTool } from "./goal-tools";

class MockGitRunner implements GitRunner {
	async init(_input: GitRepoInput): Promise<void> {}
	async currentBranch(_input: GitRepoInput): Promise<string> {
		return "plan/plan-a";
	}
	async headCommit(_input: GitRepoInput): Promise<string> {
		return "abc123";
	}
	async statusPorcelain(_input: GitRepoInput): Promise<string> {
		return "";
	}
	async diffStat(_input: GitRepoInput): Promise<string> {
		return "";
	}
	async diffNameOnly(_input: GitRepoInput): Promise<string> {
		return "";
	}
	async listProjectFiles(_input: GitRepoInput): Promise<string[]> {
		return [];
	}
	async branchExists(_input: GitBranchInput): Promise<boolean> {
		return true;
	}
	async createBranch(_input: GitCreateBranchInput): Promise<void> {}
	async deleteBranch(_input: GitDeleteBranchInput): Promise<void> {}
	async switchBranch(_input: GitSwitchBranchInput): Promise<void> {}
	async stageAll(_input: GitRepoInput): Promise<void> {}
	async commit(_input: GitCommitInput): Promise<void> {}
	async merge(_input: GitMergeInput): Promise<void> {}
	async worktreeAdd(_input: GitWorktreeAddInput): Promise<void> {}
	async worktreeRemove(_input: GitWorktreeRemoveInput): Promise<void> {}
}

describe("planner goal tools", () => {
	it("persists a model-written goal draft and waits for explicit user review", async () => {
		const setup = await createGoalSetup();

		const result = await executePlannerGoalTool({
			...setup,
			toolName: "planner_goal_submit",
			params: {
				content: "# Goal\n\nAudit the safe find command.",
				title: "Audit safe find handling",
				description: "Audit safe find command handling.",
			},
		});

		expect(result.status).toBe("applied");
		expect(setup.fs.snapshot()[setup.planPaths.goalMd]).toBe(
			"# Goal\n\nAudit the safe find command.\n",
		);
		await expect(
			readPlanState(setup.fs, setup.planPaths),
		).resolves.toMatchObject({
			stage: "intake",
			step: "await_goal_approval",
			stepStatus: "running",
		});
		expect(result.text).toContain("explicitly approve");
		expect(result.text).toContain("Audit safe find handling");
		expect(result.text).toContain("Audit safe find command handling.");
		await expect(
			readPlanRecord(setup.fs, setup.planPaths),
		).resolves.toMatchObject({
			title: "Audit safe find handling",
			description: "Audit safe find command handling.",
		});
		await expect(
			readProjectRecord(setup.fs, setup.projectPaths),
		).resolves.toMatchObject({
			plans: [
				{
					planId: "plan-a",
					title: "Audit safe find handling",
					description: "Audit safe find command handling.",
				},
			],
		});
	});

	it("enters discovery only after explicit approval", async () => {
		const setup = await createGoalSetup({
			stage: "intake",
			step: "await_goal_approval",
			stepStatus: "running",
		});

		const result = await executePlannerGoalTool({
			...setup,
			toolName: "planner_goal_decide",
			params: { decision: "approve" },
		});

		expect(result.status).toBe("applied");
		await expect(
			readPlanState(setup.fs, setup.planPaths),
		).resolves.toMatchObject({
			stage: "discovery",
			step: "scan_project_structure",
			stepStatus: "pending",
		});
		expect(setup.fs.snapshot()[setup.planPaths.decisionsMd]).toContain(
			"Goal approved by user.",
		);
	});

	it("enters planning (not a second discovery) after approval in the improve flow", async () => {
		const setup = await createGoalSetup({
			stage: "intake",
			step: "await_goal_approval",
			stepStatus: "running",
			creationMethod: "improve",
		});

		const result = await executePlannerGoalTool({
			...setup,
			toolName: "planner_goal_decide",
			params: { decision: "approve" },
		});

		expect(result.status).toBe("applied");
		expect(result.text).toContain("planning");
		await expect(
			readPlanState(setup.fs, setup.planPaths),
		).resolves.toMatchObject({
			stage: "planning",
			step: "read_context",
			stepStatus: "pending",
		});
	});

	it("returns to goal drafting when the user requests a revision", async () => {
		const setup = await createGoalSetup({
			stage: "intake",
			step: "await_goal_approval",
			stepStatus: "running",
		});

		const result = await executePlannerGoalTool({
			...setup,
			toolName: "planner_goal_decide",
			params: {
				decision: "revise",
				feedback: "Keep the fix limited to approval-modes.",
			},
		});

		expect(result.status).toBe("applied");
		await expect(
			readPlanState(setup.fs, setup.planPaths),
		).resolves.toMatchObject({
			stage: "intake",
			step: "draft_goal",
			stepStatus: "running",
		});
		expect(setup.fs.snapshot()[setup.planPaths.decisionsMd]).toContain(
			"Keep the fix limited to approval-modes.",
		);
	});

	it("blocks goal submission outside intake", async () => {
		const setup = await createGoalSetup({
			stage: "discovery",
			step: "scan_project_structure",
			stepStatus: "running",
		});

		const result = await executePlannerGoalTool({
			...setup,
			toolName: "planner_goal_submit",
			params: {
				content: "# Goal\n\nToo late.",
				title: "Too late",
				description: "Too late.",
			},
		});

		expect(result.status).toBe("blocked");
	});
});

async function createGoalSetup(state: Record<string, unknown> = {}): Promise<{
	fs: MockPlannerFs;
	git: MockGitRunner;
	projectPaths: ReturnType<typeof createProjectStoragePaths>;
	planPaths: ReturnType<typeof createPlanStoragePaths>;
}> {
	const fs = new MockPlannerFs();
	const projectPaths = createProjectStoragePaths({
		agentDir: "/agent",
		projectRoot: "/repo/app",
	});
	const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
	const worktreePath = "/repo/app/.pi/pi-code-planner/worktrees/plan-a";
	await ensureProjectRecord(fs, projectPaths);
	await initializePlanFiles(
		fs,
		planPaths,
		createPlanRecord({ planId: "plan-a", title: "Plan A" }),
	);
	await upsertProjectPlanSummary(fs, projectPaths, {
		planId: "plan-a",
		title: "Plan A",
		status: "active",
	});
	await fs.mkdirp(worktreePath);
	await fs.writeTextAtomic(
		planPaths.requestMd,
		"Audit the safe find command.\n",
	);
	await initializePlanState(fs, planPaths, {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/plan-a",
			worktreePath,
		}),
		stage: "intake",
		step: "draft_goal",
		stepStatus: "running",
		currentBranch: "plan/plan-a",
		...state,
	});
	await setActivePlan(fs, projectPaths, "plan-a");
	return { fs, git: new MockGitRunner(), projectPaths, planPaths };
}
