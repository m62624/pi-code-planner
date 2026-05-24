import { describe, expect, it } from "vitest";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "../storage/paths";
import { initializePlanFiles } from "../storage/plan-store";
import {
	ensureProjectRecord,
	setActivePlan,
	upsertProjectPlanSummary,
} from "../storage/project-store";
import { createInitialPlanState, createPlanRecord } from "../storage/schema";
import { initializePlanState, readPlanState } from "../storage/state-store";
import { MockPlannerFs } from "../test/mock-fs";
import { readActivePlanContext, updateActivePlanState } from "./active-plan";

describe("active plan runtime context", () => {
	it("reports missing project record without creating storage", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});

		const context = await readActivePlanContext({ fs, projectPaths });

		expect(context).toMatchObject({
			status: "missing_project",
			project: null,
			activePlanId: null,
		});
		expect(fs.snapshot()).toEqual({});
	});

	it("reports no active plan when project exists but activePlanId is null", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await ensureProjectRecord(fs, projectPaths);

		const context = await readActivePlanContext({ fs, projectPaths });

		expect(context).toMatchObject({
			status: "no_active_plan",
			activePlanId: null,
		});
	});

	it("loads project, plan, state, and plan paths for the active plan only", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await createStoredPlan(fs, projectPaths, "plan-a");
		await createStoredPlan(fs, projectPaths, "plan-b");
		await setActivePlan(fs, projectPaths, "plan-b");

		const context = await readActivePlanContext({ fs, projectPaths });

		expect(context.status).toBe("ready");
		if (context.status !== "ready") {
			throw new Error("Expected ready active plan context.");
		}
		expect(context.activePlanId).toBe("plan-b");
		expect(context.plan.planId).toBe("plan-b");
		expect(context.state.activeBranches.plan).toBe("plan/plan-b");
		expect(context.planPaths.stateJson).toContain("/plans/plan-b/state.json");
	});

	it("reports missing plan record separately from missing state", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await ensureProjectRecord(fs, projectPaths);
		await setActivePlan(fs, projectPaths, "missing-plan");

		const context = await readActivePlanContext({ fs, projectPaths });

		expect(context).toMatchObject({
			status: "missing_plan",
			activePlanId: "missing-plan",
		});
	});

	it("reports missing state when plan json exists but state json is absent", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
		await ensureProjectRecord(fs, projectPaths);
		await initializePlanFiles(
			fs,
			planPaths,
			createPlanRecord({ planId: "plan-a", title: "Plan A" }),
		);
		await setActivePlan(fs, projectPaths, "plan-a");

		const context = await readActivePlanContext({ fs, projectPaths });

		expect(context).toMatchObject({
			status: "missing_state",
			activePlanId: "plan-a",
		});
	});

	it("updates active plan state and returns a refreshed context", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		const planPaths = await createStoredPlan(fs, projectPaths, "plan-a");
		await setActivePlan(fs, projectPaths, "plan-a");
		const context = await readActivePlanContext({ fs, projectPaths });
		if (context.status !== "ready") {
			throw new Error("Expected ready active plan context.");
		}

		const updated = await updateActivePlanState({
			fs,
			context,
			update: (state) => ({
				...state,
				stage: "discovery",
				step: "read_project",
				stepStatus: "running",
			}),
		});

		expect(updated.state).toMatchObject({
			stage: "discovery",
			step: "read_project",
			stepStatus: "running",
		});
		await expect(readPlanState(fs, planPaths)).resolves.toMatchObject({
			stage: "discovery",
			step: "read_project",
			stepStatus: "running",
		});
	});
});

async function createStoredPlan(
	fs: MockPlannerFs,
	projectPaths: ReturnType<typeof createProjectStoragePaths>,
	planId: string,
) {
	const planPaths = createPlanStoragePaths(projectPaths, planId);
	await upsertProjectPlanSummary(fs, projectPaths, {
		planId,
		title: planId,
		status: "active",
	});
	await initializePlanFiles(
		fs,
		planPaths,
		createPlanRecord({ planId, title: planId }),
	);
	await initializePlanState(
		fs,
		planPaths,
		createInitialPlanState({
			baseBranch: "main",
			planBranch: `plan/${planId}`,
		}),
	);
	return planPaths;
}
