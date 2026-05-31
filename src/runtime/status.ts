import { join } from "node:path";
import { getInstructionContent } from "../instructions/manager";
import { createInstructionPaths } from "../instructions/paths";
import type {
	InstructionContent,
	InstructionKey,
} from "../instructions/schema";
import type { PlannerFs } from "../storage/fs";
import type { PlannerStage, PlannerStep } from "../storage/schema";
import {
	decidePlannerLifecycleNext,
	type PlannerLifecycleDecision,
} from "./lifecycle";
import { filterPlannerWrapperToolsForLifecycle } from "./orchestrator-gate";
import type { PlannerPreflightResult } from "./preflight";
import { getPlannerStageStepBehavior } from "./stage-behavior";
import { getAllowedPlannerStateTransitionTypes } from "./state-transition";

export interface PlannerStepRule {
	stage: PlannerStage;
	step: PlannerStep;
	objective: string;
	requiredActions: readonly string[];
	allowedNow: readonly string[];
	forbiddenNow: readonly string[];
	exitCondition: string;
	nextInstruction: string;
}

export interface PlannerStatusTextInput {
	fs: PlannerFs;
	preflight: PlannerPreflightResult;
}

export const PLANNER_STATUS_INVARIANTS = [
	"Raw git is forbidden while a planner plan is active. Use planner git wrappers only.",
	"The model never edits project.json, plan.json, state.json, memory checkpoint files, or worktree index files directly.",
	"Call planner_status before choosing the next planner action after every tool result, compact, recovery, or user decision.",
	"Normal flow is blocked by recovery, user decision, compact gate, or required memory update.",
	"Memory-first rule: inspect planner memory before broad source reads; read source only when memory is missing, stale, insufficient, or must be verified.",
	"Stage and step order is strict. Recovery is the only stage that may resume into a valid non-recovery position.",
	"A completed step cannot run again. Advance it first.",
	"Every wrapper tool must be allowed by runtime preflight and wrapper policy for the current exact stage/step.",
	"Every workflow transition must be allowed by the state machine for the current exact stepStatus.",
	"Actual git branch must match state.currentBranch when currentBranch is set.",
	"Git conflicts always block normal flow and require recovery.",
	"HEAD mismatch with lastCheckpointCommit requires memory update before normal flow continues.",
	"Dirty worktree is allowed inside an active work step, but not when syncing memory checkpoint or crossing a checkpoint boundary.",
	"Memory checkpoint sync requires a clean worktree and clean memory freshness.",
	"A planner commit does not finish an atomic unit. The unit is consistent only after commit plus memory update plus checkpoint sync.",
	"Merge targets come from state.json only. The model may choose taskId or experimentId, but not source/target merge branches.",
	"Production behavior changes are allowed only in implementation/refactor steps that explicitly permit them.",
	"Task branch cannot merge into plan before final task checks pass.",
	"Next task cannot start before merge_task_to_plan and compact_task.",
	"Experiment branches are temporary evidence. Non-selected experiment branches are deleted after selected experiment merge.",
	"Task branch is temporary. It is deleted after it is merged into the plan branch.",
	"Plan branch is protected. It is not deleted by managed child branch cleanup.",
	"Done cleanup requires explicit user acceptance.",
] as const;

