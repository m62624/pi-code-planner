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
import {
	createMemoryStoragePaths,
	type MemoryStoragePaths,
} from "../memory/paths";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
	type ProjectStoragePaths,
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
	checkPlannerPreflightToolAllowed,
	formatPlannerPreflightStatus,
	runPlannerPreflight,
} from "./preflight";

class MockGitRunner implements GitRunner {
	currentBranchCalls = 0;
	failInspection = false;

	constructor(
		private readonly input: {
			branch?: string;
			head?: string;
			status?: string;
			files?: string[];
		} = {},
	) {}

	async init(_input: GitRepoInput): Promise<void> {}
	async currentBranch(_input: GitRepoInput): Promise<string> {
		this.currentBranchCalls += 1;
		if (this.failInspection) {
			throw new Error("git failed");
		}
		return this.input.branch ?? "plan/plan-a";
	}
	async headCommit(_input: GitRepoInput): Promise<string> {
		return this.input.head ?? "abc123";
	}
	async statusPorcelain(_input: GitRepoInput): Promise<string> {
		return this.input.status ?? "";
	}
	async diffStat(_input: GitRepoInput): Promise<string> {
		return "";
	}
	async diffNameOnly(_input: GitRepoInput): Promise<string> {
		return "";
	}
	async listProjectFiles(_input: GitRepoInput): Promise<string[]> {
		return this.input.files ?? [];
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

describe("planner preflight orchestrator", () => {
	it("returns inactive decision without touching git when there is no active plan", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = await createProject(fs);
		const git = new MockGitRunner();

		const result = await runPlannerPreflight({ fs, git, projectPaths });

		expect(result.context.status).toBe("no_active_plan");
		expect(result.decision.action).toBe("no_active_plan");
		expect(result.gitReality).toBeNull();
		expect(git.currentBranchCalls).toBe(0);
	});

	it("returns storage recovery before git when active state is missing", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = await createProject(fs);
		const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
		await initializePlanFiles(
			fs,
			planPaths,
			createPlanRecord({ planId: "plan-a", title: "Plan A" }),
		);
		await setActivePlan(fs, projectPaths, "plan-a");
		const git = new MockGitRunner();

		const result = await runPlannerPreflight({ fs, git, projectPaths });

		expect(result.context.status).toBe("missing_state");
		expect(result.decision).toMatchObject({
			action: "require_recovery",
			recoveryReason: "missing_state",
		});
		expect(git.currentBranchCalls).toBe(0);
	});

	it("allows early init worktree creation before worktree exists", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = await createProject(fs);
		await createActivePlan(fs, projectPaths, {
			state: {
				stage: "init",
				step: "create_plan_worktree",
				currentBranch: null,
				worktreePath: null,
				lastCheckpointCommit: null,
			},
			createWorktree: false,
			initializeMemory: false,
		});
		const git = new MockGitRunner();

		const result = await runPlannerPreflight({ fs, git, projectPaths });

		expect(result.decision).toMatchObject({
			action: "allow_stage_machine",
			stage: "init",
			step: "create_plan_worktree",
		});
		expect(result.worktreeExists).toBe(false);
		expect(result.gitReality).toBeNull();
		expect(git.currentBranchCalls).toBe(0);
	});

