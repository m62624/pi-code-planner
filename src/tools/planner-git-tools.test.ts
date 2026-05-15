import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { GitCore } from "../git/core";
import type { GitPreflightResult } from "../git/preflight";
import type { RepoState } from "../git/state";
import { emptyGitStatusSummary } from "../git/status-parser";
import { createPlannerGitTools } from "./planner-git-tools";

function repoState(): RepoState {
	return {
		cwd: "/repo",
		repoRoot: "/repo",
		isRepo: true,
		currentBranch: "main",
		currentCommit: "abc123",
		isDetachedHead: false,
		status: emptyGitStatusSummary(),
	};
}

function preflight(overrides: Partial<GitPreflightResult>): GitPreflightResult {
	const repo = repoState();
	return {
		operation: "start_plan",
		allowed: true,
		kind: "allow",
		message: "allowed",
		recovery: {
			status: "inactive",
			requiresRecovery: false,
			message: "No planner runtime is active.",
			currentBranch: null,
			expectedBranch: null,
		},
		repoState: repo,
		...overrides,
	};
}

function context(): ExtensionContext {
	return {
		cwd: "/repo",
	} as ExtensionContext;
}

describe("createPlannerGitTools", () => {
	it("registers provider-safe planner tool names", () => {
		const tools = createPlannerGitTools(() => ({}) as GitCore);

		expect(tools.map((tool) => tool.name)).toEqual([
			"planner_initialize_repo",
			"planner_start_plan",
			"planner_start_work_item",
			"planner_start_experiment",
			"planner_select_experiment",
			"planner_finish_work_item",
			"planner_delete_child_branch",
			"planner_delete_experiment_branch",
			"planner_accept_current_git_state",
			"planner_soft_reset_to_expected",
			"planner_hard_reset_to_expected",
		]);
	});

	it("does not call mutations when preflight blocks the tool", async () => {
		const createPlanBranch = vi.fn();
		const core = {
			preflight: {
				check: vi.fn().mockResolvedValue(
					preflight({
						allowed: false,
						kind: "block",
						message: "Start plan requires a clean worktree.",
					}),
				),
			},
			mutations: { createPlanBranch },
		} as unknown as GitCore;
		const tool = createPlannerGitTools(() => core).find(
			(candidate) => candidate.name === "planner_start_plan",
		);

		const result = await tool?.execute(
			"call-1",
			{ planId: "plan-1" },
			undefined,
			undefined,
			context(),
		);

		expect(createPlanBranch).not.toHaveBeenCalled();
		expect(result?.content[0]).toMatchObject({
			type: "text",
			text: "Start plan requires a clean worktree.",
		});
	});

	it("routes successful tools through GitCore mutations", async () => {
		const mutationResult = {
			before: repoState(),
			after: repoState(),
			state: { mode: "idle" },
		};
		const initializeRepo = vi.fn().mockResolvedValue(mutationResult);
		const core = {
			preflight: {
				check: vi.fn().mockResolvedValue(
					preflight({
						operation: "initialize_repo",
						allowed: true,
						kind: "allow",
						message: "Git repository can be initialized.",
					}),
				),
			},
			mutations: { initializeRepo },
		} as unknown as GitCore;
		const tool = createPlannerGitTools(() => core).find(
			(candidate) => candidate.name === "planner_initialize_repo",
		);

		const result = await tool?.execute(
			"call-1",
			{},
			undefined,
			undefined,
			context(),
		);

		expect(initializeRepo).toHaveBeenCalledTimes(1);
		expect(result?.details).toBe(mutationResult);
	});

	it("blocks finishing a work item when project memory is dirty", async () => {
		const commitWorkItem = vi.fn();
		const core = {
			preflight: {
				check: vi.fn().mockResolvedValue(
					preflight({
						operation: "finish_work_item",
						allowed: true,
						kind: "allow",
						message: "Work item can be committed.",
					}),
				),
			},
			mutations: { commitWorkItem },
		} as unknown as GitCore;
		const tool = createPlannerGitTools(
			() => core,
			() => ({
				files: {
					"src/config.ts": {
						filePath: "src/config.ts",
						reason: "edit result",
						markedAt: "2026-05-15T00:00:00.000Z",
					},
				},
			}),
		).find((candidate) => candidate.name === "planner_finish_work_item");

		const result = await tool?.execute(
			"call-1",
			{ message: "feat: update config", stageAll: true },
			undefined,
			undefined,
			context(),
		);

		expect(commitWorkItem).not.toHaveBeenCalled();
		expect(result?.content[0].text).toBe(
			"Project memory has 1 dirty file(s); run signature_refresh before finish_work_item.",
		);
		expect(result?.details).toMatchObject({
			memoryPolicy: {
				kind: "block",
				dirtyFiles: ["src/config.ts"],
			},
		});
	});

	it("allows finishing a work item with dirty memory when policy is disabled", async () => {
		const mutationResult = {
			before: repoState(),
			after: repoState(),
			state: { mode: "idle" },
		};
		const commitWorkItem = vi.fn().mockResolvedValue(mutationResult);
		const core = {
			preflight: {
				check: vi.fn().mockResolvedValue(
					preflight({
						operation: "finish_work_item",
						allowed: true,
						kind: "allow",
						message: "Work item can be committed.",
					}),
				),
			},
			mutations: { commitWorkItem },
		} as unknown as GitCore;
		const dirty = () => ({
			files: {
				"src/config.ts": {
					filePath: "src/config.ts",
					reason: "edit result",
					markedAt: "2026-05-15T00:00:00.000Z",
				},
			},
		});
		const tool = createPlannerGitTools(
			() => core,
			dirty,
			() => ({
				blockCompact: true,
				blockWorkItemCommit: false,
				blockSignatureRefreshExit: true,
			}),
		).find((candidate) => candidate.name === "planner_finish_work_item");

		const result = await tool?.execute(
			"call-1",
			{ message: "feat: update config", stageAll: true },
			undefined,
			undefined,
			context(),
		);

		expect(commitWorkItem).toHaveBeenCalledTimes(1);
		expect(result?.details).toBe(mutationResult);
	});
});
