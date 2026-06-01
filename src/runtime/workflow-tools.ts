import type { GitRunner } from "../git/runner";
import { inspectMemoryGate } from "../memory/gate";
import {
	readMemoryIndexingState,
	summarizeMemoryIndexing,
} from "../memory/indexing";
import { readMemoryCheckpoint } from "../memory/manager";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";
import {
	applyPlannerStateTransition,
	type PlannerStateTransition,
	type PlannerStateTransitionResult,
} from "./state-transition";

export const PLANNER_WORKFLOW_TOOL_NAMES = [
	"planner_start_step",
	"planner_finish_step",
	"planner_advance_step",
	"planner_fail_step",
	"planner_block_step",
	"planner_retry_step",
	"planner_request_compact",
	"planner_complete_compact",
	"planner_enter_recovery",
	"planner_resume_after_recovery",
] as const;

export type PlannerWorkflowToolName =
	(typeof PLANNER_WORKFLOW_TOOL_NAMES)[number];

export interface PlannerWorkflowToolExecutionInput {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
	toolName: PlannerWorkflowToolName;
	params: unknown;
}

export interface PlannerWorkflowToolExecutionResult {
	text: string;
	transition: PlannerStateTransition;
	result: PlannerStateTransitionResult;
}

export async function executePlannerWorkflowTool(
	input: PlannerWorkflowToolExecutionInput,
): Promise<PlannerWorkflowToolExecutionResult> {
	const transition = workflowToolTransition(input.toolName, input.params);
	const orchestrator = await runPlannerOrchestrator(input);
	const gate = checkPlannerOrchestratorToolAllowed({
		orchestrator,
		toolName: input.toolName,
	});
	if (!gate.allow) {
		const state =
			orchestrator.preflight.context.status === "ready"
				? orchestrator.preflight.context.state
				: null;
		const result: PlannerStateTransitionResult = {
			status: "blocked",
			code: "runtime_blocked",
			transition,
			reason:
				gate.reason ??
				`Planner workflow tool ${input.toolName} is blocked by orchestrator.`,
			state,
		};
		return {
			text: formatWorkflowToolResult(result),
			transition,
			result,
		};
	}
	const exitBlock = await validateWorkflowExit({
		...input,
		orchestrator,
		transition,
	});
	if (exitBlock) {
		const state =
			orchestrator.preflight.context.status === "ready"
				? orchestrator.preflight.context.state
				: null;
		const result: PlannerStateTransitionResult = {
			status: "blocked",
			code: "runtime_blocked",
			transition,
			reason: exitBlock,
			state,
		};
		return {
			text: formatWorkflowToolResult(result),
			transition,
			result,
		};
	}
	const result = await applyPlannerStateTransition({
		fs: input.fs,
		preflight: orchestrator.preflight,
		transition,
	});

	return {
		text: formatWorkflowToolResult(result),
		transition,
		result,
	};
}