	it("requires recovery when a post-init worktree is missing", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = await createProject(fs);
		await createActivePlan(fs, projectPaths, { createWorktree: false });
		const git = new MockGitRunner();

		const result = await runPlannerPreflight({ fs, git, projectPaths });

		expect(result.decision).toMatchObject({
			action: "require_recovery",
			recoveryReason: "missing_worktree",
		});
		expect(git.currentBranchCalls).toBe(0);
	});

	it("requires recovery when git reality cannot be inspected", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = await createProject(fs);
		await createActivePlan(fs, projectPaths);
		const git = new MockGitRunner();
		git.failInspection = true;

		const result = await runPlannerPreflight({ fs, git, projectPaths });

		expect(result.decision).toMatchObject({
			action: "require_recovery",
			recoveryReason: "git_unavailable",
		});
		expect(result.gitReality).toBeNull();
	});

	it("requires recovery when memory checkpoint is corrupted", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = await createProject(fs);
		const setup = await createActivePlan(fs, projectPaths);
		await writeMemoryCheckpoint(fs, setup.memoryPaths, "abc123");
		await upsertFileEntries(fs, setup.memoryPaths, [
			{
				path: "src/a.ts",
				kind: "source",
				language: "ts",
				hash: "changed-after-checkpoint",
				status: "indexed",
				summary: "A",
			},
		]);

		const result = await runPlannerPreflight({
			fs,
			git: new MockGitRunner(),
			projectPaths,
		});

		expect(result.memoryCheckpoint?.valid).toBe(false);
		expect(result.memoryGate).toBeNull();
		expect(result.decision).toMatchObject({
			action: "require_recovery",
			recoveryReason: "memory_checkpoint_corrupt",
		});
	});

	it("requires memory update when memory freshness is stale", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = await createProject(fs);
		const setup = await createActivePlan(fs, projectPaths, {
			state: {
				stage: "discovery",
				step: "compact_discovery",
			},
			gitFiles: ["src/a.ts"],
		});
		await fs.writeText(
			join(setup.worktreePath, "src/a.ts"),
			"export const value = 2;\n",
		);
		await upsertFileEntries(fs, setup.memoryPaths, [
			{
				path: "src/a.ts",
				kind: "source",
				language: "ts",
				hash: "old-hash",
				status: "indexed",
				summary: "A",
			},
		]);
		await writeMemoryCheckpoint(fs, setup.memoryPaths, "abc123");

		const result = await runPlannerPreflight({
			fs,
			git: new MockGitRunner({ files: ["src/a.ts"] }),
			projectPaths,
		});

		expect(result.memoryCheckpoint?.valid).toBe(true);
		expect(result.memoryGate?.clean).toBe(false);
		expect(result.decision).toMatchObject({
			action: "require_memory_update",
			memoryUpdateReason: "file_hash_changed",
		});
		expect(
			await readPlanState(fs, createPlanStoragePaths(projectPaths, "plan-a")),
		).toMatchObject({
			requiresMemoryUpdate: true,
			memoryUpdateReason: "file_hash_changed",
		});
	});

	it("does not block normal in-progress work just because uncommitted files differ from memory", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = await createProject(fs);
		const setup = await createActivePlan(fs, projectPaths, {
			state: {
				stage: "execution",
				step: "run_experiment",
				stepStatus: "running",
			},
			gitFiles: ["src/a.ts"],
		});
		await fs.writeText(
			join(setup.worktreePath, "src/a.ts"),
			"export const value = 2;\n",
		);
		await upsertFileEntries(fs, setup.memoryPaths, [
			{
				path: "src/a.ts",
				kind: "source",
				language: "ts",
				hash: "old-hash",
				status: "indexed",
				summary: "A",
			},
		]);
		await writeMemoryCheckpoint(fs, setup.memoryPaths, "abc123");

		const result = await runPlannerPreflight({
			fs,
			git: new MockGitRunner({
				files: ["src/a.ts"],
				status: " M src/a.ts",
			}),
			projectPaths,
		});

		expect(result.memoryGate).toBeNull();
		expect(result.decision.action).toBe("allow_stage_machine");
		expect(
			await readPlanState(fs, createPlanStoragePaths(projectPaths, "plan-a")),
		).toMatchObject({
			requiresMemoryUpdate: false,
			memoryUpdateReason: null,
		});
	});

	it("persists memory update gate when a new git commit changes indexed files", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = await createProject(fs);
		const setup = await createActivePlan(fs, projectPaths, {
			state: { lastCheckpointCommit: "old123" },
			gitFiles: ["src/a.ts"],
		});
		await fs.writeText(
			join(setup.worktreePath, "src/a.ts"),
			"export const value = 2;\n",
		);
		await upsertFileEntries(fs, setup.memoryPaths, [
			{
				path: "src/a.ts",
				kind: "source",
				language: "ts",
				hash: "old-hash",
				status: "indexed",
				summary: "A",
			},
		]);
		await writeMemoryCheckpoint(fs, setup.memoryPaths, "old123");

		const result = await runPlannerPreflight({
			fs,
			git: new MockGitRunner({ head: "new456", files: ["src/a.ts"] }),
			projectPaths,
		});

		expect(result.decision).toMatchObject({
			action: "require_memory_update",
			memoryUpdateReason: "external_commit",
		});
		expect(result.memoryGate?.freshness.filesToReindex).toEqual(["src/a.ts"]);
		expect(result.context.status).toBe("ready");
		if (result.context.status === "ready") {
			expect(result.context.state).toMatchObject({
				requiresMemoryUpdate: true,
				memoryUpdateReason: "external_commit",
			});
		}
		expect(
			await readPlanState(fs, createPlanStoragePaths(projectPaths, "plan-a")),
		).toMatchObject({
			requiresMemoryUpdate: true,
			memoryUpdateReason: "external_commit",
			lastCheckpointCommit: "old123",
		});
	});

	it("allows stage machine when storage, git, checkpoint, and memory are clean", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = await createProject(fs);
		const setup = await createActivePlan(fs, projectPaths);
		await writeMemoryCheckpoint(fs, setup.memoryPaths, "abc123");

		const result = await runPlannerPreflight({
			fs,
			git: new MockGitRunner(),
			projectPaths,
		});

		expect(result.context.status).toBe("ready");
		expect(result.worktreeExists).toBe(true);
		expect(result.gitReality).toMatchObject({
			branch: "plan/plan-a",
			headCommit: "abc123",
		});
		expect(result.memoryCheckpoint?.valid).toBe(true);
		expect(result.memoryGate).toBeNull();
		expect(result.decision.action).toBe("allow_stage_machine");
		expect(result.instructions?.keys).toEqual(["discovery", "memory"]);
		expect(formatPlannerPreflightStatus(result)).toContain(
			"Allowed state transitions: finish_step, fail_step, block_step, enter_recovery",
		);
	});

	it("blocks normal wrappers when runtime preflight derives a memory gate", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = await createProject(fs);
		const setup = await createActivePlan(fs, projectPaths, {
			state: {
				stage: "execution",
				step: "merge_task_to_plan",
				lastCheckpointCommit: "old123",
			},
		});
		await writeMemoryCheckpoint(fs, setup.memoryPaths, "old123");

		const result = await runPlannerPreflight({
			fs,
			git: new MockGitRunner({ head: "new456" }),
			projectPaths,
		});

		expect(result.decision).toMatchObject({
			action: "require_memory_update",
			memoryUpdateReason: "external_commit",
		});
		expect(
			checkPlannerPreflightToolAllowed({
				preflight: result,
				tool: "planner_git_merge_task_to_plan",
			}),
		).toMatchObject({
			allow: false,
			runtimeAction: "require_memory_update",
		});
		expect(
			checkPlannerPreflightToolAllowed({
				preflight: result,
				tool: "planner_memory_upsert_files",
			}).allow,
		).toBe(true);
	});

	it("formats compact status without embedding long stage markdown", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = await createProject(fs);
		const setup = await createActivePlan(fs, projectPaths, {
			state: { requiresCompact: true },
		});
		await writeMemoryCheckpoint(fs, setup.memoryPaths, "abc123");

		const result = await runPlannerPreflight({
			fs,
			git: new MockGitRunner(),
			projectPaths,
		});

		expect(formatPlannerPreflightStatus(result)).toContain(
			"Runtime action: require_compact",
		);
		expect(formatPlannerPreflightStatus(result)).toContain(
			"Allowed planner wrappers: planner_status",
		);
		expect(formatPlannerPreflightStatus(result)).toContain(
			"Instruction keys: discovery, memory",
		);
		expect(formatPlannerPreflightStatus(result)).toContain(
			"default: /agent/extensions/pi-code-planner/instructions/defaults/discovery.md",
		);
		expect(formatPlannerPreflightStatus(result)).toContain(
			"project append: /repo/app/.pi/pi-code-planner/instructions/append/discovery.md",
		);
	});
});

