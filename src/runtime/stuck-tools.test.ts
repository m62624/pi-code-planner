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
import { initializePlanFiles } from "../storage/plan-store";
import { ensureProjectRecord, setActivePlan } from "../storage/project-store";
import { createInitialPlanState, createPlanRecord } from "../storage/schema";
import { initializePlanState, readPlanState } from "../storage/state-store";
import { MockPlannerFs } from "../test/mock-fs";
import { executePlannerStuckTool } from "./stuck-tools";

class MockGitRunner implements GitRunner {
	async init(_input: GitRepoInput): Promise<void> {}
	async currentBranch(_input: GitRepoInput): Promise<string> {
		return "task/plan-a/task-1";
	}
	async headCommit(_input: GitRepoInput): Promise<string> {
		return "abc123";
	}
	async statusPorcelain(_input: GitRepoInput): Promise<string> {
		return " M src/lib.ts\n";
	}
	async diffStat(_input: GitRepoInput): Promise<string> {
		return " src/lib.ts | 4 +++-\n 1 file changed, 3 insertions(+), 1 deletion(-)\n";
	}
	async diffNameOnly(_input: GitRepoInput): Promise<string> {
		return "src/lib.ts\n";
	}
	async diffPatch(_input: GitRepoInput): Promise<string> {
		return "diff --git a/src/lib.ts b/src/lib.ts\n+new implementation\n";
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

describe("planner stuck tools", () => {
	it("records full diff artifacts and updates planner state", async () => {
		const setup = await createStuckSetup();

		const result = await executePlannerStuckTool({
			...setup,
			toolName: "planner_report_stuck",
			now: Date.UTC(2026, 5, 5, 0, 0, 0),
			params: {
				reason: "implementation keeps failing the focused round-trip test",
				observedError: "cargo test round_trip failed",
				lastAttempt: "Changed src/lib.ts and ran cargo test round_trip.",
				nextDebugPlan:
					"Inspect the failing assertion, reduce to one case, then patch only the codec.",
			},
		});

		expect(result.status).toBe("applied");
		expect(result.details?.attemptId).toBe("attempt-001");
		expect(
			setup.fs.snapshot()[
				`${setup.planPaths.tasksDir}/task-1/attempts/attempt-001/diff.patch`
			],
		).toContain("diff --git");
		expect(
			setup.fs.snapshot()[
				`${setup.planPaths.tasksDir}/task-1/attempts/attempt-001/stuck.md`
			],
		).toContain("cargo test round_trip failed");

		await expect(
			readPlanState(setup.fs, setup.planPaths),
		).resolves.toMatchObject({
			lastStuckAttemptId: "attempt-001",
			lastStuckReportPath:
				"/agent/extensions/pi-code-planner/plans/plan-a/tasks/task-1/attempts/attempt-001/stuck.md",
			blockedReason:
				"Stuck attempt recorded: /agent/extensions/pi-code-planner/plans/plan-a/tasks/task-1/attempts/attempt-001/stuck.md",
		});
	});

	it("blocks outside execution running steps", async () => {
		const setup = await createStuckSetup({ stepStatus: "pending" });

		const result = await executePlannerStuckTool({
			...setup,
			toolName: "planner_report_stuck",
			params: {
				reason: "not running",
				lastAttempt: "none",
				nextDebugPlan: "start step first",
			},
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("blocked");
	});
});

async function createStuckSetup(
	input: { stepStatus?: "pending" | "running" } = {},
) {
	const fs = new MockPlannerFs();
	const git = new MockGitRunner();
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
	await fs.mkdirp(worktreePath);
	await initializePlanState(fs, planPaths, {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/plan-a",
			worktreePath,
		}),
		stage: "execution",
		step: "implement_task",
		stepStatus: input.stepStatus ?? "running",
		activeTaskId: "task-1",
		currentBranch: "task/plan-a/task-1",
		activeBranches: {
			base: "main",
			plan: "plan/plan-a",
			currentTask: "task/plan-a/task-1",
		},
	});
	await setActivePlan(fs, projectPaths, "plan-a");
	return { fs, git, projectPaths, planPaths };
}
