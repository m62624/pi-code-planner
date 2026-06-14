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
import { BUNDLED_INSTRUCTION_DEFAULTS_DIR } from "../instructions/defaults";
import {
	createInstructionPaths,
	instructionFilePath,
} from "../instructions/paths";
import { INSTRUCTION_KEYS } from "../instructions/schema";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "../storage/paths";
import { readPlanRecord } from "../storage/plan-store";
import { readProjectRecord, setActivePlan } from "../storage/project-store";
import { readPlanState } from "../storage/state-store";
import { createWorktreeProjectIndexPath } from "../storage/worktree-index";
import { seedInstructionDefaults } from "../test/instruction-defaults";
import { MockPlannerFs } from "../test/mock-fs";
import { executePlannerPlanTool } from "./plan-tools";

class MockGitRunner implements GitRunner {
	failCurrentBranch = false;
	readonly calls: Array<{ name: string; input: unknown }> = [];
	private branch: string;
	private head = "abc123";
	readonly existingBranches: Set<string> = new Set();

	constructor(branch = "main") {
		this.branch = branch;
	}

	async init(input: GitRepoInput): Promise<void> {
		this.calls.push({ name: "init", input });
	}
	async currentBranch(input: GitRepoInput): Promise<string> {
		this.calls.push({ name: "currentBranch", input });
		if (this.failCurrentBranch && input.repoRoot === "/repo/app") {
			throw new Error("not a git repository");
		}
		return this.branch;
	}
	async headCommit(input: GitRepoInput): Promise<string> {
		this.calls.push({ name: "headCommit", input });
		return this.head;
	}
	async hasCommits(_input: GitRepoInput): Promise<boolean> {
		return this.head !== "";
	}
	async statusPorcelain(input: GitRepoInput): Promise<string> {
		this.calls.push({ name: "statusPorcelain", input });
		return "";
	}
	async diffStat(_input: GitRepoInput): Promise<string> {
		return "";
	}
	async diffNameOnly(_input: GitRepoInput): Promise<string> {
		return "";
	}
	async listProjectFiles(_input: GitRepoInput): Promise<string[]> {
		return [];
	}
	async branchExists(input: GitBranchInput): Promise<boolean> {
		return this.existingBranches.has(input.branch);
	}
	async createBranch(_input: GitCreateBranchInput): Promise<void> {}
	async deleteBranch(_input: GitDeleteBranchInput): Promise<void> {}
	async switchBranch(_input: GitSwitchBranchInput): Promise<void> {}
	async stageAll(input: GitRepoInput): Promise<void> {
		this.calls.push({ name: "stageAll", input });
	}
	async commit(input: GitCommitInput): Promise<void> {
		this.calls.push({ name: "commit", input });
		this.head = "bootstrap456";
	}
	async merge(_input: GitMergeInput): Promise<void> {}
	async worktreeAdd(input: GitWorktreeAddInput): Promise<void> {
		this.calls.push({ name: "worktreeAdd", input });
		this.branch = input.branch;
	}
	async worktreeRemove(_input: GitWorktreeRemoveInput): Promise<void> {}
}

