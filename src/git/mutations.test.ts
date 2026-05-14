import { describe, expect, it } from "vitest";
import { RuntimeStateManager } from "../planner-state/runtime";
import {
	loadPlannerRuntimeState,
	savePlannerRuntimeState,
} from "../planner-state/store";
import { createSettingsPaths } from "../settings/paths";
import { MemoryFs } from "../test/memory-fs";
import { GitMutationRejected, GitMutations } from "./mutations";
import type { RepoState } from "./state";
import { emptyGitStatusSummary, type GitStatusSummary } from "./status-parser";
import type { GitWriter } from "./write";

class MockGitWriter implements GitWriter {
	calls: string[] = [];
	failNext: Error | null = null;

	async initRepo() {
		return this.record("initRepo");
	}

	async createBranch(branchName: string, startPoint?: string) {
		return this.record(`createBranch:${branchName}:${startPoint ?? ""}`);
	}

	async createAndSwitchBranch(branchName: string, startPoint?: string) {
		return this.record(
			`createAndSwitchBranch:${branchName}:${startPoint ?? ""}`,
		);
	}

	async switchBranch(branchName: string) {
		return this.record(`switchBranch:${branchName}`);
	}

	async deleteBranch(branchName: string) {
		return this.record(`deleteBranch:${branchName}`);
	}

	async stageFiles(files: string[]) {
		return this.record(`stageFiles:${files.join(",")}`);
	}

	async stageAll() {
		return this.record("stageAll");
	}

	async unstageFiles(files: string[]) {
		return this.record(`unstageFiles:${files.join(",")}`);
	}

	async commit(message: string) {
		return this.record(`commit:${message}`);
	}

	async mergeBranch(branchName: string) {
		return this.record(`mergeBranch:${branchName}`);
	}

	async softReset(ref: string) {
		return this.record(`softReset:${ref}`);
	}

	async hardReset(ref: string) {
		return this.record(`hardReset:${ref}`);
	}

	private async record(call: string) {
		this.calls.push(call);
		if (this.failNext) throw this.failNext;
		return { stdout: "", stderr: "" };
	}
}

const paths = createSettingsPaths({
	agentDir: "/agent",
	cwd: "/repo",
	extensionName: "pi-planner",
});

function status(changes: Partial<GitStatusSummary> = {}): GitStatusSummary {
	const next = { ...emptyGitStatusSummary(), ...changes };
	next.hasStagedChanges = next.stagedFiles.length > 0;
	next.hasUnstagedChanges = next.unstagedFiles.length > 0;
	next.hasUntrackedFiles = next.untrackedFiles.length > 0;
	next.hasConflicts = next.conflictedFiles.length > 0;
	next.isDirty =
		next.hasStagedChanges ||
		next.hasUnstagedChanges ||
		next.hasUntrackedFiles ||
		next.hasConflicts;
	return next;
}

function repo(overrides: Partial<RepoState> = {}): RepoState {
	return {
		cwd: "/repo",
		repoRoot: "/repo",
		isRepo: true,
		currentBranch: "planner/plan",
		currentCommit: "abc123",
		isDetachedHead: false,
		status: status(),
		...overrides,
	};
}

function setup(repoStates: RepoState[]) {
	const fs = new MemoryFs();
	const writer = new MockGitWriter();
	const state = new RuntimeStateManager({ paths, fs });
	let index = 0;
	const mutations = new GitMutations({
		state,
		writer,
		readRepoState: async () =>
			repoStates[Math.min(index++, repoStates.length - 1)],
		now: () => "2026-05-14T00:00:00.000Z",
		createOperationId: () => "op-1",
	});
	return { fs, state, writer, mutations };
}

function saveActivePlan(fs: MemoryFs) {
	savePlannerRuntimeState(paths, fs, {
		version: 1,
		mode: "plan_active",
		activePlanId: "plan-1",
		activeWorkItemId: "work-1",
		git: {
			baseBranch: "main",
			planBranch: "planner/plan",
			expectedBranch: "planner/plan",
			expectedCommit: "abc123",
			lastObservedCommit: "abc123",
		},
		pendingOperation: null,
		branches: {
			baseBranch: "main",
			planBranch: "planner/plan",
			items: {
				main: {
					name: "main",
					kind: "base",
					planId: null,
					workItemId: null,
					createdFromCommit: null,
					lastKnownCommit: "abc123",
					status: "active",
				},
				"planner/plan": {
					name: "planner/plan",
					kind: "plan",
					planId: "plan-1",
					workItemId: null,
					createdFromCommit: "abc123",
					lastKnownCommit: "abc123",
					status: "active",
				},
				"planner/plan/work/parser": {
					name: "planner/plan/work/parser",
					kind: "child",
					planId: "plan-1",
					workItemId: "work-1",
					createdFromCommit: "abc123",
					lastKnownCommit: "abc123",
					status: "active",
				},
				"planner/plan/work/parser/try-a": {
					name: "planner/plan/work/parser/try-a",
					kind: "experiment",
					planId: "plan-1",
					workItemId: "work-1",
					createdFromCommit: "abc123",
					lastKnownCommit: "abc123",
					status: "active",
				},
			},
		},
	});
}

