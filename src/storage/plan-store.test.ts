import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../constants";
import { MockPlannerFs } from "../test/mock-fs";
import { createPlanStoragePaths, createProjectStoragePaths } from "./paths";
import { readPlanRecord, savePlanRecord, updatePlanRecord } from "./plan-store";
import type { PlanRecord, PlanTaskSummary } from "./schema";

function seedPlan() {
	const planPaths = createPlanStoragePaths(
		createProjectStoragePaths({ agentDir: "/agent", projectRoot: "/repo/app" }),
		"plan-a",
	);
	const base: PlanRecord = {
		schemaVersion: SCHEMA_VERSION,
		planId: "plan-a",
		title: "Plan A",
		status: "draft",
		tasks: [],
	};
	return { planPaths, base };
}

function appendSummary(taskId: string) {
	const summary: PlanTaskSummary = {
		taskId,
		title: taskId,
		status: "pending",
	};
	return (plan: PlanRecord): PlanRecord => ({
		...plan,
		tasks: plan.tasks.some((task) => task.taskId === taskId)
			? plan.tasks
			: [...plan.tasks, summary],
	});
}

describe("updatePlanRecord", () => {
	it("does not drop entries when a batch of upserts mutates plan.json at once", async () => {
		const fs = new MockPlannerFs();
		const { planPaths, base } = seedPlan();
		await savePlanRecord(fs, planPaths, base);

		// The exact scenario from session 20fc5175: the model authored five
		// tasks in one message, Pi ran the upserts concurrently, and one task
		// (tasktracker) never made it into plan.tasks. Fire them concurrently.
		const taskIds = [
			"cargo-init",
			"library-core",
			"tasktracker",
			"library-storage",
			"cli-binary",
		];
		await Promise.all(
			taskIds.map((taskId) =>
				updatePlanRecord(fs, planPaths, appendSummary(taskId)),
			),
		);

		const plan = await readPlanRecord(fs, planPaths);
		expect(plan.tasks.map((task) => task.taskId).sort()).toEqual(
			[...taskIds].sort(),
		);
	});

	it("keeps serializing later writes after one mutation throws", async () => {
		const fs = new MockPlannerFs();
		const { planPaths, base } = seedPlan();
		await savePlanRecord(fs, planPaths, base);

		const failing = updatePlanRecord(fs, planPaths, () => {
			throw new Error("boom");
		});
		const succeeding = updatePlanRecord(fs, planPaths, appendSummary("ok"));

		await expect(failing).rejects.toThrow("boom");
		await succeeding;

		const plan = await readPlanRecord(fs, planPaths);
		expect(plan.tasks.map((task) => task.taskId)).toEqual(["ok"]);
	});
});
