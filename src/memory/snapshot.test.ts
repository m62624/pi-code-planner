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
import { MockPlannerFs } from "../test/mock-fs";
import { createMemoryProjectSnapshot } from "./snapshot";

class MockGitRunner implements GitRunner {
	constructor(private readonly files: string[]) {}

	async init(_input: GitRepoInput): Promise<void> {}
	async currentBranch(_input: GitRepoInput): Promise<string> {
		return "main";
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

describe("memory project snapshot", () => {
	it("hashes git-listed tracked and untracked project files deterministically", async () => {
		const fs = new MockPlannerFs();
		await fs.writeText("/repo/app/src/b.ts", "export const b = 1;\n");
		await fs.writeText("/repo/app/src/a.ts", "export const a = 1;\n");
		const git = new MockGitRunner(["src/b.ts", "src/a.ts", "src/a.ts", ""]);

		const snapshot = await createMemoryProjectSnapshot({
			fs,
			git,
			repoRoot: "/repo/app",
		});

		expect(snapshot).toEqual({
			files: [
				{
					path: "src/a.ts",
					hash: sha256("export const a = 1;\n"),
				},
				{
					path: "src/b.ts",
					hash: sha256("export const b = 1;\n"),
				},
			],
			missingFiles: [],
		});
	});

	it("reports git-listed files missing from disk so freshness can mark them missing", async () => {
		const fs = new MockPlannerFs();
		await fs.writeText("/repo/app/src/a.ts", "export const a = 1;\n");
		const git = new MockGitRunner(["src/a.ts", "src/deleted.ts"]);

		const snapshot = await createMemoryProjectSnapshot({
			fs,
			git,
			repoRoot: "/repo/app",
		});

		expect(snapshot.files).toEqual([
			{
				path: "src/a.ts",
				hash: sha256("export const a = 1;\n"),
			},
		]);
		expect(snapshot.missingFiles).toEqual(["src/deleted.ts"]);
	});
});

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}