describe("GitMutations", () => {
	it("creates a plan branch and persists plan git state", async () => {
		const { writer, mutations } = setup([
			repo({ currentBranch: "main", currentCommit: "abc123" }),
			repo({ currentBranch: "planner/plan", currentCommit: "abc123" }),
		]);

		const result = await mutations.createPlanBranch({
			planId: "plan-1",
			branchName: "planner/plan",
			startPoint: "main",
		});

		expect(writer.calls).toEqual(["createAndSwitchBranch:planner/plan:main"]);
		expect(result.state.git).toMatchObject({
			baseBranch: "main",
			planBranch: "planner/plan",
			expectedBranch: "planner/plan",
			expectedCommit: "abc123",
		});
		expect(result.state.branches.items["planner/plan"]).toMatchObject({
			kind: "plan",
			status: "active",
		});
	});

	it("commits a work item and clears pending operation", async () => {
		const { fs, state, writer, mutations } = setup([
			repo({ status: status({ unstagedFiles: ["src/a.ts"] }) }),
			repo({ currentCommit: "def456" }),
		]);
		saveActivePlan(fs);
		state.refresh();

		const result = await mutations.commitWorkItem({
			message: "feat: add parser",
		});

		expect(writer.calls).toEqual(["stageAll", "commit:feat: add parser"]);
		expect(result.state).toMatchObject({
			mode: "plan_active",
			pendingOperation: null,
			git: {
				expectedCommit: "def456",
				lastObservedCommit: "def456",
			},
		});
		expect(state.get()).toBe(result.state);
		expect(loadPlannerRuntimeState(paths, fs).git.expectedCommit).toBe(
			"def456",
		);
	});

	it("creates a child branch and registers it", async () => {
		const { fs, state, writer, mutations } = setup([
			repo(),
			repo({
				currentBranch: "planner/plan/work/new-parser",
				currentCommit: "abc123",
			}),
		]);
		saveActivePlan(fs);
		state.refresh();

		const result = await mutations.createChildBranch({
			workItemId: "work-2",
			branchName: "planner/plan/work/new-parser",
		});

		expect(writer.calls).toEqual([
			"createAndSwitchBranch:planner/plan/work/new-parser:",
		]);
		expect(result.state.activeWorkItemId).toBe("work-2");
		expect(
			result.state.branches.items["planner/plan/work/new-parser"],
		).toMatchObject({
			kind: "child",
			workItemId: "work-2",
			status: "active",
		});
	});

	it("creates an experiment branch and registers it", async () => {
		const { fs, state, writer, mutations } = setup([
			repo(),
			repo({
				currentBranch: "planner/plan/work/parser/try-b",
				currentCommit: "abc123",
			}),
		]);
		saveActivePlan(fs);
		state.refresh();

		const result = await mutations.createExperimentBranch({
			workItemId: "work-1",
			branchName: "planner/plan/work/parser/try-b",
		});

		expect(writer.calls).toEqual([
			"createAndSwitchBranch:planner/plan/work/parser/try-b:",
		]);
		expect(
			result.state.branches.items["planner/plan/work/parser/try-b"],
		).toMatchObject({
			kind: "experiment",
			workItemId: "work-1",
			status: "active",
		});
	});

	it("selects an experiment by switching to child branch and merging it", async () => {
		const { fs, state, writer, mutations } = setup([
			repo({
				currentBranch: "planner/plan/work/parser/try-a",
				currentCommit: "abc123",
			}),
			repo({
				currentBranch: "planner/plan/work/parser",
				currentCommit: "abc123",
			}),
			repo({
				currentBranch: "planner/plan/work/parser",
				currentCommit: "abc123",
			}),
			repo({
				currentBranch: "planner/plan/work/parser",
				currentCommit: "def456",
			}),
		]);
		saveActivePlan(fs);
		const storedState = loadPlannerRuntimeState(paths, fs);
		savePlannerRuntimeState(paths, fs, {
			...storedState,
			git: {
				...storedState.git,
				expectedBranch: "planner/plan/work/parser/try-a",
			},
		});
		state.refresh();

		const result = await mutations.selectExperimentBranch({
			branchName: "planner/plan/work/parser/try-a",
			targetBranch: "planner/plan/work/parser",
		});

		expect(writer.calls).toEqual([
			"switchBranch:planner/plan/work/parser",
			"mergeBranch:planner/plan/work/parser/try-a",
		]);
		expect(
			result.state.branches.items["planner/plan/work/parser/try-a"].status,
		).toBe("selected");
		expect(result.state.git.expectedCommit).toBe("def456");
	});

	it("leaves pending operation on disk when a git write fails", async () => {
		const { fs, state, writer, mutations } = setup([
			repo({ status: status({ unstagedFiles: ["src/a.ts"] }) }),
		]);
		saveActivePlan(fs);
		writer.failNext = new Error("git failed");

		await expect(
			mutations.commitWorkItem({ message: "feat: add parser" }),
		).rejects.toThrow("git failed");

		const persisted = loadPlannerRuntimeState(paths, fs);
		expect(persisted).toMatchObject({
			mode: "operation_in_progress",
			pendingOperation: {
				id: "op-1",
				type: "commit",
				before: {
					branch: "planner/plan",
					commit: "abc123",
				},
			},
		});
		expect(state.get()).toEqual(persisted);
	});

	it("rejects mutations blocked by policy before writing pending operation", async () => {
		const { fs, writer, mutations } = setup([repo()]);
		saveActivePlan(fs);

		await expect(
			mutations.commitWorkItem({ message: "feat: add parser" }),
		).rejects.toBeInstanceOf(GitMutationRejected);

		expect(writer.calls).toEqual([]);
		expect(loadPlannerRuntimeState(paths, fs).pendingOperation).toBeNull();
	});

	it("deletes only registered child branches and marks them deleted", async () => {
		const { fs, writer, mutations } = setup([repo(), repo()]);
		saveActivePlan(fs);

		const result = await mutations.deleteBranch({
			branchName: "planner/plan/work/parser",
		});

		expect(writer.calls).toEqual(["deleteBranch:planner/plan/work/parser"]);
		expect(result.state.branches.items["planner/plan/work/parser"].status).toBe(
			"deleted",
		);
	});
});
