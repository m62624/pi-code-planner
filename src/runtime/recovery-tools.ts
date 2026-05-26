import type { GitRunner } from "../git/runner";
import type { PlannerWrapperTool } from "../guard/tool-policy";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import {
	checkPlannerPreflightToolAllowed,
	runPlannerPreflight,
} from "./preflight";
import {
	formatPlannerRecoveryInspection,
	inspectPlannerRecovery,
	type PlannerRecoveryInspection,
} from "./recovery";

export const PLANNER_RECOVERY_TOOL_NAMES = [
	"planner_recovery_inspect",
] as const satisfies readonly PlannerWrapperTool[];

export type PlannerRecoveryToolName =
	(typeof PLANNER_RECOVERY_TOOL_NAMES)[number];

export interface PlannerRecoveryToolExecutionInput {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
	toolName: PlannerRecoveryToolName;
	params: unknown;
}

export interface PlannerRecoveryToolExecutionResult {
	status: "applied" | "blocked";
	toolName: PlannerRecoveryToolName;
	text: string;
	details: PlannerRecoveryInspection | { reason: string; preflight: unknown };
}

export async function executePlannerRecoveryTool(
	input: PlannerRecoveryToolExecutionInput,
): Promise<PlannerRecoveryToolExecutionResult> {
	const preflight = await runPlannerPreflight(input);
	const policy = checkPlannerPreflightToolAllowed({
		preflight,
		tool: input.toolName,
	});
	if (!policy.allow) {
		return {
			status: "blocked",
			toolName: input.toolName,
			text:
				policy.reason ?? `Planner recovery tool ${input.toolName} is blocked.`,
			details: { reason: policy.reason ?? "blocked", preflight },
		};
	}

	switch (input.toolName) {
		case "planner_recovery_inspect": {
			const inspection = await inspectPlannerRecovery(input);
			return {
				status: "applied",
				toolName: input.toolName,
				text: formatPlannerRecoveryInspection(inspection),
				details: inspection,
			};
		}
	}
}
