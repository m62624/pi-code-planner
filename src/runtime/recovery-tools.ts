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
import {
	type PlannerRecoveryResumeResult,
	resumePlannerRecovery,
} from "./recovery-manager";

export const PLANNER_RECOVERY_TOOL_NAMES = [
	"planner_recovery_inspect",
	"planner_recovery_resume",
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
	details:
		| PlannerRecoveryInspection
		| PlannerRecoveryResumeResult
		| { reason: string; preflight: unknown };
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
		case "planner_recovery_resume": {
			const target = parseResumeTarget(input.params);
			if (!target) {
				return {
					status: "blocked",
					toolName: input.toolName,
					text: "Planner recovery resume requires targetStage and targetStep string parameters.",
					details: { reason: "missing targetStage or targetStep", preflight },
				};
			}
			if (preflight.context.status !== "ready" || !preflight.planPaths) {
				return {
					status: "blocked",
					toolName: input.toolName,
					text: "Planner recovery resume requires a ready active plan context.",
					details: { reason: "active plan context is not ready", preflight },
				};
			}
			const result = await resumePlannerRecovery({
				fs: input.fs,
				git: input.git,
				projectPaths: input.projectPaths,
				planPaths: preflight.planPaths,
				state: preflight.context.state,
				target,
			});
			return {
				status: result.status,
				toolName: input.toolName,
				text: result.text,
				details: result,
			};
		}
	}
}

function parseResumeTarget(
	params: unknown,
): { stage: never; step: never } | null {
	const object = asObject(params);
	const stage = stringParam(object, "targetStage");
	const step = stringParam(object, "targetStep");
	return stage && step ? { stage: stage as never, step: step as never } : null;
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function stringParam(
	params: Record<string, unknown>,
	key: string,
): string | null {
	const value = params[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}
