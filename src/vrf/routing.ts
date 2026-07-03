import type { PlannerStage, PlannerStep } from "../storage/schema";
import { vrfTemplateImportPath } from "./paths";
import type { VrfTemplateName } from "./schema";

/**
 * Which premise templates a step should reach for by default. Every step that
 * allows planner_elenchus_check has at least one recommendation — the step
 * instruction says "use it (or record not_applicable)", never "decide whether
 * this applies".
 */
export function getRecommendedVrfTemplates(
	stage: PlannerStage,
	step: PlannerStep,
): VrfTemplateName[] {
	if (stage === "discovery" && step === "scan_project_structure") {
		return ["discovery-gaps"];
	}
	if (stage === "planning" && step === "consistency_check") {
		return ["plan-consistency"];
	}
	if (stage === "execution" && step === "write_tdd_plan") {
		return ["tdd-gate"];
	}
	if (stage === "execution" && step === "contract_check") {
		return ["branch-contract"];
	}
	if (stage === "finalize" && step === "doubt_review") {
		return ["doubt-review", "ship-gate"];
	}
	if (stage === "recovery" && step === "repair_or_resume") {
		return ["recovery-state"];
	}
	return [];
}

/** One-line hint naming the recommended templates and how to import them. */
export function describeRecommendedVrfTemplates(
	stage: PlannerStage,
	step: PlannerStep,
): string | null {
	const names = getRecommendedVrfTemplates(stage, step);
	if (names.length === 0) return null;
	const imports = names
		.map((name) => `IMPORT "${vrfTemplateImportPath(name)}"`)
		.join(" or ");
	return `Recommended premise template${names.length > 1 ? "s" : ""}: ${names.join(", ")} (start your program with ${imports}; the template header documents the facts and \`values\` ports to supply).`;
}
