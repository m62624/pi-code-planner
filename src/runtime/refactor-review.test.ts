import { describe, expect, it } from "vitest";
import { MockPlannerFs } from "../test/mock-fs";
import {
	validateRefactorReviewArtifact,
	validateRefactorReviewMarkdown,
} from "./refactor-review";

const BASE_REVIEW = [
	"# Refactor Review",
	"",
	"## Changed Surface",
	"- Files: src/lib.ts",
	"- Behavior touched: parser validation",
	"- Public API touched: no",
	"",
	"## Complexity",
	"- Unnecessary abstraction: none found in the task diff.",
	"- Over-generalization: rejected a new helper because one call site exists.",
	"- Simpler alternative considered: inline validation stayed clearer.",
	"",
	"## Duplication",
	"- New duplication: none.",
	"- Existing duplication touched: no.",
	"- Decision: no extraction.",
	"",
	"## Naming And Boundaries",
	"- Confusing names: none.",
	"- Module/API boundary issues: none.",
	"- Scope leaks: none.",
	"",
	"## Edge Cases",
	"- Validation/error handling: invalid input path covered.",
	"- State consistency: no state mutation.",
	"- Regression risk: low, focused test added.",
	"",
	"## Refactor Decision",
	"Decision: kept",
	"",
	"## Changes Applied",
	"- None.",
	"",
	"## Why Kept",
	"- The task diff is one validation branch and extracting it would add an unused helper.",
].join("\n");

describe("validateRefactorReviewMarkdown", () => {
	it("accepts a complete kept review with concrete justification", () => {
		expect(validateRefactorReviewMarkdown(BASE_REVIEW)).toMatchObject({
			valid: true,
			decision: "kept",
		});
	});

	it("requires the standard review sections", () => {
		const result = validateRefactorReviewMarkdown(
			BASE_REVIEW.replace("## Duplication", "## Duplicate Stuff"),
		);

		expect(result.valid).toBe(false);
		expect(result.reason).toContain('missing section "## Duplication"');
	});

	it("rejects kept decisions without concrete why-kept section", () => {
		const result = validateRefactorReviewMarkdown(
			BASE_REVIEW.replace(
				"## Why Kept\n- The task diff is one validation branch and extracting it would add an unused helper.",
				"## Why Kept\n-",
			),
		);

		expect(result.valid).toBe(false);
		expect(result.reason).toContain('"Decision: kept" requires');
	});

	it("requires changes-applied section when the decision is changed", () => {
		const result = validateRefactorReviewMarkdown(
			BASE_REVIEW.replace("Decision: kept", "Decision: changed").replace(
				"## Changes Applied\n- None.",
				"## Changes Applied\n-",
			),
		);

		expect(result.valid).toBe(false);
		expect(result.reason).toContain('"Decision: changed" requires');
	});

	it("tells the model how to repair an incomplete artifact", async () => {
		const fs = new MockPlannerFs();
		await fs.writeTextAtomic("/plan/tasks/task-1/refactor.md", "# Refactor\n");

		const result = await validateRefactorReviewArtifact(
			fs,
			"/plan/tasks/task-1/refactor.md",
		);

		expect(result).toContain("Refactor review is incomplete");
		expect(result).toContain("Do not call planner_finish_step again yet");
		expect(result).toContain("inspect the active task diff");
	});
});
