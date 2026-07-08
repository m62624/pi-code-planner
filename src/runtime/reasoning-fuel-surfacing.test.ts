import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
	type PlanStoragePaths,
} from "../storage/paths";
import { initializePlanFiles } from "../storage/plan-store";
import { ensureProjectRecord, setActivePlan } from "../storage/project-store";
import {
	createInitialPlanState,
	createPlanRecord,
	type PlanStateRecord,
} from "../storage/schema";
import { validateSpecRecord, writeSpecArtifacts } from "../storage/spec-store";
import { initializePlanState } from "../storage/state-store";
import { MockPlannerFs } from "../test/mock-fs";
import { formatTransitionReasoningFuelTail } from "./status";

/**
 * The reasoning-fuel nudge must reach the model in the drive loop — on the tail
 * of an applied workflow transition (planner_finish_step), not only on a rare
 * planner_status call. formatTransitionReasoningFuelTail is that seam. These
 * tests pin the gate condition (only on an applied transition against a ready
 * plan) and the self-silencing (empty when no web, present when a web or
 * friction warrants the engine).
 */

async function setupPlan(overrides: Partial<PlanStateRecord>): Promise<{
	fs: MockPlannerFs;
	planPaths: PlanStoragePaths;
	state: PlanStateRecord;
}> {
	const fs = new MockPlannerFs();
	const projectPaths = createProjectStoragePaths({
		agentDir: "/agent",
		projectRoot: "/repo/app",
	});
	const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
	const worktreePath = "/repo/app/.pi/pi-code-planner/worktrees/plan-a";
	await ensureProjectRecord(fs, projectPaths);
	await initializePlanFiles(
		fs,
		planPaths,
		createPlanRecord({ planId: "plan-a", title: "Plan A" }),
	);
	await fs.mkdirp(worktreePath);
	const state: PlanStateRecord = {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/plan-a",
			worktreePath,
		}),
		stage: "planning",
		step: "consistency_check",
		stepStatus: "running",
		currentBranch: "plan/plan-a",
		...overrides,
	};
	await initializePlanState(fs, planPaths, state);
	await setActivePlan(fs, projectPaths, "plan-a");
	return { fs, planPaths, state };
}

async function writeSpecWithConstraints(
	fs: MockPlannerFs,
	planPaths: PlanStoragePaths,
	count: number,
): Promise<void> {
	await writeSpecArtifacts(
		fs,
		planPaths,
		validateSpecRecord({
			requirements: [
				{
					id: "REQ-1",
					statement: "Behavior.",
					acceptance: "Checked.",
					acceptanceAtom: "req_1_ok",
					priority: "must",
					inScope: true,
				},
			],
			constraints: Array.from({ length: count }, (_, i) => ({
				id: `CON-${i + 1}`,
				statement: `Constraint ${i + 1}.`,
				kind: "invariant" as const,
			})),
		}),
	);
}

describe("formatTransitionReasoningFuelTail", () => {
	it("stays empty when the transition did not apply", async () => {
		const { fs, planPaths, state } = await setupPlan({});
		await writeSpecWithConstraints(fs, planPaths, 2);
		const tail = await formatTransitionReasoningFuelTail({
			fs,
			status: "blocked",
			planPaths,
			state,
		});
		expect(tail).toBe("");
	});

	it("stays empty when no plan is ready (no planPaths or state)", async () => {
		const { fs, planPaths, state } = await setupPlan({});
		await writeSpecWithConstraints(fs, planPaths, 2);
		expect(
			await formatTransitionReasoningFuelTail({
				fs,
				status: "applied",
				planPaths: undefined,
				state,
			}),
		).toBe("");
		expect(
			await formatTransitionReasoningFuelTail({
				fs,
				status: "applied",
				planPaths,
				state: null,
			}),
		).toBe("");
	});

	it("surfaces the fuel nudge on an applied transition that lands on a webby step", async () => {
		const { fs, planPaths, state } = await setupPlan({});
		await writeSpecWithConstraints(fs, planPaths, 2);
		const tail = await formatTransitionReasoningFuelTail({
			fs,
			status: "applied",
			planPaths,
			state,
		});
		expect(tail).toContain("Reasoning fuel:");
		expect(tail).toContain("## Reasoning Fuel");
		expect(tail).toContain("spec constraints");
	});

	it("stays silent on an applied transition with no interacting-condition web", async () => {
		const { fs, planPaths, state } = await setupPlan({});
		// consistency_check with a spec that declares zero constraints ⇒ W = 0.
		await writeSpecWithConstraints(fs, planPaths, 0);
		const tail = await formatTransitionReasoningFuelTail({
			fs,
			status: "applied",
			planPaths,
			state,
		});
		expect(tail).toBe("");
	});

	it("surfaces gate-thrash friction even when the step has no web", async () => {
		const { fs, planPaths, state } = await setupPlan({});
		// No spec ⇒ W = 0, but a gate re-run with the same verdict (repeat ≥ 2)
		// is friction — the one signal that fired in the real 1-hour run.
		await fs.writeTextAtomic(
			join(planPaths.elenchusDir, "last-check.json"),
			JSON.stringify({
				name: "plan-gate",
				stage: "planning",
				step: "consistency_check",
				outcome: "CONSISTENT",
				recordedAt: "2026-07-05T00:00:00.000Z",
				gate: "plan_coverage",
				sourceHash: "abc",
				repeat: 2,
			}),
		);
		const tail = await formatTransitionReasoningFuelTail({
			fs,
			status: "applied",
			planPaths,
			state,
		});
		expect(tail).toContain("Reasoning fuel:");
		expect(tail).toContain("thrash");
	});
});
