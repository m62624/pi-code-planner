import type {
	PlannerStage,
	PlannerStep,
	PlanStateRecord,
} from "../storage/schema";

// Half of a dual-gate invariant with src/runtime/stage-behavior.ts's
// `expectedTools`: a tool must be allowed by BOTH this list (STEP_ALLOWED_TOOLS
// below) and the stage-behavior gate to be usable at a step. If a tool is
// added here but omitted from stage-behavior.ts's expectedTools for the same
// step, the model sees it as available but every call is rejected — a
// silent deadlock. Covered by runtime/tool-gating-invariant.test.ts.
export const PLANNER_WRAPPER_TOOLS = [
	"planner_status",
	"planner_create_plan",
	"planner_goal_submit",
	"planner_goal_decide",
	"planner_questions_submit",
	"planner_questions_resolve",
	"planner_plan_submit",
	"planner_discovery_submit",
	"planner_tdd_submit",
	"planner_summary_submit",
	"planner_task_upsert",
	"planner_refactor_review",
	"planner_doubt_review",
	"planner_skill_create",
	"planner_skill_update",
	"planner_contract_scan",
	"planner_contract_route",
	"planner_contract_read",
	"planner_contract_check",
	"planner_contract_upsert",
	"planner_contract_decide",
	"planner_report_stuck",
	"planner_debug_strategy",
	"planner_debug_probe",
	"planner_debug_result",
	"planner_debug_cleanup",
	"planner_git_inspect",
	"planner_git_init",
	"planner_git_commit",
	"planner_git_discard_changes",
	"planner_git_create_task_branch",
	"planner_git_create_refactor_branch",
	"planner_git_merge_refactor_to_task",
	"planner_git_merge_task_to_plan",
	"planner_recovery_inspect",
	"planner_recovery_resume",
	"planner_exec",
] as const;

export type PlannerWrapperTool = (typeof PLANNER_WRAPPER_TOOLS)[number];

