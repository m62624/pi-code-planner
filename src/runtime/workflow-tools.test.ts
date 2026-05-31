import { join } from "node:path";
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
	initializeMemoryFiles,
	upsertFileEntries,
	writeMemoryCheckpoint,
} from "../memory/manager";
import { createMemoryStoragePaths } from "../memory/paths";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "../storage/paths";
import { initializePlanFiles } from "../storage/plan-store";
import { ensureProjectRecord, setActivePlan } from "../storage/project-store";
import {
	createInitialPlanState,
	createPlanRecord,
	type PlanStateRecord,
} from "../storage/schema";
import { initializePlanState, readPlanState } from "../storage/state-store";
import { MockPlannerFs } from "../test/mock-fs";
import {
	executePlannerWorkflowTool,
	type PlannerWorkflowToolName,
	workflowToolTransition,
} from "./workflow-tools";

describe("planner workflow tools", () => {
	it("maps public workflow tool calls to state transitions", () => {
		expect(transition("planner_start_step")).toEqual({ type: "start_step" });
		expect(transition("planner_advance_step")).toEqual({
			type: "advance_step",
		});
		expect(transition("planner_retry_step")).toEqual({ type: "retry_step" });
		expect(transition("planner_complete_compact")).toEqual({
			type: "complete_compact",
		});
		expect(
			transition("planner_resume_after_recovery", {
				targetStage: "discovery",
				targetStep: "read_project",
			}),
		).toEqual({
			type: "resume_after_recovery",
			target: { stage: "discovery", step: "read_project" },
		});
	});

	it("maps complete_step optional next target for decision steps", () => {
		expect(
			transition("planner_finish_step", {
				nextStage: "finalize",
				nextStep: "verify_plan_branch",
			}),
		).toEqual({
			type: "finish_step",
			next: { stage: "finalize", step: "verify_plan_branch" },
		});
		expect(transition("planner_finish_step")).toEqual({
			type: "finish_step",
		});
	});

	it("normalizes reason-bearing workflow tools", () => {
		expect(transition("planner_fail_step", { reason: "tests failed" })).toEqual(
			{
				type: "fail_step",
				reason: "tests failed",
			},
		);
		expect(
			transition("planner_block_step", {
				reason: "needs user",
				requiresUserDecision: true,
			}),
		).toEqual({
			type: "block_step",
			reason: "needs user",
			requiresUserDecision: true,
		});
		expect(
			transition("planner_request_compact", {
				reason: "compact before planning",
			}),
		).toEqual({
			type: "request_compact",
			reason: "compact before planning",
		});
		expect(
			transition("planner_enter_recovery", {
				reason: "wrong branch",
				requiresUserDecision: true,
			}),
		).toEqual({
			type: "enter_recovery",
			reason: "wrong branch",
			requiresUserDecision: true,
		});
	});

	it("executes public workflow tools through preflight and persists state", async () => {
		const setup = await createWorkflowSetup({ stepStatus: "pending" });

		const result = await executePlannerWorkflowTool({
			fs: setup.fs,
			git: new MockGitRunner(),
			projectPaths: setup.projectPaths,
			toolName: "planner_start_step",
			params: {},
		});

		expect(result.result).toMatchObject({ status: "applied" });
		expect(result.text).toContain("Planner transition applied: start_step");
		expect(await readPlanState(setup.fs, setup.planPaths)).toMatchObject({
			stage: "init",
			step: "check_project",
			stepStatus: "running",
		});
	});
});

function transition(toolName: PlannerWorkflowToolName, params: unknown = {}) {
	return workflowToolTransition(toolName, params);
}

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
		return ["src/a.ts"];
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

async function createWorkflowSetup(statePatch: Partial<PlanStateRecord> = {}) {
	const fs = new MockPlannerFs();
	const projectPaths = createProjectStoragePaths({
		agentDir: "/agent",
		projectRoot: "/repo/app",
	});
	const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
	const memoryPaths = createMemoryStoragePaths(planPaths);
	const worktreePath = "/repo/app/.pi/pi-code-planner/worktrees/plan-a";
	await ensureProjectRecord(fs, projectPaths);
	await initializePlanFiles(
		fs,
		planPaths,
		createPlanRecord({ planId: "plan-a", title: "Plan A" }),
	);
	await initializePlanState(fs, planPaths, {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/plan-a",
			worktreePath,
		}),
		currentBranch: "plan/plan-a",
		lastCheckpointCommit: "abc123",
		...statePatch,
	});
	await initializeMemoryFiles(fs, memoryPaths);
	await fs.writeText(
		join(worktreePath, "src/a.ts"),
		"export const value = 1;\n",
	);
	await upsertFileEntries(fs, memoryPaths, [
		{
			path: "src/a.ts",
			kind: "source",
			language: "ts",
			hash: "5d8f65d2774e206bc9f7a7a4ad39ca2dc563b5c31e46ab57ef4874961237ce29",
			status: "indexed",
			summary: "A",
		},
	]);
	await writeMemoryCheckpoint(fs, memoryPaths, "abc123");
	await setActivePlan(fs, projectPaths, "plan-a");
	return { fs, projectPaths, planPaths };
}