export const PLANNER_STEP_RULES = {
	check_project: stepRule("init", "check_project", {
		objective: "Resolve the opened project root and planner project identity.",
		requiredActions: [
			"Confirm the current project root.",
			"Do not inspect project source for task understanding yet.",
		],
		allowedNow: ["Use planner status and project/storage inspection only."],
		forbiddenNow: ["Do not edit project files.", "Do not create tasks."],
		exitCondition: "Project root and project id are known.",
		nextInstruction: "Call planner_finish_step to open check_git.",
	}),
	check_git: stepRule("init", "check_git", {
		objective: "Ensure the project has a git repository.",
		requiredActions: [
			"Inspect git availability through planner wrappers.",
			"Initialize git only if no repository exists and the user/task requires planner control.",
		],
		allowedNow: [
			"Use planner_git_inspect and planner_git_init if policy allows it.",
		],
		forbiddenNow: [
			"Do not use raw git through shell.",
			"Do not read source for discovery yet.",
		],
		exitCondition: "Git repository availability is known.",
		nextInstruction: "Call planner_finish_step to open prepare_storage.",
	}),
	prepare_storage: stepRule("init", "prepare_storage", {
		objective: "Prepare planner storage for the project.",
		requiredActions: ["Create or load project-level planner storage."],
		allowedNow: ["Planner internal storage writes only."],
		forbiddenNow: ["Do not edit source files.", "Do not create task branches."],
		exitCondition: "Project storage paths and project.json are available.",
		nextInstruction:
			"Call planner_finish_step to open choose_worktree_location.",
	}),
	choose_worktree_location: stepRule("init", "choose_worktree_location", {
		objective: "Choose the worktree location from settings.",
		requiredActions: [
			"Use effective planner settings to choose project-local or custom worktree root.",
		],
		allowedNow: ["Read planner settings only."],
		forbiddenNow: [
			"Do not ask the model to invent a worktree path when settings already define it.",
		],
		exitCondition: "The plan worktree path is determined.",
		nextInstruction: "Call planner_finish_step to open create_plan_record.",
	}),
	create_plan_record: stepRule("init", "create_plan_record", {
		objective: "Create the plan record and initial state.",
		requiredActions: [
			"Create plan.json, state.json, plan markdown artifacts, and memory files.",
		],
		allowedNow: ["Planner internal storage writes only."],
		forbiddenNow: ["Do not start discovery before the plan record exists."],
		exitCondition:
			"Plan files exist and project.json references the active plan.",
		nextInstruction: "Call planner_finish_step to open create_plan_worktree.",
	}),
	create_plan_worktree: stepRule("init", "create_plan_worktree", {
		objective: "Create one dedicated worktree for the whole plan.",
		requiredActions: [
			"Use internal planner create flow. The model does not call a public worktree creation tool.",
		],
		allowedNow: ["Inspect git through planner wrappers if needed."],
		forbiddenNow: [
			"Do not create worktrees through shell git.",
			"Do not create task or experiment branches here.",
		],
		exitCondition:
			"Plan worktree exists and state.worktreePath/currentBranch are set.",
		nextInstruction: "Call planner_finish_step to open enter_intake.",
	}),
	enter_intake: stepRule("init", "enter_intake", {
		objective: "Move from bootstrap into intake.",
		requiredActions: ["Persist stage=intake and step=draft_goal."],
		allowedNow: ["State transition only."],
		forbiddenNow: [
			"Do not read project source until discovery/read_project is active.",
		],
		exitCondition: "State points to intake/draft_goal.",
		nextInstruction:
			"Continue with intake/draft_goal and call planner_status again.",
	}),
	draft_goal: stepRule("intake", "draft_goal", {
		objective: "Rewrite the raw user request as a precise reviewable goal.",
		requiredActions: [
			"Read request.md.",
			"Write goal.md in your own words with outcome, assumptions, non-goals, constraints, and focused clarification questions.",
			"Call planner_goal_submit with the full goal markdown.",
		],
		allowedNow: ["Use planner_goal_submit only after the draft is complete."],
		forbiddenNow: [
			"Do not inspect project source.",
			"Do not infer implementation details from the request.",
		],
		exitCondition: "goal.md exists and the planner is waiting for user review.",
		nextInstruction:
			"Ask the user to review goal.md and approve or request revision.",
	}),
	await_goal_approval: stepRule("intake", "await_goal_approval", {
		objective: "Wait for explicit user approval of the normalized goal.",
		requiredActions: [
			"Show the exact goal.md path and summarize the draft.",
			"Ask whether the goal is approved or needs revision.",
			"Call planner_goal_decide only after the user explicitly answers.",
		],
		allowedNow: ["Use planner_goal_decide with approve or revise."],
		forbiddenNow: [
			"Do not begin discovery before approval.",
			"Do not infer approval from silence.",
		],
		exitCondition: "User explicitly approves the goal or requests a revision.",
		nextInstruction:
			"Approve enters discovery/read_project. Revise returns to intake/draft_goal.",
	}),

	read_project: stepRule("discovery", "read_project", {
		objective: "Read the project broadly enough to build compressed memory.",
		requiredActions: [
			"Inspect project structure and relevant files.",
			"Read complete files or complete chunks before indexing them.",
			"Record evidence in planner artifacts instead of relying on chat history.",
		],
		allowedNow: [
			"Read project files and run read-only discovery commands that are not raw git.",
		],
		forbiddenNow: [
			"Do not implement code.",
			"Do not create tasks before memory is written.",
		],
		exitCondition:
			"Project structure, major files, dependencies, and conventions are understood enough to write memory.",
		nextInstruction: "Call planner_finish_step to open write_project_patterns.",
	}),
	write_project_patterns: stepRule("discovery", "write_project_patterns", {
		objective: "Write project architecture and convention notes.",
		requiredActions: [
			"Write project_patterns.md with observed patterns, commands, dependencies, and uncertainty.",
		],
		allowedNow: ["Write planner artifacts and memory project patterns."],
		forbiddenNow: ["Do not edit production code."],
		exitCondition:
			"project_patterns.md contains evidence-backed patterns and open questions.",
		nextInstruction: "Call planner_finish_step to open write_file_index.",
	}),
	write_file_index: stepRule("discovery", "write_file_index", {
		objective: "Index relevant project files.",
		requiredActions: [
			"Write memory file entries with path, kind, language, hash, status, and summary.",
		],
		allowedNow: ["Use planner_memory_upsert_files for file entries."],
		forbiddenNow: [
			"Do not write memory JSONL directly.",
			"Do not skip file hashes.",
		],
		exitCondition:
			"Relevant files are indexed or explicitly marked ignored/unknown.",
		nextInstruction: "Call planner_finish_step to open write_symbols.",
	}),
	write_symbols: stepRule("discovery", "write_symbols", {
		objective: "Index symbols and signatures.",
		requiredActions: [
			"Write functions, methods, types, classes, modules, constants, and tests that matter for the plan.",
			"Record signatures, summaries, anchors, visibility, verification status, and effects.",
		],
		allowedNow: ["Use planner_memory_upsert_symbols for symbol entries."],
		forbiddenNow: [
			"Do not omit effects. Use unknown when evidence is insufficient.",
		],
		exitCondition:
			"Relevant APIs have symbol entries with signatures and effect metadata.",
		nextInstruction: "Call planner_finish_step to open write_relations.",
	}),
	write_relations: stepRule("discovery", "write_relations", {
		objective:
			"Index relations between files, symbols, modules, tests, and configuration.",
		requiredActions: [
			"Write evidence-backed relation entries for calls, tests, configures, depends_on, exposes, reads, or writes.",
		],
		allowedNow: ["Use planner_memory_upsert_relations for relation entries."],
		forbiddenNow: [
			"Do not invent relations without evidence path/search text.",
		],
		exitCondition:
			"Important symbol/file relations have evidence-backed entries.",
		nextInstruction: "Call planner_finish_step to open write_questions.",
	}),
	write_questions: stepRule("discovery", "write_questions", {
		objective: "Record uncertainty before planning.",
		requiredActions: [
			"Write focused questions and assumptions into questions.md.",
		],
		allowedNow: ["Write planner question artifacts."],
		forbiddenNow: ["Do not ask broad questions before collecting evidence."],
		exitCondition: "Known blockers, uncertainty, and assumptions are recorded.",
		nextInstruction: "Call planner_finish_step to open verify_memory.",
	}),
	verify_memory: stepRule("discovery", "verify_memory", {
		objective: "Verify memory consistency against source files.",
		requiredActions: [
			"Inspect memory freshness.",
			"Verify that file hashes, symbol anchors, relation evidence, and effects are consistent.",
		],
		allowedNow: [
			"Use planner_memory_inspect, planner_memory_verify, and planner_memory_sync_checkpoint when clean.",
		],
		forbiddenNow: [
			"Do not sync checkpoint if memory is stale or worktree is dirty.",
		],
		exitCondition: "Memory is clean and checkpoint is synced to current HEAD.",
		nextInstruction: "Call planner_finish_step to open compact_discovery.",
	}),
	compact_discovery: stepRule("discovery", "compact_discovery", {
		objective: "Create a compact boundary after discovery.",
		requiredActions: [
			"Request Pi compact and preserve discovery summary, memory status, and open questions.",
		],
		allowedNow: ["Compact flow only."],
		forbiddenNow: [
			"Do not edit code or memory while compact is required/pending.",
		],
		exitCondition:
			"Compaction finished and resume context points back to planner_status.",
		nextInstruction: "Complete compact to open enter_planning.",
	}),
	enter_planning: stepRule("discovery", "enter_planning", {
		objective: "Enter planning after verified discovery.",
		requiredActions: ["Persist stage=planning and step=read_memory."],
		allowedNow: ["State transition only."],
		forbiddenNow: ["Do not draft tasks until planning/read_memory is active."],
		exitCondition: "State points to planning/read_memory.",
		nextInstruction:
			"Continue with planning/read_memory and call planner_status again.",
	}),

	read_memory: stepRule("planning", "read_memory", {
		objective: "Use compressed memory as the source of project context.",
		requiredActions: [
			"Read project_patterns and bounded memory indexes before reading source files.",
		],
		allowedNow: [
			"Use planner memory inspection/retrieval and planner artifacts.",
		],
		forbiddenNow: [
			"Do not reread the whole project unless memory is insufficient or stale.",
		],
		exitCondition:
			"Relevant context for planning is loaded from memory and artifacts.",
		nextInstruction: "Call planner_finish_step to open draft_plan.",
	}),
	draft_plan: stepRule("planning", "draft_plan", {
		objective: "Draft an executable plan.",
		requiredActions: [
			"Write plan.md with scope, constraints, risks, checks, and intended sequence.",
		],
		allowedNow: ["Write planner artifacts."],
		forbiddenNow: ["Do not implement code.", "Do not create task branches."],
		exitCondition: "plan.md describes a coherent implementation route.",
		nextInstruction: "Call planner_finish_step to open split_tasks.",
	}),
	split_tasks: stepRule("planning", "split_tasks", {
		objective: "Split the plan into atomic tasks.",
		requiredActions: [
			"Create an ordered task list with small independent tasks and acceptance criteria.",
		],
		allowedNow: ["Write planner artifacts and plan task records."],
		forbiddenNow: ["Do not start TDD before task files exist."],
		exitCondition: "Each task is atomic enough for one TDD loop.",
		nextInstruction: "Call planner_finish_step to open write_task_files.",
	}),
	write_task_files: stepRule("planning", "write_task_files", {
		objective: "Create task artifacts.",
		requiredActions: [
			"Write task.json/task.md for each task with scope, acceptance criteria, and affected memory hints.",
		],
		allowedNow: ["Write task planner artifacts only."],
		forbiddenNow: ["Do not write tests or production code yet."],
		exitCondition: "Every planned task has its required files.",
		nextInstruction: "Call planner_finish_step to open verify_plan.",
	}),
	verify_plan: stepRule("planning", "verify_plan", {
		objective: "Verify the plan before execution.",
		requiredActions: [
			"Check that task order, scope, acceptance criteria, and risks are explicit.",
		],
		allowedNow: ["Read/write planner artifacts."],
		forbiddenNow: ["Do not start execution while plan gaps remain."],
		exitCondition: "Plan is executable without hidden broad tasks.",
		nextInstruction: "Call planner_finish_step to open compact_planning.",
	}),
	compact_planning: stepRule("planning", "compact_planning", {
		objective: "Create a compact boundary after planning.",
		requiredActions: [
			"Request Pi compact and preserve plan, task order, decisions, and memory pointers.",
		],
		allowedNow: ["Compact flow only."],
		forbiddenNow: [
			"Do not edit code or tasks while compact is required/pending.",
		],
		exitCondition:
			"Compaction finished and resume context points back to planner_status.",
		nextInstruction: "Complete compact to open enter_execution.",
	}),
	enter_execution: stepRule("planning", "enter_execution", {
		objective: "Enter task execution.",
		requiredActions: ["Persist stage=execution and step=prepare_task."],
		allowedNow: ["State transition only."],
		forbiddenNow: ["Do not start TDD until execution/prepare_task is active."],
		exitCondition: "State points to execution/prepare_task.",
		nextInstruction:
			"Continue with execution/prepare_task and call planner_status again.",
	}),

	prepare_task: stepRule("execution", "prepare_task", {
		objective: "Select exactly one task and prepare its branch/artifacts.",
		requiredActions: [
			"Select the next task, set activeTaskId, and create/switch the task branch through planner git wrappers.",
		],
		allowedNow: [
			"Read task artifacts, inspect memory, and use planner_git_create_task_branch.",
		],
		forbiddenNow: [
			"Do not write tests or production code before the task is prepared.",
		],
		exitCondition:
			"One active task and one current task branch are recorded in state.json.",
		nextInstruction: "Call planner_finish_step to open write_tdd_plan.",
	}),
	write_tdd_plan: stepRule("execution", "write_tdd_plan", {
		objective: "Write the TDD plan before changing behavior.",
		requiredActions: [
			"Read task.md and memory, then write tdd.md with failing test strategy and checks.",
		],
		allowedNow: [
			"Write TDD planner artifacts and inspect memory/source for test design.",
		],
		forbiddenNow: ["Do not change production behavior."],
		exitCondition:
			"tdd.md explains tests, mocks/fixtures, commands, edge cases, and expected failure.",
		nextInstruction: "Call planner_finish_step to open write_tests.",
	}),
	write_tests: stepRule("execution", "write_tests", {
		objective:
			"Write failing/mock/contract tests before production implementation.",
		requiredActions: [
			"Write tests, fixtures, mocks, and required test harness wiring for the active task.",
		],
		allowedNow: ["Edit test files and necessary test integration files."],
		forbiddenNow: ["Do not implement production behavior."],
		exitCondition:
			"Tests exist and are expected to fail or catch missing behavior.",
		nextInstruction: "Call planner_finish_step to open run_failing_tests.",
	}),
	run_failing_tests: stepRule("execution", "run_failing_tests", {
		objective: "Prove the tests guard the missing behavior.",
		requiredActions: [
			"Run focused checks from task/tdd/project instructions and record failure evidence.",
		],
		allowedNow: ["Run checks and update test summary artifacts."],
		forbiddenNow: [
			"Do not implement production code before the failing/contract signal is understood.",
		],
		exitCondition:
			"The failing/mock/contract signal is confirmed and documented.",
		nextInstruction: "Call planner_finish_step to open start_experiments.",
	}),
	start_experiments: stepRule("execution", "start_experiments", {
		objective: "Prepare experiment attempts for the active task.",
		requiredActions: [
			"Create the next experiment branch through planner git wrappers and record attempt intent.",
		],
		allowedNow: [
			"Use planner_git_create_experiment_branch and write experiment artifacts.",
		],
		forbiddenNow: [
			"Do not merge experiments before they are summarized and selected.",
		],
		exitCondition: "An active experiment branch and attempt id are recorded.",
		nextInstruction: "Call planner_finish_step to open run_experiment.",
	}),
	run_experiment: stepRule("execution", "run_experiment", {
		objective:
			"Implement one candidate solution in the active experiment branch.",
		requiredActions: [
			"Implement only this attempt's approach, run focused checks, commit through planner git, then update memory.",
		],
		allowedNow: [
			"Edit production/test files in scope, run checks, use planner_git_commit.",
		],
		forbiddenNow: ["Do not merge the experiment or delete branches here."],
		exitCondition:
			"Experiment implementation is committed and memory checkpoint is synced for the experiment HEAD.",
		nextInstruction: "Call planner_finish_step to open summarize_experiment.",
	}),
	summarize_experiment: stepRule("execution", "summarize_experiment", {
		objective: "Summarize experiment evidence.",
		requiredActions: [
			"Write summary with approach, checks, diff summary, tradeoffs, risks, and comparison data.",
		],
		allowedNow: [
			"Write experiment summary artifacts and inspect planner git diff through wrappers.",
		],
		forbiddenNow: ["Do not select an experiment without comparable evidence."],
		exitCondition: "Experiment summary is complete enough for selection.",
		nextInstruction: "Call planner_finish_step to open compact_experiment.",
	}),
	compact_experiment: stepRule("execution", "compact_experiment", {
		objective: "Compact the active experiment attempt.",
		requiredActions: [
			"Request Pi compact preserving attempt summary, checks, memory checkpoint, and comparison context.",
		],
		allowedNow: ["Compact flow only."],
		forbiddenNow: ["Do not edit code while compact is required/pending."],
		exitCondition:
			"Compaction finished and resume context points back to planner_status.",
		nextInstruction:
			"Complete compact to open select_experiment. That decision step chooses another experiment or selected merge.",
	}),
	select_experiment: stepRule("execution", "select_experiment", {
		objective:
			"Decide whether to run another distinct experiment or select the best completed attempt.",
		requiredActions: [
			"Compare completed attempt summaries against task stop criteria.",
			"If another distinct attempt is required, continue to execution/start_experiments.",
			"If the attempt budget or stop criteria are satisfied, choose the best attempt id through planner_git_select_experiment and continue to merge_best_experiment.",
		],
		allowedNow: [
			"Read experiment summaries, decide whether another attempt is required, and select an experiment id only when ready to merge.",
		],
		forbiddenNow: ["Do not specify merge source/target branches manually."],
		exitCondition:
			"Either another experiment is explicitly requested or state.activeBranches.selectedExperiment is set.",
		nextInstruction:
			"Complete with explicit next target: execution/start_experiments or execution/merge_best_experiment.",
	}),
	merge_best_experiment: stepRule("execution", "merge_best_experiment", {
		objective: "Merge the selected experiment into the task branch.",
		requiredActions: [
			"Use planner_git_merge_selected_experiment; extension determines source and target from state.json.",
		],
		allowedNow: [
			"Use selected experiment merge wrapper and update memory after merge commit.",
		],
		forbiddenNow: [
			"Do not use raw git merge.",
			"Do not keep unselected experiment branches after merge.",
		],
		exitCondition:
			"Selected experiment is merged into task branch, experiment branches are cleaned, memory is synced.",
		nextInstruction: "Call planner_finish_step to open refactor_task.",
	}),
	refactor_task: stepRule("execution", "refactor_task", {
		objective: "Refactor the task branch without changing behavior.",
		requiredActions: [
			"Improve clarity/style/integration while preserving test behavior, then commit and update memory if changes occur.",
		],
		allowedNow: [
			"Edit code for refactor, run checks, use planner git commit/refactor merge wrappers as policy allows.",
		],
		forbiddenNow: ["Do not add new task scope or behavior."],
		exitCondition:
			"Refactor is checked, committed if changed, and memory is synced.",
		nextInstruction: "Call planner_finish_step to open run_final_tests.",
	}),
	run_final_tests: stepRule("execution", "run_final_tests", {
		objective: "Verify the completed task branch.",
		requiredActions: [
			"Run final task checks and verify no accidental out-of-scope changes.",
		],
		allowedNow: [
			"Run checks, inspect planner diff, commit final fixes if needed, update memory.",
		],
		forbiddenNow: [
			"Do not merge task to plan while tests or memory are stale.",
		],
		exitCondition: "Final checks pass and memory checkpoint is synced.",
		nextInstruction: "Call planner_finish_step to open merge_task_to_plan.",
	}),
	merge_task_to_plan: stepRule("execution", "merge_task_to_plan", {
		objective: "Merge the completed task branch into the plan branch.",
		requiredActions: [
			"Use planner_git_merge_task_to_plan; extension determines task and plan branches from state.json.",
		],
		allowedNow: [
			"Use task-to-plan merge wrapper and update memory after merge commit.",
		],
		forbiddenNow: [
			"Do not use raw git merge.",
			"Do not start next task before compact_task.",
		],
		exitCondition:
			"Task branch is merged into plan branch, task branch is deleted, memory is synced.",
		nextInstruction: "Call planner_finish_step to open compact_task.",
	}),
	compact_task: stepRule("execution", "compact_task", {
		objective: "Compact the completed task boundary.",
		requiredActions: [
			"Request Pi compact preserving task result, checks, memory state, and next-task context.",
		],
		allowedNow: ["Compact flow only."],
		forbiddenNow: ["Do not edit task code while compact is required/pending."],
		exitCondition:
			"Compaction finished and resume context points back to planner_status.",
		nextInstruction: "Complete compact to open select_next_task.",
	}),
	select_next_task: stepRule("execution", "select_next_task", {
		objective: "Select the next task or finish execution.",
		requiredActions: [
			"Read plan/task status and choose execution/prepare_task or finalize/verify_plan_branch.",
		],
		allowedNow: ["Read plan artifacts and inspect memory."],
		forbiddenNow: [
			"Do not carry live context from the previous task except compacted artifacts and memory.",
		],
		exitCondition: "Next target is explicitly selected.",
		nextInstruction:
			"Complete with explicit next target: execution/prepare_task or finalize/verify_plan_branch.",
	}),

	verify_plan_branch: stepRule("finalize", "verify_plan_branch", {
		objective: "Verify the plan branch as a whole.",
		requiredActions: [
			"Run final project checks and inspect managed branch state.",
		],
		allowedNow: ["Run checks and inspect planner git state."],
		forbiddenNow: ["Do not cleanup worktree before user review."],
		exitCondition: "Plan branch is verified or risks are documented.",
		nextInstruction: "Call planner_finish_step to open write_final_summary.",
	}),
	write_final_summary: stepRule("finalize", "write_final_summary", {
		objective: "Write final result summary for user review.",
		requiredActions: [
			"Summarize changes, checks, risks, output branch plan, and changed files.",
		],
		allowedNow: ["Write final summary artifacts."],
		forbiddenNow: ["Do not export/cleanup until user acceptance flow."],
		exitCondition: "Final summary is ready for compact and user review.",
		nextInstruction: "Call planner_finish_step to open compact_finalize.",
	}),
	compact_finalize: stepRule("finalize", "compact_finalize", {
		objective: "Compact before user acceptance.",
		requiredActions: [
			"Request Pi compact preserving final summary, branch state, checks, and open risks.",
		],
		allowedNow: ["Compact flow only."],
		forbiddenNow: [
			"Do not modify code or cleanup while compact is required/pending.",
		],
		exitCondition:
			"Compaction finished and resume context points back to planner_status.",
		nextInstruction: "Complete compact to open enter_done.",
	}),
	enter_done: stepRule("finalize", "enter_done", {
		objective: "Enter the user acceptance stage.",
		requiredActions: ["Persist stage=done and step=present_result."],
		allowedNow: ["State transition only."],
		forbiddenNow: ["Do not cleanup plan files before done flow."],
		exitCondition: "State points to done/present_result.",
		nextInstruction:
			"Continue with done/present_result and call planner_status again.",
	}),

	present_result: stepRule("done", "present_result", {
		objective: "Present the completed plan result to the user.",
		requiredActions: [
			"Show summary, checks, risks, plan branch, worktree path, and output options.",
		],
		allowedNow: ["Read final artifacts and present user-facing summary."],
		forbiddenNow: [
			"Do not write production code.",
			"Do not cleanup before user accepts.",
		],
		exitCondition: "User has enough information to accept or request changes.",
		nextInstruction: "Call planner_finish_step to open await_user_acceptance.",
	}),
	await_user_acceptance: stepRule("done", "await_user_acceptance", {
		objective: "Wait for explicit user decision.",
		requiredActions: ["Ask user to accept result or request changes."],
		allowedNow: ["User communication only."],
		forbiddenNow: [
			"Do not choose accept/request-changes on behalf of the user.",
		],
		exitCondition: "User decision is explicit.",
		nextInstruction:
			"Complete with explicit next target: done/handle_change_request or done/prepare_output_branch.",
	}),
	handle_change_request: stepRule("done", "handle_change_request", {
		objective: "Record requested changes and return to planning.",
		requiredActions: [
			"Write feedback into planner artifacts and prepare to replan within the same plan branch/worktree.",
		],
		allowedNow: ["Write planner artifacts."],
		forbiddenNow: [
			"Do not delete worktree.",
			"Do not create a new root project state.",
		],
		exitCondition: "Change request is recorded and planning can resume.",
		nextInstruction: "Complete with next target planning/read_memory.",
	}),
	prepare_output_branch: stepRule("done", "prepare_output_branch", {
		objective: "Prepare output branch after user accepts.",
		requiredActions: [
			"Create or update output branch in the original repository through planner git wrappers.",
		],
		allowedNow: ["Use planner_git_export_plan_to_output as policy allows."],
		forbiddenNow: ["Do not delete worktree before export succeeds."],
		exitCondition: "Output branch target is prepared.",
		nextInstruction: "Call planner_finish_step to open merge_or_export_result.",
	}),
	merge_or_export_result: stepRule("done", "merge_or_export_result", {
		objective: "Export the plan branch result to the original repository.",
		requiredActions: [
			"Merge/export the plan branch into the output branch controlled by state.json.",
		],
		allowedNow: ["Use planner git export wrapper."],
		forbiddenNow: ["Do not ask the model to choose arbitrary merge branches."],
		exitCondition: "Output branch contains the accepted plan result.",
		nextInstruction: "Call planner_finish_step to open cleanup_worktree.",
	}),
	cleanup_worktree: stepRule("done", "cleanup_worktree", {
		objective: "Remove temporary planner worktree and managed child branches.",
		requiredActions: [
			"Remove plan worktree and cleanup managed task/experiment/refactor branches.",
		],
		allowedNow: [
			"Use planner worktree removal and managed branch cleanup wrappers.",
		],
		forbiddenNow: [
			"Do not delete the protected plan branch through child branch cleanup.",
		],
		exitCondition: "Worktree and managed child branches are cleaned.",
		nextInstruction: "Call planner_finish_step to open mark_done.",
	}),
	mark_done: stepRule("done", "mark_done", {
		objective: "Mark the plan finished in project storage.",
		requiredActions: [
			"Update project.json plan summary and clear activePlanId.",
		],
		allowedNow: ["Planner storage update only."],
		forbiddenNow: ["Do not leave activePlanId pointing to a cleaned plan."],
		exitCondition: "Project storage no longer has this plan active.",
		nextInstruction: "Call planner_finish_step to open cleanup_plan_files.",
	}),
	cleanup_plan_files: stepRule("done", "cleanup_plan_files", {
		objective: "Remove completed plan files from planner storage.",
		requiredActions: ["Delete plans/<plan-id>/ artifacts after mark_done."],
		allowedNow: ["Planner storage cleanup only."],
		forbiddenNow: ["Do not remove plan files before mark_done."],
		exitCondition: "Plan files are removed and no active plan references them.",
		nextInstruction:
			"Terminal step. No normal advance is needed after completion.",
	}),

	read_state: stepRule("recovery", "read_state", {
		objective: "Read persisted planner state for recovery.",
		requiredActions: ["Read project.json, active plan.json, and state.json."],
		allowedNow: ["Recovery inspection only."],
		forbiddenNow: ["Do not mutate git or project files."],
		exitCondition: "Persisted state is loaded or missing files are identified.",
		nextInstruction: "Call planner_finish_step to open inspect_git.",
	}),
	inspect_git: stepRule("recovery", "inspect_git", {
		objective: "Inspect actual git/worktree reality.",
		requiredActions: [
			"Inspect worktree path, branch, HEAD, dirty status, conflicts, and branch existence through planner internals.",
		],
		allowedNow: ["Recovery git inspection only."],
		forbiddenNow: ["Do not run destructive repair."],
		exitCondition: "Actual git reality is known.",
		nextInstruction:
			"Call planner_finish_step to open compare_expected_actual.",
	}),
	compare_expected_actual: stepRule("recovery", "compare_expected_actual", {
		objective: "Compare actual git reality with state.json.",
		requiredActions: [
			"Compare expected branch, worktree path, checkpoint commit, merge targets, dirty/conflict status.",
		],
		allowedNow: ["Recovery analysis only."],
		forbiddenNow: ["Do not repair before classification."],
		exitCondition: "All mismatches are listed.",
		nextInstruction: "Call planner_finish_step to open classify_recovery.",
	}),
	classify_recovery: stepRule("recovery", "classify_recovery", {
		objective: "Classify the recovery problem.",
		requiredActions: [
			"Classify missing worktree, wrong branch, dirty checkpoint, external commit, conflict, missing files, or history rewrite.",
		],
		allowedNow: ["Recovery analysis and user-facing explanation."],
		forbiddenNow: ["Do not choose destructive repair automatically."],
		exitCondition: "Recovery type and safe options are known.",
		nextInstruction:
			"Call planner_finish_step to open ask_user_if_destructive.",
	}),
	ask_user_if_destructive: stepRule("recovery", "ask_user_if_destructive", {
		objective: "Ask the user before destructive repair.",
		requiredActions: [
			"If reset/delete/force operation is needed, ask the user with exact consequences.",
		],
		allowedNow: ["User communication and non-destructive inspection."],
		forbiddenNow: [
			"Do not run destructive repair without explicit user approval.",
		],
		exitCondition:
			"User decision is recorded or repair is confirmed non-destructive.",
		nextInstruction: "Call planner_finish_step to open repair_or_resume.",
	}),
	repair_or_resume: stepRule("recovery", "repair_or_resume", {
		objective: "Repair safely or resume normal flow.",
		requiredActions: [
			"Apply safe recovery or resume into an explicit valid non-recovery stage/step.",
		],
		allowedNow: ["Recovery accept/resume tools and approved repair actions."],
		forbiddenNow: [
			"Do not resume into recovery or an invalid stage/step pair.",
		],
		exitCondition:
			"State is no longer broken and normal flow can continue, or user has stopped the plan.",
		nextInstruction:
			"Resume with explicit target, then call planner_status again.",
	}),
} as const satisfies Record<PlannerStep, PlannerStepRule>;

