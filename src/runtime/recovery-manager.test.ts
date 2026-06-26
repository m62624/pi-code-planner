import { describe, expect, it } from "vitest";
import type { GitRunner } from "../git/runner";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "../storage/paths";
import { initializePlanFiles } from "../storage/plan-store";
import {
	setActivePlan,
	upsertProjectPlanSummary,
} from "../storage/project-store";
import {
	createInitialPlanState,
	createPlanRecord,
	type PlanStateRecord,
} from "../storage/schema";
import { initializePlanState, readPlanState } from "../storage/state-store";
import { MockPlannerFs } from "../test/mock-fs";
import { repairWrongBranchIfSafe } from "./recovery";
import { resumePlannerRecovery } from "./recovery-manager";

const WORKTREE = "/repo/app/.pi/pi-code-planner/worktrees/plan-a";
const PLAN_BRANCH = "plan/plan-a";
const TASK_BRANCH = "task/plan-a/task-1";

/**
 * Minimal git double for the recovery path: a mutable current branch (so the
 * realigning checkout is observable), a porcelain string to toggle a dirty
 * worktree, and a set of branches that exist. Only the methods the recovery
 * flow touches are implemented; the rest are absent by design.
 */
class RecoveryGitDouble {
	branch: string;
	porcelain = "";
	existingBranches: Set<string>;
	readonly switched: string[] = [];

	constructor(branch: string, existingBranches: string[]) {
		this.branch = branch;
		this.existingBranches = new Set(existingBranches);
	}

	async currentBranch(): Promise<string> {
		return this.branch;
	}
	async headCommit(): Promise<string> {
		return "deadbee";
	}
	async statusPorcelain(): Promise<string> {
		return this.porcelain;
	}
	async branchExists(input: { branch: string }): Promise<boolean> {
		return this.existingBranches.has(input.branch);
	}
	async switchBranch(input: { branch: string }): Promise<void> {
		this.branch = input.branch;
		this.switched.push(input.branch);
	}

	asGitRunner(): GitRunner {
		return this as unknown as GitRunner;
	}
}

async function buildDivergedPlan(options: {
	currentBranch: string;
	stage?: PlanStateRecord["stage"];
	step?: PlanStateRecord["step"];
}) {
	const fs = new MockPlannerFs();
	const projectPaths = createProjectStoragePaths({
		agentDir: "/agent",
		projectRoot: "/repo/app",
	});
	const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
	await upsertProjectPlanSummary(fs, projectPaths, {
		planId: "plan-a",
		title: "plan-a",
		status: "active",
	});
	await initializePlanFiles(
		fs,
		planPaths,
		createPlanRecord({ planId: "plan-a", title: "Plan A" }),
	);
	const base = createInitialPlanState({
		baseBranch: "main",
		planBranch: PLAN_BRANCH,
		worktreePath: WORKTREE,
	});
	const state: PlanStateRecord = {
		...base,
		stage: options.stage ?? "recovery",
		step: options.step ?? "read_state",
		stepStatus: "blocked",
		currentBranch: options.currentBranch,
		activeTaskId: "task-1",
		activeBranches: { ...base.activeBranches, currentTask: TASK_BRANCH },
		// enterPlannerRecovery sets these; they are state-gate issues that the
		// resume itself clears, so they must not block the resume.
		broken: true,
		brokenReason: "diverged",
		requiresUserDecision: true,
	};
	await initializePlanState(fs, planPaths, state);
	await setActivePlan(fs, projectPaths, "plan-a");
	// The recovery inspection probes the worktree dir for existence.
	await fs.mkdirp(WORKTREE);
	return { fs, projectPaths, planPaths, state };
}

