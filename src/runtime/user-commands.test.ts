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
import { createPiSessionDir } from "../session/handoff";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
	type ProjectStoragePaths,
} from "../storage/paths";
import { initializePlanFiles, readPlanRecord } from "../storage/plan-store";
import {
	ensureProjectRecord,
	readProjectRecord,
	upsertProjectPlanSummary,
} from "../storage/project-store";
import {
	createInitialPlanState,
	createPlanRecord,
	type PlanStateRecord,
} from "../storage/schema";
import { initializePlanState } from "../storage/state-store";
import { createWorktreeProjectIndexPath } from "../storage/worktree-index";
import { MockPlannerFs } from "../test/mock-fs";
import { executePlannerUserCommand } from "./user-commands";

class MockGitRunner implements GitRunner {
	status = "";
	readonly calls: Array<{ name: string; input: unknown }> = [];

	async init(_input: GitRepoInput): Promise<void> {}
	async currentBranch(_input: GitRepoInput): Promise<string> {
		return "main";
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
	async createBranch(_input: GitCreateBranchInput): Promise<void> {}
	async deleteBranch(input: GitDeleteBranchInput): Promise<void> {
		this.calls.push({ name: "deleteBranch", input });
	}
	async switchBranch(_input: GitSwitchBranchInput): Promise<void> {}
	async stageAll(_input: GitRepoInput): Promise<void> {}
	async commit(_input: GitCommitInput): Promise<void> {}
	async merge(_input: GitMergeInput): Promise<void> {}
	async worktreeAdd(_input: GitWorktreeAddInput): Promise<void> {}
	async worktreeRemove(input: GitWorktreeRemoveInput): Promise<void> {
		this.calls.push({ name: "worktreeRemove", input });
	}
}

async function createProjectFixture(input?: {
	activePlanId?: string | null;
}): Promise<{
	fs: MockPlannerFs;
	git: MockGitRunner;
	projectPaths: ProjectStoragePaths;
}> {
	const fs = new MockPlannerFs();
	const git = new MockGitRunner();
	const projectPaths = createProjectStoragePaths({
		agentDir: "/agent",
		projectRoot: "/repo/app",
	});
	await ensureProjectRecord(fs, projectPaths);
	await createPlanFixture(fs, projectPaths, "plan-a", {
		title: "Plan A",
		worktreePath: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
	});
	await createPlanFixture(fs, projectPaths, "plan-b", {
		title: "Plan B",
		worktreePath: "/repo/app/.pi/pi-code-planner/worktrees/plan-b",
		state: {
			managedBranches: {
				tasks: {
					"task-1": {
						task: "task/plan-b/task-1",
						experiments: ["experiment/plan-b/task-1/one"],
						selectedExperiment: null,
						refactor: "refactor/plan-b/task-1",
					},
				},
			},
			activeBranches: {
				currentTask: "task/plan-b/task-1",
				currentExperiment: null,
				selectedExperiment: null,
			},
		},
	});
	if (input?.activePlanId !== undefined) {
		const project = await readProjectRecord(fs, projectPaths);
		await fs.writeTextAtomic(
			projectPaths.projectJson,
			`${JSON.stringify({ ...project, activePlanId: input.activePlanId }, null, 2)}\n`,
		);
	}
	return { fs, git, projectPaths };
}

async function createPlanFixture(
	fs: MockPlannerFs,
	projectPaths: ProjectStoragePaths,
	planId: string,
	input: {
		title: string;
		worktreePath: string;
		state?: Partial<PlanStateRecord>;
	},
): Promise<void> {
	const planPaths = createPlanStoragePaths(projectPaths, planId);
	await initializePlanFiles(
		fs,
		planPaths,
		createPlanRecord({ planId, title: input.title, status: "active" }),
	);
	const baseState = {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: `plan/${planId}`,
			worktreePath: input.worktreePath,
		}),
		stage: "discovery",
		step: "scan_project_structure",
		stepStatus: "pending",
		currentBranch: `plan/${planId}`,
		activeBranches: {
			...createInitialPlanState({
				baseBranch: "main",
				planBranch: `plan/${planId}`,
			}).activeBranches,
			...(input.state?.activeBranches ?? {}),
		},
		managedBranches: {
			tasks: input.state?.managedBranches?.tasks ?? {},
		},
	} satisfies PlanStateRecord;
	await initializePlanState(fs, planPaths, {
		...baseState,
		...input.state,
		activeBranches: baseState.activeBranches,
		managedBranches: baseState.managedBranches,
	});
	await fs.mkdirp(input.worktreePath);
	await upsertProjectPlanSummary(fs, projectPaths, {
		planId,
		title: input.title,
		status: "active",
	});
}

