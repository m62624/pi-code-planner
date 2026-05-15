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
});
