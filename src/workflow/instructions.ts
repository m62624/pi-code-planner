import type { InstructionName } from "../settings/schema";
import type { PlanStage, WorkItemStage } from "./schema";

export interface StageInstructionRef {
	instructionName: InstructionName;
	sectionName: string;
	includeDetails: boolean;
}

export function instructionForPlanStage(stage: PlanStage): StageInstructionRef {
	switch (stage) {
		case "discovery_full":
			return {
				instructionName: "discovery",
				sectionName: "discovery_full",
				includeDetails: true,
			};
		case "discovery_compact_required":
			return {
				instructionName: "compact",
				sectionName: "discovery_compact_required",
				includeDetails: true,
			};
		case "plan_finalize":
		case "plan_completed":
			return {
				instructionName: "documentation",
				sectionName: stage,
				includeDetails: true,
			};
		default:
			return {
				instructionName: "plan",
				sectionName: stage,
				includeDetails: true,
			};
	}
}

export function instructionForWorkItemStage(
	stage: WorkItemStage,
): StageInstructionRef {
	switch (stage) {
		case "refactor":
			return {
				instructionName: "refactor",
				sectionName: "refactor",
				includeDetails: true,
			};
		case "verification":
			return {
				instructionName: "api_check",
				sectionName: "verification",
				includeDetails: true,
			};
		case "work_item_compact_required":
			return {
				instructionName: "compact",
				sectionName: "work_item_compact_required",
				includeDetails: true,
			};
		case "completed":
			return {
				instructionName: "documentation",
				sectionName: "work_item_completed",
				includeDetails: true,
			};
		default:
			return {
				instructionName: "work_item",
				sectionName: stage,
				includeDetails: true,
			};
	}
}