export const ALL_PLANNER_TOOL_NAMES = [
	...PLANNER_WRAPPER_TOOLS,
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

export type AllPlannerToolName = (typeof ALL_PLANNER_TOOL_NAMES)[number];

const DEBUG_WRAPPER_TOOLS = [
	"planner_debug_strategy",
	"planner_debug_probe",
	"planner_debug_result",
	"planner_debug_cleanup",
] as const satisfies readonly PlannerWrapperTool[];

export interface PlannerToolPolicyDecision {
	allow: boolean;
	tool: PlannerWrapperTool;
	stage: PlannerStage;
	step: PlannerStep;
	reason: string | null;
	allowedTools: readonly PlannerWrapperTool[];
	hint: string;
}

const ALWAYS_ALLOWED_TOOLS = [
	"planner_status",
] as const satisfies readonly PlannerWrapperTool[];

const STEP_ALLOWED_TOOLS = {
	init: {
		check_project: ["planner_git_inspect"],
		check_git: ["planner_git_inspect", "planner_git_init"],
		prepare_storage: [],
		choose_worktree_location: [],
		create_plan_record: [],
		create_plan_worktree: ["planner_git_inspect"],
		enter_intake: ["planner_git_inspect"],
	},
	intake: {
		draft_goal: ["planner_goal_submit"],
		await_goal_approval: ["planner_goal_decide"],
	},
	discovery: {
		scan_project_structure: [
			"planner_git_inspect",
			"planner_discovery_submit",
			"planner_contract_scan",
			"planner_contract_route",
			"planner_contract_read",
			"planner_contract_upsert",
			"planner_git_commit",
			"planner_exec",
		],
		write_questions: [
			"planner_questions_submit",
			"planner_questions_resolve",
			"planner_contract_scan",
			"planner_contract_route",
			"planner_contract_read",
			"planner_exec",
		],
		compact_discovery: [],
		enter_planning: [],
	},
	planning: {
		read_context: ["planner_contract_route", "planner_contract_read"],
		draft_plan: [
			"planner_plan_submit",
			"planner_contract_route",
			"planner_contract_read",
		],
		split_tasks: ["planner_contract_route", "planner_contract_read"],
		write_task_files: [
			"planner_task_upsert",
			"planner_contract_route",
			"planner_contract_read",
		],
		verify_plan: [],
		compact_planning: [],
		enter_execution: [],
	},
	execution: {
		prepare_task: ["planner_git_inspect", "planner_git_create_task_branch"],
		write_tdd_plan: [
			"planner_git_inspect",
			"planner_tdd_submit",
			"planner_report_stuck",
			"planner_skill_create",
			"planner_skill_update",
			"planner_debug_strategy",
			"planner_debug_probe",
			"planner_debug_result",
			"planner_debug_cleanup",
			"planner_exec",
		],
		write_tests: [
			"planner_git_inspect",
			"planner_tdd_submit",
			"planner_git_commit",
			"planner_report_stuck",
			"planner_skill_create",
			"planner_skill_update",
			"planner_debug_strategy",
			"planner_debug_probe",
			"planner_debug_result",
			"planner_debug_cleanup",
			"planner_exec",
		],
		run_failing_tests: [
			"planner_git_inspect",
			"planner_tdd_submit",
			"planner_report_stuck",
			"planner_skill_create",
			"planner_skill_update",
			"planner_debug_strategy",
			"planner_debug_probe",
			"planner_debug_result",
			"planner_debug_cleanup",
			"planner_exec",
		],
		implement_task: [
			"planner_git_inspect",
			"planner_tdd_submit",
			"planner_git_commit",
			"planner_contract_route",
			"planner_contract_read",
			"planner_report_stuck",
			"planner_skill_create",
			"planner_skill_update",
			"planner_debug_strategy",
			"planner_debug_probe",
			"planner_debug_result",
			"planner_debug_cleanup",
			"planner_exec",
		],
		contract_check: [
			"planner_git_inspect",
			"planner_tdd_submit",
			"planner_git_commit",
			"planner_contract_route",
			"planner_contract_read",
			"planner_contract_check",
			"planner_contract_upsert",
			"planner_report_stuck",
			"planner_skill_create",
			"planner_skill_update",
			"planner_exec",
		],
		refactor_task: [
			"planner_git_inspect",
			"planner_tdd_submit",
			"planner_refactor_review",
			"planner_git_commit",
			"planner_contract_route",
			"planner_contract_read",
			"planner_contract_check",
			"planner_contract_upsert",
			"planner_git_create_refactor_branch",
			"planner_git_merge_refactor_to_task",
			"planner_report_stuck",
			"planner_skill_create",
			"planner_skill_update",
			"planner_debug_strategy",
			"planner_debug_probe",
			"planner_debug_result",
			"planner_debug_cleanup",
			"planner_exec",
		],
		run_final_tests: [
			"planner_git_inspect",
			"planner_tdd_submit",
			"planner_git_commit",
			"planner_report_stuck",
			"planner_skill_create",
			"planner_skill_update",
			"planner_debug_strategy",
			"planner_debug_probe",
			"planner_debug_result",
			"planner_debug_cleanup",
			"planner_exec",
		],
		capture_skill: [
			"planner_git_inspect",
			"planner_skill_create",
			"planner_skill_update",
			"planner_git_discard_changes",
		],
		merge_task_to_plan: [
			"planner_git_inspect",
			"planner_tdd_submit",
			"planner_git_merge_task_to_plan",
		],
		compact_task: [],
		select_next_task: ["planner_git_inspect"],
	},
	finalize: {
		verify_plan_branch: [
			"planner_git_inspect",
			"planner_contract_route",
			"planner_contract_read",
		],
		doubt_review: [
			"planner_git_inspect",
			"planner_doubt_review",
			"planner_skill_create",
			"planner_skill_update",
			"planner_contract_route",
			"planner_contract_read",
			"planner_contract_check",
			"planner_contract_upsert",
		],
		write_final_summary: [
			"planner_summary_submit",
			"planner_skill_create",
			"planner_skill_update",
			"planner_contract_route",
			"planner_contract_read",
			"planner_contract_check",
			"planner_contract_upsert",
		],
		compact_finalize: [],
		enter_done: [],
	},
	done: {
		present_result: [
			"planner_skill_create",
			"planner_skill_update",
			"planner_contract_decide",
		],
		await_user_acceptance: ["planner_contract_decide"],
		handle_change_request: ["planner_plan_submit", "planner_discovery_submit"],
		prepare_output_branch: [],
		merge_or_export_result: [],
		cleanup_worktree: [],
		mark_done: [],
		cleanup_plan_files: [],
	},
	recovery: {
		read_state: ["planner_recovery_inspect"],
		inspect_git: ["planner_git_inspect", "planner_recovery_inspect"],
		compare_expected_actual: ["planner_recovery_inspect"],
		classify_recovery: ["planner_recovery_inspect"],
		ask_user_if_destructive: ["planner_recovery_inspect"],
		repair_or_resume: [
			"planner_recovery_inspect",
			"planner_recovery_resume",
			"planner_git_inspect",
		],
	},
} as const satisfies Record<
	PlannerStage,
	Partial<Record<PlannerStep, readonly PlannerWrapperTool[]>>
>;

export function getAllowedPlannerWrapperTools(
	state: Pick<
		PlanStateRecord,
		| "stage"
		| "step"
		| "broken"
		| "requiresUserDecision"
		| "requiresCompact"
		| "debugArtifactsDir"
	>,
): readonly PlannerWrapperTool[] {
	if (state.broken || state.requiresUserDecision) {
		return withAlwaysAllowed([
			"planner_git_inspect",
			...STEP_ALLOWED_TOOLS.recovery.read_state,
			"planner_recovery_resume",
		]);
	}

	if (state.requiresCompact) {
		return ALWAYS_ALLOWED_TOOLS;
	}

	const stageRules: Partial<
		Record<PlannerStep, readonly PlannerWrapperTool[]>
	> = STEP_ALLOWED_TOOLS[state.stage];
	const stepRules = stageRules[state.step] ?? [];
	return withAlwaysAllowed(filterDebugToolsForState(stepRules, state));
}

export function checkPlannerWrapperAllowed(input: {
	tool: PlannerWrapperTool;
	state: Pick<
		PlanStateRecord,
		| "stage"
		| "step"
		| "stepStatus"
		| "broken"
		| "requiresUserDecision"
		| "requiresCompact"
		| "debugArtifactsDir"
	>;
}): PlannerToolPolicyDecision {
	const allowedTools = getAllowedPlannerWrapperTools(input.state);
	const allow = allowedTools.includes(input.tool);
	const reason = allow
		? null
		: buildBlockedToolReason({
				tool: input.tool,
				stage: input.state.stage,
				step: input.state.step,
				broken: input.state.broken,
				requiresUserDecision: input.state.requiresUserDecision,
				requiresCompact: input.state.requiresCompact,
			});

	return {
		allow,
		tool: input.tool,
		stage: input.state.stage,
		step: input.state.step,
		reason,
		allowedTools,
		hint: buildPlannerToolHint({
			stage: input.state.stage,
			step: input.state.step,
			allowedTools,
		}),
	};
}

export function buildPlannerToolHint(input: {
	stage: PlannerStage;
	step: PlannerStep;
	allowedTools: readonly PlannerWrapperTool[];
}): string {
	return [
		`Current planner position: ${input.stage}/${input.step}.`,
		`Extension tools (this planner session only): ${input.allowedTools.join(", ")}.`,
		"Read the markdown instruction for the current stage before continuing.",
		"Do not use raw git while a plan is active.",
	].join("\n");
}

function buildBlockedToolReason(input: {
	tool: PlannerWrapperTool;
	stage: PlannerStage;
	step: PlannerStep;
	broken: boolean;
	requiresUserDecision: boolean;
	requiresCompact: boolean;
}): string {
	if (input.broken || input.requiresUserDecision) {
		return [
			`Planner wrapper ${input.tool} is blocked.`,
			"The active plan requires recovery or a user decision.",
			"Call planner_status or a recovery wrapper instead.",
		].join("\n");
	}

	if (input.requiresCompact) {
		return [
			`Planner wrapper ${input.tool} is blocked.`,
			"The active plan is at a compact boundary.",
			"Finish compact/resume flow before calling normal planner wrappers.",
		].join("\n");
	}

	return [
		`Planner wrapper ${input.tool} is not allowed at ${input.stage}/${input.step}.`,
		"Use only the wrappers listed by the current planner policy.",
		"Call planner_status if you need the current instruction files.",
	].join("\n");
}

function withAlwaysAllowed(
	tools: readonly PlannerWrapperTool[],
): readonly PlannerWrapperTool[] {
	return Array.from(
		new Set<PlannerWrapperTool>([...ALWAYS_ALLOWED_TOOLS, ...tools]),
	);
}

// Debug tools stay listed in STEP_ALLOWED_TOOLS for execution steps but are
// hidden unless a debug session is actually open (debugArtifactsDir set), so
// the model isn't offered debug wrappers it can't yet call.
function filterDebugToolsForState(
	tools: readonly PlannerWrapperTool[],
	state: Pick<PlanStateRecord, "debugArtifactsDir">,
): readonly PlannerWrapperTool[] {
	if (state.debugArtifactsDir) {
		return tools;
	}
	return tools.filter(
		(tool) =>
			!(DEBUG_WRAPPER_TOOLS as readonly PlannerWrapperTool[]).includes(tool),
	);
}
