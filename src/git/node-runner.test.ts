import { describe, expect, it } from "vitest";
import {
	buildGitWorktreeAddArgs,
	buildGitWorktreeRemoveArgs,
} from "./node-runner";

describe("node git runner worktree command args", () => {
	it("builds add args for creating a new branch from base ref", () => {
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

	it("builds add args for existing branch checkout", () => {
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

	it("builds remove args with and without force", () => {
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