describe("repairWrongBranchIfSafe", () => {
	it("realigns a clean worktree to the expected branch", async () => {
		const git = new RecoveryGitDouble(PLAN_BRANCH, [PLAN_BRANCH, TASK_BRANCH]);
		const state = {
			...createInitialPlanState({
				baseBranch: "main",
				planBranch: PLAN_BRANCH,
				worktreePath: WORKTREE,
			}),
			currentBranch: TASK_BRANCH,
		};

		const result = await repairWrongBranchIfSafe({
			git: git.asGitRunner(),
			state,
		});

		expect(result).toEqual({
			repaired: true,
			from: PLAN_BRANCH,
			to: TASK_BRANCH,
			skippedReason: null,
		});
		expect(git.switched).toEqual([TASK_BRANCH]);
		expect(git.branch).toBe(TASK_BRANCH);
	});

	it("does nothing when the worktree is dirty", async () => {
		const git = new RecoveryGitDouble(PLAN_BRANCH, [PLAN_BRANCH, TASK_BRANCH]);
		git.porcelain = " M src/index.ts\n";
		const state = {
			...createInitialPlanState({
				baseBranch: "main",
				planBranch: PLAN_BRANCH,
				worktreePath: WORKTREE,
			}),
			currentBranch: TASK_BRANCH,
		};

		const result = await repairWrongBranchIfSafe({
			git: git.asGitRunner(),
			state,
		});

		expect(result.repaired).toBe(false);
		expect(result.skippedReason).toContain("not clean");
		expect(git.switched).toEqual([]);
	});

	it("does nothing when the expected branch no longer exists", async () => {
		const git = new RecoveryGitDouble(PLAN_BRANCH, [PLAN_BRANCH]);
		const state = {
			...createInitialPlanState({
				baseBranch: "main",
				planBranch: PLAN_BRANCH,
				worktreePath: WORKTREE,
			}),
			currentBranch: TASK_BRANCH,
		};

		const result = await repairWrongBranchIfSafe({
			git: git.asGitRunner(),
			state,
		});

		expect(result.repaired).toBe(false);
		expect(result.skippedReason).toContain("does not exist");
		expect(git.switched).toEqual([]);
	});

	it("is a no-op when the worktree is already on the expected branch", async () => {
		const git = new RecoveryGitDouble(TASK_BRANCH, [PLAN_BRANCH, TASK_BRANCH]);
		const state = {
			...createInitialPlanState({
				baseBranch: "main",
				planBranch: PLAN_BRANCH,
				worktreePath: WORKTREE,
			}),
			currentBranch: TASK_BRANCH,
		};

		const result = await repairWrongBranchIfSafe({
			git: git.asGitRunner(),
			state,
		});

		expect(result.repaired).toBe(false);
		expect(result.skippedReason).toContain("already on the expected branch");
		expect(git.switched).toEqual([]);
	});
});

describe("resumePlannerRecovery wrong_branch self-heal", () => {
	it("realigns the branch and resumes when the worktree is clean", async () => {
		const { fs, projectPaths, planPaths, state } = await buildDivergedPlan({
			currentBranch: TASK_BRANCH,
		});
		const git = new RecoveryGitDouble(PLAN_BRANCH, [PLAN_BRANCH, TASK_BRANCH]);

		const result = await resumePlannerRecovery({
			fs,
			git: git.asGitRunner(),
			projectPaths,
			planPaths,
			state,
			target: { stage: "execution", step: "merge_task_to_plan" } as never,
		});

		expect(result.status).toBe("applied");
		expect(git.switched).toEqual([TASK_BRANCH]);
		expect(result.text).toContain("Repaired wrong_branch");
		expect(result.text).toContain(TASK_BRANCH);
		// The resume persisted the requested target and cleared the recovery gate.
		const persisted = await readPlanState(fs, planPaths);
		expect(persisted).toMatchObject({
			stage: "execution",
			step: "merge_task_to_plan",
			broken: false,
			requiresUserDecision: false,
		});
	});

	it("stays blocked when the diverged worktree is dirty (no auto-switch)", async () => {
		const { fs, projectPaths, planPaths, state } = await buildDivergedPlan({
			currentBranch: TASK_BRANCH,
		});
		const git = new RecoveryGitDouble(PLAN_BRANCH, [PLAN_BRANCH, TASK_BRANCH]);
		git.porcelain = " M src/index.ts\n";

		const result = await resumePlannerRecovery({
			fs,
			git: git.asGitRunner(),
			projectPaths,
			planPaths,
			state,
			target: { stage: "execution", step: "merge_task_to_plan" } as never,
		});

		expect(result.status).toBe("blocked");
		expect(git.switched).toEqual([]);
		if (result.status !== "blocked") {
			throw new Error("expected blocked result");
		}
		expect(result.reason).toContain("wrong_branch");
	});
});
