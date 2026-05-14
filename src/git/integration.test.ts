import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeStateManager } from "../planner-state/runtime";
import { DEFAULT_SETTINGS } from "../settings/defaults";
import { createSettingsPaths } from "../settings/paths";
import { MemoryFs } from "../test/memory-fs";
import { GitMutations } from "./mutations";
import { NodeGitRunner } from "./runner";
import { getRepoState } from "./state";
import { RunnerGitWriter } from "./write";

function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const describeGit = hasGit() ? describe : describe.skip;

function createTempRepo(): string {
	return mkdtempSync(join(tmpdir(), "pi-planner-"));
}

async function createInitializedRepo(runner: NodeGitRunner): Promise<string> {
	const repo = createTempRepo();
	await runner.exec(repo, ["init"]);
	await runner.exec(repo, ["config", "user.email", "pi-planner@example.test"]);
	await runner.exec(repo, ["config", "user.name", "Pi Planner Test"]);
	writeFileSync(join(repo, "README.md"), "initial\n", "utf-8");
	await runner.exec(repo, ["add", "--all"]);
	await runner.exec(repo, ["commit", "-m", "initial commit"]);
	return repo;
}

function createMutations(repo: string, runner: NodeGitRunner) {
	const fs = new MemoryFs();
	const state = new RuntimeStateManager({
		paths: createSettingsPaths({
			agentDir: "/agent",
			cwd: repo,
			extensionName: "pi-planner",
		}),
		fs,
	});
	state.initialize();

	const writer = new RunnerGitWriter(runner, repo);
	const mutations = new GitMutations({
		state,
		writer,
		branchNaming: DEFAULT_SETTINGS.git.branchNaming,
		readRepoState: () => getRepoState(runner, repo),
		now: () => "2026-05-14T00:00:00.000Z",
		createOperationId: () => "op-1",
	});

	return { state, mutations };
}

describeGit("git integration", () => {
	it("initializes a real temp repo through mutations", async () => {
		const runner = new NodeGitRunner();
		const repo = createTempRepo();
		try {
			const { mutations } = createMutations(repo, runner);

			await mutations.initializeRepo();
			const repoState = await getRepoState(runner, repo);

			expect(repoState.isRepo).toBe(true);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("creates a plan branch and commits a work item in a real temp repo", async () => {
		const runner = new NodeGitRunner();
		const repo = await createInitializedRepo(runner);
		try {
			const { mutations } = createMutations(repo, runner);
			await mutations.createPlanBranch({
				planId: "plan-1",
			});
			writeFileSync(join(repo, "feature.txt"), "feature\n", "utf-8");

			const result = await mutations.commitWorkItem({
				message: "feat: add feature",
			});
			const repoState = await getRepoState(runner, repo);

			expect(repoState.currentBranch).toBe("planner/plan-1/main");
			expect(result.state.git.expectedCommit).toBe(repoState.currentCommit);
			expect(result.state.pendingOperation).toBeNull();
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("creates, switches away from, and deletes a child branch in a real temp repo", async () => {
		const runner = new NodeGitRunner();
		const repo = await createInitializedRepo(runner);
		try {
			const { mutations } = createMutations(repo, runner);
			await mutations.createPlanBranch({
				planId: "plan-1",
			});
			await mutations.createChildBranch({
				workItemId: "work-1",
			});
			await mutations.switchToPlanBranch();

			const result = await mutations.deleteChildBranch({
				workItemId: "work-1",
			});

			expect(
				result.state.branches.items["planner/plan-1/work/work-1"].status,
			).toBe("deleted");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
