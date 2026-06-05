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
import { initializePlanState } from "../storage/state-store";
import { MockPlannerFs } from "../test/mock-fs";
import { executePlannerRefactorTool } from "./refactor-tools";

class MockGitRunner implements GitRunner {
	async init(_input: GitRepoInput): Promise<void> {}
	async currentBranch(_input: GitRepoInput): Promise<string> {
		return "task/plan-a/task-1";
	}
	async headCommit(_input: GitRepoInput): Promise<string> {
		return "abc123";
	}
	async statusPorcelain(_input: GitRepoInput): Promise<string> {
		return "";
	}
	async diffStat(_input: GitRepoInput): Promise<string> {
		return " src/lib.ts | 4 +++-\n";
	}
	async diffNameOnly(_input: GitRepoInput): Promise<string> {
		return "src/lib.ts\n";
	}
	async diffPatch(_input: GitRepoInput): Promise<string> {
		return "diff --git a/src/lib.ts b/src/lib.ts\n";
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

describe("planner refactor tools", () => {
	it("writes structured refactor.md from semantic fields", async () => {
		const setup = await createRefactorSetup();

		const result = await executePlannerRefactorTool({
			...setup,
			toolName: "planner_refactor_review",
			params: keptParams(),
		});

		expect(result.status).toBe("applied");
		expect(result.details).toMatchObject({ decision: "kept" });
		const refactorMd =
			setup.fs.snapshot()[`${setup.planPaths.tasksDir}/task-1/refactor.md`];
		expect(refactorMd).toContain("## Changed Surface");
		expect(refactorMd).toContain("Decision: kept");
		expect(refactorMd).toContain("extracting it would add an unused helper");
	});

	it("blocks outside execution/refactor_task", async () => {
		const setup = await createRefactorSetup({ step: "implement_task" });

		const result = await executePlannerRefactorTool({
			...setup,
			toolName: "planner_refactor_review",
			params: keptParams(),
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("blocked");
	});

	it("requires whyKept for kept decisions", async () => {
		const setup = await createRefactorSetup();

		const result = await executePlannerRefactorTool({
			...setup,
			toolName: "planner_refactor_review",
			params: { ...keptParams(), whyKept: "" },
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("whyKept must be a non-empty string");
	});

	it("requires changesApplied for changed decisions", async () => {
		const setup = await createRefactorSetup();

		const result = await executePlannerRefactorTool({
			...setup,
			toolName: "planner_refactor_review",
			params: {
				...keptParams(),
				decision: "changed",
				whyKept: "",
				changesApplied: "",
			},
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("changesApplied must be a non-empty string");
	});
});

function keptParams() {
	return {
		changedSurface:
			"- Files: src/lib.ts\n- Behavior touched: parser validation\n- Public API touched: no",
		complexity:
			"- Unnecessary abstraction: none in the active diff\n- Over-generalization: rejected helper extraction\n- Simpler alternative considered: inline validation",
		duplication:
			"- New duplication: none\n- Existing duplication touched: no\n- Decision: keep local branch",
		namingAndBoundaries:
			"- Confusing names: none\n- Module/API boundary issues: none\n- Scope leaks: none",
		edgeCases:
			"- Validation/error handling: invalid input path covered\n- State consistency: no mutable state\n- Regression risk: low",
		decision: "kept",
		whyKept:
			"- The task diff is one validation branch and extracting it would add an unused helper.",
	};
}

async function createRefactorSetup(
	input: { step?: "implement_task" | "refactor_task" } = {},
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
	await fs.writeTextAtomic(`${planPaths.tasksDir}/task-1/tdd.md`, "TDD\n");
	await initializePlanState(fs, planPaths, {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/plan-a",
			worktreePath,
		}),
		stage: "execution",
		step: input.step ?? "refactor_task",
		stepStatus: "running",
		activeTaskId: "task-1",
		currentBranch: "task/plan-a/task-1",
		activeBranches: {
			base: "main",
			plan: "plan/plan-a",
			currentTask: "task/plan-a/task-1",
		},
		managedBranches: {
			tasks: {
				"task-1": {
					task: "task/plan-a/task-1",
					refactor: null,
					mergedToPlan: false,
				},
			},
		},
	});
	await setActivePlan(fs, projectPaths, "plan-a");
	return { fs, git, projectPaths, planPaths };
}
