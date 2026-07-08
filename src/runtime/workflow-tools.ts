import { createHash } from "node:crypto";
import { join } from "node:path";
import { errorMessage } from "../errors";
import type { GitRunner } from "../git/runner";
import { loadEffectivePlannerSettings } from "../settings/manager";
import type { PlannerFs } from "../storage/fs";
import {
	createTaskStoragePaths,
	type PlanStoragePaths,
} from "../storage/paths";
import { readPlanRecord, updatePlanRecord } from "../storage/plan-store";
import {
	PLANNER_STAGE_STEPS,
	type PlannerStage,
	type PlannerStep,
	type PlanStateRecord,
	type TaskRecord,
} from "../storage/schema";
import { readTaskRecord, updateTaskStatus } from "../storage/task-store";
import {
	validateContractCheckCompleted,
	validateDiscoveryContractRouting,
} from "./contracts";
import { validateDoubtReviewMarkdown } from "./doubt-review";
import { readElenchusLastCheck } from "./elenchus-tools";
import { planCoverageSourceHash } from "./gate-tools";
import type { PlannerGitReality } from "./git-state-sync";
import {
	decidePlannerLifecycleNext,
	type PlannerLifecycleDecision,
} from "./lifecycle";
import { buildNextStepHint, formatAllowedNextTargets } from "./next-step-hint";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";
import { asObject } from "./params";
import { validateRefactorReviewArtifact } from "./refactor-review";
import { getAllowedNextPlannerPositions } from "./state-machine";
import {
	applyPlannerStateTransition,
	type PlannerStateTransition,
	type PlannerStateTransitionResult,
} from "./state-transition";
import {
	validatePostImplementationCounterexampleReview,
	validatePreImplementationProofContract,
	validateTaskMergeScopeAudit,
} from "./tdd-evidence";
import type { PlannerToolExecutionInput } from "./tool-context";

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

type PlannerTargetPosition = { stage: PlannerStage; step: PlannerStep };

export type PlannerWorkflowToolExecutionInput =
	PlannerToolExecutionInput<PlannerWorkflowToolName>;

export interface PlannerWorkflowToolExecutionResult {
	text: string;
	transition: PlannerStateTransition;
	result: PlannerStateTransitionResult;
	lifecycle: PlannerLifecycleDecision | null;
	/**
	 * The active plan's storage paths when this transition ran against a ready
	 * plan — pure data pass-through, so the surfacing layer (the tool dispatcher)
	 * can render the reasoning-fuel nudge for the resulting step without any
	 * decision module importing a fuel module. Absent when no plan is ready.
	 */
	planPaths?: PlanStoragePaths;
}

export async function executePlannerWorkflowTool(
	input: PlannerWorkflowToolExecutionInput,
): Promise<PlannerWorkflowToolExecutionResult> {
	let transition: PlannerStateTransition;
	try {
		transition = workflowToolTransition(input.toolName, input.params);
	} catch (error) {
		transition = fallbackWorkflowToolTransition(input.toolName);
		const result: PlannerStateTransitionResult = {
			status: "blocked",
			code: "runtime_blocked",
			transition,
			reason: errorMessage(error),
			state: null,
		};
		return {
			text: formatWorkflowToolResult(result),
			transition,
			result,
			lifecycle: null,
		};
	}
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
			lifecycle: null,
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
			lifecycle: null,
		};
	}
	const lifecycle = decidePlannerLifecycleNext(orchestrator.preflight);
	const result = await applyPlannerStateTransition({
		fs: input.fs,
		preflight: orchestrator.preflight,
		transition,
	});
	if (
		result.status === "applied" &&
		orchestrator.preflight.context.status === "ready"
	) {
		await applyWorkflowSideEffects({
			fs: input.fs,
			planPaths: orchestrator.preflight.context.planPaths,
			transition,
			previousState: result.previousState,
		});
	}

	return {
		text: formatWorkflowToolResult(result),
		transition,
		result,
		lifecycle,
		planPaths:
			orchestrator.preflight.context.status === "ready"
				? orchestrator.preflight.context.planPaths
				: undefined,
	};
}

async function applyWorkflowSideEffects(input: {
	fs: PlannerFs;
	planPaths: PlanStoragePaths;
	transition: PlannerStateTransition;
	previousState: PlanStateRecord;
}): Promise<void> {
	if (
		input.transition.type === "finish_step" &&
		input.previousState.stage === "done" &&
		input.previousState.step === "handle_change_request"
	) {
		await markExistingTasksDone(input.fs, input.planPaths);
	}
}

