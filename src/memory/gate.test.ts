import { createHash } from "node:crypto";
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
import { MockPlannerFs } from "../test/mock-fs";
import {
	applyMemoryGateFreshness,
	inspectMemoryGate,
	MEMORY_GATE_REQUIRED_CHECKS,
} from "./gate";
import {
	initializeMemoryFiles,
	readFileIndex,
	readRelationIndex,
	readSymbolIndex,
	upsertFileEntries,
	upsertRelationEntries,
	upsertSymbolEntries,
} from "./manager";
import type {
	MemoryFileEntry,
	MemoryRelationEntry,
	MemorySymbolEntry,
} from "./schema";

class MockGitRunner implements GitRunner {
	constructor(private readonly files: string[]) {}

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
		return this.files;
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

describe("memory gate", () => {
	it("returns continue when memory matches the current project snapshot", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);
		await fs.writeText("/repo/app/src/config.ts", "export const config = 1;\n");
		await upsertFileEntries(fs, paths, [
			fileEntry("src/config.ts", hashOf("export const config = 1;\n")),
		]);

		const result = await inspectMemoryGate({
			fs,
			git: new MockGitRunner(["src/config.ts"]),
			repoRoot: "/repo/app",
			memoryPaths: paths,
		});

		expect(result.clean).toBe(true);
		expect(result.nextAction).toBe("continue");
		expect(result.requiredChecks).toEqual([]);
		expect(result.instruction).toContain("Memory matches");
	});

	it("requires file, symbol, relation, and effects checks when memory is stale", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);
		await fs.writeText("/repo/app/src/config.ts", "export const config = 2;\n");
		await fs.writeText("/repo/app/src/test.ts", "config;\n");
		await upsertFileEntries(fs, paths, [
			fileEntry("src/config.ts", "old-hash"),
			fileEntry("src/test.ts", hashOf("config;\n")),
		]);
		await upsertSymbolEntries(fs, paths, [
			symbolEntry("sym_config", "src/config.ts"),
			symbolEntry("sym_test", "src/test.ts"),
		]);
		await upsertRelationEntries(fs, paths, [
			relationEntry("rel_test_config", "sym_test", "sym_config", "src/test.ts"),
		]);

		const result = await inspectMemoryGate({
			fs,
			git: new MockGitRunner(["src/config.ts", "src/test.ts"]),
			repoRoot: "/repo/app",
			memoryPaths: paths,
		});