async function createProject(fs: MockPlannerFs): Promise<ProjectStoragePaths> {
	const projectPaths = createProjectStoragePaths({
		agentDir: "/agent",
		projectRoot: "/repo/app",
	});
	await ensureProjectRecord(fs, projectPaths);
	return projectPaths;
}

async function createActivePlan(
	fs: MockPlannerFs,
	projectPaths: ProjectStoragePaths,
	options: {
		state?: Partial<PlanStateRecord>;
		createWorktree?: boolean;
		initializeMemory?: boolean;
		gitFiles?: readonly string[];
	} = {},
): Promise<{
	worktreePath: string;
	memoryPaths: MemoryStoragePaths;
}> {
	const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
	const worktreePath = join(
		projectPaths.projectRoot,
		".pi",
		"pi-code-planner",
		"worktrees",
		"plan-a",
	);
	await initializePlanFiles(
		fs,
		planPaths,
		createPlanRecord({ planId: "plan-a", title: "Plan A" }),
	);
	const state = {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/plan-a",
			worktreePath,
		}),
		stage: "discovery",
		step: "read_project",
		stepStatus: "running",
		currentBranch: "plan/plan-a",
		lastCheckpointCommit: "abc123",
		...options.state,
	} satisfies PlanStateRecord;
	await initializePlanState(fs, planPaths, state);
	await setActivePlan(fs, projectPaths, "plan-a");
	if (options.createWorktree ?? true) {
		await fs.mkdirp(worktreePath);
	}
	const memoryPaths =
		(options.initializeMemory ?? true)
			? await initializeMemoryFiles(fs, planPaths)
			: createMemoryStoragePaths(planPaths);
	for (const file of options.gitFiles ?? []) {
		await fs.writeText(join(worktreePath, file), "");
	}
	return { worktreePath, memoryPaths };
}
