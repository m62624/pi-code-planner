import type {
	AgentToolResult,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PlannerCycleManager } from "../cycle/manager";
import type { PlannerNextStep } from "../cycle/schema";

export type PlannerCycleManagerResolver = (cwd: string) => PlannerCycleManager;

function ok<T>(message: string, details: T): AgentToolResult<T> {
	return {
		content: [{ type: "text", text: message }],
		details,
	};
}

function textWithPrompt(step: PlannerNextStep): string {
	if (!step.prompt) return step.message;
	return `${step.message}\n\nNEXT PLANNER INSTRUCTION\n${step.prompt.prompt}`;
}

export function createPlannerCycleTools(
	getCycleManager: PlannerCycleManagerResolver,
): ToolDefinition[] {
	return [
		{
			name: "planner_next_step",
			label: "planner next step",
			description:
				"Return the normalized next planner step, required tool, blocking status, and next instruction.",
			promptSnippet:
				"CALL before continuing planner work. If this reports a requiredTool, call that tool before normal implementation.",
			promptGuidelines: [
				"Use planner_next_step before choosing the next planner action.",
				"If requiredTool is not null, call that tool or explain why recovery is needed.",
				"If NEXT PLANNER INSTRUCTION is returned, follow it before unrelated work.",
			],
			parameters: Type.Object({}),
			executionMode: "sequential",
			renderShell: "default",
			execute: async (_id, _params, _signal, _onUpdate, ctx) => {
				const step = await getCycleManager(ctx.cwd).getNextStep();
				return ok(textWithPrompt(step), step);
			},
		},
	];
}
