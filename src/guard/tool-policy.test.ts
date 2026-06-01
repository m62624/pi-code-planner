import { describe, expect, it } from "vitest";
import {
	checkPlannerWrapperAllowed,
	getAllowedPlannerWrapperTools,
	type PlannerWrapperTool,
} from "./tool-policy";

const baseState = {
	stage: "execution",
	step: "prepare_task",
	stepStatus: "running",
	broken: false,
	requiresUserDecision: false,
	requiresCompact: false,
	requiresMemoryUpdate: false,
} as const;

describe("planner wrapper tool policy", () => {
	it("always allows planner_status", () => {
		expect(
			checkPlannerWrapperAllowed({
				tool: "planner_status",
				state: { ...baseState, stage: "planning", step: "draft_plan" },
			}).allow,
		).toBe(true);
	});

	it("allows task branch creation only at execution prepare_task", () => {
		expect(
			checkPlannerWrapperAllowed({
				tool: "planner_git_create_task_branch",
				state: baseState,
			}).allow,
		).toBe(true);

		const blocked = checkPlannerWrapperAllowed({
			tool: "planner_git_create_task_branch",
			state: { ...baseState, step: "write_tests" },
		});

		expect(blocked.allow).toBe(false);
		expect(blocked.reason).toContain("not allowed at execution/write_tests");
		expect(blocked.allowedTools).not.toContain(
			"planner_git_create_task_branch",
		);
	});

	it("keeps merge targets state-bound by exposing only step-specific wrappers", () => {
		expect(
			getAllowedPlannerWrapperTools({
				...baseState,
				step: "merge_best_experiment",
			}),
		).toEqual([
			"planner_status",
			"planner_git_inspect",
			"planner_git_merge_selected_experiment",
			"planner_memory_search",
		] satisfies PlannerWrapperTool[]);

		expect(
			getAllowedPlannerWrapperTools({
				...baseState,
				step: "merge_task_to_plan",
			}),
		).toEqual([
			"planner_status",
			"planner_git_inspect",
			"planner_git_merge_task_to_plan",
			"planner_memory_search",
		] satisfies PlannerWrapperTool[]);
	});

	it("does not expose commit during experiment summary", () => {
		const allowedTools = getAllowedPlannerWrapperTools({
			...baseState,
			step: "summarize_experiment",
		});

		expect(allowedTools).toEqual([
			"planner_status",
			"planner_git_inspect",
			"planner_memory_search",
		] satisfies PlannerWrapperTool[]);
		expect(
			checkPlannerWrapperAllowed({
				tool: "planner_git_commit",
				state: { ...baseState, step: "summarize_experiment" },
			}),
		).toMatchObject({ allow: false });
	});

	it("does not expose plan worktree creation as a public wrapper", () => {
		expect(
			getAllowedPlannerWrapperTools({
				...baseState,
				stage: "init",
				step: "create_plan_worktree",
			}),
		).toEqual([
			"planner_status",
			"planner_git_inspect",
		] satisfies PlannerWrapperTool[]);

		expect(
			checkPlannerWrapperAllowed({
				tool: "planner_git_create_task_branch",
				state: { ...baseState, stage: "init", step: "prepare_storage" },
			}).allow,
		).toBe(false);
	});

	it("blocks normal wrappers while compact is required", () => {
		const decision = checkPlannerWrapperAllowed({
			tool: "planner_git_inspect",
			state: { ...baseState, requiresCompact: true },
		});

		expect(decision.allow).toBe(false);
		expect(decision.allowedTools).toEqual(["planner_status"]);
		expect(decision.reason).toContain("compact boundary");
	});

	it("blocks normal wrappers while memory update is required", () => {
		const decision = checkPlannerWrapperAllowed({
			tool: "planner_git_merge_task_to_plan",
			state: { ...baseState, requiresMemoryUpdate: true },
		});

		expect(decision.allow).toBe(false);
		expect(decision.allowedTools).toEqual([
			"planner_status",
			"planner_git_inspect",
			"planner_memory_inspect",
			"planner_memory_apply_freshness",
			"planner_memory_scan_project",
			"planner_memory_index_status",
			"planner_memory_next_file",
			"planner_memory_read_chunk",
			"planner_memory_upsert_active_file",
			"planner_memory_upsert_symbols",
			"planner_memory_verify_active_file",
			"planner_memory_complete_active_file",
			"planner_memory_ignore_active_file",
			"planner_memory_upsert_relations",
			"planner_memory_search",
			"planner_memory_verify",
			"planner_memory_sync_checkpoint",
		] satisfies PlannerWrapperTool[]);
		expect(decision.reason).toContain("requires a memory update");
	});

	it("allows memory wrappers while memory update is required", () => {
		const decision = checkPlannerWrapperAllowed({
			tool: "planner_memory_scan_project",
			state: { ...baseState, requiresMemoryUpdate: true },
		});

		expect(decision.allow).toBe(true);
	});

	it("blocks normal wrappers during recovery or user decision", () => {
		const decision = checkPlannerWrapperAllowed({
			tool: "planner_git_merge_task_to_plan",
			state: { ...baseState, requiresUserDecision: true },
		});

		expect(decision.allow).toBe(false);
		expect(decision.allowedTools).toEqual([
			"planner_status",
			"planner_git_inspect",
			"planner_recovery_inspect",
			"planner_recovery_resume",
		] satisfies PlannerWrapperTool[]);
		expect(decision.reason).toContain("requires recovery or a user decision");
	});

	it("points the model to current stage markdown without embedding long prompts", () => {
		const decision = checkPlannerWrapperAllowed({
			tool: "planner_git_create_experiment_branch",
			state: { ...baseState, step: "start_experiments" },
		});

		expect(decision.hint).toContain(
			"Current planner position: execution/start_experiments.",
		);
		expect(decision.hint).toContain(
			"Read the markdown instruction for the current stage",
		);
	});
});
