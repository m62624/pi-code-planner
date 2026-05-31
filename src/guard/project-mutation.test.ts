import { describe, expect, it } from "vitest";
import {
	createInitialPlanState,
	type PlanStateRecord,
} from "../storage/schema";
import {
	checkPlannerBuiltinToolAllowed,
	isFinalizeCheckCommand,
	isReadOnlyShellCommand,
	type PlannerBuiltinGuardState,
} from "./project-mutation";

describe("planner built-in Pi tool guard", () => {
	it("allows normal Pi tools when no planner plan is active", () => {
		expect(
			decision({
				toolName: "write",
				path: "src/a.ts",
				state: inactiveState(),
			}),
		).toEqual({ allow: true, reason: null });
		expect(
			decision({
				toolName: "bash",
				command: "git status",
				state: inactiveState(),
			}),
		).toEqual({ allow: true, reason: null });
	});

	it("blocks project write and edit during discovery and planning", () => {
		expect(
			decision({
				toolName: "write",
				path: "src/a.ts",
				state: activeState({ stage: "discovery", step: "read_project" }),
			}).allow,
		).toBe(false);
		expect(
			decision({
				toolName: "edit",
				path: "/repo/app/src/a.ts",
				state: activeState({ stage: "planning", step: "draft_plan" }),
			}).allow,
		).toBe(false);
	});

	it("allows project write and edit throughout non-compact execution", () => {
		for (const step of [
			"write_tdd_plan",
			"write_tests",
			"run_failing_tests",
			"run_experiment",
			"refactor_task",
			"run_final_tests",
		] as const) {
			expect(
				decision({
					toolName: "edit",
					path: "src/a.rs",
					state: activeState({ stage: "execution", step }),
				}),
				`execution/${step} should allow project edits`,
			).toEqual({ allow: true, reason: null });
		}
	});

	it("blocks project writes at compact and runtime gates", () => {
		expect(
			decision({
				toolName: "write",
				path: "src/a.ts",
				state: activeState({ stage: "execution", step: "compact_task" }),
			}).allow,
		).toBe(false);
		expect(
			decision({
				toolName: "write",
				path: "src/a.ts",
				state: activeState({ requiresMemoryUpdate: true }),
			}).allow,
		).toBe(false);
		expect(
			decision({
				toolName: "write",
				path: "src/a.ts",
				state: activeState({ broken: true }),
			}).allow,
		).toBe(false);
	});

	it("allows planner artifact writes outside the project while gates are open", () => {
		expect(
			decision({
				toolName: "write",
				path: "/agent/extensions/pi-code-planner/projects/app/plans/plan-a/plan.md",
				state: activeState({ stage: "planning", step: "draft_plan" }),
			}),
		).toEqual({ allow: true, reason: null });
		expect(
			decision({
				toolName: "write",
				path: "/agent/extensions/pi-code-planner/projects/app/plans/other-plan/plan.md",
				state: activeState({ stage: "planning", step: "draft_plan" }),
			}).allow,
		).toBe(false);
	});

	it("blocks arbitrary writes outside the worktree and direct planner state edits", () => {
		const state = activeState();
		expect(
			decision({
				toolName: "write",
				path: "/tmp/unmanaged-output.txt",
				state,
			}).allow,
		).toBe(false);
		expect(
			decision({
				toolName: "write",
				path: "/agent/extensions/pi-code-planner/projects/app/plans/plan-a/state.json",
				state,
			}).allow,
		).toBe(false);
	});

	it("allows authored task and experiment json artifacts but not runtime json", () => {
		const state = activeState({ stage: "planning", step: "write_task_files" });
		expect(
			decision({
				toolName: "write",
				path: "/agent/extensions/pi-code-planner/projects/app/plans/plan-a/tasks/task-1/task.json",
				state,
			}),
		).toEqual({ allow: true, reason: null });
		expect(
			decision({
				toolName: "write",
				path: "/agent/extensions/pi-code-planner/projects/app/plans/plan-a/tasks/task-1/experiments/attempt-1/experiment.json",
				state,
			}),
		).toEqual({ allow: true, reason: null });
		expect(
			decision({
				toolName: "write",
				path: "/agent/extensions/pi-code-planner/projects/app/plans/plan-a/memory/files/index.jsonl",
				state,
			}).allow,
		).toBe(false);
		expect(
			decision({
				toolName: "write",
				path: "/agent/extensions/pi-code-planner/projects/app/plans/plan-a/plan.json",
				state,
			}).allow,
		).toBe(false);
	});

	it("blocks writes to the original checkout even during execution", () => {
		expect(
			decision({
				toolName: "edit",
				path: "/repo/app/src/a.ts",
				state: activeState(),
			}).allow,
		).toBe(false);
	});

	it("protects both original project root and custom worktree paths", () => {
		const state = activeState({
			stage: "discovery",
			step: "read_project",
			worktreePath: "/tmp/custom/app/plan-a",
		});
		expect(
			decision({
				toolName: "edit",
				path: "/repo/app/src/a.ts",
				state,
			}).allow,
		).toBe(false);
		expect(
			decision({
				toolName: "edit",
				path: "/tmp/custom/app/plan-a/src/a.ts",
				state,
			}).allow,
		).toBe(false);
		expect(
			decision({
				toolName: "edit",
				path: "/tmp/custom/app/plan-a/src/a.ts",
				state: activeState({
					stage: "execution",
					step: "run_experiment",
					worktreePath: "/tmp/custom/app/plan-a",
				}),
			}),
		).toEqual({ allow: true, reason: null });
	});

	it("allows recovery markdown artifacts but blocks them at compact boundaries", () => {
		const decisions =
			"/agent/extensions/pi-code-planner/projects/app/plans/plan-a/decisions.md";
		expect(
			decision({
				toolName: "write",
				path: decisions,
				state: activeState({
					stage: "recovery",
					step: "classify_recovery",
					broken: true,
				}),
			}),
		).toEqual({ allow: true, reason: null });
		expect(
			decision({
				toolName: "write",
				path: decisions,
				state: activeState({
					stage: "execution",
					step: "compact_task",
					requiresCompact: true,
				}),
			}).allow,
		).toBe(false);
	});

	it("allows read-only discovery shell commands and rejects mutating shell forms", () => {
		const state = activeState({ stage: "discovery", step: "read_project" });
		expect(
			decision({ toolName: "bash", command: "find src -type f | head", state }),
		).toEqual({ allow: true, reason: null });
		expect(
			decision({ toolName: "bash", command: "cd src && rg TODO", state }),
		).toEqual({ allow: true, reason: null });
		expect(
			decision({ toolName: "bash", command: "sed -i s/a/b/ src/a.ts", state })
				.allow,
		).toBe(false);
		expect(
			decision({ toolName: "bash", command: "echo x > src/a.ts", state }).allow,
		).toBe(false);
		expect(
			decision({ toolName: "bash", command: "node scripts/rewrite.js", state })
				.allow,
		).toBe(false);
	});

	it("allows non-git shell work in execution but still blocks raw git", () => {
		const state = activeState({ stage: "execution", step: "run_experiment" });
		expect(
			decision({ toolName: "bash", command: "node scripts/rewrite.js", state }),
		).toEqual({ allow: true, reason: null });
		const rawGit = decision({ toolName: "bash", command: "git status", state });
		expect(rawGit.allow).toBe(false);
		expect(rawGit.reason).toContain("Raw git is blocked");
	});

	it("allows known finalize checks but blocks unknown mutation scripts", () => {
		const state = activeState({
			stage: "finalize",
			step: "verify_plan_branch",
		});
		expect(decision({ toolName: "bash", command: "npm test", state })).toEqual({
			allow: true,
			reason: null,
		});
		expect(
			decision({ toolName: "bash", command: "node scripts/rewrite.js", state })
				.allow,
		).toBe(false);
	});
});