export async function buildPlannerStatusText(
	input: PlannerStatusTextInput,
): Promise<string> {
	const preflight = input.preflight;
	const lifecycle = decidePlannerLifecycleNext(preflight);
	const lines = [
		"# Planner Status",
		"",
		"Use this status as the source of truth before choosing the next planner action.",
		"",
		"## Runtime",
		`- action: ${preflight.decision.action}`,
	];
	if (preflight.decision.reason) {
		lines.push(`- reason: ${preflight.decision.reason}`);
	}

	if (preflight.context.status !== "ready") {
		lines.push(
			`- context: ${preflight.context.status}`,
			`- detail: ${preflight.context.reason}`,
			"",
			"## Lifecycle Decision",
			...formatLifecycleDecision(lifecycle),
			"",
			"## Next Required Action",
			formatLifecycleNextAction(lifecycle, null),
			"",
			"## Global Invariants",
			...formatNumbered(PLANNER_STATUS_INVARIANTS),
		);
		return lines.join("\n");
	}

	const state = preflight.context.state;
	const rule = getPlannerStepRule(state);
	const behavior = getPlannerStageStepBehavior(state);
	const allowedWrapperTools = filterPlannerWrapperToolsForLifecycle({
		preflight,
		lifecycle,
		behavior,
		tools: preflight.decision.allowedTools,
	});
	const instructionBundle = await readCurrentStageInstruction(
		input.fs,
		preflight,
	);

	lines.push(
		`- plan: ${preflight.context.activePlanId}`,
		`- plan title: ${preflight.context.plan.title}`,
		`- stage: ${state.stage}`,
		`- step: ${state.step}`,
		`- stepStatus: ${state.stepStatus}`,
		`- nextStep: ${state.nextStep ?? "(none)"}`,
		`- activeTaskId: ${state.activeTaskId ?? "(none)"}`,
		`- activeExperimentId: ${state.activeExperimentId ?? "(none)"}`,
		`- requiresMemoryUpdate: ${String(state.requiresMemoryUpdate)}`,
		`- memoryUpdateReason: ${state.memoryUpdateReason ?? "(none)"}`,
		`- requiresCompact: ${String(state.requiresCompact)}`,
		`- requiresUserDecision: ${String(state.requiresUserDecision)}`,
		`- broken: ${String(state.broken)}`,
		`- blockedReason: ${state.blockedReason ?? "(none)"}`,
		"",
		"## Git And Worktree",
		`- worktree: ${state.worktreePath ?? "(none)"}`,
		`- worktreeExists: ${String(preflight.worktreeExists)}`,
		`- expectedCurrentBranch: ${state.currentBranch ?? "(none)"}`,
		`- actualBranch: ${preflight.gitReality?.branch ?? "(unavailable)"}`,
		`- actualHEAD: ${preflight.gitReality?.headCommit ?? "(unavailable)"}`,
		`- dirty: ${preflight.gitReality ? String(preflight.gitReality.isDirty) : "(unavailable)"}`,
		`- conflicts: ${preflight.gitReality ? String(preflight.gitReality.hasConflicts) : "(unavailable)"}`,
		`- lastCheckpointCommit: ${state.lastCheckpointCommit ?? "(none)"}`,
		`- activeBranches: ${JSON.stringify(state.activeBranches)}`,
		`- mergeTargets: ${JSON.stringify(state.mergeTargets)}`,
		"",
		"## Memory",
		...formatMemorySection(preflight),
		"",
		"## Lifecycle Decision",
		...formatLifecycleDecision(lifecycle),
		"",
		"## Next Required Action",
		formatLifecycleNextAction(lifecycle, rule),
		"",
		"## Current Step Rule",
		`- stage: ${rule.stage}`,
		`- step: ${rule.step}`,
		`- objective: ${rule.objective}`,
		"- required actions:",
		...formatBullets(rule.requiredActions),
		"- allowed now:",
		...formatBullets(rule.allowedNow),
		"- forbidden now:",
		...formatBullets(rule.forbiddenNow),
		`- exit condition: ${rule.exitCondition}`,
		`- next instruction: ${rule.nextInstruction}`,
		"",
		"## Stage Behavior",
		`- projectAccess: ${behavior.projectAccess}`,
		`- actions: ${behavior.actions.join(", ") || "(none)"}`,
		`- requiredArtifacts: ${behavior.requiredArtifacts.join(", ") || "(none)"}`,
		`- updatedArtifacts: ${behavior.updatedArtifacts.join(", ") || "(none)"}`,
		`- requiredGates: ${behavior.requiredGates.join(", ") || "(none)"}`,
		`- expectedTools: ${behavior.expectedTools.join(", ") || "(none)"}`,
		`- commitPolicy: ${behavior.commitPolicy}`,
		`- memoryPolicy: ${behavior.memoryPolicy}`,
		`- compactPolicy: ${behavior.compactPolicy}`,
		"",
		"## Allowed Planner Wrappers",
		allowedWrapperTools.join(", ") || "(none)",
		"",
		"## Allowed State Transitions",
		getAllowedPlannerStateTransitionTypes(preflight).join(", ") || "(none)",
		"",
		"## Instruction Files To Read",
		...formatInstructionRoutes(preflight),
		"",
		"## Current Stage Instruction",
		...formatInstructionBundle(instructionBundle),
		"",
		"## Planner Artifacts",
		...formatPlannerArtifactLinks(preflight),
		"",
		"## Memory-First Rule",
		"Inspect planner memory before broad source reads. Use project_patterns, file index, symbol index, relation index, and dirty state first. Read source files only when memory is missing, stale, insufficient, or must be verified for the current step.",
	);

	return lines.join("\n");
}

