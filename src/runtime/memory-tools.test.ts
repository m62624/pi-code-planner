import { createHash } from "node:crypto";
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
	readFileIndex,
	readMemoryDirtyState,
	readSymbolIndex,
	upsertFileEntries,
	writeMemoryCheckpoint,
} from "../memory/manager";
import { createMemoryStoragePaths } from "../memory/paths";
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
import { executePlannerMemoryTool } from "./memory-tools";

class MockGitRunner implements GitRunner {
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

describe("planner memory tools", () => {
	it("runs the full stale-memory cycle and clears the gate only after clean verification", async () => {
		const fs = new MockPlannerFs();
		const setup = await createMemoryToolSetup(fs, {
			state: {
				lastCheckpointCommit: "old123",
				requiresMemoryUpdate: true,
				memoryUpdateReason: "planner_commit",
			},
			fileContent: "export const value = 2;\n",
			indexedHash: "old-hash",
			checkpointCommit: "old123",
		});
		const git = new MockGitRunner({ head: "new456", files: ["src/a.ts"] });

		const inspect = await executePlannerMemoryTool({
			fs,
			git,
			projectPaths: setup.projectPaths,
			toolName: "planner_memory_inspect",
			params: {},
		});
		expect(inspect.status).toBe("applied");
		expect(inspect.text).toContain("Files to reindex: src/a.ts");

		const appliedFreshness = await executePlannerMemoryTool({
			fs,
			git,
			projectPaths: setup.projectPaths,
			toolName: "planner_memory_apply_freshness",
			params: { detectedAt: "2026-05-24T10:00:00.000Z" },
		});
		expect(appliedFreshness.status).toBe("applied");
		expect(await readFileIndex(fs, setup.memoryPaths)).toMatchObject([
			{ path: "src/a.ts", status: "dirty" },
		]);
		expect(await readMemoryDirtyState(fs, setup.memoryPaths)).toMatchObject({
			files: {
				"src/a.ts": {
					reason: "file_hash_changed",
					detectedAt: "2026-05-24T10:00:00.000Z",
				},
			},
		});

		const blockedSync = await executePlannerMemoryTool({
			fs,
			git,
			projectPaths: setup.projectPaths,
			toolName: "planner_memory_sync_checkpoint",
			params: {},
		});
		expect(blockedSync.status).toBe("blocked");
		expect(await readPlanState(fs, setup.planPaths)).toMatchObject({
			lastCheckpointCommit: "old123",
			requiresMemoryUpdate: true,
		});

		const write = await executePlannerMemoryTool({
			fs,
			git,
			projectPaths: setup.projectPaths,
			toolName: "planner_memory_write_batch",
			params: {
				files: [
					{
						path: "src/a.ts",
						kind: "source",
						language: "ts",
						hash: hashOf("export const value = 2;\n"),
						status: "indexed",
						summary: "Exports value.",
					},
				],
				symbols: [
					{
						id: "sym_value",
						path: "src/a.ts",
						language: "ts",
						name: "value",
						qualifiedName: "value",
						kind: "function",
						signature: "value: number",
						summary: "Exported value.",
						visibility: "public",
						effects: {
							reads: [],
							writes: [],
							io: [],
							globalState: "none",
						},
						anchor: { searchText: "value" },
						verification: {
							fileHash: hashOf("export const value = 2;\n"),
							status: "verified",
						},
					},
				],
			},
		});
		expect(write.status).toBe("applied");
		expect(write.text).toContain("Accepted: 2");
		expect(await readSymbolIndex(fs, setup.memoryPaths)).toMatchObject([
			{ id: "sym_value", effects: { globalState: "none" } },
		]);

		const verify = await executePlannerMemoryTool({
			fs,
			git,
			projectPaths: setup.projectPaths,
			toolName: "planner_memory_verify",
			params: {},
		});
		expect(verify.status).toBe("applied");
		expect(verify.text).toContain("Planner memory is fresh");

		const synced = await executePlannerMemoryTool({
			fs,
			git,
			projectPaths: setup.projectPaths,
			toolName: "planner_memory_sync_checkpoint",
			params: {},
		});
		expect(synced.status).toBe("applied");
		expect(await readPlanState(fs, setup.planPaths)).toMatchObject({
			lastCheckpointCommit: "new456",
			requiresMemoryUpdate: false,
			memoryUpdateReason: null,
		});
		expect(await readMemoryDirtyState(fs, setup.memoryPaths)).toEqual({
			files: {},
		});
	});

	it("blocks memory tools when policy does not allow them", async () => {
		const fs = new MockPlannerFs();
		const setup = await createMemoryToolSetup(fs, {
			state: {
				stage: "execution",
				step: "run_experiment",
				stepStatus: "running",
				requiresMemoryUpdate: false,
			},
			fileContent: "export const value = 1;\n",
			indexedHash: hashOf("export const value = 1;\n"),
			checkpointCommit: "abc123",
		});

		const result = await executePlannerMemoryTool({
			fs,
			git: new MockGitRunner({ files: ["src/a.ts"] }),
			projectPaths: setup.projectPaths,
			toolName: "planner_memory_write_batch",
			params: { files: [] },
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("blocked");
	});

	it("blocks checkpoint sync while the worktree is dirty even when memory hashes are fresh", async () => {
		const fs = new MockPlannerFs();
		const content = "export const value = 2;\n";
		const setup = await createMemoryToolSetup(fs, {
			state: {
				lastCheckpointCommit: "old123",
				requiresMemoryUpdate: true,
				memoryUpdateReason: "planner_commit",
			},
			fileContent: content,
			indexedHash: hashOf(content),
			checkpointCommit: "old123",
		});

		const result = await executePlannerMemoryTool({
			fs,
			git: new MockGitRunner({
				head: "new456",
				status: " M src/a.ts",
				files: ["src/a.ts"],
			}),
			projectPaths: setup.projectPaths,
			toolName: "planner_memory_sync_checkpoint",
			params: {},
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("worktree is dirty");
		expect(await readPlanState(fs, setup.planPaths)).toMatchObject({
			lastCheckpointCommit: "old123",
			requiresMemoryUpdate: true,
			memoryUpdateReason: "planner_commit",
		});
	});
});

async function createMemoryToolSetup(
	fs: MockPlannerFs,
	input: {
		state: Partial<PlanStateRecord>;
		fileContent: string;
		indexedHash: string;
		checkpointCommit: string;
	},
): Promise<{
	projectPaths: ProjectStoragePaths;
	planPaths: ReturnType<typeof createPlanStoragePaths>;
	memoryPaths: ReturnType<typeof createMemoryStoragePaths>;
}> {
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
		...input.state,
	});
	await initializeMemoryFiles(fs, planPaths);
	await fs.writeText(join(worktreePath, "src/a.ts"), input.fileContent);
	await upsertFileEntries(fs, memoryPaths, [
		{
			path: "src/a.ts",
			kind: "source",
			language: "ts",
			hash: input.indexedHash,
			status: "indexed",
			summary: "A",
		},
	]);
	await writeMemoryCheckpoint(fs, memoryPaths, input.checkpointCommit);
	await setActivePlan(fs, projectPaths, "plan-a");
	return { projectPaths, planPaths, memoryPaths };
}

function hashOf(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
