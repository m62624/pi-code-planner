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
	readSymbolIndex,
	upsertFileEntries,
	upsertSymbolEntries,
} from "./manager";
import type { MemoryFileEntry, MemorySymbolEntry } from "./schema";

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
		await upsertFileEntries(fs, paths, [
			fileEntry("src/config.ts", "old-hash"),
		]);
		await upsertSymbolEntries(fs, paths, [
			symbolEntry("sym_config", "src/config.ts"),
		]);

		const result = await inspectMemoryGate({
			fs,
			git: new MockGitRunner(["src/config.ts"]),
			repoRoot: "/repo/app",
			memoryPaths: paths,
		});

		expect(result.clean).toBe(false);
		expect(result.nextAction).toBe("update_memory");
		expect(result.requiredChecks).toEqual(MEMORY_GATE_REQUIRED_CHECKS);
		expect(result.freshness.filesToReindex).toEqual(["src/config.ts"]);
		expect(result.freshness.affectedSymbolIds).toEqual(["sym_config"]);
		expect(result.instruction).toContain("Required checks");
		expect(result.instruction).toContain("effects");
		expect(result.instruction).toContain('globalState="unknown"');
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

function hashOf(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}