async function markExistingTasksDone(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
): Promise<void> {
	const plan = await updatePlanRecord(fs, planPaths, (record) => ({
		...record,
		tasks: record.tasks.map((task) =>
			task.status === "blocked" ? task : { ...task, status: "done" },
		),
	}));
	for (const task of plan.tasks) {
		if (task.status === "blocked") continue;
		const paths = createTaskStoragePaths(planPaths, task.taskId);
		if (await fs.exists(paths.taskJson)) {
			await updateTaskStatus(fs, paths, "done");
		}
	}
}

function fallbackWorkflowToolTransition(
	toolName: PlannerWorkflowToolName,
): PlannerStateTransition {
	switch (toolName) {
		case "planner_start_step":
			return { type: "start_step" };
		case "planner_finish_step":
			return { type: "finish_step" };
		case "planner_advance_step":
			return { type: "advance_step" };
		case "planner_fail_step":
			return { type: "fail_step", reason: "Invalid tool parameters." };
		case "planner_block_step":
			return { type: "block_step", reason: "Invalid tool parameters." };
		case "planner_retry_step":
			return { type: "retry_step" };
		case "planner_request_compact":
			return { type: "request_compact" };
		case "planner_complete_compact":
			return { type: "complete_compact" };
		case "planner_enter_recovery":
			return {
				type: "enter_recovery",
				reason: "Invalid tool parameters.",
			};
		case "planner_resume_after_recovery":
			return {
				type: "resume_after_recovery",
				target: { stage: "recovery", step: "read_state" },
			};
	}
}

/**
 * The SDD spec gate (SPEC.md §6.2): the latest planner_gate_check run for
 * spec_consistency must be CONSISTENT and must have been computed from the
 * spec.json that is on disk right now — an edit after the pass invalidates it.
 */
async function validateSpecGatePassed(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
): Promise<string | null> {
	const lastCheck = await readElenchusLastCheck(fs, planPaths.elenchusDir);
	if (lastCheck?.gate !== "spec_consistency") {
		return 'The spec gate has not run. Call planner_gate_check with gate: "spec_consistency" at spec/verify_spec and reach CONSISTENT before advancing.';
	}
	if (lastCheck.outcome !== "CONSISTENT") {
		return `The latest spec_consistency gate ended in ${lastCheck.outcome} — the spec stage only advances on CONSISTENT. Close the gaps the gate named (planner_spec_submit to fix the spec, or loop back to spec/elicit_gaps for user answers), then re-run planner_gate_check.`;
	}
	if (!(await fs.exists(planPaths.specJson))) {
		return "spec.json is missing although the spec gate passed earlier. Re-author it with planner_spec_submit and re-run planner_gate_check.";
	}
	const currentHash = createHash("sha256")
		.update(await fs.readText(planPaths.specJson))
		.digest("hex");
	if (lastCheck.sourceHash && lastCheck.sourceHash !== currentHash) {
		return "spec.json changed after the last spec_consistency pass — the verdict is stale. Re-run planner_gate_check at spec/verify_spec.";
	}
	return null;
}

/**
 * The SDD coverage gate (SPEC.md §6.2): for a plan WITH a spec, the latest
 * plan_coverage run must be CONSISTENT and fresh against both spec.json and
 * every task's requirements list. Legacy plans (no spec.json) skip it —
 * coverage degrades gracefully (REQ-11) and the old plan-consistency flow
 * (with its CONFLICT-only rule above) still applies.
 */