async function validateWorkflowExit(input: {
	fs: PlannerFs;
	git: GitRunner;
	orchestrator: Awaited<ReturnType<typeof runPlannerOrchestrator>>;
	transition: PlannerStateTransition;
}): Promise<string | null> {
	if (
		input.transition.type !== "finish_step" ||
		input.orchestrator.preflight.context.status !== "ready"
	) {
		return null;
	}
	const { state } = input.orchestrator.preflight.context;
	const memoryPaths = input.orchestrator.preflight.memoryPaths;
	if (!memoryPaths) {
		return null;
	}
	if (state.stage === "discovery" && state.step === "scan_project_structure") {
		const indexing = await readMemoryIndexingState(input.fs, memoryPaths);
		return indexing.mode === "initial_discovery"
			? null
			: "Project structure scan is incomplete. Call planner_memory_scan_project before finishing discovery/scan_project_structure.";
	}
	if (state.stage === "discovery" && state.step === "index_files_iteratively") {
		const summary = summarizeMemoryIndexing(
			await readMemoryIndexingState(input.fs, memoryPaths),
		);
		return summary.complete
			? null
			: [
					"Iterative memory indexing is incomplete.",
					`Active file: ${summary.activeFile ?? "(none)"}.`,
					`Pending=${summary.pending}, reading=${summary.reading}, verifying=${summary.verifying}, failed=${summary.failed}.`,
					"Call planner_memory_index_status and continue the exact active file.",
				].join("\n");
	}
	if (state.stage === "discovery" && state.step === "verify_memory") {
		const summary = summarizeMemoryIndexing(
			await readMemoryIndexingState(input.fs, memoryPaths),
		);
		if (!summary.complete) {
			return [
				"Memory verification boundary cannot finish while iterative indexing is incomplete.",
				`Active file: ${summary.activeFile ?? "(none)"}.`,
				`Pending=${summary.pending}, reading=${summary.reading}, verifying=${summary.verifying}, failed=${summary.failed}.`,
				"Call planner_memory_index_status and finish the exact active file first.",
			].join("\n");
		}
		if (!state.worktreePath) {
			return "Planner worktree path is missing.";
		}
		const inspection = await inspectMemoryGate({
			fs: input.fs,
			git: input.git,
			repoRoot: state.worktreePath,
			memoryPaths,
		});
		const checkpoint = await readMemoryCheckpoint(input.fs, memoryPaths);
		const head = input.orchestrator.preflight.gitReality?.headCommit;
		if (!inspection.clean || checkpoint.commit !== head) {
			return [
				"Memory verification boundary is not complete.",
				`Memory clean: ${String(inspection.clean)}.`,
				`Checkpoint commit: ${checkpoint.commit ?? "(none)"}.`,
				`Current HEAD: ${head ?? "(none)"}.`,
				"Use planner_memory_verify and planner_memory_sync_checkpoint before finishing discovery/verify_memory.",
			].join("\n");
		}
	}
	return null;
}

export function workflowToolTransition(
	toolName: PlannerWorkflowToolName,
	params: unknown,
): PlannerStateTransition {
	const object = asObject(params);
	switch (toolName) {
		case "planner_start_step":
			return { type: "start_step" };
		case "planner_finish_step": {
			const nextStage = stringOrUndefined(object.nextStage);
			const nextStep = stringOrUndefined(object.nextStep);
			return nextStage && nextStep
				? {
						type: "finish_step",
						next: { stage: nextStage as never, step: nextStep as never },
					}
				: { type: "finish_step" };
		}
		case "planner_advance_step":
			return { type: "advance_step" };
		case "planner_fail_step":
			return {
				type: "fail_step",
				reason: stringOrUndefined(object.reason) ?? "Planner step failed.",
			};
		case "planner_block_step":
			return {
				type: "block_step",
				reason: stringOrUndefined(object.reason) ?? "Planner step blocked.",
				requiresUserDecision: booleanOrUndefined(object.requiresUserDecision),
			};
		case "planner_retry_step":
			return { type: "retry_step" };
		case "planner_request_compact":
			return {
				type: "request_compact",
				reason: stringOrUndefined(object.reason),
			};
		case "planner_complete_compact":
			return { type: "complete_compact" };
		case "planner_enter_recovery":
			return {
				type: "enter_recovery",
				reason:
					stringOrUndefined(object.reason) ??
					"Planner entered recovery by workflow tool.",
				requiresUserDecision: booleanOrUndefined(object.requiresUserDecision),
			};
		case "planner_resume_after_recovery":
			return {
				type: "resume_after_recovery",
				target: {
					stage: stringOrUndefined(object.targetStage) as never,
					step: stringOrUndefined(object.targetStep) as never,
				},
			};
	}
}

function formatWorkflowToolResult(
	result: PlannerStateTransitionResult,
): string {
	if (result.status === "blocked") {
		return [
			`Planner transition blocked: ${result.transition.type}`,
			`Code: ${result.code}`,
			`Reason: ${result.reason}`,
			result.stateMachineErrorCode
				? `State machine error: ${result.stateMachineErrorCode}`
				: null,
			"Call planner_status before choosing the next planner action.",
		]
			.filter(Boolean)
			.join("\n");
	}

	return [
		`Planner transition applied: ${result.transition.type}`,
		`Previous: ${result.previousState.stage}/${result.previousState.step} (${result.previousState.stepStatus})`,
		`Current: ${result.state.stage}/${result.state.step} (${result.state.stepStatus})`,
		result.state.nextStep ? `Next step: ${result.state.nextStep}` : null,
		"Call planner_status before choosing the next planner action.",
	]
		.filter(Boolean)
		.join("\n");
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value
		: undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}
