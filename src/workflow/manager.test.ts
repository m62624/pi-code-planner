import { describe, expect, it } from "vitest";
import { createSettingsPaths } from "../settings/paths";
import { PlanStore } from "../storage/store";
import { MemoryFs } from "../test/memory-fs";
import { WorkflowManager, WorkflowTransitionRejected } from "./manager";

const settingsPaths = createSettingsPaths({
	agentDir: "/agent",
	cwd: "/repo",
	extensionName: "pi-planner",
});

function setup() {
	let tick = 0;
	const fs = new MemoryFs();
	const store = new PlanStore({
		paths: settingsPaths,
		fs,
		now: () => `2026-05-15T00:00:0${tick++}.000Z`,
	});
	const workflow = new WorkflowManager(store);
	return { store, workflow };
}

function createPlanTree(store: PlanStore) {
	store.createPlan("/repo", { title: "Plan", planId: "plan-1" });
	store.createWorkItem("/repo", "plan-1", {
		title: "Parser API",
		workItemId: "parser-api",
	});
	store.createAttempt("/repo", "plan-1", "parser-api", {
		attemptId: "attempt-1",
	});
}

describe("WorkflowManager", () => {
	it("transitions a plan and derives status", () => {
		const { store, workflow } = setup();
		store.createPlan("/repo", { title: "Plan", planId: "plan-1" });

		const result = workflow.transitionPlan("/repo", "plan-1", "discovery_full");

		expect(result.previous.stage).toBe("plan_draft");
		expect(result.current).toMatchObject({
			stage: "discovery_full",
			status: "draft",
		});
		expect(result.current.updatedAt).not.toBe(result.previous.updatedAt);
		expect(store.readPlan("/repo", "plan-1")).toEqual(result.current);
	});

	it("rejects invalid plan transitions without changing storage", () => {
		const { store, workflow } = setup();
		store.createPlan("/repo", { title: "Plan", planId: "plan-1" });
		const before = store.readPlan("/repo", "plan-1");

		expect(() =>
			workflow.transitionPlan("/repo", "plan-1", "plan_active"),
		).toThrow(WorkflowTransitionRejected);
		expect(store.readPlan("/repo", "plan-1")).toEqual(before);
	});

	it("transitions a work item through commit boundary stages", () => {
		const { store, workflow } = setup();
		createPlanTree(store);
		store.updateWorkItem("/repo", "plan-1", "parser-api", {
			stage: "verification",
			status: "active",
		});

		const commit = workflow.transitionWorkItem(
			"/repo",
			"plan-1",
			"parser-api",
			"work_item_commit",
		);
		const refresh = workflow.transitionWorkItem(
			"/repo",
			"plan-1",
			"parser-api",
			"signature_refresh",
		);
		const compact = workflow.transitionWorkItem(
			"/repo",
			"plan-1",
			"parser-api",
			"work_item_compact_required",
		);

		expect(commit.current.status).toBe("active");
		expect(refresh.current.stage).toBe("signature_refresh");
		expect(compact.current.stage).toBe("work_item_compact_required");
	});

	it("rejects invalid work item transitions without changing storage", () => {
		const { store, workflow } = setup();
		createPlanTree(store);
		const before = store.readWorkItem("/repo", "plan-1", "parser-api");

		expect(() =>
			workflow.transitionWorkItem("/repo", "plan-1", "parser-api", "completed"),
		).toThrow(WorkflowTransitionRejected);
		expect(store.readWorkItem("/repo", "plan-1", "parser-api")).toEqual(before);
	});

	it("transitions attempts and derives selected status", () => {
		const { store, workflow } = setup();
		createPlanTree(store);
		for (const stage of [
			"active",
			"implemented",
			"verified",
			"scored",
			"candidate",
			"selected",
		] as const) {
			workflow.transitionAttempt(
				"/repo",
				"plan-1",
				"parser-api",
				"attempt-1",
				stage,
			);
		}

		const attempt = store.readAttempt(
			"/repo",
			"plan-1",
			"parser-api",
			"attempt-1",
		);
		expect(attempt).toMatchObject({
			stage: "selected",
			status: "selected",
		});
	});

	it("rejects invalid attempt transitions without changing storage", () => {
		const { store, workflow } = setup();
		createPlanTree(store);
		store.updateAttempt("/repo", "plan-1", "parser-api", "attempt-1", {
			stage: "verified",
			status: "active",
		});
		const before = store.readAttempt(
			"/repo",
			"plan-1",
			"parser-api",
			"attempt-1",
		);

		expect(() =>
			workflow.transitionAttempt(
				"/repo",
				"plan-1",
				"parser-api",
				"attempt-1",
				"selected",
			),
		).toThrow(WorkflowTransitionRejected);
		expect(
			store.readAttempt("/repo", "plan-1", "parser-api", "attempt-1"),
		).toEqual(before);
	});

	it("allows unchanged transitions for idempotent saves", () => {
		const { store, workflow } = setup();
		store.createPlan("/repo", { title: "Plan", planId: "plan-1" });

		const result = workflow.transitionPlan("/repo", "plan-1", "plan_draft");

		expect(result.decision).toMatchObject({
			allowed: true,
			reason: "Stage is unchanged.",
		});
		expect(result.current.stage).toBe("plan_draft");
	});
});
