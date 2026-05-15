import type {
	AgentToolResult,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
	PlannerRuntimeController,
	PlannerRuntimeInspection,
} from "../runtime/planner-runtime-controller";

export type PlannerRuntimeControllerResolver = (
	cwd: string,
) => PlannerRuntimeController;

function ok<T>(message: string, details: T): AgentToolResult<T> {
	return {
		content: [{ type: "text", text: message }],
		details,
	};
}

function textWithNextPrompt(
	message: string,
	inspection: PlannerRuntimeInspection,
): string {
	if (!inspection.nextPrompt) return message;
	return `${message}\n\nNEXT PLANNER INSTRUCTION\n${inspection.nextPrompt.prompt}`;
}

export function createPlannerRuntimeTools(
	getController: PlannerRuntimeControllerResolver,
): ToolDefinition[] {
	return [
		{
			name: "planner_runtime_status",
			label: "planner runtime status",
			description:
				"Inspect the active planner runtime, recovery status, and next planner instruction.",
			promptSnippet:
				"CALL when planner state is unclear. Returns active plan/work item state, recovery status, and the next planner instruction.",
			promptGuidelines: [
				"Use planner_runtime_status when resuming work or when planner state is unclear.",
				"If planner_runtime_status reports recovery_required or compact_pending, do not continue normal implementation work.",
				"If planner_runtime_status returns NEXT PLANNER INSTRUCTION, follow it before moving to unrelated work.",
			],
			parameters: Type.Object({}),
			executionMode: "sequential",
			renderShell: "default",
			execute: async (_id, _params, _signal, _onUpdate, ctx) => {
				const inspection = await getController(ctx.cwd).inspect();
				return ok(
					textWithNextPrompt(inspection.message, inspection),
					inspection,
				);
			},
		},
	];
}
