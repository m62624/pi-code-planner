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

const nextPlanPrompt = {
	prompt: "Plan next instruction",
	instruction: "Plan next instruction",
	artifactPaths: [
		"/agent/extensions/pi-planner/projects/repo/plans/plan-1/plan.md",
	],
};

const nextWorkItemPrompt = {
	prompt: "Work item next instruction",
	instruction: "Work item next instruction",
	artifactPaths: [
		"/agent/extensions/pi-planner/projects/repo/plans/plan-1/work-items/parser-api/tdd_plan.md",
	],
};

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
		const buildPlanStagePrompt = vi.fn().mockReturnValue(nextPlanPrompt);
		const orchestrator = {
			createPlan,
			buildPlanStagePrompt,
		} as unknown as PlannerOrchestrator;
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
		});
		expect(result.content[0].text).toContain("Planner plan created.");
		expect(result.content[0].text).toContain("NEXT PLANNER INSTRUCTION");
		expect(result.content[0].text).toContain("Plan next instruction");
		expect(buildPlanStagePrompt).toHaveBeenCalledWith("plan-1");
		expect(result.details).toMatchObject({
			result: { planId: "plan-1" },
			nextPrompt: nextPlanPrompt,
		});
	});

	it("transitions a plan through the orchestrator", async () => {
		const transitionPlan = vi.fn().mockReturnValue({
			current: { planId: "plan-1", stage: "discovery_full" },
		});
		const buildPlanStagePrompt = vi.fn().mockReturnValue(nextPlanPrompt);
		const orchestrator = {
			transitionPlan,
			buildPlanStagePrompt,
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
		expect(buildPlanStagePrompt).toHaveBeenCalledWith("plan-1");
		expect(result.content[0].text).toContain("Planner plan transitioned.");
		expect(result.details).toMatchObject({
			result: { current: { planId: "plan-1" } },
			nextPrompt: nextPlanPrompt,
		});
	});

	it("creates a work item through the orchestrator", async () => {
		const createWorkItem = vi.fn().mockReturnValue({
			workItemId: "parser-api",
			stage: "pending",
		});
		const buildWorkItemStagePrompt = vi
			.fn()
			.mockReturnValue(nextWorkItemPrompt);
		const orchestrator = {
			createWorkItem,
			buildWorkItemStagePrompt,
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
		expect(buildWorkItemStagePrompt).toHaveBeenCalledWith(
			"plan-1",
			"parser-api",
		);
		expect(result.content[0].text).toContain("Work item next instruction");
		expect(result.details).toMatchObject({
			result: { workItemId: "parser-api" },
			nextPrompt: nextWorkItemPrompt,
		});
	});

	it("transitions a work item through the orchestrator", async () => {
		const transitionWorkItem = vi.fn().mockReturnValue({
			current: { workItemId: "parser-api", stage: "ready" },
		});
		const buildWorkItemStagePrompt = vi
			.fn()
			.mockReturnValue(nextWorkItemPrompt);
		const orchestrator = {
			transitionWorkItem,
			buildWorkItemStagePrompt,
		} as unknown as PlannerOrchestrator;
		const tool = toolByName("planner_transition_work_item", orchestrator);

		const result = await tool.execute(
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
		expect(buildWorkItemStagePrompt).toHaveBeenCalledWith(
			"plan-1",
			"parser-api",
		);
		expect(result.details).toMatchObject({
			result: { current: { workItemId: "parser-api" } },
			nextPrompt: nextWorkItemPrompt,
		});
	});

	it("requests discovery compaction through the orchestrator", async () => {
		const requestDiscoveryCompact = vi.fn().mockReturnValue({
			kind: "started",
			pending: { id: "compact-1" },
		});
		const buildPlanStagePrompt = vi.fn().mockReturnValue(nextPlanPrompt);
		const orchestrator = {
			requestDiscoveryCompact,
			buildPlanStagePrompt,
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
		expect(buildPlanStagePrompt).toHaveBeenCalledWith("plan-1");
		expect(result.content[0].text).toContain(
			"Planner discovery compaction requested.",
		);
		expect(result.details).toMatchObject({
			result: { kind: "started" },
			nextPrompt: nextPlanPrompt,
		});
	});

	it("completes discovery compaction through the orchestrator", async () => {
		const completeDiscoveryCompact = vi.fn().mockReturnValue({
			current: { planId: "plan-1", stage: "post_discovery_questions" },
		});
		const buildPlanStagePrompt = vi.fn().mockReturnValue(nextPlanPrompt);
		const orchestrator = {
			completeDiscoveryCompact,
			buildPlanStagePrompt,
		} as unknown as PlannerOrchestrator;
		const tool = toolByName("planner_complete_discovery_compact", orchestrator);

		const result = await tool.execute(
			"call-1",
			{ planId: "plan-1" },
			undefined,
			undefined,
			context(),
		);

		expect(completeDiscoveryCompact).toHaveBeenCalledWith("plan-1");
		expect(buildPlanStagePrompt).toHaveBeenCalledWith("plan-1");
		expect(result.details).toMatchObject({
			result: { current: { planId: "plan-1" } },
			nextPrompt: nextPlanPrompt,
		});
	});

	it("requests work item compaction through the orchestrator", async () => {
		const requestWorkItemCompact = vi.fn().mockReturnValue({
			kind: "started",
			pending: { id: "compact-1" },
		});
		const buildWorkItemStagePrompt = vi
			.fn()
			.mockReturnValue(nextWorkItemPrompt);
		const orchestrator = {
			requestWorkItemCompact,
			buildWorkItemStagePrompt,
		} as unknown as PlannerOrchestrator;
		const ctx = context();
		const tool = toolByName("planner_request_work_item_compact", orchestrator);

		const result = await tool.execute(
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
		expect(buildWorkItemStagePrompt).toHaveBeenCalledWith(
			"plan-1",
			"parser-api",
		);
		expect(result.details).toMatchObject({
			result: { kind: "started" },
			nextPrompt: nextWorkItemPrompt,
		});
	});

	it("completes work item compaction through the orchestrator", async () => {
		const completeWorkItemCompact = vi.fn().mockReturnValue({
			current: { workItemId: "parser-api", stage: "completed" },
		});
		const buildWorkItemStagePrompt = vi
			.fn()
			.mockReturnValue(nextWorkItemPrompt);
		const orchestrator = {
			completeWorkItemCompact,
			buildWorkItemStagePrompt,
		} as unknown as PlannerOrchestrator;
		const tool = toolByName("planner_complete_work_item_compact", orchestrator);

		const result = await tool.execute(
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
		expect(buildWorkItemStagePrompt).toHaveBeenCalledWith(
			"plan-1",
			"parser-api",
		);
		expect(result.details).toMatchObject({
			result: { current: { workItemId: "parser-api" } },
			nextPrompt: nextWorkItemPrompt,
		});
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
