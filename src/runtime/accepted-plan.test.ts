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
import {
	ensureProjectRecord,
	readProjectRecord,
	setActivePlan,
	upsertProjectPlanSummary,
} from "../storage/project-store";
import {
	createInitialPlanState,
	createPlanRecord,
	type PlanStateRecord,
} from "../storage/schema";
import { initializePlanState } from "../storage/state-store";
import {
	createWorktreeProjectIndexPath,
	saveWorktreeProjectIndex,
} from "../storage/worktree-index";
import { MockPlannerFs } from "../test/mock-fs";
import {
	buildAcceptedPlanCompletionPrompt,
	finalizeAcceptedPlan,
	inspectAcceptedPlan,
} from "./accepted-plan";

class MockGitRunner implements GitRunner {
	status = "";
	branch = "plan/plan-a";
	readonly calls: Array<{ name: string; input: unknown }> = [];

	async init(_input: GitRepoInput): Promise<void> {}
	async currentBranch(input: GitRepoInput): Promise<string> {
		this.calls.push({ name: "currentBranch", input });
		return this.branch;
	}
	async headCommit(_input: GitRepoInput): Promise<string> {
		return "head";
	}
	async statusPorcelain(input: GitRepoInput): Promise<string> {
		this.calls.push({ name: "statusPorcelain", input });
		return this.status;
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
	async createBranch(input: GitCreateBranchInput): Promise<void> {
		this.calls.push({ name: "createBranch", input });
	}
	async deleteBranch(input: GitDeleteBranchInput): Promise<void> {
		this.calls.push({ name: "deleteBranch", input });
	}
	async switchBranch(input: GitSwitchBranchInput): Promise<void> {
		this.calls.push({ name: "switchBranch", input });
	}
	async stageAll(_input: GitRepoInput): Promise<void> {}
	async commit(_input: GitCommitInput): Promise<void> {}
	async merge(input: GitMergeInput): Promise<void> {
		this.calls.push({ name: "merge", input });
	}
	async worktreeAdd(_input: GitWorktreeAddInput): Promise<void> {}
	async worktreeRemove(input: GitWorktreeRemoveInput): Promise<void> {
		this.calls.push({ name: "worktreeRemove", input });
	}
}

async function createFixture(input?: {
	originalSession?: boolean;
	state?: Partial<PlanStateRecord>;
}) {
	const fs = new MockPlannerFs();
	const git = new MockGitRunner();
	const projectPaths = createProjectStoragePaths({
		agentDir: "/agent",
		projectRoot: "/repo/app",
	});
	const planId = "plan-a";
	const planPaths = createPlanStoragePaths(projectPaths, planId);
	const worktreePath = "/repo/app/.pi/pi-code-planner/worktrees/plan-a";
	const originalSessionFile = "/agent/sessions/--repo-app--/original.jsonl";
	await ensureProjectRecord(fs, projectPaths);
	await initializePlanFiles(
		fs,
		planPaths,
		createPlanRecord({ planId, title: "Plan A", status: "active" }),
	);
	const base = createInitialPlanState({
		baseBranch: "main",
		planBranch: "plan/plan-a",
		worktreePath,
	});
	await initializePlanState(fs, planPaths, {
		...base,
		stage: "done",
		step: "await_user_acceptance",
		stepStatus: "running",
		currentBranch: "plan/plan-a",
		managedBranches: {
			tasks: {
				"task-a": {
					task: "task/plan-a/task-a",
					experiments: ["experiment/plan-a/task-a/one"],
					selectedExperiment: "experiment/plan-a/task-a/one",
					refactor: "refactor/plan-a/task-a",
				},
			},
		},
		...(input?.state ?? {}),
	});
	await fs.mkdirp(worktreePath);
	await upsertProjectPlanSummary(fs, projectPaths, {
		planId,
		title: "Plan A",
		status: "active",
	});
	await setActivePlan(fs, projectPaths, planId);
	await saveWorktreeProjectIndex({
		fs,
		agentDir: projectPaths.agentDir,
		record: {
			schemaVersion: 1,
			projectId: projectPaths.projectId,
			projectRoot: projectPaths.projectRoot,
			planId,
			worktreePath,
			originalSessionFile,
		},
	});
	if (input?.originalSession !== false) {
		await fs.writeTextAtomic(originalSessionFile, "{}\n");
	}
	return {
		fs,
		git,
		projectPaths,
		planId,
		planPaths,
		worktreePath,
		originalSessionFile,
	};
}

describe("accepted planner result", () => {
	it("exports one output branch and removes temporary planner state", async () => {
		const fixture = await createFixture();

		const result = await finalizeAcceptedPlan(fixture);

		expect(result.outputBranch).toBe("output/plan-a");
		expect(result.originalSessionExists).toBe(true);
		await expect(fixture.fs.exists(fixture.planPaths.planDir)).resolves.toBe(
			false,
		);
		await expect(
			fixture.fs.exists(
				createWorktreeProjectIndexPath({
					agentDir: "/agent",
					worktreePath: fixture.worktreePath,
				}),
			),
		).resolves.toBe(false);
		await expect(
			readProjectRecord(fixture.fs, fixture.projectPaths),
		).resolves.toMatchObject({ activePlanId: null, plans: [] });
		expect(fixture.git.calls).toContainEqual({
			name: "createBranch",
			input: {
				repoRoot: "/repo/app",
				branch: "output/plan-a",
				fromRef: "main",
			},
		});
		expect(fixture.git.calls).toContainEqual({
			name: "merge",
			input: {
				repoRoot: "/repo/app",
				sourceBranch: "plan/plan-a",
				noFastForward: true,
				message: "feat: export accepted planner result plan-a",
			},
		});
		expect(fixture.git.calls).toContainEqual({
			name: "worktreeRemove",
			input: {
				repoRoot: "/repo/app",
				path: fixture.worktreePath,
				force: false,
			},
		});
		expect(fixture.git.calls).toContainEqual({
			name: "deleteBranch",
			input: {
				repoRoot: "/repo/app",
				branch: "plan/plan-a",
				force: false,
			},
		});
		expect(result.removedChildBranches).toEqual([
			"task/plan-a/task-a",
			"experiment/plan-a/task-a/one",
			"refactor/plan-a/task-a",
		]);
	});

	it("reports missing original JSONL without blocking cleanup preparation", async () => {
		const fixture = await createFixture({ originalSession: false });

		const preview = await inspectAcceptedPlan(fixture);

		expect(preview.originalSessionFile).toBe(fixture.originalSessionFile);
		expect(preview.originalSessionExists).toBe(false);
	});

	it("accepts an explicit user command immediately after result presentation", async () => {
		const fixture = await createFixture({
			state: { stage: "done", step: "present_result", stepStatus: "running" },
		});

		await expect(inspectAcceptedPlan(fixture)).resolves.toMatchObject({
			planId: "plan-a",
			outputBranch: "output/plan-a",
		});
	});

	it("blocks acceptance before result presentation starts", async () => {
		const fixture = await createFixture({
			state: { stage: "done", step: "present_result", stepStatus: "pending" },
		});

		await expect(inspectAcceptedPlan(fixture)).rejects.toThrow(
			"allowed only after result presentation",
		);
	});

	it("blocks acceptance outside done/await_user_acceptance", async () => {
		const fixture = await createFixture({
			state: { stage: "finalize", step: "write_final_summary" },
		});

		await expect(inspectAcceptedPlan(fixture)).rejects.toThrow(
			"allowed only after result presentation",
		);
	});

	it("blocks acceptance while the worktree is dirty", async () => {
		const fixture = await createFixture();
		fixture.git.status = " M src/index.ts\n";

		await expect(inspectAcceptedPlan(fixture)).rejects.toThrow(
			"requires a clean worktree",
		);
	});

	it("builds a searchable completion handoff message", () => {
		expect(
			buildAcceptedPlanCompletionPrompt({
				planId: "plan-a",
				outputBranch: "output/plan-a",
				originalSessionMissing: true,
				preservedWorktreeChatDir: "/agent/sessions/worktree",
			}),
		).toContain("[SYSTEM_INSTRUCTIONS]\n\nPlanner plan plan-a is complete.");
		expect(
			buildAcceptedPlanCompletionPrompt({
				planId: "plan-a",
				outputBranch: "output/plan-a",
				originalSessionMissing: false,
			}),
		).toContain("Pi returned to the original project JSONL session.");
	});
});
