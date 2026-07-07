import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncInstructionFiles } from "../instructions/manager";
import { createInstructionPaths } from "../instructions/paths";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "../storage/paths";
import { createInitialPlanState } from "../storage/schema";
import { TEST_INSTRUCTION_DEFAULTS } from "../test/instruction-defaults";
import { MockPlannerFs } from "../test/mock-fs";
import type { PlannerPreflightResult } from "./preflight";
import {
	buildPlannerStatusText,
	getPlannerStepRule,
	resolveCompactStepRule,
} from "./status";

/**
 * The stage instruction is no longer inlined on every planner_status (it bloated
 * the prompt for local models). It returns only on the FIRST status after a
 * compact (pendingFullStatus), and forks must name their targets so the model
 * does not guess `{}` and get bounced.
 */
async function makePreflight(overrides: {
	step: string;
	stepStatus?: string;
	pendingFullStatus?: boolean;
	/** Defaults to the fixture stage ("execution") — i.e. already briefed here. */
	lastFullStatusStage?: string;
}): Promise<{ fs: MockPlannerFs; preflight: PlannerPreflightResult }> {
	const fs = new MockPlannerFs();
	const projectPaths = createProjectStoragePaths({
		agentDir: "/agent",
		projectRoot: "/repo/app",
	});
	const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
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
		step: overrides.step,
		stepStatus: overrides.stepStatus ?? "running",
		activeTaskId: "task-1",
		currentBranch: "task/plan-a/task-1",
		pendingFullStatus: overrides.pendingFullStatus ?? false,
		lastFullStatusStage: overrides.lastFullStatusStage ?? "execution",
	};
	const entry = {
		key: "execution",
		defaultPath: join(
			createInstructionPaths(projectPaths).defaultsDir,
			"execution.md",
		),
		projectAppendPath:
			"/repo/app/.pi/pi-code-planner/instructions/append/execution.md",
		globalAppendPath: "/agent/instructions/append/execution.md",
	};
	const preflight = {
		context: {
			status: "ready",
			activePlanId: "plan-a",
			plan: { title: "Test plan" },
			projectPaths,
			planPaths,
			state,
		},
		gitReality: {
			branch: "task/plan-a/task-1",
			isDirty: false,
			hasConflicts: false,
		},
		worktreeExists: true,
		decision: {
			action: "allow_stage_machine",
			reason: "",
			allowedTools: ["planner_status"],
		},
		planPaths,
		instructions: { keys: ["execution"], entries: [entry] },
	} as unknown as PlannerPreflightResult;

	await syncInstructionFiles(fs, createInstructionPaths(projectPaths), {
		...TEST_INSTRUCTION_DEFAULTS,
		execution: "# execution\n\nUNIQUE_STAGE_INSTRUCTION_BODY marker.",
	});

	return { fs, preflight };
}

describe("buildPlannerStatusText — instruction inlining", () => {
	it("omits the full stage instruction on a normal status", async () => {
		const { fs, preflight } = await makePreflight({ step: "implement_task" });
		const text = await buildPlannerStatusText({ fs, preflight });
		expect(text).not.toContain("## Current Stage Instruction");
		expect(text).not.toContain("UNIQUE_STAGE_INSTRUCTION_BODY");
		// The routing paths are still there so the model can read on demand.
		expect(text).toContain("## Instruction Files To Read");
	});

	it("re-inlines the full stage instruction on the first status after a compact", async () => {
		const { fs, preflight } = await makePreflight({
			step: "implement_task",
			pendingFullStatus: true,
		});
		const text = await buildPlannerStatusText({ fs, preflight });
		expect(text).toContain("## Current Stage Instruction");
		expect(text).toContain("UNIQUE_STAGE_INSTRUCTION_BODY");
	});

	it("inlines the full stage instruction on the first status of a new stage", async () => {
		// Last briefed on a different stage — entering execution shows its job once.
		const { fs, preflight } = await makePreflight({
			step: "implement_task",
			lastFullStatusStage: "planning",
		});
		const text = await buildPlannerStatusText({ fs, preflight });
		expect(text).toContain("## Current Stage Instruction");
		expect(text).toContain("UNIQUE_STAGE_INSTRUCTION_BODY");
	});
});

describe("buildPlannerStatusText — fork targets", () => {
	it("names the fork targets on a branching step", async () => {
		const { fs, preflight } = await makePreflight({ step: "run_final_tests" });
		const text = await buildPlannerStatusText({ fs, preflight });
		expect(text).toContain("This step forks");
		expect(text).toContain("capture_skill");
		expect(text).toContain("implement_task");
	});

	it("states the decision criterion for a known fork", async () => {
		const { fs, preflight } = await makePreflight({ step: "run_final_tests" });
		const text = await buildPlannerStatusText({ fs, preflight });
		// Not just the targets: WHICH one, so the model picks right the first time.
		expect(text).toContain("Choose:");
		expect(text).toContain("capture_skill when all final tests");
		expect(text).toContain("implement_task when a test still fails");
	});

	it("adds no fork line on a linear step", async () => {
		const { fs, preflight } = await makePreflight({ step: "compact_task" });
		const text = await buildPlannerStatusText({ fs, preflight });
		expect(text).not.toContain("This step forks");
	});
});

describe("resolveCompactStepRule", () => {
	const compactTask = getPlannerStepRule({
		stage: "execution",
		step: "compact_task",
	});

	it("renders one enabled directive and keeps the connection check", () => {
		const rule = resolveCompactStepRule(compactTask, true);
		// The connection check (genuine non-boundary work) survives as the lead.
		expect(rule.requiredActions[0]).toContain(
			"did the task change any component",
		);
		const joined = rule.requiredActions.join("\n");
		expect(joined).toContain("planner_request_compact");
		expect(joined).toContain("planner_complete_compact");
		expect(rule.nextInstruction).toContain("planner_request_compact");
		// No classify-first residue.
		expect(joined).not.toMatch(/if (task )?compaction is (ENABLED|DISABLED)/i);
	});

	it("renders one disabled directive that points at finish_step", () => {
		const rule = resolveCompactStepRule(compactTask, false);
		const joined = rule.requiredActions.join("\n");
		expect(joined).toContain("disabled in your settings");
		expect(joined).toContain("planner_finish_step");
		expect(rule.nextInstruction).toContain(
			"do not call planner_request_compact",
		);
		// The connection check still leads even when the boundary is skipped.
		expect(rule.requiredActions[0]).toContain(
			"did the task change any component",
		);
	});

	it("surfaces the preserve hint only when the boundary is enabled", () => {
		const spec = getPlannerStepRule({ stage: "spec", step: "compact_spec" });
		expect(
			resolveCompactStepRule(spec, true).requiredActions.join("\n"),
		).toContain("requirement ids");
		expect(
			resolveCompactStepRule(spec, false).requiredActions.join("\n"),
		).not.toContain("requirement ids");
	});

	it("passes a non-compact step through unchanged", () => {
		const draft = getPlannerStepRule({
			stage: "spec",
			step: "draft_requirements",
		});
		expect(resolveCompactStepRule(draft, true)).toBe(draft);
		expect(resolveCompactStepRule(draft, false)).toBe(draft);
	});
});
