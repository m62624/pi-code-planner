import { describe, expect, it } from "vitest";
import { getAllowedPlannerWrapperTools } from "../guard/tool-policy";
import type { PlannerStep } from "../storage/schema";
import { PLANNER_STEP_RULES } from "./status";

/**
 * Elenchus reminders must sit only at steps where the runtime gate actually lets
 * the tool through, so the model is never told to call a blocked tool. These are
 * the normal-flow steps that allow planner_elenchus_check. The broken-state
 * branch of getAllowedPlannerWrapperTools normally overrides per-step
 * allow-lists, so recovery/repair_or_resume carries an explicit broken-state
 * exception (elenchus is a pure-diagnosis tool there). The reminders are also
 * default-on (not classify-first) and never use the rejected "web of
 * interacting conditions" framing.
 */
const ELENCHUS_STEPS: PlannerStep[] = [
	"scan_project_structure",
	"consistency_check",
	"write_tdd_plan",
	"contract_check",
	"doubt_review",
];

function ruleText(step: PlannerStep): string {
	const rule = PLANNER_STEP_RULES[step];
	return [
		rule.objective,
		...rule.requiredActions,
		...rule.allowedNow,
		rule.exitCondition,
	].join("\n");
}

describe("elenchus step reminders", () => {
	it("instructs planner_elenchus_check at every reminded step", () => {
		for (const step of ELENCHUS_STEPS) {
			expect(ruleText(step)).toContain("planner_elenchus_check");
		}
	});

	it("only reminds where the runtime gate actually allows elenchus", () => {
		for (const step of ELENCHUS_STEPS) {
			const allowed = getAllowedPlannerWrapperTools({
				stage: PLANNER_STEP_RULES[step].stage,
				step,
				broken: false,
				requiresUserDecision: false,
				requiresCompact: false,
				debugArtifactsDir: null,
			});
			expect(allowed).toContain("planner_elenchus_check");
		}
	});

	it("advertises elenchus at recovery/repair_or_resume and keeps it reachable while broken", () => {
		expect(ruleText("repair_or_resume")).toContain("planner_elenchus_check");
		const whileBroken = getAllowedPlannerWrapperTools({
			stage: "recovery",
			step: "repair_or_resume",
			broken: true,
			requiresUserDecision: false,
			requiresCompact: false,
			debugArtifactsDir: null,
		});
		expect(whileBroken).toContain("planner_elenchus_check");
		// The broken-state exception is scoped to the repair decision only.
		const earlierRecoveryStep = getAllowedPlannerWrapperTools({
			stage: "recovery",
			step: "classify_recovery",
			broken: true,
			requiresUserDecision: false,
			requiresCompact: false,
			debugArtifactsDir: null,
		});
		expect(earlierRecoveryStep).not.toContain("planner_elenchus_check");
	});

	it("is default-on with a narrow not_applicable escape, not a classify-first gate", () => {
		for (const step of [...ELENCHUS_STEPS, "repair_or_resume" as const]) {
			const text = ruleText(step).toLowerCase();
			expect(text).toContain("default to");
			expect(text).toContain("not_applicable");
		}
	});

	it("names the recommended premise template at every elenchus step", () => {
		for (const step of [...ELENCHUS_STEPS, "repair_or_resume" as const]) {
			expect(ruleText(step)).toContain('IMPORT "templates/');
		}
	});

	it("never reintroduces the rejected 'web of interacting' framing", () => {
		for (const step of Object.keys(PLANNER_STEP_RULES) as PlannerStep[]) {
			expect(ruleText(step).toLowerCase()).not.toContain("web of interacting");
		}
	});
});
