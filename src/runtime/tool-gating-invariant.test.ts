import { describe, expect, it } from "vitest";
import {
	getAllowedPlannerWrapperTools,
	PLANNER_WRAPPER_TOOLS,
	type PlannerWrapperTool,
} from "../guard/tool-policy";
import {
	PLANNER_STAGE_STEPS,
	type PlannerStage,
	type PlannerStep,
} from "../storage/schema";
import {
	checkPlannerStageBehaviorWrapperTool,
	getPlannerStageStepBehavior,
} from "./stage-behavior";

// A planner tool is usable at a step only if it passes BOTH gates: the guard
// policy (STEP_ALLOWED_TOOLS) and the stage-behavior expectedTools gate. The
// two gates are composed in orchestrator-gate.ts, but ONLY on the normal
// `allow_stage_machine` path — i.e. when the plan is not broken, not awaiting a
// user decision, and not at a compact boundary. In those special states the
// behavior gate is bypassed and the guard returns a fixed recovery/compact set.
//
// So the deadlock invariant has two halves, and this test enforces both so any
// drift between the allowlists (debug, git, contract, fill-tools, or future
// additions) is caught before publish.

const STEPS = Object.entries(PLANNER_STAGE_STEPS) as Array<
	[PlannerStage, readonly PlannerStep[]]
>;

describe("planner tool gating invariant", () => {
	// Half 1 — normal (allow_stage_machine) path: everything the guard permits
	// MUST also pass the behavior gate, or the guard advertises a tool the model
	// can never actually call (a deadlock when no fallback exists, as happened
	// with the artifact fill-tools). Checked with debug artifacts both present
	// and absent, since debugArtifactsDir changes the guard set.
	for (const debugArtifactsDir of [null, "/tmp/planner-debug"]) {
		it(`guard-allowed wrappers pass the behavior gate at every step (debug=${debugArtifactsDir ? "on" : "off"})`, () => {
			const violations: string[] = [];
			for (const [stage, stepList] of STEPS) {
				for (const step of stepList) {
					const allowed = getAllowedPlannerWrapperTools({
						stage,
						step,
						broken: false,
						requiresUserDecision: false,
						requiresCompact: false,
						debugArtifactsDir,
					});
					const behavior = getPlannerStageStepBehavior({ stage, step });
					for (const tool of allowed as readonly PlannerWrapperTool[]) {
						if (
							!checkPlannerStageBehaviorWrapperTool({ behavior, tool }).allow
						) {
							violations.push(`${stage}/${step}: ${tool}`);
						}
					}
				}
			}
			expect(violations, violations.join("\n")).toEqual([]);
		});
	}

	// Half 2 — special states bypass the behavior gate, so the guard is the sole
	// gate. Their allowed set must therefore be FIXED (independent of the frozen
	// stage/step); otherwise a step-scoped tool could leak into a state where
	// nothing checks it against stage behavior. We pin that the set is identical
	// across every stage/step for each special flag.
	for (const flags of [
		{ name: "broken", broken: true, requiresUserDecision: false },
		{ name: "requiresUserDecision", broken: false, requiresUserDecision: true },
	] as const) {
		it(`guard set is fixed (step-independent) when ${flags.name}`, () => {
			const sets = STEPS.flatMap(([stage, stepList]) =>
				stepList.map((step) =>
					[
						...getAllowedPlannerWrapperTools({
							stage,
							step,
							broken: flags.broken,
							requiresUserDecision: flags.requiresUserDecision,
							requiresCompact: false,
							debugArtifactsDir: "/tmp/planner-debug",
						}),
					].sort(),
				),
			);
			const first = JSON.stringify(sets[0]);
			for (const set of sets) {
				expect(JSON.stringify(set)).toEqual(first);
			}
		});
	}

	it("guard set is exactly [planner_status] at a compact boundary", () => {
		for (const [stage, stepList] of STEPS) {
			for (const step of stepList) {
				const allowed = getAllowedPlannerWrapperTools({
					stage,
					step,
					broken: false,
					requiresUserDecision: false,
					requiresCompact: true,
					debugArtifactsDir: "/tmp/planner-debug",
				});
				expect([...allowed]).toEqual(["planner_status"]);
			}
		}
	});

	// Reverse direction: a wrapper tool the stage behavior advertises in
	// expectedTools (so it shows up in status' "Stage Behavior" and the model
	// reaches for it) MUST be permitted by the guard — otherwise the model is
	// told to use a tool the guard blocks ("not allowed at stage/step"). The two
	// always-allowed specials (planner_status, planner_git_inspect) are exempt
	// because the behavior gate permits them regardless of the guard step list;
	// non-wrapper workflow tools (finish_step, request/complete_compact,
	// report_stuck) are gated elsewhere and never appear in the guard set.
	const WRAPPER_TOOLS = new Set<string>(PLANNER_WRAPPER_TOOLS);
	const GATE_EXEMPT = new Set<string>([
		"planner_status",
		"planner_git_inspect",
	]);
	it("every wrapper tool in expectedTools is permitted by the guard", () => {
		const violations: string[] = [];
		for (const [stage, stepList] of STEPS) {
			for (const step of stepList) {
				const guard = new Set<string>(
					getAllowedPlannerWrapperTools({
						stage,
						step,
						broken: false,
						requiresUserDecision: false,
						requiresCompact: false,
						debugArtifactsDir: "/tmp/planner-debug",
					}),
				);
				const behavior = getPlannerStageStepBehavior({ stage, step });
				for (const tool of behavior.expectedTools) {
					if (!WRAPPER_TOOLS.has(tool) || GATE_EXEMPT.has(tool)) continue;
					if (!guard.has(tool)) violations.push(`${stage}/${step}: ${tool}`);
				}
			}
		}
		expect(violations, violations.join("\n")).toEqual([]);
	});
});