async function validatePlanCoverageGatePassed(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
): Promise<string | null> {
	if (!(await fs.exists(planPaths.specJson))) {
		return null;
	}
	const lastCheck = await readElenchusLastCheck(fs, planPaths.elenchusDir);
	if (lastCheck?.gate !== "plan_coverage") {
		return 'This plan has a spec, so requirement coverage is a hard gate. Call planner_gate_check with gate: "plan_coverage" at planning/consistency_check and reach CONSISTENT before advancing.';
	}
	if (lastCheck.outcome !== "CONSISTENT") {
		return `The latest plan_coverage gate ended in ${lastCheck.outcome} — a requirement is dropped or a task is orphan work. Fix the tasks' \`requirements\` via planner_task_upsert (or de-scope through a recorded user decision), then re-run planner_gate_check.`;
	}
	if (lastCheck.sourceHash) {
		const plan = await readPlanRecord(fs, planPaths);
		const tasks: TaskRecord[] = [];
		for (const summary of plan.tasks) {
			tasks.push(
				await readTaskRecord(
					fs,
					createTaskStoragePaths(planPaths, summary.taskId),
				),
			);
		}
		const currentHash = await planCoverageSourceHash(fs, planPaths, tasks);
		if (lastCheck.sourceHash !== currentHash) {
			return "spec.json or a task's requirements changed after the last plan_coverage pass — the verdict is stale. Re-run planner_gate_check at planning/consistency_check.";
		}
	}
	return null;
}

/**
 * The SDD test-coverage gate (execution phase): when the active task has a
 * behavior board (behaviors.json), leaving write_tests requires every
 * behavior to have a RED witness, and leaving run_final_tests forward
 * requires GREEN — verified by the latest tdd_coverage run, fresh against
 * the board's current content. Legacy tasks without a board skip the gate.
 */
async function validateTddCoverageGatePassed(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
	state: PlanStateRecord,
): Promise<string | null> {
	if (!state.activeTaskId) return null;
	const taskPaths = createTaskStoragePaths(planPaths, state.activeTaskId);
	if (!(await fs.exists(taskPaths.behaviorsJson))) {
		return null;
	}
	const phase = state.step === "run_final_tests" ? "green" : "red";
	const lastCheck = await readElenchusLastCheck(fs, planPaths.elenchusDir);
	if (
		lastCheck?.gate !== "tdd_coverage" ||
		lastCheck.name !== `tdd-coverage-${phase}`
	) {
		return `This task has a behavior board, so test coverage is a hard gate. Call planner_gate_check with gate: "tdd_coverage" at this step and reach CONSISTENT (${phase} witnesses) before advancing.`;
	}
	if (lastCheck.outcome !== "CONSISTENT") {
		return `The latest tdd_coverage (${phase}) gate ended in ${lastCheck.outcome} — the machine still counts behaviors as uncovered. Write/fix the named tests, flip the toggles via planner_behavior_upsert, and re-run planner_gate_check.`;
	}
	if (lastCheck.sourceHash) {
		const currentHash = createHash("sha256")
			.update(await fs.readText(taskPaths.behaviorsJson))
			.digest("hex");
		if (lastCheck.sourceHash !== currentHash) {
			return "behaviors.json changed after the last tdd_coverage pass — the verdict is stale. Re-run planner_gate_check.";
		}
	}
	return null;
}

