import { describe, expect, it } from "vitest";
import { MockPlannerFs } from "../test/mock-fs";
import { createProjectStoragePaths } from "./paths";
import { readProjectRecord, upsertProjectPlanSummary } from "./project-store";
import type { ProjectPlanSummary } from "./schema";

describe("updateProjectRecord (via upsertProjectPlanSummary)", () => {
	it("does not drop entries when concurrent upserts append plan summaries", async () => {
		const fs = new MockPlannerFs();
		const paths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});

		// Same lost-update class as the plan.tasks race: several summaries
		// appended to the one project.json at once. Each read-modify-write must
		// observe the previous one or an append is silently clobbered.
		const summaries: ProjectPlanSummary[] = ["a", "b", "c", "d", "e"].map(
			(planId) => ({ planId, title: planId, status: "active" }),
		);
		await Promise.all(
			summaries.map((summary) => upsertProjectPlanSummary(fs, paths, summary)),
		);

		const record = await readProjectRecord(fs, paths);
		expect(record.plans.map((plan) => plan.planId).sort()).toEqual([
			"a",
			"b",
			"c",
			"d",
			"e",
		]);
	});
});