describe("planner user commands", () => {
	it("lists no plans when project storage was never created", async () => {
		const fs = new MockPlannerFs();
		const git = new MockGitRunner();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});

		const result = await executePlannerUserCommand({
			fs,
			git,
			projectPaths,
			commandName: "planner_get_plan_list",
			params: {},
		});

		expect(result.status).toBe("applied");
		expect(result.text).toBe("No planner plans in this project.");
		expect(result.details).toMatchObject({ project: null, plans: [] });
	});

	it("blocks user plan commands gracefully when project storage was never created", async () => {
		const fs = new MockPlannerFs();
		const git = new MockGitRunner();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});

		for (const [commandName, params] of [
			["planner_rename", { title: "New Title" }],
			["planner_resume", { planId: "plan-a" }],
			["planner_delete", { planId: "plan-a" }],
		] as const) {
			const result = await executePlannerUserCommand({
				fs,
				git,
				projectPaths,
				commandName,
				params,
			});

			expect(result.status).toBe("blocked");
			expect(result.text).toBe(
				"No planner plans in this project. Create one with /planner-create first.",
			);
			expect(result.text).not.toContain("ENOENT");
		}
	});

	it("lists plans for the resolved project with state and broken markers", async () => {
		const { fs, git, projectPaths } = await createProjectFixture({
			activePlanId: "plan-a",
		});
		await fs.removeFile(
			createPlanStoragePaths(projectPaths, "plan-b").stateJson,
		);

		const result = await executePlannerUserCommand({
			fs,
			git,
			projectPaths,
			commandName: "planner_get_plan_list",
			params: {},
		});

		expect(result.status).toBe("applied");
		expect(result.text).toContain(
			"* plan-a [active] discovery/scan_project_structure",
		);
		expect(result.text).toContain("plan-b");
		expect(result.text).toContain("missing state.json");
	});

	it("renames the active plan title without changing its id", async () => {
		const { fs, git, projectPaths } = await createProjectFixture({
			activePlanId: "plan-a",
		});

		const result = await executePlannerUserCommand({
			fs,
			git,
			projectPaths,
			commandName: "planner_rename",
			params: { title: "Renamed Plan" },
		});

		expect(result.status).toBe("applied");
		await expect(
			readPlanRecord(fs, createPlanStoragePaths(projectPaths, "plan-a")),
		).resolves.toMatchObject({ planId: "plan-a", title: "Renamed Plan" });
		await expect(readProjectRecord(fs, projectPaths)).resolves.toMatchObject({
			plans: expect.arrayContaining([
				expect.objectContaining({
					planId: "plan-a",
					title: "Renamed Plan",
				}),
			]),
		});
	});

	it("renames an explicit inactive plan title", async () => {
		const { fs, git, projectPaths } = await createProjectFixture({
			activePlanId: "plan-a",
		});

		const result = await executePlannerUserCommand({
			fs,
			git,
			projectPaths,
			commandName: "planner_rename",
			params: { planId: "plan-b", title: "Background Plan" },
		});

		expect(result.status).toBe("applied");
		await expect(
			readPlanRecord(fs, createPlanStoragePaths(projectPaths, "plan-b")),
		).resolves.toMatchObject({ planId: "plan-b", title: "Background Plan" });
	});

	it("resumes another plan when current and target worktrees are clean", async () => {
		const { fs, git, projectPaths } = await createProjectFixture({
			activePlanId: "plan-a",
		});

		const result = await executePlannerUserCommand({
			fs,
			git,
			projectPaths,
			commandName: "planner_resume",
			params: { planId: "plan-b" },
		});

		expect(result.status).toBe("applied");
		await expect(readProjectRecord(fs, projectPaths)).resolves.toMatchObject({
			activePlanId: "plan-b",
		});
		expect(result.details).toMatchObject({
			worktreePath: "/repo/app/.pi/pi-code-planner/worktrees/plan-b",
		});
		expect(git.calls).toContainEqual({
			name: "statusPorcelain",
			input: { repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a" },
		});
	});

	it("returns worktreePath when resuming the already active plan", async () => {
		const { fs, git, projectPaths } = await createProjectFixture({
			activePlanId: "plan-a",
		});

		const result = await executePlannerUserCommand({
			fs,
			git,
			projectPaths,
			commandName: "planner_resume",
			params: { planId: "plan-a" },
		});

		expect(result.status).toBe("applied");
		expect(result.details).toMatchObject({
			worktreePath: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
		});
	});

	it("blocks resuming another plan from a dirty active plan", async () => {
		const { fs, git, projectPaths } = await createProjectFixture({
			activePlanId: "plan-a",
		});
		git.status = " M src/index.ts";

		const result = await executePlannerUserCommand({
			fs,
			git,
			projectPaths,
			commandName: "planner_resume",
			params: { planId: "plan-b" },
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("dirty worktree");
		await expect(readProjectRecord(fs, projectPaths)).resolves.toMatchObject({
			activePlanId: "plan-a",
		});
	});

	it("deletes active plan, clears active id, and removes worktree chat sessions", async () => {
		const { fs, git, projectPaths } = await createProjectFixture({
			activePlanId: "plan-a",
		});
		git.status = " M src/index.ts";
		const worktreePath = "/repo/app/.pi/pi-code-planner/worktrees/plan-a";
		const sessionDir = createPiSessionDir({
			agentDir: "/agent",
			cwd: worktreePath,
		});
		await fs.writeTextAtomic(`${sessionDir}/active.jsonl`, "{}\n");
		await fs.writeTextAtomic(
			createWorktreeProjectIndexPath({
				agentDir: "/agent",
				worktreePath,
			}),
			"{}\n",
		);

		const result = await executePlannerUserCommand({
			fs,
			git,
			projectPaths,
			commandName: "planner_delete",
			params: {
				planId: "plan-a",
				deleteSessions: true,
			},
		});

		expect(result.status).toBe("applied");
		await expect(readProjectRecord(fs, projectPaths)).resolves.toMatchObject({
			activePlanId: null,
			plans: [expect.objectContaining({ planId: "plan-b" })],
		});
		await expect(
			fs.exists(createPlanStoragePaths(projectPaths, "plan-a").planDir),
		).resolves.toBe(false);
		await expect(fs.exists(sessionDir)).resolves.toBe(false);
		expect(git.calls).toContainEqual({
			name: "worktreeRemove",
			input: {
				repoRoot: "/repo/app",
				path: worktreePath,
			},
		});
		expect(git.calls.some((call) => call.name === "statusPorcelain")).toBe(
			false,
		);
	});

	it("deletes active planner storage best-effort when original project root is gone", async () => {
		const { fs, git, projectPaths } = await createProjectFixture({
			activePlanId: "plan-a",
		});
		const customWorktreePath = "/custom/worktrees/plan-a";
		const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
		await initializePlanState(fs, planPaths, {
			...createInitialPlanState({
				baseBranch: "main",
				planBranch: "plan/plan-a",
				worktreePath: customWorktreePath,
			}),
			stage: "recovery",
			step: "read_state",
			stepStatus: "blocked",
			currentBranch: "plan/plan-a",
			broken: true,
			brokenReason: "original project disappeared",
			requiresUserDecision: true,
		});
		await fs.mkdirp(customWorktreePath);
		await fs.removeDir(projectPaths.projectRoot);

		const result = await executePlannerUserCommand({
			fs,
			git,
			projectPaths,
			commandName: "planner_delete",
			params: {
				planId: "plan-a",
				deleteSessions: true,
			},
		});

		expect(result.status).toBe("applied");
		expect(result.details).toMatchObject({
			projectRootExists: false,
			gitCleanupSkipped: true,
		});
		await expect(readProjectRecord(fs, projectPaths)).resolves.toMatchObject({
			activePlanId: null,
			plans: [expect.objectContaining({ planId: "plan-b" })],
		});
		await expect(fs.exists(customWorktreePath)).resolves.toBe(false);
		expect(git.calls.map((call) => call.name)).not.toContain("worktreeRemove");
		expect(git.calls.map((call) => call.name)).not.toContain("deleteBranch");
	});

	it("deletes inactive clean plan files, worktree index, worktree, and child branches", async () => {
		const { fs, git, projectPaths } = await createProjectFixture({
			activePlanId: "plan-a",
		});
		const worktreePath = "/repo/app/.pi/pi-code-planner/worktrees/plan-b";
		await fs.writeTextAtomic(
			createWorktreeProjectIndexPath({
				agentDir: "/agent",
				worktreePath,
			}),
			"{}\n",
		);

		const result = await executePlannerUserCommand({
			fs,
			git,
			projectPaths,
			commandName: "planner_delete",
			params: { planId: "plan-b", deleteSessions: true },
		});

		expect(result.status).toBe("applied");
		await expect(
			fs.exists(createPlanStoragePaths(projectPaths, "plan-b").planDir),
		).resolves.toBe(false);
		await expect(
			fs.exists(
				createWorktreeProjectIndexPath({
					agentDir: "/agent",
					worktreePath,
				}),
			),
		).resolves.toBe(false);
		await expect(readProjectRecord(fs, projectPaths)).resolves.toMatchObject({
			activePlanId: "plan-a",
			plans: [expect.objectContaining({ planId: "plan-a" })],
		});
		await expect(
			fs.exists(
				createPiSessionDir({
					agentDir: "/agent",
					cwd: worktreePath,
				}),
			),
		).resolves.toBe(false);
		expect(git.calls).toContainEqual({
			name: "worktreeRemove",
			input: {
				repoRoot: "/repo/app",
				path: worktreePath,
			},
		});
		expect(git.calls.filter((call) => call.name === "deleteBranch")).toEqual([
			{
				name: "deleteBranch",
				input: {
					repoRoot: "/repo/app",
					branch: "task/plan-b/task-1",
				},
			},
			{
				name: "deleteBranch",
				input: {
					repoRoot: "/repo/app",
					branch: "experiment/plan-b/task-1/one",
				},
			},
			{
				name: "deleteBranch",
				input: {
					repoRoot: "/repo/app",
					branch: "refactor/plan-b/task-1",
				},
			},
		]);
	});
});
