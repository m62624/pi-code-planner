import type {
	PlannerStage,
	PlannerStep,
	PlanStateRecord,
} from "../storage/schema";

export const PLANNER_WRAPPER_TOOLS = [
	"planner_status",
	"planner_create_plan",
	"planner_goal_submit",
	"planner_goal_decide",
	"planner_git_inspect",
	"planner_git_init",
	"planner_git_commit",
	"planner_git_create_task_branch",
	"planner_git_create_experiment_branch",
	"planner_git_select_experiment",
	"planner_git_merge_selected_experiment",
	"planner_git_create_refactor_branch",
	"planner_git_merge_refactor_to_task",
	"planner_git_merge_task_to_plan",
	"planner_git_export_plan_to_output",
	"planner_git_remove_plan_worktree",
	"planner_git_cleanup_managed_branches",
	"planner_memory_inspect",
	"planner_memory_apply_freshness",
	"planner_memory_write_project_patterns",
	"planner_memory_upsert_files",
	"planner_memory_upsert_symbols",
	"planner_memory_upsert_relations",
	"planner_memory_search",
	"planner_memory_verify",
	"planner_memory_sync_checkpoint",
	"planner_recovery_inspect",
	"planner_recovery_resume",
] as const;

export type PlannerWrapperTool = (typeof PLANNER_WRAPPER_TOOLS)[number];

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

const MEMORY_SEARCH_STAGES = new Set<PlannerStage>([
	"discovery",
	"planning",
	"execution",
	"finalize",
	"done",
	"recovery",
]);

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
		read_project: ["planner_git_inspect"],
		write_project_patterns: ["planner_memory_write_project_patterns"],
		write_file_index: ["planner_memory_upsert_files"],
		write_symbols: ["planner_memory_upsert_symbols"],
		write_relations: ["planner_memory_upsert_relations"],
		write_questions: [],
		verify_memory: [
			"planner_memory_inspect",
			"planner_memory_verify",
			"planner_memory_sync_checkpoint",
		],
		compact_discovery: [],
		enter_planning: [],
	},
	planning: {
		read_memory: ["planner_memory_inspect", "planner_memory_search"],
		draft_plan: [],
		split_tasks: [],
		write_task_files: [],
		verify_plan: [],
		compact_planning: [],
		enter_execution: [],
	},
	execution: {
		prepare_task: ["planner_git_inspect", "planner_git_create_task_branch"],
		write_tdd_plan: ["planner_git_inspect"],
		write_tests: ["planner_git_inspect", "planner_git_commit"],
		run_failing_tests: ["planner_git_inspect"],
		start_experiments: [
			"planner_git_inspect",
			"planner_git_create_experiment_branch",
		],
		run_experiment: ["planner_git_inspect", "planner_git_commit"],
		summarize_experiment: ["planner_git_inspect"],
		compact_experiment: [],
		select_experiment: ["planner_git_inspect", "planner_git_select_experiment"],
		merge_best_experiment: [
			"planner_git_inspect",
			"planner_git_merge_selected_experiment",
		],
		refactor_task: [
			"planner_git_inspect",
			"planner_git_commit",
			"planner_git_create_refactor_branch",
			"planner_git_merge_refactor_to_task",
		],
		run_final_tests: ["planner_git_inspect", "planner_git_commit"],
		merge_task_to_plan: [
			"planner_git_inspect",
			"planner_git_merge_task_to_plan",
		],
		compact_task: [],
		select_next_task: ["planner_git_inspect"],
	},
	finalize: {
		verify_plan_branch: ["planner_git_inspect"],
		write_final_summary: [],
		compact_finalize: [],
		enter_done: [],
	},
	done: {
		present_result: [],
		await_user_acceptance: [],
		handle_change_request: [],
		prepare_output_branch: [
			"planner_git_inspect",
			"planner_git_export_plan_to_output",
		],
		merge_or_export_result: [
			"planner_git_inspect",
			"planner_git_export_plan_to_output",
		],
		cleanup_worktree: [
			"planner_git_inspect",
			"planner_git_remove_plan_worktree",
			"planner_git_cleanup_managed_branches",
		],
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
		| "requiresMemoryUpdate"
	>,
): readonly PlannerWrapperTool[] {
	if (state.broken || state.requiresUserDecision) {
		return withAlwaysAllowed([
			"planner_git_inspect",
			...STEP_ALLOWED_TOOLS.recovery.read_state,
			"planner_recovery_resume",
		]);
	}

	if (state.requiresMemoryUpdate) {
		return withAlwaysAllowed([
			"planner_git_inspect",
			"planner_memory_inspect",
			"planner_memory_apply_freshness",
			"planner_memory_upsert_files",
			"planner_memory_upsert_symbols",
			"planner_memory_upsert_relations",
			"planner_memory_search",
			"planner_memory_verify",
			"planner_memory_sync_checkpoint",
		]);
	}

	if (state.requiresCompact) {
		return ALWAYS_ALLOWED_TOOLS;
	}

	const stageRules: Partial<
		Record<PlannerStep, readonly PlannerWrapperTool[]>
	> = STEP_ALLOWED_TOOLS[state.stage];
	const stepRules = stageRules[state.step] ?? [];
	return withAlwaysAllowed([
		...stepRules,
		...(MEMORY_SEARCH_STAGES.has(state.stage)
			? (["planner_memory_search"] as const)
			: []),
	]);
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
		| "requiresMemoryUpdate"
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
				requiresMemoryUpdate: input.state.requiresMemoryUpdate,
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
		`Allowed planner wrappers now: ${input.allowedTools.join(", ")}.`,
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
	requiresMemoryUpdate: boolean;
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

	if (input.requiresMemoryUpdate) {
		return [
			`Planner wrapper ${input.tool} is blocked.`,
			"The active plan requires a memory update before normal work can continue.",
			"Inspect memory freshness, update affected memory entries, verify freshness, then resume.",
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
