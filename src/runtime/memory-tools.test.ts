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
import { writeMemoryIndexingState } from "../memory/indexing";
import {
	initializeMemoryFiles,
	readFileIndex,
	readMemoryDirtyState,
	readProjectPatterns,
	readRelationIndex,
	readSymbolIndex,
	upsertFileEntries,
	upsertSymbolEntries,
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
	it("returns a bounded mechanical project map before selective source search", async () => {
		const fs = new MockPlannerFs();
		const setup = await createMemoryToolSetup(fs, {
			state: {
				stage: "discovery",
				step: "scan_project_structure",
				stepStatus: "running",
			},
			fileContent: "export const unrelated = 1;\n",
			indexedHash: hashOf("export const unrelated = 1;\n"),
			checkpointCommit: "abc123",
		});

		const result = await executePlannerMemoryTool({
			fs,
			git: new MockGitRunner({
				files: ["package.json", "src/index.ts", "tests/index.test.ts"],
			}),
			projectPaths: setup.projectPaths,
			toolName: "planner_memory_project_map",
			params: {},
		});

		expect(result.status).toBe("applied");
		expect(result.details).toMatchObject({
			result: {
				totalFiles: 3,
				manifests: ["package.json"],
				entrypoints: ["src/index.ts"],
				testPaths: ["tests/index.test.ts"],
			},
		});
	});

	it("searches the project mechanically and queues only selected relevant files", async () => {
		const fs = new MockPlannerFs();
		const setup = await createMemoryToolSetup(fs, {
			state: {
				stage: "discovery",
				step: "scan_project_structure",
				stepStatus: "running",
			},
			fileContent: "export const unrelated = 1;\n",
			indexedHash: hashOf("export const unrelated = 1;\n"),
			checkpointCommit: "abc123",
		});
		const worktreePath = "/repo/app/.pi/pi-code-planner/worktrees/plan-a";
		await fs.writeText(
			join(worktreePath, "src/config.ts"),
			"export function parseConfig(input: string) {\n\treturn input;\n}\n",
		);
		const git = new MockGitRunner({ files: ["src/a.ts", "src/config.ts"] });

		const search = await executePlannerMemoryTool({
			fs,
			git,
			projectPaths: setup.projectPaths,
			toolName: "planner_memory_search_project",
			params: { query: "parse config", limit: 1 },
		});
		expect(search.status).toBe("applied");
		expect(search.text).toContain("src/config.ts");

		const scan = await executePlannerMemoryTool({
			fs,
			git,
			projectPaths: setup.projectPaths,
			toolName: "planner_memory_scan_project",
			params: { paths: ["src/config.ts"] },
		});
		expect(scan.status).toBe("applied");
		expect(scan.details).toMatchObject({
			state: { files: [{ path: "src/config.ts", status: "pending" }] },
			summary: { total: 1, pending: 1 },
		});
	});

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

		const scan = await executePlannerMemoryTool({
			fs,
			git,
			projectPaths: setup.projectPaths,
			toolName: "planner_memory_scan_project",
			params: {},
		});
		expect(scan.status).toBe("applied");
		expect(scan.text).toContain("Mode: refresh");

		await expect(
			executePlannerMemoryTool({
				fs,
				git,
				projectPaths: setup.projectPaths,
				toolName: "planner_memory_next_file",
				params: {},
			}),
		).resolves.toMatchObject({ status: "applied" });
		await expect(
			executePlannerMemoryTool({
				fs,
				git,
				projectPaths: setup.projectPaths,
				toolName: "planner_memory_read_chunk",
				params: {},
			}),
		).resolves.toMatchObject({ status: "applied" });
		const writeFile = await executePlannerMemoryTool({
			fs,
			git,
			projectPaths: setup.projectPaths,
			toolName: "planner_memory_upsert_active_file",
			params: {
				kind: "source",
				language: "ts",
				summary: "Exports value.",
			},
		});
		expect(writeFile.status).toBe("applied");
		expect(await readFileIndex(fs, setup.memoryPaths)).toMatchObject([
			{
				path: "src/a.ts",
				hash: hashOf("export const value = 2;\n"),
				status: "indexed",
			},
		]);

		const writeSymbols = await executePlannerMemoryTool({
			fs,
			git,
			projectPaths: setup.projectPaths,
			toolName: "planner_memory_upsert_symbols",
			params: {
				symbols: [
					{
						name: "value",
						kind: "constant",
						signature: "value: number",
						anchorSearchText: "value",
						summary: "Exported value.",
						effects: {
							reads: [],
							writes: [],
							io: [],
							globalState: "none",
						},
					},
				],
			},
		});
		expect(writeSymbols.status).toBe("applied");
		expect(writeSymbols.text).toContain("Accepted: 1");
		expect(await readSymbolIndex(fs, setup.memoryPaths)).toMatchObject([
			{
				id: expect.stringMatching(/^sym_/),
				language: "ts",
				qualifiedName: "value",
				visibility: "unknown",
				effects: { globalState: "none" },
				anchor: { searchText: "value" },
				verification: {
					fileHash: hashOf("export const value = 2;\n"),
					status: "verified",
				},
			},
		]);

		await expect(
			executePlannerMemoryTool({
				fs,
				git,
				projectPaths: setup.projectPaths,
				toolName: "planner_memory_verify_active_file",
				params: {},
			}),
		).resolves.toMatchObject({ status: "applied" });
		await expect(
			executePlannerMemoryTool({
				fs,
				git,
				projectPaths: setup.projectPaths,
				toolName: "planner_memory_complete_active_file",
				params: {},
			}),
		).resolves.toMatchObject({ status: "applied" });

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
			toolName: "planner_memory_scan_project",
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

	it("blocks global verification and checkpoint sync until the active indexing file is completed", async () => {
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

		await executePlannerMemoryTool({
			fs,
			git,
			projectPaths: setup.projectPaths,
			toolName: "planner_memory_scan_project",
			params: {},
		});
		await executePlannerMemoryTool({
			fs,
			git,
			projectPaths: setup.projectPaths,
			toolName: "planner_memory_next_file",
			params: {},
		});
		await executePlannerMemoryTool({
			fs,
			git,
			projectPaths: setup.projectPaths,
			toolName: "planner_memory_read_chunk",
			params: {},
		});
		await executePlannerMemoryTool({
			fs,
			git,
			projectPaths: setup.projectPaths,
			toolName: "planner_memory_upsert_active_file",
			params: {
				kind: "source",
				language: "ts",
				summary: "Exports value.",
			},
		});

		const verify = await executePlannerMemoryTool({
			fs,
			git,
			projectPaths: setup.projectPaths,
			toolName: "planner_memory_verify",
			params: {},
		});
		expect(verify.status).toBe("blocked");
		expect(verify.text).toContain("indexing queue is incomplete");
		expect(verify.text).toContain("verifying=1");

		const sync = await executePlannerMemoryTool({
			fs,
			git,
			projectPaths: setup.projectPaths,
			toolName: "planner_memory_sync_checkpoint",
			params: {},
		});
		expect(sync.status).toBe("blocked");
		expect(sync.text).toContain("indexing queue is incomplete");
		expect(await readPlanState(fs, setup.planPaths)).toMatchObject({
			lastCheckpointCommit: "old123",
			requiresMemoryUpdate: true,
		});
	});

	it("writes project patterns only to the managed memory artifact", async () => {
		const fs = new MockPlannerFs();
		const setup = await createMemoryToolSetup(fs, {
			state: {
				stage: "discovery",
				step: "write_project_patterns",
				stepStatus: "running",
			},
			fileContent: "export const value = 1;\n",
			indexedHash: hashOf("export const value = 1;\n"),
			checkpointCommit: "abc123",
		});

		const result = await executePlannerMemoryTool({
			fs,
			git: new MockGitRunner({ files: ["src/a.ts"] }),
			projectPaths: setup.projectPaths,
			toolName: "planner_memory_write_project_patterns",
			params: { content: "# Patterns\n\nUse Vitest." },
		});

		expect(result.status, result.text).toBe("applied");
		await expect(readProjectPatterns(fs, setup.memoryPaths)).resolves.toBe(
			"# Patterns\n\nUse Vitest.",
		);
		expect(
			fs.snapshot()[join(setup.planPaths.planDir, "project_patterns.md")],
		).toBeUndefined();
	});

	it("returns an exact rejection reason for invalid active file metadata", async () => {
		const fs = new MockPlannerFs();
		const setup = await createMemoryToolSetup(fs, {
			state: {
				stage: "discovery",
				step: "index_files_iteratively",
				stepStatus: "running",
			},
			fileContent: "export const value = 1;\n",
			indexedHash: hashOf("export const value = 1;\n"),
			checkpointCommit: "abc123",
		});

		const result = await executePlannerMemoryTool({
			fs,
			git: new MockGitRunner({ files: ["src/a.ts"] }),
			projectPaths: setup.projectPaths,
			toolName: "planner_memory_upsert_active_file",
			params: {
				kind: "module",
				language: "ts",
				summary: "Invalid kind on purpose.",
			},
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("kind has unsupported value: module");
	});

	it("requires symbols to reference a file indexed through the file wrapper first", async () => {
		const fs = new MockPlannerFs();
		const setup = await createMemoryToolSetup(fs, {
			state: {
				stage: "discovery",
				step: "index_files_iteratively",
				stepStatus: "running",
			},
			fileContent: "export const value = 1;\n",
			indexedHash: hashOf("export const value = 1;\n"),
			checkpointCommit: "abc123",
		});

		const result = await executePlannerMemoryTool({
			fs,
			git: new MockGitRunner({ files: ["src/a.ts"] }),
			projectPaths: setup.projectPaths,
			toolName: "planner_memory_upsert_symbols",
			params: {
				symbols: [symbolEntry({ path: "src/missing.ts" })],
			},
		});

		expect(result.status, result.text).toBe("applied");
		expect(result.text).toContain("Rejected: 1");
		expect(result.text).toContain("must match the active verifying file");
	});

	it("rejects symbol batches larger than five entries", async () => {
		const fs = new MockPlannerFs();
		const content = "export const value = 1;\n";
		const setup = await createMemoryToolSetup(fs, {
			state: {
				stage: "discovery",
				step: "index_files_iteratively",
				stepStatus: "running",
			},
			fileContent: content,
			indexedHash: hashOf(content),
			checkpointCommit: "abc123",
		});
		await writeMemoryIndexingState(fs, setup.memoryPaths, {
			mode: "initial_discovery",
			activeFile: "src/a.ts",
			files: [
				{
					path: "src/a.ts",
					hash: hashOf(content),
					status: "verifying",
					lineCount: 1,
					nextUnreadLine: 2,
					candidateSymbolIds: [],
					verificationPassed: false,
					failureReason: null,
				},
			],
		});

		const result = await executePlannerMemoryTool({
			fs,
			git: new MockGitRunner({ files: ["src/a.ts"] }),
			projectPaths: setup.projectPaths,
			toolName: "planner_memory_upsert_symbols",
			params: {
				symbols: Array.from({ length: 6 }, () => symbolEntry()),
			},
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("accepts at most 5 entries");
	});

	it("writes evidence-backed relations through the dedicated wrapper", async () => {
		const fs = new MockPlannerFs();
		const setup = await createMemoryToolSetup(fs, {
			state: {
				stage: "discovery",
				step: "write_relations",
				stepStatus: "running",
			},
			fileContent: "export const value = 1;\n",
			indexedHash: hashOf("export const value = 1;\n"),
			checkpointCommit: "abc123",
		});
		await upsertSymbolEntries(fs, setup.memoryPaths, [
			{
				...symbolEntry(),
				verification: {
					fileHash: hashOf("export const value = 1;\n"),
					status: "verified",
				},
			},
		]);
		await writeMemoryCheckpoint(fs, setup.memoryPaths, "abc123");

		const result = await executePlannerMemoryTool({
			fs,
			git: new MockGitRunner({ files: ["src/a.ts"] }),
			projectPaths: setup.projectPaths,
			toolName: "planner_memory_upsert_relations",
			params: {
				relations: [
					{
						from: "value",
						to: null,
						kind: "exposes",
						evidenceSearchText: "value",
					},
				],
			},
		});

		expect(result.status).toBe("applied");
		expect(result.text).toContain("Accepted: 1");
		await expect(
			readRelationIndex(fs, setup.memoryPaths),
		).resolves.toMatchObject([
			{
				id: expect.stringMatching(/^rel_/),
				from: "sym_value",
				kind: "exposes",
			},
		]);
	});

	it("exposes bounded memory retrieval instead of dumping the full index", async () => {
		const fs = new MockPlannerFs();
		const setup = await createMemoryToolSetup(fs, {
			state: {
				stage: "planning",
				step: "read_memory",
				stepStatus: "running",
			},
			fileContent: "export const value = 1;\n",
			indexedHash: hashOf("export const value = 1;\n"),
			checkpointCommit: "abc123",
		});
		await fs.writeText(
			join("/repo/app/.pi/pi-code-planner/worktrees/plan-a", "src/b.ts"),
			"export const other = 2;\n",
		);
		await upsertFileEntries(fs, setup.memoryPaths, [
			{
				path: "src/b.ts",
				kind: "source",
				language: "ts",
				hash: hashOf("export const other = 2;\n"),
				status: "indexed",
				summary: "B",
			},
		]);
		await writeMemoryCheckpoint(fs, setup.memoryPaths, "abc123");

		const result = await executePlannerMemoryTool({
			fs,
			git: new MockGitRunner({ files: ["src/a.ts", "src/b.ts"] }),
			projectPaths: setup.projectPaths,
			toolName: "planner_memory_search",
			params: { limits: { files: 1 } },
		});

		expect(result.status).toBe("applied");
		const details = result.details as {
			result: {
				files: {
					entries: unknown[];
					totalMatched: number;
					nextCursor: number | null;
				};
			};
		};
		expect(details.result.files.entries).toHaveLength(1);
		expect(details.result.files.totalMatched).toBe(2);
		expect(details.result.files.nextCursor).toBe(1);
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

function symbolEntry(input: { path?: string } = {}) {
	return {
		id: "sym_value",
		path: input.path ?? "src/a.ts",
		language: "ts",
		name: "value",
		qualifiedName: "value",
		kind: "constant" as const,
		signature: "value: number",
		summary: "Exported value.",
		visibility: "public" as const,
		effects: {
			reads: [],
			writes: [],
			io: [],
			globalState: "none" as const,
		},
		anchor: { searchText: "value" },
	};
}