const INTERNAL_DONE_STEPS = new Set<string>([
	"prepare_output_branch",
	"merge_or_export_result",
	"cleanup_worktree",
	"mark_done",
	"cleanup_plan_files",
]);

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
	{
		// An elenchus CONFLICT is a proven contradiction: the step may not finish
		// on it. Every planner_elenchus_check call overwrites the record, so
		// re-running to CONSISTENT/WARNING — or recording not_applicable — clears
		// the block. Checks from earlier steps never block a later step.
		const lastCheck = await readElenchusLastCheck(
			input.fs,
			input.orchestrator.preflight.context.planPaths.elenchusDir,
		);
		if (
			lastCheck &&
			lastCheck.stage === state.stage &&
			lastCheck.step === state.step &&
			lastCheck.outcome === "CONFLICT"
		) {
			return `The latest elenchus check "${lastCheck.name}" for this step ended in CONFLICT — a proven contradiction in the modeled facts/premises. Apply the drop/flip repair its CORE/RETRACT names (fix the plan or the wrong fact, not the check), re-run planner_elenchus_check until the verdict improves, then finish the step. If the check itself modeled the wrong thing, re-run it as not_applicable with a reason.`;
		}
	}
	if (state.stage === "finalize" || state.stage === "done") {
		const cleanBlock = validateCleanWorktreeForFinalizeOrDone(
			input.orchestrator.preflight.gitReality,
		);
		if (cleanBlock) {
			return cleanBlock;
		}
	}
	if (state.stage === "spec" && state.step === "elicit_gaps") {
		return state.questionsResolved
			? null
			: "Spec questions are still unresolved. Show them to the user verbatim, wait for answers, and call planner_questions_resolve before finishing spec/elicit_gaps.";
	}
	if (
		state.stage === "spec" &&
		(state.step === "verify_spec" || state.step === "finish_spec")
	) {
		// Looping back from verify_spec to elicit_gaps is always allowed — that
		// is how gate gaps become user questions. Only the FORWARD transition is
		// gated on a fresh CONSISTENT spec_consistency run (SPEC.md §6.2 hard
		// gate: WARNING/UNDERDETERMINED block too, unlike the generic
		// CONFLICT-only rule above).
		const target =
			input.transition.type === "finish_step"
				? input.transition.next
				: undefined;
		const loopBack = target?.stage === "spec" && target.step === "elicit_gaps";
		if (!loopBack) {
			const gateBlock = await validateSpecGatePassed(
				input.fs,
				input.orchestrator.preflight.context.planPaths,
			);
			if (gateBlock) {
				return gateBlock;
			}
		}
	}
	if (
		state.stage === "execution" &&
		(state.step === "write_tests" || state.step === "run_final_tests")
	) {
		// Going back from run_final_tests to implement_task (a late failure
		// being fixed) is always allowed; only the FORWARD transition demands
		// the phase's coverage witnesses.
		const target =
			input.transition.type === "finish_step"
				? input.transition.next
				: undefined;
		const backToImplement =
			state.step === "run_final_tests" && target?.step === "implement_task";
		if (!backToImplement) {
			const tddBlock = await validateTddCoverageGatePassed(
				input.fs,
				input.orchestrator.preflight.context.planPaths,
				state,
			);
			if (tddBlock) {
				return tddBlock;
			}
		}
	}
	if (
		state.stage === "planning" &&
		(state.step === "consistency_check" || state.step === "enter_execution")
	) {
		const coverageBlock = await validatePlanCoverageGatePassed(
			input.fs,
			input.orchestrator.preflight.context.planPaths,
		);
		if (coverageBlock) {
			return coverageBlock;
		}
	}
	if (state.stage === "discovery" && state.step === "scan_project_structure") {
		const settings = await loadEffectivePlannerSettings({
			fs: input.fs,
			projectPaths: input.orchestrator.preflight.context.projectPaths,
		});
		return (
			validateDiscoveryContractRouting({
				state,
				settingsEnabled: settings.effective.contracts.enabled,
			}) ??
			(await requireArtifactIncludes(
				input.fs,
				input.orchestrator.preflight.context.planPaths.discoveryMd,
				"## Verification Protocol",
				"discovery.md must include ## Verification Protocol with exact test/lint/build/format commands, working directory, flags, or explicit unknowns to ask in discovery/write_questions.",
			)) ??
			validateCleanWorktree(input.orchestrator.preflight.gitReality)
		);
	}
	if (state.stage === "discovery" && state.step === "write_questions") {
		const artifactBlock = await requireNonEmptyArtifact(
			input.fs,
			input.orchestrator.preflight.context.planPaths.questionsMd,
		);
		return (
			artifactBlock ??
			(state.questionsResolved
				? null
				: "Discovery questions are still unresolved. Show them to the user verbatim, wait for answers, and call planner_questions_resolve before finishing discovery/write_questions.")
		);
	}
	if (state.stage === "done" && INTERNAL_DONE_STEPS.has(state.step)) {
		return "Internal done steps are managed by /planner-finish. Do not call planner_finish_step here — run /planner-finish from done/await_user_acceptance instead.";
	}
	if (
		state.stage === "done" &&
		state.step === "await_user_acceptance" &&
		state.stepStatus === "running"
	) {
		const target =
			input.transition.type === "finish_step"
				? input.transition.next
				: undefined;
		const isChangeRequest =
			target?.stage === "done" && target.step === "handle_change_request";
		if (!isChangeRequest) {
			return "Run /planner-finish (the CLI slash command) to accept the result — do not advance done/await_user_acceptance via planner_finish_step. Only change requests are allowed here: call planner_finish_step with target {stage: 'done', step: 'handle_change_request'}.";
		}
	}
	if (state.stage === "done" && state.step === "handle_change_request") {
		return (
			(await requireArtifactIncludes(
				input.fs,
				input.orchestrator.preflight.context.planPaths.decisionsMd,
				"Change Request",
				"Record the user's requested corrections in decisions.md under a Change Request section before finishing done/handle_change_request.",
			)) ??
			(await requireArtifactIncludes(
				input.fs,
				input.orchestrator.preflight.context.planPaths.planMd,
				"Change Request",
				"Append a short Change Request Replan note to plan.md before finishing done/handle_change_request.",
			)) ??
			(await requireArtifactIncludes(
				input.fs,
				input.orchestrator.preflight.context.planPaths.planMd,
				"Completed Work",
				"Add a Completed Work subsection to plan.md before finishing done/handle_change_request.",
			)) ??
			(await requireArtifactIncludes(
				input.fs,
				input.orchestrator.preflight.context.planPaths.planMd,
				"Remaining Work",
				"Add a Remaining Work subsection to plan.md before finishing done/handle_change_request.",
			)) ??
			(await requireArtifactIncludes(
				input.fs,
				input.orchestrator.preflight.context.planPaths.discoveryMd,
				"Post-Implementation Snapshot",
				"Append a Post-Implementation Snapshot to discovery.md before finishing done/handle_change_request.",
			)) ??
			(await requireArtifactIncludes(
				input.fs,
				input.orchestrator.preflight.context.planPaths.discoveryMd,
				"Completed Work",
				"Add a Completed Work subsection to discovery.md before finishing done/handle_change_request.",
			)) ??
			(await requireArtifactIncludes(
				input.fs,
				input.orchestrator.preflight.context.planPaths.discoveryMd,
				"Remaining Work",
				"Add a Remaining Work subsection to discovery.md before finishing done/handle_change_request.",
			))
		);
	}
	if (state.stage === "finalize" && state.step === "doubt_review") {
		const target = input.transition.next;
		const artifactBlock = await requireValidDoubtReview(
			input.fs,
			input.orchestrator.preflight.context.planPaths.verifyMd,
			target,
		);
		return (
			artifactBlock ??
			(target?.stage === "planning" && target.step === "read_context"
				? await requireArtifactIncludes(
						input.fs,
						input.orchestrator.preflight.context.planPaths.decisionsMd,
						"Doubt Review",
						"Record the proven doubt findings in decisions.md before returning finalize/doubt_review to planning/read_context.",
					)
				: null)
		);
	}
	if (state.stage !== "execution") {
		return state.stage === "planning" && state.step === "write_task_files"
			? await validateTaskArtifacts(
					input.fs,
					input.orchestrator.preflight.context.planPaths,
				)
			: null;
	}

	const taskDir = state.activeTaskId
		? join(
				input.orchestrator.preflight.context.planPaths.tasksDir,
				state.activeTaskId,
			)
		: null;
	switch (state.step) {
		case "prepare_task":
			return validatePreparedTask(state);
		case "write_tdd_plan":
			return taskDir
				? await requireNonEmptyArtifact(input.fs, join(taskDir, "tdd.md"))
				: "Active task is missing. Prepare exactly one task branch first.";
		case "write_tests":
			return (
				(taskDir
					? await requireNonEmptyArtifact(input.fs, join(taskDir, "tdd.md"))
					: "Active task is missing. Prepare exactly one task branch first.") ??
				validateCleanWorktree(input.orchestrator.preflight.gitReality)
			);
		case "run_failing_tests":
			return taskDir
				? ((await requireNonEmptyArtifact(input.fs, join(taskDir, "tdd.md"))) ??
						(await validatePreImplementationProofContract(
							input.fs,
							join(taskDir, "tdd.md"),
						)))
				: "Active task is missing. Prepare exactly one task branch first.";
		case "implement_task":
			return (
				(taskDir
					? ((await requireNonEmptyArtifact(
							input.fs,
							join(taskDir, "tdd.md"),
						)) ??
						(await validatePostImplementationCounterexampleReview(
							input.fs,
							join(taskDir, "tdd.md"),
						)))
					: "Active task is missing. Prepare exactly one task branch first.") ??
				validateCleanWorktree(input.orchestrator.preflight.gitReality)
			);
		case "contract_check":
			return (
				validateContractCheckCompleted(state) ??
				validateCleanWorktree(input.orchestrator.preflight.gitReality)
			);
		case "refactor_task":
			return (
				(taskDir
					? await validateRefactorReviewArtifact(
							input.fs,
							join(taskDir, "refactor.md"),
						)
					: "Active task is missing. Prepare exactly one task branch first.") ??
				validateCleanWorktree(input.orchestrator.preflight.gitReality)
			);
		case "run_final_tests":
			return (
				(taskDir
					? await requireNonEmptyArtifact(
							input.fs,
							join(taskDir, "refactor.md"),
						)
					: "Active task is missing. Prepare exactly one task branch first.") ??
				validateCleanWorktree(input.orchestrator.preflight.gitReality)
			);
		case "merge_task_to_plan":
			return (
				(await validateTaskMergeAuditForCurrentOrDoneTask(
					input.fs,
					input.orchestrator.preflight.context.planPaths,
					state,
				)) ??
				validateMergedTask(state) ??
				validateCleanWorktree(input.orchestrator.preflight.gitReality)
			);
		default:
			return null;
	}
}

