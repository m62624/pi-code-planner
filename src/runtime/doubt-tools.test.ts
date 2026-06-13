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
import { executePlannerDoubtTool } from "./doubt-tools";

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

describe("planner doubt review tool", () => {
	it("writes a structured doubt review", async () => {
		const setup = await createDoubtSetup();

		const result = await executePlannerDoubtTool({
			...setup,
			toolName: "planner_doubt_review",
			params: {
				summary: "One suspected issue was disproven by code inspection.",
				possibleErrors: [
					{
						id: "resume-selection-bug",
						riskCategory: "user_flow_regression",
						status: "disproven",
						proofLevel: "disproven_by_code",
						claim: "Resume selection compares labels instead of ids.",
						specReference: "goal.md resume command requirements",
						codePath: "src/commands/resume.ts",
						verification:
							"Inspected selection adapter and confirmed it returns vaultChatId.",
						evidence: ["Selected option value is vaultChatId, not label text."],
						counterEvidence: [],
						nextAction: "no_action",
					},
				],
			},
		});

		expect(result.status).toBe("applied");
		expect(setup.fs.snapshot()[setup.planPaths.verifyMd]).toContain(
			"## Possible Errors",
		);
		expect(setup.fs.snapshot()[setup.planPaths.verifyMd]).toContain(
			"- riskCategory: user_flow_regression",
		);
		expect(result.text).toContain("Proven bugs: 0");
	});

	it("blocks proven bugs without proof", async () => {
		const setup = await createDoubtSetup();

		const result = await executePlannerDoubtTool({
			...setup,
			toolName: "planner_doubt_review",
			params: {
				summary: "A suspected issue was not proven.",
				possibleErrors: [
					{
						id: "storage-root-bug",
						riskCategory: "persistence_error",
						status: "proven_bug",
						proofLevel: "insufficient_evidence",
						claim: "Storage root is wrong.",
						specReference: "spec storage root",
						codePath: "src/index.ts",
						verification: "Only suspected from reading names.",
						evidence: ["Path looked suspicious."],
						counterEvidence: [],
						nextAction: "create_revision_task",
					},
				],
			},
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("not proof");
	});

	it("requires a valid risk category", async () => {
		const setup = await createDoubtSetup();

		const result = await executePlannerDoubtTool({
			...setup,
			toolName: "planner_doubt_review",
			params: {
				summary: "A suspected issue used an invalid risk category.",
				possibleErrors: [
					{
						id: "unknown-risk",
						riskCategory: "maybe_bad",
						status: "needs_probe",
						proofLevel: "insufficient_evidence",
						claim: "Something might be wrong.",
						specReference: "goal.md",
						codePath: "src/index.ts",
						verification: "No probe yet.",
						evidence: ["Only a suspicion."],
						counterEvidence: [],
						nextAction: "run_probe",
					},
				],
			},
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("riskCategory");
	});

	it("blocks closing placeholder or superficial findings as not_a_bug", async () => {
		const setup = await createDoubtSetup();

		const result = await executePlannerDoubtTool({
			...setup,
			toolName: "planner_doubt_review",
			params: {
				summary: "A placeholder concern was dismissed without proof.",
				possibleErrors: [
					{
						id: "placeholder-implementation",
						riskCategory: "requirement_mismatch",
						status: "not_a_bug",
						proofLevel: "code_path_proven",
						claim:
							"Implementation may still be a placeholder for the actual vault behavior.",
						specReference: "goal.md accepted behavior",
						codePath: "src/vault/index.ts",
						verification: "Only checked that files exist.",
						evidence: ["Placeholder-looking logic remains."],
						counterEvidence: [],
						nextAction: "no_action",
					},
				],
			},
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("must be proven_bug or needs_probe");
	});
});

async function createDoubtSetup() {
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
	return { fs, git, projectPaths, planPaths };
}
