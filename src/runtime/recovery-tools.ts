import type { PlannerWrapperTool } from "../guard/tool-policy";
import { readActivePlanContext } from "./active-plan";
import {
	buildRecoveryReport,
	evaluatePlannerStuck,
	RECOVERY_ISSUE_URL,
	readDiagnosticsRecord,
	type StuckThresholds,
	writeRecoveryReport,
} from "./diagnostics";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";
import {
	formatPlannerRecoveryInspection,
	inspectPlannerRecovery,
	type PlannerRecoveryInspection,
} from "./recovery";
import {
	type PlannerRecoveryResumeResult,
	resumePlannerRecovery,
} from "./recovery-manager";
import type {
	PlannerToolContext,
	PlannerToolExecutionInput,
} from "./tool-context";
import { asObject } from "./values";

export const PLANNER_RECOVERY_TOOL_NAMES = [
	"planner_recovery_inspect",
	"planner_recovery_resume",
] as const satisfies readonly PlannerWrapperTool[];

export type PlannerRecoveryToolName =
	(typeof PLANNER_RECOVERY_TOOL_NAMES)[number];

export type PlannerRecoveryToolExecutionInput =
	PlannerToolExecutionInput<PlannerRecoveryToolName>;

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
	const orchestrator = await runPlannerOrchestrator(input);
	const policy = checkPlannerOrchestratorToolAllowed({
		orchestrator,
		toolName: input.toolName,
	});
	if (!policy.allow) {
		return {
			status: "blocked",
			toolName: input.toolName,
			text:
				policy.reason ?? `Planner recovery tool ${input.toolName} is blocked.`,
			details: {
				reason: policy.reason ?? "blocked",
				preflight: orchestrator.preflight,
			},
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
					details: {
						reason: "missing targetStage or targetStep",
						preflight: orchestrator.preflight,
					},
				};
			}
			if (
				orchestrator.preflight.context.status !== "ready" ||
				!orchestrator.preflight.planPaths
			) {
				return {
					status: "blocked",
					toolName: input.toolName,
					text: "Planner recovery resume requires a ready active plan context.",
					details: {
						reason: "active plan context is not ready",
						preflight: orchestrator.preflight,
					},
				};
			}
			const result = await resumePlannerRecovery({
				fs: input.fs,
				git: input.git,
				projectPaths: input.projectPaths,
				planPaths: orchestrator.preflight.planPaths,
				state: orchestrator.preflight.context.state,
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

export const PLANNER_RECOVERY_REPORT_TOOL_NAME = "planner_recovery_report";

export interface PlannerRecoveryReportToolInput extends PlannerToolContext {
	thresholds: StuckThresholds;
	modelId: string | null;
	now?: number;
}

export interface PlannerRecoveryReportToolResult {
	status: "applied" | "blocked";
	toolName: typeof PLANNER_RECOVERY_REPORT_TOOL_NAME;
	text: string;
	details: unknown;
}

/**
 * Prepare a sanitized diagnostics report when the planner is stuck. Cross-stage
 * by design (a deadlock can happen in any stage), so it does not go through the
 * stage policy; instead it gates on the stuck signal itself.
 */
export async function executePlannerRecoveryReportTool(
	input: PlannerRecoveryReportToolInput,
): Promise<PlannerRecoveryReportToolResult> {
	const toolName = PLANNER_RECOVERY_REPORT_TOOL_NAME;
	const context = await readActivePlanContext({
		fs: input.fs,
		projectPaths: input.projectPaths,
	});
	if (context.status !== "ready") {
		return {
			status: "blocked",
			toolName,
			text: "planner_recovery_report requires a ready active plan context.",
			details: { reason: "active plan context is not ready" },
		};
	}
	const planPaths = context.planPaths;
	const now = input.now ?? Date.now();
	const diagnostics = await readDiagnosticsRecord(input.fs, planPaths);
	const evaluation = evaluatePlannerStuck(diagnostics, now, input.thresholds);
	if (!evaluation.stuck) {
		return {
			status: "blocked",
			toolName,
			text: "planner_recovery_report unlocks only after the planner is detected stuck (repeated blocked transitions, a long stall, or a recovery call). Keep working the normal lifecycle; call planner_status if unsure.",
			details: { reason: "not stuck", diagnostics },
		};
	}

	const artifacts = buildRecoveryReport({
		state: context.state,
		plan: context.plan,
		diagnostics,
		evaluation,
		modelId: input.modelId,
		now,
		issueUrl: RECOVERY_ISSUE_URL,
	});
	const written = await writeRecoveryReport(
		input.fs,
		planPaths,
		context.activePlanId,
		artifacts,
	);

	return {
		status: "applied",
		toolName,
		text: [
			"Tell the user, in their language, that an abnormal pi-code-planner error occurred and you prepared a diagnostics report — paraphrase, do not invent details:",
			"",
			"- What happened: the planner state machine got stuck and could not progress on its own.",
			`- A sanitized report was written to: ${written.reportPath}`,
			"- The report contains only generalized state-machine data (planner tool names, statuses, pseudonymized task ids) for machine analysis — not what the project does. No arguments, code, paths, titles, or descriptions are included.",
			"- Ask the user to review the report and confirm there is nothing sensitive, then, if possible, open an issue so this pattern can be fixed:",
			`  ${RECOVERY_ISSUE_URL}`,
			`- A local-only legend (token → real id) sits next to the report at ${written.legendPath}; it is NOT part of the report and should not be attached unless the user verifies the ids are safe.`,
			"",
			"Then continue: use planner_recovery_inspect / planner_recovery_resume to get unstuck if appropriate.",
		].join("\n"),
		details: { ...written, evaluation, diagnostics },
	};
}

function parseResumeTarget(
	params: unknown,
): { stage: never; step: never } | null {
	const object = asObject(params);
	const stage = stringParam(object, "targetStage");
	const step = stringParam(object, "targetStep");
	return stage && step ? { stage: stage as never, step: step as never } : null;
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