async function validateTaskMergeAuditForCurrentOrDoneTask(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
	state: PlanStateRecord,
): Promise<string | null> {
	const taskId = state.activeTaskId ?? (await latestDoneTaskId(fs, planPaths));
	if (!taskId) {
		return "Task merge audit is unavailable because no active or completed task could be identified.";
	}
	return await validateTaskMergeScopeAudit(
		fs,
		join(planPaths.tasksDir, taskId, "tdd.md"),
	);
}

async function latestDoneTaskId(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
): Promise<string | null> {
	const plan = await readPlanRecord(fs, planPaths);
	for (let index = plan.tasks.length - 1; index >= 0; index -= 1) {
		if (plan.tasks[index]?.status === "done") {
			return plan.tasks[index].taskId;
		}
	}
	return null;
}

async function requireValidDoubtReview(
	fs: PlannerFs,
	path: string,
	target: PlannerTargetPosition | undefined,
): Promise<string | null> {
	const nonEmpty = await requireNonEmptyArtifact(fs, path);
	if (nonEmpty) return nonEmpty;
	const validation = validateDoubtReviewMarkdown(await fs.readText(path));
	if (!validation.valid) {
		return `${validation.reason} Use planner_doubt_review; do not hand-write weak doubt notes.`;
	}
	if (validation.needsProbeCount > 0) {
		return "Doubt Review still contains needs_probe findings. Run the probes or dismiss them with proof before finishing finalize/doubt_review.";
	}
	if (
		target?.stage === "planning" &&
		target.step === "read_context" &&
		validation.provenBugCount === 0
	) {
		return "Returning from finalize/doubt_review to planning/read_context requires at least one proven_bug finding.";
	}
	if (
		target?.stage === "finalize" &&
		target.step === "write_final_summary" &&
		validation.provenBugCount > 0
	) {
		return "Doubt Review contains proven bugs. Return to planning/read_context for revision tasks instead of writing the final summary.";
	}
	return null;
}

