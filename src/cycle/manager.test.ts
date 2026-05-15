import { describe, expect, it, vi } from "vitest";
import type { PlannerDecision } from "../decision/engine";
import type { PlannerRuntimeController } from "../runtime/planner-runtime-controller";
import { PlannerCycleManager } from "./manager";

function decision(input: Partial<PlannerDecision> = {}): PlannerDecision {
	return {
		status: "plan_stage",
		action: "continue_plan_stage",
		blocking: false,
		message: "Planner is ready.",
		recovery: {
			status: "ok",
			requiresRecovery: false,
			message: "ok",
			currentBranch: null,
			expectedBranch: null,
		},
		dirtyFiles: [],
		compactReason: null,
		planStage: "discovery_full",
		workItemStage: null,
		...input,
	};
}

function runtime(decisionValue: PlannerDecision, nextPrompt: unknown = null) {
	return {
		inspect: vi.fn().mockResolvedValue({
			status: "ready",
			message: decisionValue.message,
			decision: decisionValue,
			nextPrompt,
		}),
	} as unknown as PlannerRuntimeController;
}

describe("PlannerCycleManager", () => {
	it("normalizes a ready plan stage into a next step", async () => {
		const prompt = {
			prompt: "Continue discovery.",
			instruction: "Discovery instruction",
			artifactPaths: ["/plans/plan-1/plan.md"],
		};
		const manager = new PlannerCycleManager({
			runtime: runtime(decision(), prompt),
		});

		const step = await manager.getNextStep();

		expect(step).toMatchObject({
			status: "ready",
			kind: "plan_stage",
			blocking: false,
			requiredTool: null,
			memoryRefresh: {
				required: false,
				requiredTools: [],
				instructions: [],
			},
			tournament: {
				required: false,
				defaultAttemptIds: [],
				requiredTools: [],
			},
			instructionName: "discovery",
			sectionName: "discovery_full",
			prompt,
			artifactPaths: ["/plans/plan-1/plan.md"],
		});
	});

	it("normalizes discovery compact boundary", async () => {
		const prompt = {
			prompt: "Discovery compact instruction.",
			instruction: "Discovery compact instruction.",
			artifactPaths: ["/plans/plan-1/discovery.md"],
		};
		const manager = new PlannerCycleManager({
			runtime: runtime(
				decision({
					status: "compact_required",
					action: "request_discovery_compact",
					blocking: true,
					compactReason: "discovery",
					planStage: "discovery_compact_required",
				}),
				prompt,
			),
		});

		const step = await manager.getNextStep();

		expect(step).toMatchObject({
			status: "blocked",
			kind: "compact_required",
			blocking: true,
			requiredTool: "planner_request_discovery_compact",
			instructionName: "compact",
			sectionName: "discovery_compact_required",
			compact: {
				required: true,
				reason: "discovery",
				requestTool: "planner_request_discovery_compact",
				payload: {
					customInstructions: expect.stringContaining(
						"Discovery compact instruction.",
					),
					resumePrompt: expect.stringContaining("planner_next_step"),
				},
			},
		});
		expect(step.compact.payload?.customInstructions).toContain(
			"/plans/plan-1/discovery.md",
		);
		expect(step.compact.resumePurpose).toContain("post-discovery questions");
	});

	it("normalizes work item compact boundary", async () => {
		const manager = new PlannerCycleManager({
			runtime: runtime(
				decision({
					status: "compact_required",
					action: "request_work_item_compact",
					blocking: true,
					compactReason: "work_item",
					planStage: "plan_active",
					workItemStage: "work_item_compact_required",
				}),
			),
		});

		const step = await manager.getNextStep();

		expect(step).toMatchObject({
			status: "blocked",
			kind: "compact_required",
			requiredTool: "planner_request_work_item_compact",
			instructionName: "compact",
			sectionName: "work_item_compact_required",
			compact: {
				required: true,
				reason: "work_item",
				requestTool: "planner_request_work_item_compact",
				payload: {
					customInstructions: expect.stringContaining("work_item"),
					resumePrompt: expect.stringContaining("completed work item"),
				},
			},
		});
		expect(step.compact.resumePurpose).toContain("completed work item");
	});

	it("normalizes dirty memory into signature refresh guidance", async () => {
		const manager = new PlannerCycleManager({
			runtime: runtime(
				decision({
					status: "memory_refresh_required",
					action: "refresh_memory",
					blocking: true,
					dirtyFiles: ["src/app.ts"],
					planStage: "plan_active",
					workItemStage: "verification",
				}),
			),
		});

		const step = await manager.getNextStep();

		expect(step).toMatchObject({
			status: "blocked",
			kind: "memory_refresh",
			requiredTool: "planner_memory_get_dirty",
			instructionName: "api_check",
			sectionName: "verification",
			dirtyFiles: ["src/app.ts"],
			memoryRefresh: {
				required: true,
				dirtyFiles: ["src/app.ts"],
				requiredTools: [
					"planner_memory_get_dirty",
					"planner_memory_upsert_files",
					"planner_memory_upsert_symbols",
					"planner_memory_upsert_relations",
					"planner_memory_verify_file",
					"planner_memory_verify_symbol",
					"planner_memory_clear_dirty",
					"planner_transition_work_item",
				],
				instructions: expect.arrayContaining([
					expect.stringContaining("signature_refresh"),
					expect.stringContaining("listed dirty files"),
					expect.stringContaining("planner_memory_clear_dirty"),
					expect.stringContaining("work_item_compact_required"),
				]),
			},
		});
	});

	it("normalizes experiment stages into tournament guidance", async () => {
		const manager = new PlannerCycleManager({
			runtime: runtime(
				decision({
					status: "work_item_stage",
					action: "continue_work_item_stage",
					blocking: false,
					planStage: "plan_active",
					workItemStage: "experiments_running",
				}),
			),
		});

		const step = await manager.getNextStep();

		expect(step).toMatchObject({
			status: "ready",
			kind: "work_item_stage",
			instructionName: "work_item",
			sectionName: "experiments_running",
			tournament: {
				required: true,
				stage: "experiments_running",
				defaultAttemptIds: ["attempt-1", "attempt-2", "attempt-3"],
				requiredTools: [
					"planner_start_experiment",
					"planner_select_experiment",
					"planner_delete_experiment_branch",
					"planner_transition_work_item",
				],
				requiredArtifacts: [
					"plan.md",
					"prompt.md",
					"summary.md",
					"score.json",
					"verification.json",
					"changed_files.json",
				],
				scoringScale: {
					min: 0,
					max: 10,
				},
				selectionCriteria: expect.arrayContaining([
					expect.objectContaining({ name: "correctness", weight: 1 }),
					expect.objectContaining({
						name: "integration_risk",
						direction: "lower_is_better",
					}),
				]),
				instructions: expect.arrayContaining([
					expect.stringContaining("planner_start_experiment"),
					expect.stringContaining("select exactly one winner"),
					expect.stringContaining("Do not refactor experiment branches"),
				]),
			},
		});
	});

	it("normalizes recovery and compact pending as blocked status checks", async () => {
		const recoveryManager = new PlannerCycleManager({
			runtime: runtime(
				decision({
					status: "recovery_required",
					action: "recover_git",
					blocking: true,
				}),
			),
		});
		const compactPendingManager = new PlannerCycleManager({
			runtime: runtime(
				decision({
					status: "compact_pending",
					action: "wait_for_compact_resume",
					blocking: true,
				}),
			),
		});

		await expect(recoveryManager.getNextStep()).resolves.toMatchObject({
			status: "blocked",
			kind: "recovery",
			requiredTool: "planner_runtime_status",
		});
		await expect(compactPendingManager.getNextStep()).resolves.toMatchObject({
			status: "blocked",
			kind: "compact_pending",
			requiredTool: "planner_runtime_status",
		});
	});
});
