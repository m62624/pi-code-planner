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
import { executePlannerQuestionTool } from "./question-tools";

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

describe("planner discovery question tools", () => {
	it("persists open questions and requires explicit user answers", async () => {
		const setup = await createQuestionSetup();

		const result = await executePlannerQuestionTool({
			...setup,
			toolName: "planner_questions_submit",
			params: {
				content: "# Questions\n\n1. Should safe find pipelines remain allowed?",
				hasOpenQuestions: true,
			},
		});

		expect(result.status).toBe("applied");
		expect(result.text).toContain("## Questions For User");
		expect(result.text).toContain("Wait for the user's answers");
		expect(setup.fs.snapshot()[setup.planPaths.questionsMd]).toContain(
			"Should safe find pipelines remain allowed?",
		);
		await expect(
			readPlanState(setup.fs, setup.planPaths),
		).resolves.toMatchObject({
			questionsSubmitted: true,
			questionsResolved: false,
		});
	});

	it("records explicit answers before allowing discovery to continue", async () => {
		const setup = await createQuestionSetup({
			questionsSubmitted: true,
			questionsResolved: false,
		});

		const result = await executePlannerQuestionTool({
			...setup,
			toolName: "planner_questions_resolve",
			params: { answers: "Keep read-only find pipelines allowed." },
		});

		expect(result.status).toBe("applied");
		expect(setup.fs.snapshot()[setup.planPaths.decisionsMd]).toContain(
			"Keep read-only find pipelines allowed.",
		);
		expect(setup.fs.snapshot()[setup.planPaths.questionsMd]).toContain(
			"Keep read-only find pipelines allowed.",
		);
		await expect(
			readPlanState(setup.fs, setup.planPaths),
		).resolves.toMatchObject({
			questionsSubmitted: true,
			questionsResolved: true,
		});
	});

	it("allows an explicit no-question artifact without a user round trip", async () => {
		const setup = await createQuestionSetup();

		const result = await executePlannerQuestionTool({
			...setup,
			toolName: "planner_questions_submit",
			params: {
				content: "# Questions\n\nNo unresolved questions remain.",
				hasOpenQuestions: false,
			},
		});

		expect(result.status).toBe("applied");
		await expect(
			readPlanState(setup.fs, setup.planPaths),
		).resolves.toMatchObject({
			questionsSubmitted: true,
			questionsResolved: true,
		});
	});

	it("blocks resolve before submit and duplicate submit after submit", async () => {
		const setup = await createQuestionSetup();

		const resolve = await executePlannerQuestionTool({
			...setup,
			toolName: "planner_questions_resolve",
			params: { answers: "Answer." },
		});
		expect(resolve.status).toBe("blocked");
		expect(resolve.text).toContain("planner_questions_submit");

		await executePlannerQuestionTool({
			...setup,
			toolName: "planner_questions_submit",
			params: {
				content: "# Questions\n\nNo unresolved questions remain.",
				hasOpenQuestions: false,
			},
		});
		const duplicate = await executePlannerQuestionTool({
			...setup,
			toolName: "planner_questions_submit",
			params: {
				content: "# Questions\n\nDuplicate.",
				hasOpenQuestions: false,
			},
		});
		expect(duplicate.status).toBe("blocked");
		expect(duplicate.text).toContain("already submitted");
	});

	it("blocks question submission outside discovery/write_questions", async () => {
		const setup = await createQuestionSetup({
			stage: "planning",
			step: "read_memory",
			stepStatus: "running",
		});

		const result = await executePlannerQuestionTool({
			...setup,
			toolName: "planner_questions_submit",
			params: {
				content: "# Questions\n\nToo late.",
				hasOpenQuestions: false,
			},
		});

		expect(result.status).toBe("blocked");
	});
});

async function createQuestionSetup(
	state: Record<string, unknown> = {},
): Promise<{
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
	await fs.mkdirp(worktreePath);
	await initializePlanState(fs, planPaths, {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/plan-a",
			worktreePath,
		}),
		stage: "discovery",
		step: "write_questions",
		stepStatus: "running",
		currentBranch: "plan/plan-a",
		lastCheckpointCommit: "abc123",
		...state,
	});
	await setActivePlan(fs, projectPaths, "plan-a");
	return { fs, git: new MockGitRunner(), projectPaths, planPaths };
}