export function getPlannerStepRule(input: {
	stage: PlannerStage;
	step: PlannerStep;
}): PlannerStepRule {
	const rule = PLANNER_STEP_RULES[input.step];
	if (rule.stage !== input.stage) {
		throw new Error(
			`Planner step rule mismatch: ${input.stage}/${input.step} belongs to ${rule.stage}.`,
		);
	}
	return rule;
}

function stepRule(
	stage: PlannerStage,
	step: PlannerStep,
	rule: Omit<PlannerStepRule, "stage" | "step">,
): PlannerStepRule {
	return { stage, step, ...rule };
}

async function readCurrentStageInstruction(
	fs: PlannerFs,
	preflight: PlannerPreflightResult,
): Promise<InstructionContent[]> {
	if (preflight.context.status !== "ready" || !preflight.instructions) {
		return [];
	}
	const paths = createInstructionPaths(preflight.context.projectPaths);
	const contents: InstructionContent[] = [];
	const key = preflight.instructions.keys[0];
	if (key) {
		contents.push(await safeGetInstructionContent(fs, paths, key));
	}
	return contents;
}

async function safeGetInstructionContent(
	fs: PlannerFs,
	paths: ReturnType<typeof createInstructionPaths>,
	key: InstructionKey,
): Promise<InstructionContent> {
	try {
		return await getInstructionContent(fs, paths, key);
	} catch (error) {
		return {
			key,
			defaultPath: join(paths.defaultsDir, `${key}.md`),
			appendPath: null,
			appendSource: null,
			content: `Instruction content is unavailable for ${key}: ${errorMessage(error)}`,
		};
	}
}