async function validateTaskArtifacts(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
): Promise<string | null> {
	const plan = await readPlanRecord(fs, planPaths);
	if (plan.tasks.length === 0) {
		return "No planner tasks exist. Call planner_task_upsert for each behavioral task before finishing planning/write_task_files.";
	}
	for (const task of plan.tasks) {
		const paths = createTaskStoragePaths(planPaths, task.taskId);
		for (const path of [paths.taskJson, paths.taskMd]) {
			const artifactBlock = await requireNonEmptyArtifact(fs, path);
			if (artifactBlock) return artifactBlock;
		}
	}
	return null;
}

function validatePreparedTask(state: PlanStateRecord): string | null {
	const taskId = state.activeTaskId;
	const taskBranch = state.activeBranches.currentTask;
	const registry = taskId ? state.managedBranches.tasks[taskId] : null;
	return taskId &&
		taskBranch &&
		state.currentBranch === taskBranch &&
		registry?.task === taskBranch
		? null
		: "Task preparation is incomplete. Call planner_git_create_task_branch for exactly one task before finishing execution/prepare_task.";
}

function validateMergedTask(state: PlanStateRecord): string | null {
	return state.activeTaskId === null &&
		state.activeBranches.currentTask === null &&
		state.currentBranch === state.activeBranches.plan
		? null
		: "Task has not been merged and cleaned through planner_git_merge_task_to_plan.";
}

function validateCleanWorktree(
	gitReality: PlannerGitReality | null,
): string | null {
	if (!gitReality) {
		return "Git reality is unavailable.";
	}
	return !gitReality.isDirty
		? null
		: "Commit planner changes before finishing this step.";
}

