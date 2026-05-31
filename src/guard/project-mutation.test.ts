import { describe, expect, it } from "vitest";
import {
	createInitialPlanState,
	type PlannerStage,
	type PlanStateRecord,
} from "../storage/schema";
import {
	checkPlannerBuiltinToolAllowed,
	type PlannerBuiltinGuardState,
} from "./project-mutation";

describe("planner built-in Pi tool guard", () => {
	it("does not interfere when no planner plan is active", () => {
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

	it("blocks project writes during init, discovery, and planning", () => {
		for (const stage of ["init", "discovery", "planning"] as const) {
			expect(
				decision({
					toolName: "write",
					path: "src/a.ts",
					state: activeState(stage),
				}).allow,
				`${stage} should block project writes`,
			).toBe(false);
			expect(
				decision({
					toolName: "edit",
					path: "/repo/app/src/a.ts",
					state: activeState(stage),
				}).allow,
				`${stage} should block original checkout edits`,
			).toBe(false);
		}
	});

	it("allows planner artifact writes while project writes are blocked", () => {
		expect(
			decision({
				toolName: "write",
				path: "/agent/extensions/pi-code-planner/projects/app/plans/plan-a/discovery.md",
				state: activeState("discovery"),
			}),
		).toEqual({ allow: true, reason: null });
	});

	it("blocks write and edit when an active planner state cannot be loaded", () => {
		expect(
			decision({
				toolName: "write",
				path: "src/a.ts",
				state: {
					active: true,
					activePlanId: "plan-a",
					projectPaths: { projectRoot: "/repo/app" },
					planState: null,
				},
			}).allow,
		).toBe(false);
	});

	it("allows write and edit after planning without classifying file roles", () => {
		for (const stage of [
			"execution",
			"finalize",
			"done",
			"recovery",
		] as const) {
			expect(
				decision({
					toolName: "edit",
					path: "src/a.rs",
					state: activeState(stage),
				}),
				`${stage} should allow project edits`,
			).toEqual({ allow: true, reason: null });
			expect(
				decision({
					toolName: "write",
					path: "/tmp/custom-output.txt",
					state: activeState(stage),
				}),
				`${stage} should not classify external paths`,
			).toEqual({ allow: true, reason: null });
		}
	});

	it("allows every non-git shell command at every planner stage", () => {
		for (const stage of ALL_STAGES) {
			expect(
				decision({
					toolName: "bash",
					command: "unknown-project-alias --check && node scripts/rewrite.js",
					state: activeState(stage),
				}),
				`${stage} should allow non-git shell`,
			).toEqual({ allow: true, reason: null });
		}
	});

	it("still blocks raw git through shell while a planner plan is active", () => {
		for (const stage of ALL_STAGES) {
			const result = decision({
				toolName: "bash",
				command: "git status",
				state: activeState(stage),
			});
			expect(result.allow, `${stage} should block raw git`).toBe(false);
			expect(result.reason).toContain("Raw git is blocked");
		}
	});
});

const ALL_STAGES: readonly PlannerStage[] = [
	"init",
	"discovery",
	"planning",
	"execution",
	"finalize",
	"done",
	"recovery",
];

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
		projectPaths: { projectRoot: "/repo/app" },
		planState: null,
	};
}

function activeState(stage: PlannerStage): PlannerBuiltinGuardState {
	return {
		active: true,
		activePlanId: "plan-a",
		projectPaths: { projectRoot: "/repo/app" },
		planState: {
			...createInitialPlanState({
				baseBranch: "main",
				planBranch: "plan/plan-a",
				worktreePath: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
			}),
			stage,
			step: stepFor(stage),
		},
	};
}

function stepFor(stage: PlannerStage): PlanStateRecord["step"] {
	switch (stage) {
		case "init":
			return "check_project";
		case "discovery":
			return "read_project";
		case "planning":
			return "draft_plan";
		case "execution":
			return "run_experiment";
		case "finalize":
			return "verify_plan_branch";
		case "done":
			return "present_result";
		case "recovery":
			return "inspect_git";
	}
}