describe("planner plan tools", () => {
	it("creates project, plan, state, instructions, and activates the plan", async () => {
		const fs = new MockPlannerFs();
		await seedInstructionDefaults(fs, BUNDLED_INSTRUCTION_DEFAULTS_DIR);
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});

		const result = await executePlannerPlanTool({
			fs,
			git: new MockGitRunner("feature/base"),
			projectPaths,
			toolName: "planner_create_plan",
			params: {
				planId: "API Audit",
				request: "Audit why approval modes blocks a safe find command.",
				title: "Audit approval modes",
			},
		});

		expect(result.status).toBe("applied");
		expect(result.text).toContain("Plan: api-audit");

		const planPaths = createPlanStoragePaths(projectPaths, "api-audit");
		await expect(readProjectRecord(fs, projectPaths)).resolves.toMatchObject({
			activePlanId: "api-audit",
			plans: [
				{
					planId: "api-audit",
					title: "Audit approval modes",
					description: "Audit why approval modes blocks a safe find command.",
					status: "active",
				},
			],
		});
		await expect(readPlanRecord(fs, planPaths)).resolves.toMatchObject({
			planId: "api-audit",
			title: "Audit approval modes",
			description: "Audit why approval modes blocks a safe find command.",
			status: "active",
			tasks: [],
		});
		await expect(readPlanState(fs, planPaths)).resolves.toMatchObject({
			creationMethod: "create",
			compatibilityMode: "additive",
			stage: "intake",
			step: "draft_goal",
			stepStatus: "running",
			activeBranches: {
				base: "feature/base",
				plan: "plan/api-audit",
			},
			worktreePath: "/repo/app/.pi/pi-code-planner/worktrees/api-audit",
			currentBranch: "plan/api-audit",
			compactBoundaries: {
				stage: true,
				task: false,
			},
		});
		expect(fs.snapshot()[planPaths.planMd]).toBe("");
		expect(fs.snapshot()[planPaths.requestMd]).toBe(
			"Audit why approval modes blocks a safe find command.\n",
		);
		expect(fs.snapshot()[planPaths.goalMd]).toBe("");
		expect(fs.snapshot()[planPaths.discoveryMd]).toBe("");
		expect(
			fs.snapshot()[
				"/repo/app/.pi/pi-code-planner/worktrees/api-audit/.gitignore"
			],
		).toBe(".pi/pi-code-planner/worktrees/\n");
		expect(fs.snapshot()["/repo/app/.git/info/exclude"]).toBe(
			".pi/pi-code-planner/worktrees/\n",
		);
		await expect(
			fs.exists("/repo/app/.pi/pi-code-planner/worktrees/api-audit"),
		).resolves.toBe(true);
		expect(
			fs.snapshot()[
				createWorktreeProjectIndexPath({
					agentDir: "/agent",
					worktreePath: "/repo/app/.pi/pi-code-planner/worktrees/api-audit",
				})
			],
		).toBeDefined();

		const instructionPaths = createInstructionPaths(projectPaths);
		for (const key of INSTRUCTION_KEYS) {
			expect(
				fs.snapshot()[instructionFilePath(instructionPaths.defaultsDir, key)],
			).toBeDefined();
			expect(
				fs.snapshot()[
					instructionFilePath(instructionPaths.globalAppendDir, key)
				],
			).toBe("");
		}
	});

	it("uses explicit baseBranch and blocks accidental overwrite of an active plan", async () => {
		const fs = new MockPlannerFs();
		await seedInstructionDefaults(fs, BUNDLED_INSTRUCTION_DEFAULTS_DIR);
		const git = new MockGitRunner("ignored");
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});

		const created = await executePlannerPlanTool({
			fs,
			git,
			projectPaths,
			toolName: "planner_create_plan",
			params: {
				planId: "plan-a",
				request: "Create plan A.",
				title: "Plan A",
				baseBranch: "release/1",
			},
		});
		expect(created.status).toBe("applied");

		const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
		await expect(readPlanState(fs, planPaths)).resolves.toMatchObject({
			activeBranches: {
				base: "release/1",
				plan: "plan/plan-a",
			},
		});
		expect(git.calls).toContainEqual({
			name: "worktreeAdd",
			input: {
				repoRoot: "/repo/app",
				path: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
				branch: "plan/plan-a",
				fromRef: "release/1",
			},
		});

		const second = await executePlannerPlanTool({
			fs,
			git: new MockGitRunner(),
			projectPaths,
			toolName: "planner_create_plan",
			params: {
				planId: "plan-b",
				request: "Create plan B.",
				title: "Plan B",
			},
		});

		// Should succeed — new plan becomes the active one
		expect(second.status).toBe("applied");
		expect(second.text).toContain("Plan: plan-b");
		await expect(readProjectRecord(fs, projectPaths)).resolves.toMatchObject({
			activePlanId: "plan-b",
			plans: [
				{ planId: "plan-a", title: "Plan A", status: "active" },
				{ planId: "plan-b", title: "Plan B", status: "active" },
			],
		});
	});

	it("falls back to main when git branch inspection is unavailable", async () => {
		const fs = new MockPlannerFs();
		await seedInstructionDefaults(fs, BUNDLED_INSTRUCTION_DEFAULTS_DIR);
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		const git = new MockGitRunner();
		git.failCurrentBranch = true;

		const result = await executePlannerPlanTool({
			fs,
			git,
			projectPaths,
			toolName: "planner_create_plan",
			params: {
				planId: "plan-a",
				request: "Create plan A.",
				title: "Plan A",
			},
		});

		expect(result.status).toBe("applied");
		await expect(
			readPlanState(fs, createPlanStoragePaths(projectPaths, "plan-a")),
		).resolves.toMatchObject({
			activeBranches: { base: "main" },
		});
	});

	it("uses project settings custom worktree settings without adding a project-local gitignore rule", async () => {
		const fs = new MockPlannerFs();
		await seedInstructionDefaults(fs, BUNDLED_INSTRUCTION_DEFAULTS_DIR);
		const git = new MockGitRunner("main");
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await fs.writeTextAtomic(
			"/repo/app/.pi/pi-code-planner/settings.json",
			`${JSON.stringify({
				worktree: {
					mode: "custom",
					root: "/tmp/planner-worktrees",
				},
			})}\n`,
		);

		const result = await executePlannerPlanTool({
			fs,
			git,
			projectPaths,
			toolName: "planner_create_plan",
			params: {
				planId: "plan-a",
				request: "Create plan A.",
				title: "Plan A",
			},
		});

		expect(result.status).toBe("applied");
		const expectedPath = `/tmp/planner-worktrees/${projectPaths.projectId}/plan-a`;
		await expect(
			readPlanState(fs, createPlanStoragePaths(projectPaths, "plan-a")),
		).resolves.toMatchObject({
			worktreePath: expectedPath,
		});
		expect(git.calls).toContainEqual({
			name: "worktreeAdd",
			input: {
				repoRoot: "/repo/app",
				path: expectedPath,
				branch: "plan/plan-a",
				fromRef: "main",
			},
		});
		await expect(fs.exists("/repo/app/.gitignore")).resolves.toBe(false);
	});

	it("uses global settings custom worktree settings when project settings are absent", async () => {
		const fs = new MockPlannerFs();
		await seedInstructionDefaults(fs, BUNDLED_INSTRUCTION_DEFAULTS_DIR);
		const git = new MockGitRunner("main");
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await fs.writeTextAtomic(
			"/agent/extensions/pi-code-planner/settings.json",
			`${JSON.stringify({
				worktree: {
					mode: "custom",
					root: "/global/worktrees",
				},
			})}\n`,
		);

		const result = await executePlannerPlanTool({
			fs,
			git,
			projectPaths,
			toolName: "planner_create_plan",
			params: {
				planId: "plan-a",
				request: "Create plan A.",
				title: "Plan A",
			},
		});

		expect(result.status).toBe("applied");
		const expectedPath = `/global/worktrees/${projectPaths.projectId}/plan-a`;
		await expect(
			readPlanState(fs, createPlanStoragePaths(projectPaths, "plan-a")),
		).resolves.toMatchObject({
			worktreePath: expectedPath,
		});
		expect(git.calls).toContainEqual({
			name: "worktreeAdd",
			input: {
				repoRoot: "/repo/app",
				path: expectedPath,
				branch: "plan/plan-a",
				fromRef: "main",
			},
		});
	});

	it("blocks creating an existing inactive plan instead of overwriting files", async () => {
		const fs = new MockPlannerFs();
		await seedInstructionDefaults(fs, BUNDLED_INSTRUCTION_DEFAULTS_DIR);
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});

		const first = await executePlannerPlanTool({
			fs,
			git: new MockGitRunner(),
			projectPaths,
			toolName: "planner_create_plan",
			params: {
				planId: "plan-a",
				request: "Create plan A.",
				title: "Plan A",
			},
		});
		expect(first.status).toBe("applied");
		await setActivePlan(fs, projectPaths, null);

		const second = await executePlannerPlanTool({
			fs,
			git: new MockGitRunner(),
			projectPaths,
			toolName: "planner_create_plan",
			params: {
				planId: "plan-a",
				request: "Create plan A again.",
				title: "Plan A again",
			},
		});

		expect(second.status).toBe("applied");
		expect(second.details).toMatchObject({
			plan: expect.objectContaining({
				planId: expect.stringMatching(/^plan-a-[a-f0-9]{8}$/),
			}),
		});
	});

	it("generates a compact unique id from the raw request when planId is omitted", async () => {
		const fs = new MockPlannerFs();
		await seedInstructionDefaults(fs, BUNDLED_INSTRUCTION_DEFAULTS_DIR);
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});

		const result = await executePlannerPlanTool({
			fs,
			git: new MockGitRunner(),
			projectPaths,
			toolName: "planner_create_plan",
			params: {
				request: "Audit safe find command",
			},
		});

		expect(result.status).toBe("applied");
		expect(result.text).toContain("Plan: audit-safe");
		await expect(readProjectRecord(fs, projectPaths)).resolves.toMatchObject({
			activePlanId: expect.stringMatching(
				/^audit-safe-find-command-[a-f0-9]{8}$/,
			),
		});
	});
});