function validateCleanWorktreeForFinalizeOrDone(
	gitReality: PlannerGitReality | null,
): string | null {
	if (!gitReality) {
		return "Git reality is unavailable.";
	}
	return !gitReality.isDirty
		? null
		: "Discard any worktree changes using planner_git_discard_changes before finishing this step.";
}

async function requireNonEmptyArtifact(
	fs: PlannerFs,
	path: string,
): Promise<string | null> {
	if (
		!(await fs.exists(path)) ||
		(await fs.readText(path)).trim().length === 0
	) {
		return `Required planner artifact is missing or empty: ${path}.`;
	}
	return null;
}

async function requireArtifactIncludes(
	fs: PlannerFs,
	path: string,
	requiredText: string,
	message: string,
): Promise<string | null> {
	const nonEmpty = await requireNonEmptyArtifact(fs, path);
	if (nonEmpty) return nonEmpty;
	const content = await fs.readText(path);
	return content.includes(requiredText) ? null : message;
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
						next: parsePlannerPosition({
							stage: nextStage,
							step: nextStep,
							stageParam: "nextStage",
							stepParam: "nextStep",
						}),
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
				target: parsePlannerPosition({
					stage: stringOrUndefined(object.targetStage),
					step: stringOrUndefined(object.targetStep),
					stageParam: "targetStage",
					stepParam: "targetStep",
				}),
			};
	}
}

function parsePlannerPosition(input: {
	stage: string | undefined;
	step: string | undefined;
	stageParam: string;
	stepParam: string;
}): { stage: PlannerStage; step: PlannerStep } {
	const stages = Object.keys(PLANNER_STAGE_STEPS) as PlannerStage[];
	if (!input.stage || !isPlannerStage(input.stage)) {
		throw new Error(
			`${input.stageParam} must be one of: ${stages.join(", ")}.`,
		);
	}
	const steps = PLANNER_STAGE_STEPS[input.stage];
	if (!input.step || !isPlannerStepInStage(input.stage, input.step)) {
		throw new Error(
			`${input.stepParam} must be one of ${input.stage} steps: ${steps.join(", ")}.`,
		);
	}
	return { stage: input.stage, step: input.step };
}

function isPlannerStage(value: string): value is PlannerStage {
	return Object.hasOwn(PLANNER_STAGE_STEPS, value);
}

function isPlannerStepInStage(
	stage: PlannerStage,
	step: string,
): step is PlannerStep {
	return (PLANNER_STAGE_STEPS[stage] as readonly string[]).includes(step);
}

function formatWorkflowToolResult(
	result: PlannerStateTransitionResult,
): string {
	if (result.status === "blocked") {
		const lines: (string | null)[] = [
			`Planner transition blocked: ${result.transition.type}`,
			`Code: ${result.code}`,
			`Reason: ${result.reason}`,
			result.stateMachineErrorCode
				? `State machine error: ${result.stateMachineErrorCode}`
				: null,
		];
		// A branch step bounced finish_step because no target was chosen. List the
		// concrete allowed targets inline so the model re-calls finish_step with a
		// nextStep directly, instead of round-tripping through planner_status.
		const branchTargets =
			result.stateMachineErrorCode === "ambiguous_next_step" && result.state
				? safeAllowedNext(result.state)
				: [];
		if (result.state && branchTargets.length > 0) {
			lines.push(
				`Allowed next: ${formatAllowedNextTargets(result.state, branchTargets)}.`,
				"Re-call planner_finish_step with ONE of these as nextStep — no need to call planner_status.",
			);
		} else {
			lines.push(
				"Call planner_status before choosing the next planner action.",
			);
		}
		return lines.filter(Boolean).join("\n");
	}

	// The applied result reflects the step we just moved INTO, so build the
	// guidance from the post-transition state. This replaces the old generic
	// "Call planner_status" footer with a compact, actionable hint.
	return [
		`Planner transition applied: ${result.transition.type} (previous: ${result.previousState.stage}/${result.previousState.step}).`,
		"",
		buildNextStepHint(result.state),
	].join("\n");
}

function safeAllowedNext(state: PlanStateRecord): PlannerTargetPosition[] {
	try {
		return getAllowedNextPlannerPositions({
			stage: state.stage,
			step: state.step,
			creationMethod: state.creationMethod,
		});
	} catch {
		return [];
	}
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value
		: undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}
