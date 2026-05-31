import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncInstructionFiles } from "../instructions/manager";
import { createInstructionPaths } from "../instructions/paths";
import { createMemoryStoragePaths } from "../memory/paths";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "../storage/paths";
import { createInitialPlanState } from "../storage/schema";
import { TEST_INSTRUCTION_DEFAULTS } from "../test/instruction-defaults";
import { MockPlannerFs } from "../test/mock-fs";
import {
	buildPlannerCompactInstructionBundle,
	buildPlannerPostAutoCompactMessage,
	clearPlannerControlledCompact,
	collectAutoCompactInstructionSections,
	consumePlannerControlledCompact,
	createPlannerCompactRuntimeState,
	markPlannerControlledCompactStarted,
	PLANNER_COMPACT_MARKER,
	PLANNER_SYSTEM_INSTRUCTIONS_HEADER,
} from "./compact";
import type { PlannerPreflightResult } from "./preflight";

describe("planner compact runtime", () => {
	it("tracks planner-controlled compact so auto compact handlers can skip follow-up", () => {
		const state = createPlannerCompactRuntimeState();

		expect(consumePlannerControlledCompact(state)).toBe(false);

		markPlannerControlledCompactStarted(state);

		expect(consumePlannerControlledCompact(state)).toBe(true);
		expect(consumePlannerControlledCompact(state)).toBe(false);

		markPlannerControlledCompactStarted(state);
		clearPlannerControlledCompact(state);

		expect(consumePlannerControlledCompact(state)).toBe(false);
	});

	it("builds manual compact instructions with planner state, artifacts, and section content", async () => {
		const setup = await createCompactSetup();
		const bundle = await buildPlannerCompactInstructionBundle({
			fs: setup.fs,
			projectPaths: setup.projectPaths,
			preflight: setup.preflight,
			sectionName: "manual-compact",
		});

		expect(bundle.text).toContain(PLANNER_COMPACT_MARKER);
		expect(bundle.text).toContain("- planId: plan-a");
		expect(bundle.text).toContain("- stage: execution");
		expect(bundle.text).toContain("- step: compact_task");
		expect(bundle.text).toContain(setup.planPaths.requestMd);
		expect(bundle.text).toContain(setup.planPaths.goalMd);
		expect(bundle.text).toContain(setup.planPaths.planMd);
		expect(bundle.text).toContain("Preserve task result and artifact links.");
		expect(bundle.sections).toMatchObject([
			{ key: "execution", found: true },
			{ key: "experiment", found: false },
		]);
	});

	it("builds auto compact follow-up message that forces planner_status", async () => {
		const setup = await createCompactSetup();
		const sections = await collectAutoCompactInstructionSections({
			fs: setup.fs,
			projectPaths: setup.projectPaths,
			preflight: setup.preflight,
		});

		const message = buildPlannerPostAutoCompactMessage({
			preflight: setup.preflight,
			sections,
		});

		expect(message).toContain(PLANNER_SYSTEM_INSTRUCTIONS_HEADER);
		expect(message).toContain("Call planner_status now");
		expect(message).toContain("- planId: plan-a");
		expect(message).toContain("- step: compact_task");
		expect(message).toContain("Check git and memory before resuming.");
	});
});

async function createCompactSetup() {
	const fs = new MockPlannerFs();
	const projectPaths = createProjectStoragePaths({
		agentDir: "/agent",
		projectRoot: "/repo/app",
	});
	const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
	const memoryPaths = createMemoryStoragePaths(planPaths);
	const worktreePath = join(
		projectPaths.projectRoot,
		".pi",
		"pi-code-planner",
		"worktrees",
		"plan-a",
	);
	const state = {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/plan-a",
			worktreePath,
		}),
		stage: "execution",
		step: "compact_task",
		stepStatus: "blocked",
		activeTaskId: "task-1",
		currentBranch: "task/plan-a/task-1",
		lastCheckpointCommit: "abc123",
		requiresCompact: true,
	} as const;
	const preflight = {
		context: {
			status: "ready",
			activePlanId: "plan-a",
			planPaths,
			state,
		},
		decision: {
			action: "require_compact",
			reason: "Planner compact boundary is pending.",
			allowedTools: ["planner_status"],
		},
		planPaths,
		memoryPaths,
		instructions: {
			keys: ["execution", "experiment"],
			entries: [],
		},
	} as unknown as PlannerPreflightResult;

	await syncInstructionFiles(fs, createInstructionPaths(projectPaths), {
		...TEST_INSTRUCTION_DEFAULTS,
		execution: [
			"# execution",
			"",
			"## manual-compact",
			"Preserve task result and artifact links.",
			"",
			"## auto-compact",
			"Check git and memory before resuming.",
		].join("\n"),
	});

	return { fs, projectPaths, planPaths, preflight };
}
