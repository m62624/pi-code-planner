import { describe, expect, it } from "vitest";
import { PLANNER_STATUS_INVARIANTS, PLANNER_STEP_RULES } from "./status";

/**
 * The capture_skill step must default to capturing a skill and make a no-skill
 * exit expensive (an explicit, candidate-naming justification), and it must
 * treat recurring code patterns as first-class skill content. These assertions
 * pin that behavior so a future edit cannot silently relax it back to the old
 * "write a no-skill note to skip" default.
 */
describe("capture_skill instruction", () => {
	const rule = PLANNER_STEP_RULES.capture_skill;
	const text = [
		rule.objective,
		...rule.requiredActions,
		...rule.forbiddenNow,
		rule.exitCondition,
	]
		.join("\n")
		.toLowerCase();

	it("defaults to capturing rather than skipping", () => {
		expect(rule.objective.toLowerCase()).toContain("default");
		expect(text).toContain("no-skill is the exception");
	});

	it("treats recurring code patterns as valid skill content", () => {
		expect(text).toContain("code shape");
	});

	it("makes a no-skill exit require naming each considered candidate", () => {
		expect(rule.exitCondition.toLowerCase()).toContain("names each considered");
		// A generic 'nothing reusable' note must be explicitly rejected.
		expect(text).toContain("generic");
	});

	it("keeps the global guidance biased toward capture", () => {
		const guidance = PLANNER_STATUS_INVARIANTS.join("\n").toLowerCase();
		expect(guidance).toContain("capture planner skills by default");
		expect(guidance).toContain("recurring code pattern");
	});
});
