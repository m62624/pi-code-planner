import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	type PlannerOrchestrator,
	PlannerOrchestratorBlockedByCompact,
} from "../orchestrator/planner-orchestrator";
import type { PendingPlannerCompact } from "../planner-state/schema";
import { WorkflowTransitionRejected } from "../workflow/manager";
import { createPlannerWorkflowTools } from "./planner-workflow-tools";

function context(): ExtensionContext {
	return {
		cwd: "/repo",
		compact: vi.fn(),
	} as unknown as ExtensionContext;
}

function toolByName(name: string, orchestrator: PlannerOrchestrator) {
	const tool = createPlannerWorkflowTools(() => orchestrator).find(
		(candidate) => candidate.name === name,
	);
	if (!tool) throw new Error(`Missing tool: ${name}`);
	return tool;
}

describe("createPlannerWorkflowTools", () => {
	it("registers provider-safe workflow tool names", () => {
		const tools = createPlannerWorkflowTools(() => ({}) as PlannerOrchestrator);

		expect(tools.map((tool) => tool.name)).toEqual([
			"planner_create_plan",
			"planner_transition_plan",
			"planner_create_work_item",
			"planner_transition_work_item",
			"planner_request_discovery_compact",
			"planner_complete_discovery_compact",
			"planner_request_work_item_compact",
			"planner_complete_work_item_compact",
		]);
	});

	it("creates a plan through the orchestrator", async () => {
		const createPlan = vi.fn().mockReturnValue({
			planId: "plan-1",
			stage: "plan_draft",
		});
		const orchestrator = { createPlan } as unknown as PlannerOrchestrator;
		const tool = toolByName("planner_create_plan", orchestrator);

		const result = await tool.execute(
			"call-1",
			{ title: "Parser", planId: "plan-1" },
			undefined,
			undefined,
			context(),
		);

		expect(createPlan).toHaveBeenCalledWith({
			title: "Parser",
			planId: "plan-1",
		});
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "Planner plan created.",
		});
		expect(result.details).toMatchObject({ planId: "plan-1" });
	});

	it("transitions a plan through the orchestrator", async () => {
		const transitionPlan = vi.fn().mockReturnValue({
			current: { planId: "plan-1", stage: "discovery_full" },
		});
		const orchestrator = {
			transitionPlan,
		} as unknown as PlannerOrchestrator;
		const tool = toolByName("planner_transition_plan", orchestrator);

		const result = await tool.execute(
			"call-1",
			{ planId: "plan-1", stage: "discovery_full" },
			undefined,
			undefined,
			context(),
		);

		expect(transitionPlan).toHaveBeenCalledWith("plan-1", "discovery_full");
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "Planner plan transitioned.",
		});
	});

	it("creates a work item through the orchestrator", async () => {
		const createWorkItem = vi.fn().mockReturnValue({
			workItemId: "parser-api",
			stage: "pending",
		});
		const orchestrator = {
			createWorkItem,
		} as unknown as PlannerOrchestrator;
		const tool = toolByName("planner_create_work_item", orchestrator);

		const result = await tool.execute(
			"call-1",
			{
				planId: "plan-1",
				title: "Parser API",
				workItemId: "parser-api",
			},
			undefined,
			undefined,
			context(),
		);

		expect(createWorkItem).toHaveBeenCalledWith("plan-1", {
			title: "Parser API",
			workItemId: "parser-api",
		});
		expect(result.details).toMatchObject({ workItemId: "parser-api" });
	});

	it("transitions a work item through the orchestrator", async () => {
		const transitionWorkItem = vi.fn().mockReturnValue({
			current: { workItemId: "parser-api", stage: "ready" },
		});
		const orchestrator = {
			transitionWorkItem,
		} as unknown as PlannerOrchestrator;
		const tool = toolByName("planner_transition_work_item", orchestrator);

		await tool.execute(
			"call-1",
			{ planId: "plan-1", workItemId: "parser-api", stage: "ready" },
			undefined,
			undefined,
			context(),
		);

		expect(transitionWorkItem).toHaveBeenCalledWith(
			"plan-1",
			"parser-api",
			"ready",
		);
	});

	it("requests discovery compaction through the orchestrator", async () => {
		const requestDiscoveryCompact = vi.fn().mockReturnValue({
			kind: "started",
			pending: { id: "compact-1" },
		});
		const orchestrator = {
			requestDiscoveryCompact,
		} as unknown as PlannerOrchestrator;
		const ctx = context();
		const tool = toolByName("planner_request_discovery_compact", orchestrator);

		const result = await tool.execute(
			"call-1",
			{
				planId: "plan-1",
				customInstructions: "compact discovery",
				resumePrompt: "resume discovery",
			},
			undefined,
			undefined,
			ctx,
		);

		expect(requestDiscoveryCompact).toHaveBeenCalledWith(ctx, "plan-1", {
			customInstructions: "compact discovery",
			resumePrompt: "resume discovery",
			attachToNextTurn: undefined,
			autoResume: undefined,
		});
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "Planner discovery compaction requested.",
		});
	});

	it("completes discovery compaction through the orchestrator", async () => {
		const completeDiscoveryCompact = vi.fn().mockReturnValue({
			current: { planId: "plan-1", stage: "post_discovery_questions" },
		});
		const orchestrator = {
			completeDiscoveryCompact,
		} as unknown as PlannerOrchestrator;
		const tool = toolByName("planner_complete_discovery_compact", orchestrator);

		await tool.execute(
			"call-1",
			{ planId: "plan-1" },
			undefined,
			undefined,
			context(),
		);

		expect(completeDiscoveryCompact).toHaveBeenCalledWith("plan-1");
	});

	it("requests work item compaction through the orchestrator", async () => {
		const requestWorkItemCompact = vi.fn().mockReturnValue({
			kind: "started",
			pending: { id: "compact-1" },
		});
		const orchestrator = {
			requestWorkItemCompact,
		} as unknown as PlannerOrchestrator;
		const ctx = context();
		const tool = toolByName("planner_request_work_item_compact", orchestrator);

		await tool.execute(
			"call-1",
			{
				planId: "plan-1",
				workItemId: "parser-api",
				customInstructions: "compact work item",
				resumePrompt: "resume work item",
			},
			undefined,
			undefined,
			ctx,
		);

		expect(requestWorkItemCompact).toHaveBeenCalledWith(ctx, "plan-1", {
			planId: "plan-1",
			workItemId: "parser-api",
			customInstructions: "compact work item",
			resumePrompt: "resume work item",
		});
	});

	it("completes work item compaction through the orchestrator", async () => {
		const completeWorkItemCompact = vi.fn().mockReturnValue({
			current: { workItemId: "parser-api", stage: "completed" },
		});
		const orchestrator = {
			completeWorkItemCompact,
		} as unknown as PlannerOrchestrator;
		const tool = toolByName("planner_complete_work_item_compact", orchestrator);

		await tool.execute(
			"call-1",
			{ planId: "plan-1", workItemId: "parser-api" },
			undefined,
			undefined,
			context(),
		);

		expect(completeWorkItemCompact).toHaveBeenCalledWith(
			"plan-1",
			"parser-api",
		);
	});

	it("returns transition rejections as tool failures", async () => {
		const transitionPlan = vi.fn(() => {
			throw new WorkflowTransitionRejected({
				allowed: false,
				from: "plan_draft",
				to: "plan_completed",
				reason: "Cannot transition from plan_draft to plan_completed.",
			});
		});
		const orchestrator = {
			transitionPlan,
		} as unknown as PlannerOrchestrator;
		const tool = toolByName("planner_transition_plan", orchestrator);

		const result = await tool.execute(
			"call-1",
			{ planId: "plan-1", stage: "plan_completed" },
			undefined,
			undefined,
			context(),
		);

		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "Cannot transition from plan_draft to plan_completed.",
		});
		expect(result.details).toMatchObject({
			decision: { allowed: false },
		});
	});

	it("returns compact boundary blocks as tool failures", async () => {
		const pending = {
			id: "compact-1",
			status: "completed",
		} as PendingPlannerCompact;
		const completeDiscoveryCompact = vi.fn(() => {
			throw new PlannerOrchestratorBlockedByCompact(pending);
		});
		const orchestrator = {
			completeDiscoveryCompact,
		} as unknown as PlannerOrchestrator;
		const tool = toolByName("planner_complete_discovery_compact", orchestrator);

		const result = await tool.execute(
			"call-1",
			{ planId: "plan-1" },
			undefined,
			undefined,
			context(),
		);

		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "Planner compact is still pending: compact-1.",
		});
		expect(result.details).toMatchObject({
			pendingCompact: { id: "compact-1" },
		});
	});
});