function formatLifecycleDecision(decision: PlannerLifecycleDecision): string[] {
	return [
		`- action: ${decision.action}`,
		`- requiredTool: ${decision.requiredTool ?? "(none)"}`,
		`- requiredTransition: ${decision.requiredTransition ?? "(none)"}`,
		`- reason: ${decision.reason}`,
	];
}

function formatLifecycleNextAction(
	decision: PlannerLifecycleDecision,
	rule: PlannerStepRule | null,
): string {
	switch (decision.action) {
		case "finish_step":
			return `Call planner_finish_step only after exit condition is true: ${rule?.exitCondition ?? "(missing rule)"}`;
		case "start_step":
			return `Call planner_start_step, then follow ${decision.stage}/${decision.step}: ${rule?.objective ?? "current step"}.`;
		case "write_memory":
		case "inspect_memory":
		case "sync_memory_checkpoint":
			return `Update planner memory first: inspect/apply freshness, rewrite affected file/symbol/relation/effects entries, verify memory, then sync checkpoint when the worktree is clean. Exact next action: ${decision.modelMessage}`;
		default:
			return decision.modelMessage;
	}
}

function formatMemorySection(preflight: PlannerPreflightResult): string[] {
	const lines: string[] = [];
	if (!preflight.memoryPaths) {
		lines.push(
			"- memory paths: (unavailable before worktree/memory initialization)",
		);
		return lines;
	}
	lines.push(
		`- project patterns: ${preflight.memoryPaths.projectPatternsMd}`,
		`- files index: ${preflight.memoryPaths.filesIndexJsonl}`,
		`- symbols index: ${preflight.memoryPaths.symbolsIndexJsonl}`,
		`- relations index: ${preflight.memoryPaths.relationsIndexJsonl}`,
		`- dirty state: ${preflight.memoryPaths.dirtyJson}`,
		`- checkpoint: ${preflight.memoryPaths.latestCheckpointJson}`,
		`- checkpointValid: ${preflight.memoryCheckpoint ? String(preflight.memoryCheckpoint.valid) : "(unavailable)"}`,
	);
	if (preflight.memoryGate) {
		lines.push(
			`- memoryClean: ${String(preflight.memoryGate.clean)}`,
			`- filesToReindex: ${preflight.memoryGate.freshness.filesToReindex.join(", ") || "(none)"}`,
			`- affectedSymbols: ${preflight.memoryGate.freshness.affectedSymbolIds.join(", ") || "(none)"}`,
			`- affectedRelations: ${preflight.memoryGate.freshness.affectedRelationIds.join(", ") || "(none)"}`,
			`- requiredChecks: ${preflight.memoryGate.requiredChecks.join(", ") || "(none)"}`,
		);
	} else {
		lines.push("- memoryFreshness: not inspected for this step/gate");
	}
	return lines;
}

