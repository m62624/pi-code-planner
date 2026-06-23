import { describe, expect, it } from "vitest";
import {
	buildGitBranchExistsArgs,
	buildGitCommitArgs,
	buildGitCreateBranchArgs,
	buildGitCurrentBranchArgs,
	buildGitDeleteBranchArgs,
	buildGitDiffNameOnlyArgs,
	buildGitDiffStatArgs,
	buildGitHeadCommitArgs,
	buildGitInitArgs,
	buildGitListProjectFilesArgs,
	buildGitMergeAbortArgs,
	buildGitMergeArgs,
	buildGitPathArgs,
	buildGitStageAllArgs,
	buildGitStatusPorcelainArgs,
	buildGitSwitchBranchArgs,
	buildGitWorktreeAddArgs,
	buildGitWorktreeRemoveArgs,
} from "./node-runner";

describe("node git runner command args", () => {
	it("builds repo read/status args", () => {
		expect(buildGitInitArgs({ repoRoot: "/repo/app" })).toEqual([
			"-C",
			"/repo/app",
			"init",
		]);
		expect(buildGitCurrentBranchArgs({ repoRoot: "/repo/app" })).toEqual([
			"-C",
			"/repo/app",
			"branch",
			"--show-current",
		]);
		expect(buildGitHeadCommitArgs({ repoRoot: "/repo/app" })).toEqual([
			"-C",
			"/repo/app",
			"rev-parse",
			"HEAD",
		]);
		expect(buildGitStatusPorcelainArgs({ repoRoot: "/repo/app" })).toEqual([
			"-C",
			"/repo/app",
			"status",
			"--porcelain=v1",
		]);
		expect(buildGitDiffStatArgs({ repoRoot: "/repo/app" })).toEqual([
			"-C",
			"/repo/app",
			"diff",
			"--stat",
		]);
		expect(buildGitDiffNameOnlyArgs({ repoRoot: "/repo/app" })).toEqual([
			"-C",
			"/repo/app",
			"diff",
			"--name-only",
		]);
		expect(
			buildGitPathArgs({ repoRoot: "/repo/app", path: "info/exclude" }),
		).toEqual(["-C", "/repo/app", "rev-parse", "--git-path", "info/exclude"]);
		expect(buildGitListProjectFilesArgs({ repoRoot: "/repo/app" })).toEqual([
			"-C",
			"/repo/app",
			"ls-files",
			"--cached",
			"--others",
			"--exclude-standard",
		]);
	});

	it("builds branch, switch, stage, commit, and merge args", () => {
		expect(
			buildGitBranchExistsArgs({ repoRoot: "/repo/app", branch: "task/a/b" }),
		).toEqual([
			"-C",
			"/repo/app",
			"rev-parse",
			"--verify",
			"--quiet",
			"task/a/b",
		]);
		expect(
			buildGitCreateBranchArgs({
				repoRoot: "/repo/app",
				branch: "task/a/b",
				fromRef: "plan/a",
			}),
		).toEqual(["-C", "/repo/app", "branch", "task/a/b", "plan/a"]);
		expect(
			buildGitDeleteBranchArgs({
				repoRoot: "/repo/app",
				branch: "task/a/b",
				force: true,
			}),
		).toEqual(["-C", "/repo/app", "branch", "-D", "task/a/b"]);
		expect(
			buildGitSwitchBranchArgs({ repoRoot: "/repo/app", branch: "plan/a" }),
		).toEqual(["-C", "/repo/app", "switch", "plan/a"]);
		expect(buildGitStageAllArgs({ repoRoot: "/repo/app" })).toEqual([
			"-C",
			"/repo/app",
			"add",
			"-A",
		]);
		expect(
			buildGitCommitArgs({ repoRoot: "/repo/app", message: "finish task" }),
		).toEqual(["-C", "/repo/app", "commit", "-m", "finish task"]);
		expect(
			buildGitMergeArgs({
				repoRoot: "/repo/app",
				sourceBranch: "task/a/b",
				noFastForward: true,
				message: "merge task",
			}),
		).toEqual([
			"-C",
			"/repo/app",
			"merge",
			"--no-ff",
			"-m",
			"merge task",
			"task/a/b",
		]);
		expect(
			buildGitMergeArgs({
				repoRoot: "/repo/app",
				sourceBranch: "plan/a",
				squash: true,
			}),
		).toEqual(["-C", "/repo/app", "merge", "--squash", "plan/a"]);
		expect(buildGitMergeAbortArgs({ repoRoot: "/repo/app" })).toEqual([
			"-C",
			"/repo/app",
			"merge",
			"--abort",
		]);
	});

	it("builds worktree add args for creating a new branch from base ref", () => {
		expect(
			buildGitWorktreeAddArgs({
				repoRoot: "/repo/app",
				path: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
				branch: "plan/plan-a",
				fromRef: "main",
			}),
		).toEqual([
			"-C",
			"/repo/app",
			"worktree",
			"add",
			"-b",
			"plan/plan-a",
			"/repo/app/.pi/pi-code-planner/worktrees/plan-a",
			"main",
		]);
	});

	it("builds worktree add args for existing branch checkout", () => {
		expect(
			buildGitWorktreeAddArgs({
				repoRoot: "/repo/app",
				path: "/tmp/worktrees/app/plan-a",
				branch: "plan/plan-a",
				fromRef: null,
			}),
		).toEqual([
			"-C",
			"/repo/app",
			"worktree",
			"add",
			"/tmp/worktrees/app/plan-a",
			"plan/plan-a",
		]);
	});

	it("builds worktree remove args with and without force", () => {
		expect(
			buildGitWorktreeRemoveArgs({
				repoRoot: "/repo/app",
				path: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
			}),
		).toEqual([
			"-C",
			"/repo/app",
			"worktree",
			"remove",
			"/repo/app/.pi/pi-code-planner/worktrees/plan-a",
		]);

		expect(
			buildGitWorktreeRemoveArgs({
				repoRoot: "/repo/app",
				path: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
				force: true,
			}),
		).toEqual([
			"-C",
			"/repo/app",
			"worktree",
			"remove",
			"--force",
			"/repo/app/.pi/pi-code-planner/worktrees/plan-a",
		]);
	});
});