describe("planner shell classification", () => {
	it("recognizes bounded read-only shell pipelines", () => {
		expect(isReadOnlyShellCommand("cd src && rg TODO | head -20")).toBe(true);
		expect(isReadOnlyShellCommand("rg TODO src | head -20")).toBe(true);
		expect(isReadOnlyShellCommand("find src -type f -delete")).toBe(false);
		expect(isReadOnlyShellCommand("find src -type f -fprintf out %p")).toBe(
			false,
		);
		expect(isReadOnlyShellCommand("cat a > b")).toBe(false);
		expect(isReadOnlyShellCommand("cat <<EOF")).toBe(false);
		expect(isReadOnlyShellCommand("echo $(rm file)")).toBe(false);
		expect(isReadOnlyShellCommand("env FOO=bar rg TODO src")).toBe(true);
		expect(isReadOnlyShellCommand("env FOO=bar command rg TODO src")).toBe(
			true,
		);
		expect(isReadOnlyShellCommand("env FOO=bar rm src/a")).toBe(false);
	});

	it("recognizes finalize check commands without allowing shell writes", () => {
		expect(isFinalizeCheckCommand("npm run check && npm test")).toBe(true);
		expect(isFinalizeCheckCommand("cargo test")).toBe(true);
		expect(isFinalizeCheckCommand("npx vitest run")).toBe(true);
		expect(isFinalizeCheckCommand("npx rm file")).toBe(false);
		expect(isFinalizeCheckCommand("npm exec rm file")).toBe(false);
		expect(isFinalizeCheckCommand("npm test > result.txt")).toBe(false);
	});
});

function decision(
	input:
		| {
				toolName: "write" | "edit";
				path: string;
				state: PlannerBuiltinGuardState;
		  }
		| {
				toolName: "bash";
				command: string;
				state: PlannerBuiltinGuardState;
		  },
) {
	return checkPlannerBuiltinToolAllowed({
		cwd: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
		tool: input,
		state: input.state,
	});
}

function inactiveState(): PlannerBuiltinGuardState {
	return {
		active: false,
		activePlanId: null,
		projectPaths: projectPaths(),
		planState: null,
	};
}

function activeState(
	patch: Partial<PlanStateRecord> = {},
): PlannerBuiltinGuardState {
	return {
		active: true,
		activePlanId: "plan-a",
		projectPaths: projectPaths(),
		planState: {
			...createInitialPlanState({
				baseBranch: "main",
				planBranch: "plan/plan-a",
				worktreePath: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
			}),
			stage: "execution",
			step: "run_experiment",
			...patch,
		},
	};
}

function projectPaths(): PlannerBuiltinGuardState["projectPaths"] {
	return {
		plansDir: "/agent/extensions/pi-code-planner/projects/app/plans",
	};
}