function formatInstructionRoutes(preflight: PlannerPreflightResult): string[] {
	if (!preflight.instructions) {
		return ["- (none)"];
	}
	const lines: string[] = [];
	for (const entry of preflight.instructions.entries) {
		lines.push(
			`- ${entry.key}`,
			`  default: ${entry.defaultPath}`,
			`  project append: ${entry.projectAppendPath}`,
			`  global append: ${entry.globalAppendPath}`,
		);
	}
	return lines;
}

function formatInstructionBundle(
	contents: readonly InstructionContent[],
): string[] {
	if (contents.length === 0) {
		return ["(none)"];
	}
	const lines: string[] = [];
	for (const content of contents) {
		lines.push(
			`### ${content.key}`,
			`default: ${content.defaultPath}`,
			`append: ${content.appendPath ?? "(none)"}`,
			`appendSource: ${content.appendSource ?? "(none)"}`,
			"",
			"```markdown",
			content.content.trimEnd(),
			"```",
			"",
		);
	}
	return lines;
}

function formatPlannerArtifactLinks(
	preflight: PlannerPreflightResult,
): string[] {
	if (preflight.context.status !== "ready" || !preflight.planPaths) {
		return ["- (unavailable)"];
	}
	const { planPaths } = preflight;
	const state = preflight.context.state;
	const lines = [
		`- plan.md: ${planPaths.planMd}`,
		`- request.md: ${planPaths.requestMd}`,
		`- goal.md: ${planPaths.goalMd}`,
		`- discovery.md: ${planPaths.discoveryMd}`,
		`- questions.md: ${planPaths.questionsMd}`,
		`- decisions.md: ${planPaths.decisionsMd}`,
		`- tasks dir: ${planPaths.tasksDir}`,
	];
	if (state.activeTaskId) {
		const taskDir = join(planPaths.tasksDir, state.activeTaskId);
		lines.push(
			`- active task dir: ${taskDir}`,
			`- active task.md: ${join(taskDir, "task.md")}`,
			`- active tdd.md: ${join(taskDir, "tdd.md")}`,
			`- active tests.md: ${join(taskDir, "tests.md")}`,
			`- active implementation.md: ${join(taskDir, "implementation.md")}`,
			`- active verify.md: ${join(taskDir, "verify.md")}`,
		);
		if (state.activeExperimentId) {
			const experimentDir = join(
				taskDir,
				"experiments",
				state.activeExperimentId,
			);
			lines.push(
				`- active experiment dir: ${experimentDir}`,
				`- active experiment.json: ${join(experimentDir, "experiment.json")}`,
				`- active experiment summary.md: ${join(experimentDir, "summary.md")}`,
			);
		}
	}
	return lines;
}

function formatBullets(values: readonly string[]): string[] {
	return values.map((value) => `  - ${value}`);
}

function formatNumbered(values: readonly string[]): string[] {
	return values.map((value, index) => `${index + 1}. ${value}`);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
