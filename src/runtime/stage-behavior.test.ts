import { describe, expect, it } from "vitest";
import { getAllowedPlannerWrapperTools } from "../guard/tool-policy";
import { PLANNER_STAGE_STEPS } from "../storage/schema";
import {
	checkPlannerStageBehaviorWrapperTool,
	getPlannerStageStepBehavior,
	PLANNER_STAGE_BEHAVIOR,
} from "./stage-behavior";

describe("planner stage behavior", () => {
	it("has an exact behavior spec for every planner stage step", () => {
		const allSteps = Object.values(PLANNER_STAGE_STEPS).flat();

		expect(Object.keys(PLANNER_STAGE_BEHAVIOR).sort()).toEqual(
			[...allSteps].sort(),
		);
		for (const [stage, steps] of Object.entries(PLANNER_STAGE_STEPS)) {
			for (const step of steps) {
				expect(
					getPlannerStageStepBehavior({ stage: stage as never, step }),
				).toMatchObject({ stage, step });
			}
		}
	});

	it("rejects behavior requests with a mismatched stage", () => {
		expect(() =>
			getPlannerStageStepBehavior({
				stage: "planning",
				step: "read_project",
			}),
		).toThrow("belongs to discovery");
	});

	it("keeps discovery as read/memory/artifact work without commits", () => {
		expect(
			getPlannerStageStepBehavior({ stage: "discovery", step: "read_project" }),
		).toMatchObject({
			projectAccess: "read_only",
			commitPolicy: "forbidden",
			memoryPolicy: "not_required",
		});
		expect(
			getPlannerStageStepBehavior({
				stage: "discovery",
				step: "write_symbols",
			}),
		).toMatchObject({
			projectAccess: "planner_artifacts",
			commitPolicy: "forbidden",
			memoryPolicy: "write_entries",
		});
	});

	it("enforces TDD-first behavior before production implementation", () => {
		expect(
			getPlannerStageStepBehavior({
				stage: "execution",
				step: "write_tdd_plan",
			}),
		).toMatchObject({
			projectAccess: "planner_artifacts",
			commitPolicy: "forbidden",
		});
		expect(
			getPlannerStageStepBehavior({ stage: "execution", step: "write_tests" }),
		).toMatchObject({
			projectAccess: "test_edits",
			commitPolicy: "allowed_if_dirty",
			requiredGates: ["tdd_plan_written"],
		});
		expect(
			getPlannerStageStepBehavior({
				stage: "execution",
				step: "run_experiment",
			}),
		).toMatchObject({
			projectAccess: "production_edits",
			commitPolicy: "required_if_dirty",
			memoryPolicy: "sync_after_git",
		});
	});

	it("marks compact steps as compact-only boundaries", () => {
		for (const [stage, step] of [
			["discovery", "compact_discovery"],
			["planning", "compact_planning"],
			["execution", "compact_experiment"],
			["execution", "compact_task"],
			["finalize", "compact_finalize"],
		] as const) {
			expect(getPlannerStageStepBehavior({ stage, step })).toMatchObject({
				projectAccess: "none",
				actions: ["compact"],
				compactPolicy: "request_required",
				expectedTools: ["planner_request_compact", "planner_complete_compact"],
			});
		}
	});

	it("keeps done cleanup user-accepted and git-wrapper controlled", () => {
		expect(
			getPlannerStageStepBehavior({
				stage: "done",
				step: "await_user_acceptance",
			}),
		).toMatchObject({
			projectAccess: "user_communication",
			requiredGates: ["user_acceptance_required"],
		});
		expect(
			getPlannerStageStepBehavior({ stage: "done", step: "cleanup_worktree" }),
		).toMatchObject({
			projectAccess: "none",
			actions: ["planner_git", "cleanup"],
			expectedTools: [
				"planner_git_remove_plan_worktree",
				"planner_git_cleanup_managed_branches",
			],
		});
	});

	it("keeps behavior commit policy aligned with wrapper policy", () => {
		for (const [stage, steps] of Object.entries(PLANNER_STAGE_STEPS)) {
			for (const step of steps) {
				const behavior = getPlannerStageStepBehavior({
					stage: stage as never,
					step,
				});
				const allowedTools = getAllowedPlannerWrapperTools({
					stage: stage as never,
					step,
					broken: false,
					requiresUserDecision: false,
					requiresCompact: false,
					requiresMemoryUpdate: false,
				});
				if (allowedTools.includes("planner_git_commit")) {
					expect(
						behavior.commitPolicy,
						`${stage}/${step} allows planner_git_commit but behavior forbids commits`,
					).not.toBe("forbidden");
				}
			}
		}
	});

	it("uses behavior policy to block contradictory wrapper tools", () => {
		expect(
			checkPlannerStageBehaviorWrapperTool({
				behavior: getPlannerStageStepBehavior({
					stage: "execution",
					step: "write_tdd_plan",
				}),
				tool: "planner_git_commit",
			}),
		).toMatchObject({ allow: false });
		expect(
			checkPlannerStageBehaviorWrapperTool({
				behavior: getPlannerStageStepBehavior({
					stage: "execution",
					step: "write_tests",
				}),
				tool: "planner_git_commit",
			}),
		).toMatchObject({ allow: true });
		expect(
			checkPlannerStageBehaviorWrapperTool({
				behavior: getPlannerStageStepBehavior({
					stage: "discovery",
					step: "read_project",
				}),
				tool: "planner_memory_inspect",
			}),
		).toMatchObject({ allow: false });
	});
});
