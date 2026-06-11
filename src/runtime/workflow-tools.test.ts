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
import type { PlannerFs } from "../storage/fs";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
	createTaskStoragePaths,
	type ProjectStoragePaths,
} from "../storage/paths";
import {
	initializePlanFiles,
	readPlanRecord,
	updatePlanRecord,
} from "../storage/plan-store";
import { ensureProjectRecord, setActivePlan } from "../storage/project-store";
import { createInitialPlanState, createPlanRecord } from "../storage/schema";
import { initializePlanState } from "../storage/state-store";
import { readTaskRecord, upsertTaskArtifacts } from "../storage/task-store";
import { MockPlannerFs } from "../test/mock-fs";
import {
	executePlannerWorkflowTool,
	workflowToolTransition,
} from "./workflow-tools";

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

describe("workflowToolTransition", () => {
	it("rejects unknown stage ids instead of casting them", () => {
		expect(() =>
			workflowToolTransition("planner_finish_step", {
				nextStage: "finalization",
				nextStep: "verify_plan_branch",
			}),
		).toThrow("nextStage must be one of");
	});

	it("rejects steps that do not belong to the selected stage", () => {
		expect(() =>
			workflowToolTransition("planner_finish_step", {
				nextStage: "finalize",
				nextStep: "prepare_task",
			}),
		).toThrow("nextStep must be one of finalize steps");
	});

	it("returns a blocked tool result for invalid exact stage ids", async () => {
		const result = await executePlannerWorkflowTool({
			fs: {} as PlannerFs,
			git: {} as GitRunner,
			projectPaths: {} as ProjectStoragePaths,
			toolName: "planner_finish_step",
			params: {
				nextStage: "finalization",
				nextStep: "verify_plan_branch",
			},
		});

		expect(result.result.status).toBe("blocked");
		expect(result.text).toContain("nextStage must be one of");
		expect(result.text).toContain("Call planner_status");
	});

	it("marks existing tasks done when returning from a change request to planning", async () => {
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
			stage: "done",
			step: "handle_change_request",
			stepStatus: "running",
			currentBranch: "plan/plan-a",
		});
		await setActivePlan(fs, projectPaths, "plan-a");
		const taskPaths = await upsertTaskArtifacts(fs, planPaths, {
			taskId: "old-task",
			title: "Old task",
			objective: "Already implemented.",
			scope: ["src/a.ts"],
			acceptanceCriteria: ["Old task passes."],
		});
		await updatePlanRecord(fs, planPaths, (plan) => ({
			...plan,
			tasks: [{ taskId: "old-task", title: "Old task", status: "pending" }],
		}));
		await fs.writeTextAtomic(
			planPaths.decisionsMd,
			"## Change Request\n\nFix remaining vault gaps.\n",
		);
		await fs.writeTextAtomic(
			planPaths.planMd,
			[
				"## Change Request Replan",
				"",
				"### Completed Work",
				"- Old implementation exists.",
				"",
				"### Remaining Work",
				"- Fix storage and recovery.",
				"",
			].join("\n"),
		);
		await fs.writeTextAtomic(
			planPaths.discoveryMd,
			[
				"## Post-Implementation Snapshot",
				"",
				"### Completed Work",
				"- Old implementation exists.",
				"",
				"### Remaining Work",
				"- Fix storage and recovery.",
				"",
			].join("\n"),
		);

		const result = await executePlannerWorkflowTool({
			fs,
			git,
			projectPaths,
			toolName: "planner_finish_step",
			params: {},
		});

		expect(result.result.status).toBe("applied");
		expect(result.result.state).toMatchObject({
			stage: "planning",
			step: "read_context",
		});
		await expect(readPlanRecord(fs, planPaths)).resolves.toMatchObject({
			tasks: [{ taskId: "old-task", status: "done" }],
		});
		await expect(
			readTaskRecord(fs, createTaskStoragePaths(planPaths, "old-task")),
		).resolves.toMatchObject({ status: "done" });
		await expect(readTaskRecord(fs, taskPaths.paths)).resolves.toMatchObject({
			status: "done",
		});
	});

	it("requires a recorded doubt review before leaving finalize doubt_review", async () => {
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
			stage: "finalize",
			step: "doubt_review",
			stepStatus: "running",
			currentBranch: "plan/plan-a",
		});
		await setActivePlan(fs, projectPaths, "plan-a");
		await fs.writeTextAtomic(planPaths.verifyMd, "Checks passed.\n");

		const blocked = await executePlannerWorkflowTool({
			fs,
			git,
			projectPaths,
			toolName: "planner_finish_step",
			params: {
				nextStage: "finalize",
				nextStep: "write_final_summary",
			},
		});

		expect(blocked.result.status).toBe("blocked");
		expect(blocked.text).toContain("Doubt Review");

		await fs.writeTextAtomic(
			planPaths.verifyMd,
			[
				"# Doubt Review",
				"",
				"## Summary",
				"",
				"No actionable concern found.",
				"",
				"## Possible Errors",
				"",
				"### 1. resume-selection-bug",
				"",
				"- riskCategory: user_flow_regression",
				"- status: disproven",
				"- proofLevel: disproven_by_code",
				"- nextAction: no_action",
				"- claim: Resume selection compares labels instead of ids.",
				"- specReference: goal.md resume behavior",
				"- codePath: src/commands/resume.ts",
				"- verification: Inspected adapter and confirmed selected value is vaultChatId.",
				"",
				"#### Evidence",
				"- Selection value is vaultChatId.",
				"",
				"#### Counter Evidence",
				"- (none)",
				"",
			].join("\n"),
		);
		const applied = await executePlannerWorkflowTool({
			fs,
			git,
			projectPaths,
			toolName: "planner_finish_step",
			params: {
				nextStage: "finalize",
				nextStep: "write_final_summary",
			},
		});

		expect(applied.result.status).toBe("applied");
		expect(applied.result.state).toMatchObject({
			stage: "finalize",
			step: "write_final_summary",
		});
	});

	it("returns final doubt review with proven bugs to planning", async () => {
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
			stage: "finalize",
			step: "doubt_review",
			stepStatus: "running",
			currentBranch: "plan/plan-a",
		});
		await setActivePlan(fs, projectPaths, "plan-a");
		await fs.writeTextAtomic(
			planPaths.verifyMd,
			[
				"# Doubt Review",
				"",
				"## Summary",
				"",
				"One proven bug remains.",
				"",
				"## Possible Errors",
				"",
				"### 1. storage-root-bug",
				"",
				"- riskCategory: persistence_error",
				"- status: proven_bug",
				"- proofLevel: code_path_proven",
				"- nextAction: create_revision_task",
				"- claim: Storage root uses cwd-local directory instead of agent extension dir.",
				"- specReference: goal.md storage root requirement",
				"- codePath: src/index.ts",
				"- verification: Traced createNodeFs argument to ctx.cwd/.pi path.",
				"",
				"#### Evidence",
				"- Runtime path is ctx.cwd/.pi/extensions/pi-session-vault.",
				"",
				"#### Counter Evidence",
				"- (none)",
				"",
			].join("\n"),
		);

		const summaryBlocked = await executePlannerWorkflowTool({
			fs,
			git,
			projectPaths,
			toolName: "planner_finish_step",
			params: {
				nextStage: "finalize",
				nextStep: "write_final_summary",
			},
		});
		expect(summaryBlocked.result.status).toBe("blocked");
		expect(summaryBlocked.text).toContain("proven bugs");

		await fs.writeTextAtomic(
			planPaths.decisionsMd,
			"## Doubt Review\n\n- storage-root-bug must become a revision task.\n",
		);
		const returned = await executePlannerWorkflowTool({
			fs,
			git,
			projectPaths,
			toolName: "planner_finish_step",
			params: {
				nextStage: "planning",
				nextStep: "read_context",
			},
		});

		expect(returned.result.status).toBe("applied");
		expect(returned.result.state).toMatchObject({
			stage: "planning",
			step: "read_context",
		});
	});
});
