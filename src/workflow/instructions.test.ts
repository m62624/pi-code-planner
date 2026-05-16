import { describe, expect, it } from "vitest";
import { getMarkdownSection } from "../instructions/section-parser";
import { readDefaultInstructionContent } from "../settings/default-instructions";
import {
	instructionForPlanStage,
	instructionForWorkItemStage,
} from "./instructions";
import { PLAN_STAGES, WORK_ITEM_STAGES } from "./schema";

describe("stage instruction mapping", () => {
	it("maps every plan stage to an existing bundled markdown section", () => {
		for (const stage of PLAN_STAGES) {
			const instruction = instructionForPlanStage(stage);
			const content = readDefaultInstructionContent(
				instruction.instructionName,
			);

			expect(
				getMarkdownSection(content, instruction.sectionName),
				`${stage} -> ${instruction.instructionName}:${instruction.sectionName}`,
			).not.toBeNull();
		}
	});

	it("maps every work item stage to an existing bundled markdown section", () => {
		for (const stage of WORK_ITEM_STAGES) {
			const instruction = instructionForWorkItemStage(stage);
			const content = readDefaultInstructionContent(
				instruction.instructionName,
			);

			expect(
				getMarkdownSection(content, instruction.sectionName),
				`${stage} -> ${instruction.instructionName}:${instruction.sectionName}`,
			).not.toBeNull();
		}
	});

	it("keeps discovery memory requirements explicit", () => {
		const content = readDefaultInstructionContent("discovery");

		expect(content).toContain("planner_memory_upsert_symbols");
		expect(content).toContain("planner_memory_upsert_relations");
		expect(content).toContain("important exported/internal symbols indexed");
	});

	it("keeps work item execution test-first", () => {
		const content = readDefaultInstructionContent("work_item");

		expect(content).toContain("TDD is mandatory");
		expect(content).toContain("production implementation starts before");
		expect(content).toContain("mock test or contract test");
		expect(content).toContain(
			"changing the test contract inside experiment branches",
		);
	});

	it("keeps plan stages as a guided playbook", () => {
		const content = readDefaultInstructionContent("plan");

		expect(content).toContain("Goal:");
		expect(content).toContain("Required tools:");
		expect(content).toContain("Next stage:");
		expect(content).toContain("tests first, production code second");
	});
});