		expect(result.clean).toBe(false);
		expect(result.nextAction).toBe("update_memory");
		expect(result.requiredChecks).toEqual(MEMORY_GATE_REQUIRED_CHECKS);
		expect(result.freshness.filesToReindex).toEqual(["src/config.ts"]);
		expect(result.freshness.affectedSymbolIds).toEqual(["sym_config"]);
		expect(result.freshness.affectedRelationIds).toEqual(["rel_test_config"]);
		expect(result.instruction).toContain("Required checks");
		expect(result.instruction).toContain("effects");
		expect(result.instruction).toContain('globalState="unknown"');
	});

	it("requires memory update for new files that are not in the file index yet", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);
		await fs.writeText("/repo/app/src/new.ts", "export const value = 1;\n");

		const result = await inspectMemoryGate({
			fs,
			git: new MockGitRunner(["src/new.ts"]),
			repoRoot: "/repo/app",
			memoryPaths: paths,
		});

		expect(result.clean).toBe(false);
		expect(result.nextAction).toBe("update_memory");
		expect(result.requiredChecks).toEqual(MEMORY_GATE_REQUIRED_CHECKS);
		expect(result.freshness.newFiles).toEqual(["src/new.ts"]);
		expect(result.freshness.filesToReindex).toEqual(["src/new.ts"]);
		expect(result.instruction).toContain("New files: src/new.ts.");
	});

	it("requires memory update for indexed files missing from the current snapshot", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);
		await upsertFileEntries(fs, paths, [
			fileEntry("src/deleted.ts", "old-hash"),
		]);
		await upsertSymbolEntries(fs, paths, [
			symbolEntry("sym_deleted", "src/deleted.ts"),
		]);

		const result = await applyMemoryGateFreshness({
			fs,
			git: new MockGitRunner([]),
			repoRoot: "/repo/app",
			memoryPaths: paths,
			detectedAt: "2026-05-24T07:10:00.000Z",
		});

		expect(result.clean).toBe(false);
		expect(result.freshness.missingFiles).toEqual(["src/deleted.ts"]);
		expect(result.instruction).toContain(
			"Missing indexed files: src/deleted.ts.",
		);
		expect((await readFileIndex(fs, paths))[0]).toMatchObject({
			path: "src/deleted.ts",
			status: "missing",
		});
		expect((await readSymbolIndex(fs, paths))[0]).toMatchObject({
			id: "sym_deleted",
			verification: { status: "missing" },
		});
	});

	it("keeps gate blocked when git lists a file that is missing from disk", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);

		const result = await inspectMemoryGate({
			fs,
			git: new MockGitRunner(["src/missing-unindexed.ts"]),
			repoRoot: "/repo/app",
			memoryPaths: paths,
		});

		expect(result.clean).toBe(false);
		expect(result.nextAction).toBe("update_memory");
		expect(result.snapshot.missingFiles).toEqual(["src/missing-unindexed.ts"]);
		expect(result.requiredChecks).toEqual(MEMORY_GATE_REQUIRED_CHECKS);
	});

	it("applies freshness so stale entries become dirty before model memory update", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);
		await fs.writeText("/repo/app/src/config.ts", "export const config = 2;\n");
		await upsertFileEntries(fs, paths, [
			fileEntry("src/config.ts", "old-hash"),
		]);
		await upsertSymbolEntries(fs, paths, [
			symbolEntry("sym_config", "src/config.ts"),
		]);

		const result = await applyMemoryGateFreshness({
			fs,
			git: new MockGitRunner(["src/config.ts"]),
			repoRoot: "/repo/app",
			memoryPaths: paths,
			detectedAt: "2026-05-24T07:00:00.000Z",
		});

		expect(result.clean).toBe(false);
		expect((await readFileIndex(fs, paths))[0]).toMatchObject({
			path: "src/config.ts",
			status: "dirty",
		});
		expect((await readSymbolIndex(fs, paths))[0]).toMatchObject({
			id: "sym_config",
			verification: { status: "stale" },
		});
	});

	it("clean apply leaves indexes unchanged and does not require checks", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);
		await fs.writeText("/repo/app/src/config.ts", "export const config = 1;\n");
		const file = fileEntry(
			"src/config.ts",
			hashOf("export const config = 1;\n"),
		);
		const symbol = symbolEntry("sym_config", "src/config.ts");
		await upsertFileEntries(fs, paths, [file]);
		await upsertSymbolEntries(fs, paths, [symbol]);

		const result = await applyMemoryGateFreshness({
			fs,
			git: new MockGitRunner(["src/config.ts"]),
			repoRoot: "/repo/app",
			memoryPaths: paths,
			detectedAt: "2026-05-24T07:20:00.000Z",
		});

		expect(result.clean).toBe(true);
		expect(result.nextAction).toBe("continue");
		expect(result.requiredChecks).toEqual([]);
		expect(await readFileIndex(fs, paths)).toEqual([file]);
		expect(await readSymbolIndex(fs, paths)).toEqual([symbol]);
		expect(await readRelationIndex(fs, paths)).toEqual([]);
	});
});

async function initializeTestMemory(fs: MockPlannerFs) {
	const projectPaths = createProjectStoragePaths({
		agentDir: "/agent",
		projectRoot: "/repo/app",
	});
	const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
	return await initializeMemoryFiles(fs, planPaths);
}

function fileEntry(path: string, hash: string): MemoryFileEntry {
	return {
		path,
		kind: "source",
		language: "ts",
		hash,
		status: "indexed",
		summary: `${path} summary.`,
	};
}

function symbolEntry(id: string, path: string): MemorySymbolEntry {
	return {
		id,
		path,
		language: "ts",
		kind: "constant",
		name: id.replace(/^sym_/, ""),
		qualifiedName: id.replace(/^sym_/, ""),
		signature: `const ${id.replace(/^sym_/, "")}: number`,
		summary: `${id} summary.`,
		visibility: "public",
		effects: {
			reads: [],
			writes: [],
			io: [],
			globalState: "none",
		},
		anchor: {
			searchText: id.replace(/^sym_/, ""),
		},
		verification: {
			fileHash: "old-hash",
			status: "verified",
		},
	};
}

function relationEntry(
	id: string,
	from: string,
	to: string | null,
	evidencePath: string,
): MemoryRelationEntry {
	return {
		id,
		from,
		to,
		kind: "tests",
		evidencePath,
		evidenceSearchText: "config",
	};
}

function hashOf(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}
