import { describe, expect, it, vi } from "vitest";
import {
	type CompactContext,
	CompactionCoordinator,
} from "../compaction/coordinator";
import { RuntimeStateManager } from "../planner-state/runtime";
import { createSettingsPaths } from "../settings/paths";
import { PlanStore } from "../storage/store";
import { MemoryFs } from "../test/memory-fs";
import { WorkflowManager } from "../workflow/manager";
import {
	PlannerOrchestrator,
	PlannerOrchestratorBlockedByCompact,
} from "./planner-orchestrator";

const paths = createSettingsPaths({
	agentDir: "/agent",
	cwd: "/repo",
	extensionName: "pi-planner",
});

function createHarness() {
	const fs = new MemoryFs();
	const runtime = new RuntimeStateManager({ paths, fs });
	runtime.initialize();
	let tick = 0;
	const store = new PlanStore({
		paths,
		fs,
		now: () => `2026-05-15T00:00:${String(tick++).padStart(2, "0")}.000Z`,
	});
	const workflow = new WorkflowManager(store);
	const compactor = new CompactionCoordinator({
		state: runtime,
		now: () => `2026-05-15T00:01:${String(tick++).padStart(2, "0")}.000Z`,
		createId: () => "compact-1",
	});
	const orchestrator = new PlannerOrchestrator({
		projectPath: "/repo",
		store,
		workflow,
		runtime,
		compactor,
	});
	const ctx: Pick<CompactContext, "compact"> = {
		compact: vi.fn(),
	};
	return { compactor, ctx, fs, orchestrator, runtime, store };
}

describe("PlannerOrchestrator", () => {
	it("creates a plan and activates runtime state", () => {
		const { orchestrator, runtime, store } = createHarness();

		const plan = orchestrator.createPlan({
			title: "Parser rewrite",
			planId: "plan-1",
		});

		expect(plan).toMatchObject({
			planId: "plan-1",
			stage: "plan_draft",
			status: "draft",
		});
		expect(runtime.get()).toMatchObject({
			mode: "plan_active",
			activePlanId: "plan-1",
			activeWorkItemId: null,
		});
		expect(store.readPlan("/repo", "plan-1").title).toBe("Parser rewrite");
	});

	it("transitions plan stages through WorkflowManager", () => {
		const { orchestrator, runtime, store } = createHarness();
		orchestrator.createPlan({ title: "Plan", planId: "plan-1" });

		const result = orchestrator.transitionPlan("plan-1", "discovery_full");

		expect(result.previous.stage).toBe("plan_draft");
		expect(result.current.stage).toBe("discovery_full");
		expect(store.readPlan("/repo", "plan-1").status).toBe("draft");
		expect(runtime.get().activePlanId).toBe("plan-1");
	});

	it("requests discovery compact at the compact boundary", () => {
		const { compactor, ctx, orchestrator, runtime, store } = createHarness();
		orchestrator.createPlan({ title: "Plan", planId: "plan-1" });
		orchestrator.transitionPlan("plan-1", "discovery_full");

		const result = orchestrator.requestDiscoveryCompact(ctx, "plan-1", {
			customInstructions: "compact discovery",
			resumePrompt: "continue after discovery compact",
		});

		expect(result.kind).toBe("started");
		expect(store.readPlan("/repo", "plan-1").stage).toBe(
			"discovery_compact_required",
		);
		expect(runtime.get().pendingCompact).toMatchObject({
			id: "compact-1",
			reason: "discovery",
			activePlanId: "plan-1",
			activeWorkItemId: null,
			customInstructions: "compact discovery",
			resumePrompt: "continue after discovery compact",
		});
		expect(compactor.getPending()?.status).toBe("requested");
		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("blocks completing a compact boundary until resume is consumed", () => {
		const { ctx, orchestrator } = createHarness();
		orchestrator.createPlan({ title: "Plan", planId: "plan-1" });
		orchestrator.transitionPlan("plan-1", "discovery_full");
		orchestrator.requestDiscoveryCompact(ctx, "plan-1", {
			customInstructions: "compact",
			resumePrompt: "resume",
		});

		expect(() => orchestrator.completeDiscoveryCompact("plan-1")).toThrow(
			PlannerOrchestratorBlockedByCompact,
		);
	});

	it("completes discovery compact after pending resume is consumed", () => {
		const { compactor, ctx, orchestrator, store } = createHarness();
		orchestrator.createPlan({ title: "Plan", planId: "plan-1" });
		orchestrator.transitionPlan("plan-1", "discovery_full");
		orchestrator.requestDiscoveryCompact(ctx, "plan-1", {
			customInstructions: "compact",
			resumePrompt: "resume",
		});
		compactor.markCompleted("compact-1");
		expect(compactor.consumeResumeInstructionForNextTurn()).toBe("resume");

		const result = orchestrator.completeDiscoveryCompact("plan-1");

		expect(result.current.stage).toBe("post_discovery_questions");
		expect(store.readPlan("/repo", "plan-1").stage).toBe(
			"post_discovery_questions",
		);
	});

	it("creates and transitions work items while updating active work item id", () => {
		const { orchestrator, runtime } = createHarness();
		orchestrator.createPlan({ title: "Plan", planId: "plan-1" });
		const workItem = orchestrator.createWorkItem("plan-1", {
			title: "Parser API",
			workItemId: "parser-api",
		});

		expect(workItem.stage).toBe("pending");
		orchestrator.transitionWorkItem("plan-1", "parser-api", "ready");
		orchestrator.transitionWorkItem("plan-1", "parser-api", "active");

		expect(runtime.get().activeWorkItemId).toBe("parser-api");
	});

	it("requests work item compact and completes after resume consumption", () => {
		const { compactor, ctx, orchestrator, runtime, store } = createHarness();
		orchestrator.createPlan({ title: "Plan", planId: "plan-1" });
		orchestrator.createWorkItem("plan-1", {
			title: "Parser API",
			workItemId: "parser-api",
			stage: "signature_refresh",
			status: "active",
		});

		orchestrator.requestWorkItemCompact(ctx, "plan-1", {
			workItemId: "parser-api",
			customInstructions: "compact work item",
			resumePrompt: "continue after work item compact",
		});
		expect(store.readWorkItem("/repo", "plan-1", "parser-api").stage).toBe(
			"work_item_compact_required",
		);
		expect(runtime.get().pendingCompact).toMatchObject({
			reason: "work_item",
			activeWorkItemId: "parser-api",
		});

		compactor.markCompleted("compact-1");
		compactor.consumeResumeInstructionForNextTurn();
		const result = orchestrator.completeWorkItemCompact("plan-1", "parser-api");

		expect(result.current.stage).toBe("completed");
		expect(runtime.get().activeWorkItemId).toBeNull();
	});
});
