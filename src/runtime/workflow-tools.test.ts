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

	it("blocks discovery finish until discovered contracts are routed and read", async () => {
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
			stage: "discovery",
			step: "scan_project_structure",
			stepStatus: "running",
			currentBranch: "plan/plan-a",
			contracts: {
				...createInitialPlanState({
					baseBranch: "main",
					planBranch: "plan/plan-a",
					worktreePath,
				}).contracts,
				scanComplete: true,
				discoveredPaths: [
					`${worktreePath}/AGENTS.md`,
					`${worktreePath}/src/AGENTS.md`,
				],
			},
		});
		await setActivePlan(fs, projectPaths, "plan-a");
		await fs.writeTextAtomic(planPaths.discoveryMd, "Project overview.\n");

		const unrouted = await executePlannerWorkflowTool({
			fs,
			git,
			projectPaths,
			toolName: "planner_finish_step",
			params: {},
		});

		expect(unrouted.result.status).toBe("blocked");
		expect(unrouted.text).toContain("planner_contract_route");

		await initializePlanState(fs, planPaths, {
			...createInitialPlanState({
				baseBranch: "main",
				planBranch: "plan/plan-a",
				worktreePath,
			}),
			stage: "discovery",
			step: "scan_project_structure",
			stepStatus: "running",
			currentBranch: "plan/plan-a",
			contracts: {
				...createInitialPlanState({
					baseBranch: "main",
					planBranch: "plan/plan-a",
					worktreePath,
				}).contracts,
				scanComplete: true,
				discoveredPaths: [
					`${worktreePath}/AGENTS.md`,
					`${worktreePath}/src/AGENTS.md`,
				],
				activeChains: [
					{
						targetPath: `${worktreePath}/src/runtime/status.ts`,
						chain: [
							`${worktreePath}/AGENTS.md`,
							`${worktreePath}/src/AGENTS.md`,
						],
						reason: "discovery",
						updatedAt: 1000,
					},
				],
			},
		});

		const unread = await executePlannerWorkflowTool({
			fs,
			git,
			projectPaths,
			toolName: "planner_finish_step",
			params: {},
		});

		expect(unread.result.status).toBe("blocked");
		expect(unread.text).toContain("planner_contract_read");

		await initializePlanState(fs, planPaths, {
			...createInitialPlanState({
				baseBranch: "main",
				planBranch: "plan/plan-a",
				worktreePath,
			}),
			stage: "discovery",
			step: "scan_project_structure",
			stepStatus: "running",
			currentBranch: "plan/plan-a",
			contracts: {
				...createInitialPlanState({
					baseBranch: "main",
					planBranch: "plan/plan-a",
					worktreePath,
				}).contracts,
				scanComplete: true,
				discoveredPaths: [
					`${worktreePath}/AGENTS.md`,
					`${worktreePath}/src/AGENTS.md`,
				],
				activeChains: [
					{
						targetPath: `${worktreePath}/src/runtime/status.ts`,
						chain: [
							`${worktreePath}/AGENTS.md`,
							`${worktreePath}/src/AGENTS.md`,
						],
						reason: "discovery",
						updatedAt: 1000,
					},
				],
				summaries: [
					{
						path: `${worktreePath}/AGENTS.md`,
						purpose: "Root.",
						childIndex: [],
						stableContracts: [],
						readFirst: [],
						doNotTouchUnless: [],
						domainDetails: [],
						diagnostics: [],
						updatedAt: 1000,
					},
					{
						path: `${worktreePath}/src/AGENTS.md`,
						purpose: "Source.",
						childIndex: [],
						stableContracts: [],
						readFirst: [],
						doNotTouchUnless: [],
						domainDetails: [],
						diagnostics: [],
						updatedAt: 1000,
					},
				],
			},
		});
		const missingProtocol = await executePlannerWorkflowTool({
			fs,
			git,
			projectPaths,
			toolName: "planner_finish_step",
			params: {},
		});
		expect(missingProtocol.result.status).toBe("blocked");
		expect(missingProtocol.text).toContain("Verification Protocol");

		await fs.writeTextAtomic(
			planPaths.discoveryMd,
			[
				"# Discovery",
				"",
				"## Verification Protocol",
				"- working directory: worktree root",
				"- test: npm test",
				"- build: npm run build",
				"- lint: npm run check",
			].join("\n"),
		);
		const applied = await executePlannerWorkflowTool({
			fs,
			git,
			projectPaths,
			toolName: "planner_finish_step",
			params: {},
		});
		expect(applied.result.status).toBe("applied");
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

	it("lists the branch targets inline when finish_step is ambiguous", async () => {
		const fs = new MockPlannerFs();
		const git = new (class extends MockGitRunner {
			async currentBranch(): Promise<string> {
				return "task/plan-a/fix-a";
			}
		})();
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
		const taskPaths = await upsertTaskArtifacts(fs, planPaths, {
			taskId: "fix-a",
			title: "Fix A",
			objective: "Fix the thing.",
			scope: ["src/a.ts"],
			acceptanceCriteria: ["Tests pass."],
		});
		await fs.writeTextAtomic(
			join(taskPaths.paths.taskDir, "refactor.md"),
			"## Refactor Review\n\nNo refactor needed.\n",
		);
		await initializePlanState(fs, planPaths, {
			...createInitialPlanState({
				baseBranch: "main",
				planBranch: "plan/plan-a",
				worktreePath,
			}),
			stage: "execution",
			step: "run_final_tests",
			stepStatus: "running",
			currentBranch: "task/plan-a/fix-a",
			activeTaskId: "fix-a",
		});
		await setActivePlan(fs, projectPaths, "plan-a");

		const blocked = await executePlannerWorkflowTool({
			fs,
			git,
			projectPaths,
			toolName: "planner_finish_step",
			params: {},
		});

		expect(blocked.result.status).toBe("blocked");
		expect(blocked.result.stateMachineErrorCode).toBe("ambiguous_next_step");
		expect(blocked.text).toContain(
			"Allowed next: {stage: 'execution', step: 'capture_skill'} or {stage: 'execution', step: 'implement_task'} (loops back)",
		);
		expect(blocked.text).toContain(
			"Re-call planner_finish_step with ONE of these as nextStep",
		);
		expect(blocked.text).not.toContain(
			"Call planner_status before choosing the next planner action.",
		);
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
				"## Verification Evidence",
				"",
				"- command: npm test",
				"  status: passed",
				"  evidence: Unit tests passed.",
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
				"## Verification Evidence",
				"",
				"- command: npm test",
				"  status: failed",
				"  evidence: Storage root test failed.",
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

	it("blocks final summary when doubt review dismisses placeholder work", async () => {
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
				"Placeholder concern dismissed.",
				"",
				"## Verification Evidence",
				"",
				"- command: npm test",
				"  status: passed",
				"  evidence: Unit tests passed.",
				"",
				"## Possible Errors",
				"",
				"### 1. placeholder-implementation",
				"",
				"- riskCategory: requirement_mismatch",
				"- status: not_a_bug",
				"- proofLevel: code_path_proven",
				"- nextAction: no_action",
				"- claim: Implementation may still be a placeholder.",
				"- specReference: goal.md accepted behavior",
				"- codePath: src/vault/index.ts",
				"- verification: Only checked that files exist.",
				"",
				"#### Evidence",
				"- Placeholder-looking logic remains.",
				"",
				"#### Counter Evidence",
				"- (none)",
				"",
			].join("\n"),
		);

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
		expect(blocked.text).toContain("must be proven_bug or needs_probe");
	});

	it("blocks planner_finish_step at done/await_user_acceptance unless targeting handle_change_request", async () => {
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
			step: "await_user_acceptance",
			stepStatus: "running",
			currentBranch: "plan/plan-a",
		});
		await setActivePlan(fs, projectPaths, "plan-a");

		const blockedNoTarget = await executePlannerWorkflowTool({
			fs,
			git,
			projectPaths,
			toolName: "planner_finish_step",
			params: {},
		});
		expect(blockedNoTarget.result.status).toBe("blocked");
		expect(blockedNoTarget.text).toContain("/planner-finish");

		const blockedWrongTarget = await executePlannerWorkflowTool({
			fs,
			git,
			projectPaths,
			toolName: "planner_finish_step",
			params: { nextStage: "done", nextStep: "prepare_output_branch" },
		});
		expect(blockedWrongTarget.result.status).toBe("blocked");
		expect(blockedWrongTarget.text).toContain("/planner-finish");

		const allowed = await executePlannerWorkflowTool({
			fs,
			git,
			projectPaths,
			toolName: "planner_finish_step",
			params: { nextStage: "done", nextStep: "handle_change_request" },
		});
		expect(allowed.result.status).toBe("applied");
		expect(allowed.result.state).toMatchObject({
			stage: "done",
			step: "handle_change_request",
		});
	});

	it("blocks planner_finish_step at internal done steps (prepare_output_branch, etc.)", async () => {
		const internalSteps = [
			"prepare_output_branch",
			"merge_or_export_result",
			"cleanup_worktree",
			"mark_done",
			"cleanup_plan_files",
		] as const;

		for (const step of internalSteps) {
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
				step,
				stepStatus: "running",
				currentBranch: "plan/plan-a",
			});
			await setActivePlan(fs, projectPaths, "plan-a");

			const result = await executePlannerWorkflowTool({
				fs,
				git,
				projectPaths,
				toolName: "planner_finish_step",
				params: {},
			});
			expect(result.result.status, `step=${step}`).toBe("blocked");
			expect(result.text, `step=${step}`).toContain("/planner-finish");
		}
	});
});
