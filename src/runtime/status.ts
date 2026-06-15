import { join } from "node:path";
import { getInstructionContent } from "../instructions/manager";
import { createInstructionPaths } from "../instructions/paths";
import type {
	InstructionContent,
	InstructionKey,
} from "../instructions/schema";
import { loadEffectivePlannerSettings } from "../settings/manager";
import type { PlannerFs } from "../storage/fs";
import type { PlannerStage, PlannerStep } from "../storage/schema";
import { formatPlannerContractsStatus } from "./contracts";
import { formatDebugStatusLines } from "./debug-tools";
import { extractVerificationProtocolCommands } from "./doubt-review";
import {
	decidePlannerLifecycleNext,
	type PlannerLifecycleDecision,
} from "./lifecycle";
import { filterPlannerWrapperToolsForLifecycle } from "./orchestrator-gate";
import type { PlannerPreflightResult } from "./preflight";
import {
	listActivePlannerSkillSummaries,
	type PlannerSkillSummary,
} from "./skill-library";
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
	"The model never edits project.json, plan.json, state.json, or worktree index files directly.",
	"Call planner_status before choosing the next planner action after every tool result, compact, recovery, or user decision.",
	"Normal flow is blocked by recovery, user decision, or compact gate.",
	"Discovery familiarizes the model with the project before planning. Read only the files needed for the approved goal and summarize findings in discovery.md.",
	"Stage and step order is strict. Recovery is the only stage that may resume into a valid non-recovery position.",
	"A completed step cannot run again. Advance it first.",
	"Every wrapper tool must be allowed by runtime preflight and wrapper policy for the current exact stage/step.",
	"Every workflow transition must be allowed by the state machine for the current exact stepStatus.",
	"Actual git branch must match state.currentBranch when currentBranch is set.",
	"Git conflicts always block normal flow and require recovery.",
	"Dirty worktree is allowed inside an active work step, but must be resolved before merge boundaries.",
	"Merge targets come from state.json only. The model may choose taskId, but not source/target merge branches.",
	"Production behavior changes are allowed only in implementation/refactor steps that explicitly permit them.",
	"Before finishing any step, doubt the result: identify the artifact, command, diff, or user answer that proves the exit condition is true.",
	"Doubt must lead to a concrete probe or recorded risk. Do not create extra tests only to feel safer; add tests only when they falsify a specific requirement risk.",
	"If repeated attempts fail, treat stuck state as under-instrumentation. Use planner_report_stuck with stuckLoad and continue from evidence after compact.",
	"Create planner skills only from verified reusable lessons. A planner skill is future memory for later sessions, not a substitute for current stage evidence.",
	"Repository AGENTS.md files are planner local contracts. Prefer reading the relevant contract chain before source reads; update contracts when completed work changes a durable domain rule.",
	"Task branch cannot merge into plan before final task checks pass.",
	"Next task cannot start before merge_task_to_plan and compact_task.",
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
			"Create plan.json, state.json, and plan markdown artifacts.",
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
			"Do not create task branches here.",
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
			"Do not read project source until discovery/scan_project_structure is active.",
		],
		exitCondition: "State points to intake/draft_goal.",
		nextInstruction:
			"Continue with intake/draft_goal and call planner_status again.",
	}),
	draft_goal: stepRule("intake", "draft_goal", {
		objective: "Rewrite the raw user request as a precise reviewable goal.",
		requiredActions: [
			"Read request.md for normal /planner-create plans. For creationMethod=improve, use discovery.md findings as the source goal instead.",
			"Draft goal.md content in your own words with outcome, assumptions, non-goals, and constraints.",
			"Propose a short user-facing title in metadata.titleLanguage unless the user explicitly requested another language.",
			"Propose a very short planner-list description in the metadata.descriptionLanguage reported by planner_status.",
			"Call planner_goal_submit with the full goal markdown, proposed title, and proposed description. Do not edit goal.md directly; the wrapper writes it.",
		],
		allowedNow: ["Use planner_goal_submit only after the draft is complete."],
		forbiddenNow: [
			"Do not inspect project source during normal intake. For creationMethod=improve, source inspection already happened during discovery; do not perform new broad source reads here.",
			"Do not infer implementation details from the request.",
		],
		exitCondition: "goal.md exists and the planner is waiting for user review.",
		nextInstruction:
			"Ask the user to review goal.md and approve or request revision.",
	}),
	await_goal_approval: stepRule("intake", "await_goal_approval", {
		objective: "Wait for explicit user approval of the normalized goal.",
		requiredActions: [
			"Show the exact goal.md path, proposed title, and draft summary.",
			"Ask whether the goal and title are approved or need revision.",
			"Call planner_goal_decide only after the user explicitly answers.",
		],
		allowedNow: ["Use planner_goal_decide with approve or revise."],
		forbiddenNow: [
			"Do not begin discovery before approval.",
			"Do not infer approval from silence.",
		],
		exitCondition: "User explicitly approves the goal or requests a revision.",
		nextInstruction:
			"On approve: normal plans enter discovery/scan_project_structure; creationMethod=improve plans continue to planning/read_context (discovery already ran). Revise returns to intake/draft_goal.",
	}),

	scan_project_structure: stepRule("discovery", "scan_project_structure", {
		objective:
			"Become familiar with the project without indexing the repository.",
		requiredActions: [
			"Call planner_contract_scan in batches to discover AGENTS.md canonical contracts and read-only context imports before broad source reads.",
			"When contract/context files exist, call planner_contract_route and planner_contract_read for the relevant chain first. Treat AGENTS.md as writable routing memory; treat CLAUDE.md, GEMINI.md, .cursorrules, and similar files as read-only imported guidance.",
			"Inspect the project tree with read-only shell commands only after the contract map is started.",
			"Read only the source files needed to understand architecture, commands, risks, and the requested change after contract guidance is considered.",
			"Write concise findings to discovery.md, including a ## Verification Protocol section with exact test/lint/build/format commands, working directory, flags, or explicit unknowns.",
			"If no AGENTS.md exists, create initial root/domain AGENTS.md only for meaningful architectural zones once discovery evidence proves the domains. Do not create one in every folder.",
			"If planner_contract_upsert changes AGENTS.md files, commit them through planner_git_commit before finishing discovery/scan_project_structure.",
			"If commands are missing or the project is empty, record unknowns in ## Verification Protocol for discovery/write_questions.",
		],
		allowedNow: [
			"Use planner_contract_scan/route/read, read-only shell commands, focused source reads, and discovery.md.",
		],
		forbiddenNow: [
			"Do not implement code.",
			"Do not read every project file by default.",
			"Do not create AGENTS.md in every directory; contracts belong only to durable architectural domains.",
		],
		exitCondition:
			"discovery.md contains a concise useful project overview and ## Verification Protocol.",
		nextInstruction:
			"Call planner_finish_step to open and start write_questions.",
	}),
	write_questions: stepRule("discovery", "write_questions", {
		objective: "Resolve evidence-based user questions before planning.",
		requiredActions: [
			"Call planner_questions_submit with focused questions and assumptions for questions.md.",
			"If the project is empty or lacks test/lint/build conventions, ask the user which test framework, lint command, formatter, and flags to use.",
			"If existing conventions are present but exact commands/flags are unclear, ask only for the missing command details.",
			"If open questions exist, show the returned questions to the user verbatim and wait for answers.",
			"Call planner_questions_resolve with explicit user answers before finishing this step.",
			"If there are no unresolved questions, submit an explicit no-questions artifact with hasOpenQuestions=false.",
		],
		allowedNow: [
			"Write planner question artifacts and ask the user questions.",
		],
		forbiddenNow: ["Do not ask broad questions before collecting evidence."],
		exitCondition:
			"questions.md is non-empty and every answer required before planning is recorded in decisions.md.",
		nextInstruction:
			"Call planner_finish_step to open and start compact_discovery.",
	}),
	compact_discovery: stepRule("discovery", "compact_discovery", {
		objective: "Create a compact boundary after discovery.",
		requiredActions: [
			"Request Pi compact and preserve discovery summary and open questions.",
		],
		allowedNow: ["Compact flow only."],
		forbiddenNow: ["Do not edit code while compact is required/pending."],
		exitCondition:
			"Compaction finished and resume context points back to planner_status.",
		nextInstruction: "Complete compact to open enter_planning.",
	}),
	enter_planning: stepRule("discovery", "enter_planning", {
		objective: "Enter planning after verified discovery.",
		requiredActions: [
			"Persist stage=planning and step=read_context for normal plans.",
			"For creationMethod=improve, persist stage=intake and step=draft_goal so goal.md can be written from discovery findings.",
		],
		allowedNow: ["State transition only."],
		forbiddenNow: ["Do not draft tasks until planning/read_context is active."],
		exitCondition:
			"State points to planning/read_context, or to intake/draft_goal for creationMethod=improve.",
		nextInstruction: "Continue with the next state reported by planner_status.",
	}),

	read_context: stepRule("planning", "read_context", {
		objective: "Load the project context needed for planning.",
		requiredActions: [
			"Read discovery.md, questions.md, and decisions.md.",
			"If decisions.md contains a Change Request, read the Post-Implementation Snapshot in discovery.md and preserve Completed Work as current context.",
			"Use planner_contract_route/read for applicable AGENTS.md chains before reading additional source files.",
			"Read specific source files only when the recorded discovery and local contracts are insufficient.",
		],
		allowedNow: [
			"Use planner artifacts, planner_contract_route/read, and focused source reads.",
		],
		forbiddenNow: ["Do not reread the whole project by default."],
		exitCondition:
			"Relevant context for planning is loaded from planner artifacts.",
		nextInstruction: "Call planner_finish_step to open draft_plan.",
	}),
	draft_plan: stepRule("planning", "draft_plan", {
		objective: "Draft an executable plan.",
		requiredActions: [
			"Write plan.md with scope, constraints, risks, checks, and intended sequence.",
			"If this is a change-request planning pass, append or revise only the relevant sections. Do not overwrite the previous completed plan wholesale and do not repeat work listed under Completed Work.",
			"For follow-up work, add a labeled revision section explaining what remains and why the previous result was rejected.",
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
			"Keep tests inside each behavioral task as its TDD cycle. Never create standalone tasks for writing tests, mocks, or verification.",
			"If this is a change-request planning pass, keep completed task IDs as history and create new revision task IDs only for remaining work.",
		],
		allowedNow: [
			"Write planner artifacts and the planned task list in plan.md. Task records are created in planning/write_task_files.",
		],
		forbiddenNow: ["Do not start TDD before task files exist."],
		exitCondition: "Each task is atomic enough for one TDD loop.",
		nextInstruction: "Call planner_finish_step to open write_task_files.",
	}),
	write_task_files: stepRule("planning", "write_task_files", {
		objective: "Create task artifacts.",
		requiredActions: [
			"Call planner_task_upsert for each behavioral task with scope and acceptance criteria.",
			"When known, include AGENTS.md contract chain paths in the task scope/dependency context so execution can reload them after compact.",
			"In a change-request planning pass, call planner_task_upsert only for new or still-pending revision tasks. Do not reuse completed task IDs.",
			"Let the wrapper create task.json, task.md, and empty TDD lifecycle artifacts. Do not write task JSON manually.",
		],
		allowedNow: ["Use planner_task_upsert for task planner artifacts only."],
		forbiddenNow: ["Do not write tests or production code yet."],
		exitCondition: "Every planned task has its required files.",
		nextInstruction: "Call planner_finish_step to open verify_plan.",
	}),
	verify_plan: stepRule("planning", "verify_plan", {
		objective: "Verify the plan before execution.",
		requiredActions: [
			"Check that task order, scope, acceptance criteria, and risks are explicit.",
			"Reject standalone test-only tasks. Each behavioral task must own its tests-first TDD work.",
		],
		allowedNow: ["Read/write planner artifacts."],
		forbiddenNow: ["Do not start execution while plan gaps remain."],
		exitCondition: "Plan is executable without hidden broad tasks.",
		nextInstruction: "Call planner_finish_step to open compact_planning.",
	}),
	compact_planning: stepRule("planning", "compact_planning", {
		objective: "Create a compact boundary after planning.",
		requiredActions: [
			"Request Pi compact and preserve plan, task order, decisions, and artifact paths.",
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
		allowedNow: ["Read task artifacts and use planner_git_create_task_branch."],
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
			"Read task.md and relevant source files, then write tdd.md with failing test strategy and checks.",
		],
		allowedNow: [
			"Write TDD planner artifacts and inspect discovery context/source for test design.",
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
			"Append the test intent and changed test files to tdd.md. If project files changed, commit through planner_git_commit before continuing.",
		],
		allowedNow: ["Edit test files and necessary test integration files."],
		forbiddenNow: ["Do not implement production behavior."],
		exitCondition:
			"tdd.md records the test coverage, project files are committed, and tests are expected to fail or catch missing behavior.",
		nextInstruction: "Call planner_finish_step to open run_failing_tests.",
	}),
	run_failing_tests: stepRule("execution", "run_failing_tests", {
		objective: "Prove the tests guard the missing behavior.",
		requiredActions: [
			"Run focused checks from task/tdd/project instructions and record failure evidence.",
			"Add ## Pre-Implementation Proof Contract to tdd.md with failingSignal, productionPath, successSignal, and outOfScopeFiles.",
			"If the first red signal is only module-not-found/import/file missing, treat it as bootstrap only; ensure the test contains real behavior assertions before implementation is accepted.",
		],
		allowedNow: ["Run checks and update test summary artifacts."],
		forbiddenNow: [
			"Do not implement production code before the failing/contract signal is understood.",
		],
		exitCondition:
			"The failing/mock/contract signal and pre-implementation proof contract are confirmed and documented.",
		nextInstruction: "Call planner_finish_step to open implement_task.",
	}),
	implement_task: stepRule("execution", "implement_task", {
		objective: "Implement the active task on the task branch.",
		requiredActions: [
			"Implement only the behavior required by task.md and tdd.md.",
			"After green focused checks, add ## Post-Implementation Counterexample Review to tdd.md.",
			"Reject placeholder/stub/TODO-only/hardcoded implementations unless the task explicitly asked for a placeholder and tests prove that contract.",
			"Run focused checks, update tdd.md with the implementation/check result, then commit through planner_git_commit when project files changed.",
			"If a repeated failure, stale-context hazard, state-machine/tooling mistake, or non-obvious verified lesson was resolved, call planner_skill_create before leaving this step.",
		],
		allowedNow: [
			"Edit production/test files in scope, run checks, use planner_git_commit.",
		],
		forbiddenNow: [
			"Do not add speculative behavior outside task scope.",
			"Do not merge the task into the plan here.",
		],
		exitCondition:
			"Task implementation is committed, counterexample review is recorded, and the worktree is clean.",
		nextInstruction: "Call planner_finish_step to open contract_check.",
	}),
	contract_check: stepRule("execution", "contract_check", {
		objective:
			"Check whether the green task changed durable AGENTS.md local contracts before refactor. Also check for hidden component dependencies the implementation revealed.",
		requiredActions: [
			"Run planner_git_inspect or review the diff to identify the exact changed files and their directories.",
			"For each changed component: who calls or imports it? What does it read from? What does it write to? If you discovered a non-obvious dependency or invariant during implementation, it belongs in AGENTS.md Domain Details — not only in tdd.md. tdd.md is erased between sessions. AGENTS.md is not.",
			"Check the level: is the nearest AGENTS.md in your active chain at the same directory level as the changed files, or is it a parent? If it is a parent and the changed area has its own distinct domain, prefer create_new at the specific directory level.",
			"Call planner_contract_check with outcomeSummary, domainImpact, changedFiles, evidence, and action no_update/upsert_existing/create_new.",
			"If project files changed and no writable AGENTS.md exists yet, no_update is invalid. Use create_new and write the initial meaningful root/domain AGENTS.md contract.",
			"If planner_contract_check reports an update is needed, call planner_contract_upsert for the nearest meaningful AGENTS.md domain and commit that change if the worktree becomes dirty.",
			"Use AGENTS.md as repository-owned routing memory. Add durable domain rules, parent backlinks, child index entries, read-first hints, stable contracts, and domain details that help future agents avoid reading irrelevant code.",
			"Do not add overly specific task trivia to AGENTS.md. Record one-off task details in tdd.md.",
		],
		allowedNow: [
			"Inspect the task diff, read/update AGENTS.md through planner_contract tools, and commit contract documentation changes.",
		],
		forbiddenNow: [
			"Do not refactor before contract_check is complete.",
			"Do not write managed contract blocks by hand; use planner_contract_upsert.",
			"Do not create AGENTS.md in every folder — only at meaningful architectural boundaries.",
		],
		exitCondition:
			"planner_contract_check is recorded for the active task, pending upserts are resolved, and the worktree is clean.",
		nextInstruction: "Call planner_finish_step to open refactor_task.",
	}),
	refactor_task: stepRule("execution", "refactor_task", {
		objective:
			"Challenge the task implementation and simplify it without changing behavior.",
		requiredActions: [
			"Read the selected implementation and inspect the planner-controlled diff.",
			"Question unnecessary abstraction, duplication, speculative flexibility, premature generalization, and code that exists for imagined future work rather than the current task.",
			"Call planner_refactor_review with semantic review fields and every category review: duplication, naming, control_flow, abstraction_level, hidden_coupling, error_handling, test_clarity, debug_leftovers, scope_creep.",
			"If refactor changes a durable domain contract or discovers stale AGENTS.md guidance, call planner_contract_check and planner_contract_upsert.",
			"A passing test, linter, formatter, or build is not a refactor review.",
			"If the review proves a reusable refactor/debug lesson, repeated mistake, or category-specific audit method, call planner_skill_create with sourceKind=refactor before leaving this step.",
			"Commit if project files changed.",
		],
		allowedNow: [
			"Edit code for refactor, run checks, use planner git commit/refactor merge wrappers as policy allows.",
		],
		forbiddenNow: [
			"Do not add new task scope or behavior.",
			"Do not treat a successful linter or test run as sufficient refactor review.",
		],
		exitCondition:
			"refactor.md passes the structured review gate and the refactor is committed if changed.",
		nextInstruction: "Call planner_finish_step to open run_final_tests.",
	}),
	run_final_tests: stepRule("execution", "run_final_tests", {
		objective: "Verify the completed task branch.",
		requiredActions: [
			"Run final task checks and verify no accidental out-of-scope changes.",
			"If a check fails and needs a code edit (this step cannot edit project files): call planner_finish_step with target {stage: 'execution', step: 'implement_task'} to fix it, then re-verify. Do NOT use planner_fail_step for this — fail/retry only re-runs the same step.",
		],
		allowedNow: [
			"Run checks and inspect the planner diff (no project edits here).",
		],
		forbiddenNow: [
			"Do not merge task to plan while tests fail or project files remain uncommitted.",
		],
		exitCondition: "Final checks pass and the worktree is clean.",
		nextInstruction:
			"On success: planner_finish_step with target execution/capture_skill. On a fix that needs edits: planner_finish_step with target execution/implement_task.",
	}),
	capture_skill: stepRule("execution", "capture_skill", {
		objective:
			"Decide whether this task produced a reusable planner lesson and create or update a skill.",
		requiredActions: [
			"Review skills already loaded in this session.",
			"If an existing skill is outdated or wrong: call planner_skill_update.",
			"If a new reusable lesson exists with no matching skill: call planner_skill_create.",
			"If the skill body describes a runnable probe, run it, then call planner_git_inspect. If the worktree is dirty, call planner_git_discard_changes immediately.",
			"If no skill action is taken: write an explicit no-skill note in decisions.md with the reason.",
		],
		allowedNow: [
			"planner_skill_create, planner_skill_update, planner_git_inspect, planner_git_discard_changes.",
		],
		forbiddenNow: [
			"Do not commit at this step.",
			"Do not merge before capture_skill is complete.",
		],
		exitCondition:
			"A skill was created/updated, or a no-skill decision is recorded in decisions.md.",
		nextInstruction: "Call planner_finish_step to open merge_task_to_plan.",
	}),
	merge_task_to_plan: stepRule("execution", "merge_task_to_plan", {
		objective: "Merge the completed task branch into the plan branch.",
		requiredActions: [
			"Use planner_git_merge_task_to_plan; extension determines task and plan branches from state.json.",
			"Before finishing this step, add ## Task Merge Scope Audit to tdd.md with acceptance coverage, changed-file scope, tests run, cleanup, commit message fit, and branch drift check.",
		],
		allowedNow: ["Use the task-to-plan merge wrapper."],
		forbiddenNow: [
			"Do not use raw git merge.",
			"Do not start next task before compact_task.",
		],
		exitCondition:
			"Task branch is merged into plan branch, task branch is deleted, and tdd.md contains the merge scope audit.",
		nextInstruction: "Call planner_finish_step to open compact_task.",
	}),
	compact_task: stepRule("execution", "compact_task", {
		objective:
			"Close the completed task boundary and verify no hidden connections were missed.",
		requiredActions: [
			"Briefly check — did the task change any component called, imported, or depended upon by code outside the task scope? If yes and it was not captured in tdd.md or AGENTS.md, add a note to tdd.md.",
			"If task compaction is ENABLED: call planner_request_compact, then planner_complete_compact after the boundary finishes.",
			"If task compaction is DISABLED (the default): do NOT call planner_request_compact — call planner_finish_step with target {stage: 'execution', step: 'select_next_task'} to skip the Pi compact and keep the checkpoint.",
		],
		allowedNow: [
			"Brief connection check, then the compact-or-finish flow only.",
		],
		forbiddenNow: ["Do not edit task code while compact is required/pending."],
		exitCondition:
			"Compaction finished, or the disabled boundary was skipped via finish_step. Either way state points to select_next_task.",
		nextInstruction:
			"Follow planner_status: enabled → request_compact then complete_compact; disabled → planner_finish_step with target execution/select_next_task.",
	}),
	select_next_task: stepRule("execution", "select_next_task", {
		objective: "Select the next task or finish execution.",
		requiredActions: [
			"Read plan/task status and choose execution/prepare_task or finalize/verify_plan_branch.",
		],
		allowedNow: ["Read plan artifacts and focused source files when needed."],
		forbiddenNow: [
			"Do not carry live context from the previous task except compacted artifacts.",
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
		nextInstruction: "Call planner_finish_step to open compact_before_doubt.",
	}),
	compact_before_doubt: stepRule("finalize", "compact_before_doubt", {
		objective:
			"Compact before doubt review so the model audits from persisted artifacts instead of live confidence.",
		requiredActions: [
			"Request planner-controlled compact before doubt_review.",
			"After compaction, call planner_complete_compact and planner_status before any audit work.",
		],
		allowedNow: ["Use planner_request_compact and planner_complete_compact."],
		forbiddenNow: [
			"Do not begin doubt_review from pre-compact chat memory.",
			"Do not inspect or patch production code in this compact step.",
		],
		exitCondition:
			"Planner-controlled compact has completed and the next step is doubt_review.",
		nextInstruction:
			"After compact completes, call planner_finish_step to open doubt_review.",
	}),
	doubt_review: stepRule("finalize", "doubt_review", {
		objective: "Doubt the completed result before user acceptance.",
		requiredActions: [
			"Reread goal.md, plan.md, task artifacts, verify.md, and the final diff from the planner worktree.",
			"Reread discovery.md ## Verification Protocol and treat every listed command/check as mandatory evidence for planner_doubt_review.",
			"Reconstruct the approved promise from artifacts first; do not trust chat memory or confidence from previous steps.",
			"Start with a Possible Errors list written in metadata.doubtReviewLanguage. Each item must name a concrete requirement, changed code path, missing test, or integration risk.",
			"Assign every item to the narrowest riskCategory enum before proving or dismissing it.",
			"Populate verificationEvidence with every command/check from discovery.md ## Verification Protocol. A missing command means the result is not verified.",
			"If any required command/check failed, was not run, or is unknown, create a proven_bug or needs_probe finding that names that command. Do not continue to final_summary.",
			"Treat each possible error like TDD for a suspected problem: prove it with a focused failing test/command, exact code-path proof, or exact spec contradiction; otherwise disprove it or mark needs_probe.",
			"Use planner_doubt_review to write verify.md. Do not hand-write weak doubt notes.",
			"Audit AGENTS.md local contracts: check stale guidance, missing parent backlinks, wrong child routing, or missing durable domain details. Use planner_contract_check/upsert when needed.",
			"Run every needs_probe before leaving this step; unresolved probes cannot become bugs and cannot be ignored.",
			"Placeholder, stub, TODO-only, hardcoded, superficial, missing-test, or unresolved-work findings cannot be closed as not_a_bug/disproven. Mark them proven_bug or needs_probe.",
			"If proven_bug findings exist, record them in decisions.md and complete with explicit target planning/read_context for revision tasks.",
			"Never simplify or patch ad hoc from finalize. Any proven bug must go through planning/read_context, draft_plan, split_tasks, task files, execution, and verification again.",
			"If a proven, disproven, or probed finding teaches a reusable workflow lesson or exposes a repeated planner/model failure pattern, call planner_skill_create with sourceKind=doubt_review before leaving this step.",
			"If no proven bugs and no needs_probe findings remain, complete with target finalize/write_final_summary.",
		],
		allowedNow: [
			"Run focused checks, inspect planner git state from the planner worktree, call planner_doubt_review, and update AGENTS.md contracts when evidence shows they changed.",
		],
		forbiddenNow: [
			"Do not ask the user for acceptance yet.",
			"Do not patch production code directly in finalize.",
			"Do not cleanup or export the result.",
		],
		exitCondition:
			"Doubt Review is recorded and either no actionable concern remains or the state returns to planning/read_context for revision work.",
		nextInstruction:
			"Call planner_finish_step to open write_final_summary, or call planner_finish_step with target planning/read_context if revision tasks are needed.",
	}),
	write_final_summary: stepRule("finalize", "write_final_summary", {
		objective: "Write final result summary for user review.",
		requiredActions: [
			"Write final_summary.md in metadata.humanLanguage unless the user explicitly requested another language.",
			"Summarize changes, checks, risks, output branch plan, and changed files.",
			"If the whole plan produced a reusable verified lesson not already captured, call planner_skill_create with sourceKind=final_summary.",
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
			"After presenting the result, call planner_finish_step immediately so state enters done/await_user_acceptance.",
		],
		allowedNow: ["Read final artifacts and present user-facing summary."],
		forbiddenNow: [
			"Do not write production code.",
			"Do not cleanup before user accepts.",
		],
		exitCondition: "User has enough information to accept or request changes.",
		nextInstruction:
			"After presenting the result, call planner_finish_step immediately to open await_user_acceptance. The user may also run /planner-finish directly as an explicit acceptance command.",
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
			"If the user accepts, ask the user to run /planner-finish. If the user writes feedback, says what is wrong, or requests changes, complete with explicit next target done/handle_change_request.",
	}),
	handle_change_request: stepRule("done", "handle_change_request", {
		objective: "Record requested changes and return to planning.",
		requiredActions: [
			"Append the user's requested corrections to decisions.md under a Change Request section.",
			"Append a short Change Request Replan note near the start of plan.md with Completed Work and Remaining Work subsections. Preserve the previous completed plan and do not rewrite it wholesale.",
			"Append a Post-Implementation Snapshot section to discovery.md with Completed Work, Remaining Work, current relevant files/branches, known gaps, and why another pass is needed.",
			"Prepare to replan within the same plan branch/worktree.",
		],
		allowedNow: ["Write planner artifacts."],
		forbiddenNow: [
			"Do not delete worktree.",
			"Do not create a new root project state.",
		],
		exitCondition:
			"Change request is recorded in decisions.md, plan.md, and discovery.md, and planning can resume.",
		nextInstruction: "Complete with next target planning/read_context.",
	}),
	prepare_output_branch: stepRule("done", "prepare_output_branch", {
		objective: "Internal /planner-finish phase: prepare output branch.",
		requiredActions: [
			"Do not enter this phase manually. /planner-finish performs it atomically after explicit user approval.",
		],
		allowedNow: ["Internal /planner-finish execution only."],
		forbiddenNow: ["Do not delete worktree before export succeeds."],
		exitCondition: "Output branch target is prepared.",
		nextInstruction:
			"Run /planner-finish from done/await_user_acceptance instead.",
	}),
	merge_or_export_result: stepRule("done", "merge_or_export_result", {
		objective: "Internal /planner-finish phase: export the accepted result.",
		requiredActions: [
			"Do not enter this phase manually. /planner-finish exports the plan branch.",
		],
		allowedNow: ["Internal /planner-finish execution only."],
		forbiddenNow: ["Do not ask the model to choose arbitrary merge branches."],
		exitCondition: "Output branch contains the accepted plan result.",
		nextInstruction:
			"Run /planner-finish from done/await_user_acceptance instead.",
	}),
	cleanup_worktree: stepRule("done", "cleanup_worktree", {
		objective:
			"Internal /planner-finish phase: remove temporary planner state.",
		requiredActions: [
			"Do not enter this phase manually. /planner-finish removes the worktree and temporary branches after export succeeds.",
		],
		allowedNow: ["Internal /planner-finish execution only."],
		forbiddenNow: [
			"Do not delete the protected plan branch through child branch cleanup.",
		],
		exitCondition: "Worktree and managed child branches are cleaned.",
		nextInstruction:
			"Run /planner-finish from done/await_user_acceptance instead.",
	}),
	mark_done: stepRule("done", "mark_done", {
		objective: "Internal /planner-finish phase: mark the plan finished.",
		requiredActions: [
			"Do not enter this phase manually. /planner-finish clears the active plan record after cleanup.",
		],
		allowedNow: ["Internal /planner-finish execution only."],
		forbiddenNow: ["Do not leave activePlanId pointing to a cleaned plan."],
		exitCondition: "Project storage no longer has this plan active.",
		nextInstruction:
			"Run /planner-finish from done/await_user_acceptance instead.",
	}),
	cleanup_plan_files: stepRule("done", "cleanup_plan_files", {
		objective: "Internal /planner-finish phase: remove completed plan files.",
		requiredActions: [
			"Do not enter this phase manually. /planner-finish deletes plans/<plan-id>/ artifacts after accepted export.",
		],
		allowedNow: ["Internal /planner-finish execution only."],
		forbiddenNow: ["Do not remove plan files before mark_done."],
		exitCondition: "Plan files are removed and no active plan references them.",
		nextInstruction:
			"Run /planner-finish from done/await_user_acceptance instead.",
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
			"Compare expected branch, worktree path, merge targets, dirty/conflict status.",
		],
		allowedNow: ["Recovery analysis only."],
		forbiddenNow: ["Do not repair before classification."],
		exitCondition: "All mismatches are listed.",
		nextInstruction: "Call planner_finish_step to open classify_recovery.",
	}),
	classify_recovery: stepRule("recovery", "classify_recovery", {
		objective: "Classify the recovery problem.",
		requiredActions: [
			"Classify missing worktree, wrong branch, dirty worktree, external commit, conflict, missing files, or history rewrite.",
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
	const settings = await loadEffectivePlannerSettings({
		fs: input.fs,
		projectPaths: preflight.context.projectPaths,
	});
	const instructionBundle = await readCurrentStageInstruction(
		input.fs,
		preflight,
	);
	const skillSummaries = shouldShowPlannerSkillInventory(behavior)
		? await listActivePlannerSkillSummaries({
				fs: input.fs,
				projectPaths: preflight.context.projectPaths,
			})
		: [];
	lines.push(
		`- plan: ${preflight.context.activePlanId}`,
		`- plan title: ${preflight.context.plan.title}`,
		`- creationMethod: ${state.creationMethod ?? "create"}`,
		`- compatibilityMode: ${state.compatibilityMode ?? "additive"}`,
		`- stage: ${state.stage}`,
		`- step: ${state.step}`,
		`- stepStatus: ${state.stepStatus}`,
		`- nextStep: ${state.nextStep ?? "(none)"}`,
		`- activeTaskId: ${state.activeTaskId ?? "(none)"}`,
		`- questionsSubmitted: ${String(state.questionsSubmitted)}`,
		`- questionsResolved: ${String(state.questionsResolved)}`,
		`- compactBoundaries: ${JSON.stringify(state.compactBoundaries)}`,
		`- lastPlannerToolCallAt: ${state.lastPlannerToolCallAt ?? "(none)"}`,
		`- lastIdleWakeAt: ${state.lastIdleWakeAt ?? "(none)"}`,
		`- idleWakeInFlight: ${String(state.idleWakeInFlight)}`,
		`- lastStuckAttemptId: ${state.lastStuckAttemptId ?? "(none)"}`,
		`- lastStuckReportPath: ${state.lastStuckReportPath ?? "(none)"}`,
		`- debugSessionId: ${state.debugSessionId ?? "(none)"}`,
		`- debugArtifactsDir: ${state.debugArtifactsDir ?? "(none)"}`,
		`- debugCleanupRequired: ${String(state.debugCleanupRequired)}`,
		`- requiresCompact: ${String(state.requiresCompact)}`,
		`- requiresUserDecision: ${String(state.requiresUserDecision)}`,
		`- broken: ${String(state.broken)}`,
		`- blockedReason: ${state.blockedReason ?? "(none)"}`,
		"",
		"## Effective Settings",
		`- metadata.humanLanguage: ${settings.effective.metadata.humanLanguage}`,
		`- metadata.titleLanguage: ${settings.effective.metadata.titleLanguage}`,
		`- metadata.descriptionLanguage: ${settings.effective.metadata.descriptionLanguage}`,
		`- metadata.commitLanguage: ${settings.effective.metadata.commitLanguage}`,
		`- metadata.doubtReviewLanguage: ${settings.effective.metadata.doubtReviewLanguage}`,
		`- metadata.skillLanguage: ${settings.effective.metadata.skillLanguage}`,
		`- idle.enabled: ${String(settings.effective.idle.enabled)}`,
		`- idle.timeoutMinutes: ${settings.effective.idle.timeoutMinutes}`,
		`- skills.enabled: ${String(settings.effective.skills.enabled)}`,
		`- skills.maxActive: ${settings.effective.skills.maxActive}`,
		`- contracts.enabled: ${String(settings.effective.contracts.enabled)}`,
		`- contracts.finalPolicy: ${settings.effective.contracts.finalPolicy}`,
		`- contracts.scanBatchSize: ${settings.effective.contracts.scanBatchSize}`,
		`- contracts.readChunkChars: ${settings.effective.contracts.readChunkChars}`,
		"",
		"## Git And Worktree",
		`- worktree: ${state.worktreePath ?? "(none)"}`,
		`- worktreeExists: ${String(preflight.worktreeExists)}`,
		`- expectedCurrentBranch: ${state.currentBranch ?? "(none)"}`,
		`- actualBranch: ${preflight.gitReality?.branch ?? "(unavailable)"}`,
		`- actualHEAD: ${preflight.gitReality?.headCommit ?? "(unavailable)"}`,
		`- dirty: ${preflight.gitReality ? String(preflight.gitReality.isDirty) : "(unavailable)"}`,
		`- conflicts: ${preflight.gitReality ? String(preflight.gitReality.hasConflicts) : "(unavailable)"}`,
		`- activeBranches: ${JSON.stringify(state.activeBranches)}`,
		`- mergeTargets: ${JSON.stringify(state.mergeTargets)}`,
		"",
		"## Debug Mode",
		...formatDebugStatusLines(state),
		"",
		"## Planner Local Contracts",
		...formatPlannerContractsStatus({
			state,
			settings: settings.effective.contracts,
		}),
		"",
		...(state.stage === "finalize" && preflight.planPaths
			? await formatDoubtReviewProtocolSection(
					input.fs,
					preflight.planPaths.discoveryMd,
					state.step === "doubt_review",
				)
			: []),
		...(shouldShowPlannerSkillInventory(behavior)
			? [
					"## Planner Skill Memory",
					...formatPlannerSkillInventory(skillSummaries),
					"",
				]
			: []),
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
		"## Discovery Context Rule",
		"Use discovery.md as the summary. Read source files only when the current action needs details that are not recorded there.",
	);

	return lines.join("\n");
}

export function getPlannerStepRule(input: {
	stage: PlannerStage;
	step: PlannerStep;
}): PlannerStepRule {
	const rule = PLANNER_STEP_RULES[input.step];
	if (!rule) {
		throw new Error(`Unknown planner step rule: ${input.step}.`);
	}
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
			if (decision.requiredTool === "planner_finish_step") {
				return `Call planner_finish_step only after exit condition is true: ${rule?.exitCondition ?? "(missing rule)"}`;
			}
			return decision.modelMessage;
		case "start_step":
			return `Call planner_start_step, then follow ${decision.stage}/${decision.step}: ${rule?.objective ?? "current step"}.`;
		default:
			return decision.modelMessage;
	}
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

async function formatDoubtReviewProtocolSection(
	fs: PlannerFs,
	discoveryMdPath: string,
	isDoubtReviewStep: boolean,
): Promise<string[]> {
	const content = await fs.readText(discoveryMdPath).catch(() => "");
	const commands = extractVerificationProtocolCommands(content);
	if (commands.length === 0) {
		return [
			"## Verification Protocol",
			"WARNING: discovery.md has no ## Verification Protocol section or no parseable commands.",
			isDoubtReviewStep
				? "Add a ## Verification Protocol with exact test/build/check commands to discovery.md before calling planner_doubt_review."
				: "Add a ## Verification Protocol with exact test/build/check commands to discovery.md before reaching doubt_review.",
			"",
		];
	}
	return [
		"## Verification Protocol",
		isDoubtReviewStep
			? "These commands are required in verificationEvidence for planner_doubt_review:"
			: "These commands will be required in verificationEvidence during doubt_review:",
		...commands.map((c) => `- ${c}`),
		"",
	];
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
		`- verify.md: ${planPaths.verifyMd}`,
		`- contracts manifest: ${planPaths.contractsManifestJson}`,
		`- contracts baseline dir: ${planPaths.contractsBaselineDir}`,
		`- tasks dir: ${planPaths.tasksDir}`,
	];
	if (state.activeTaskId) {
		const taskDir = join(planPaths.tasksDir, state.activeTaskId);
		lines.push(
			`- active task dir: ${taskDir}`,
			`- active task.md: ${join(taskDir, "task.md")}`,
			`- active tdd.md: ${join(taskDir, "tdd.md")}`,
			`- active refactor.md: ${join(taskDir, "refactor.md")}`,
		);
	}
	return lines;
}

function shouldShowPlannerSkillInventory(
	behavior: ReturnType<typeof getPlannerStageStepBehavior>,
): boolean {
	return behavior.expectedTools.includes("planner_skill_create");
}

function formatPlannerSkillInventory(
	skills: readonly PlannerSkillSummary[],
): string[] {
	if (skills.length === 0) {
		return [
			"- active skills: 0",
			"- guidance: No planner-generated skills are currently exposed. If this step proves a reusable lesson, call planner_skill_create.",
		];
	}
	const lines = [
		`- active skills: ${skills.length}`,
		"- guidance: Pi receives these SKILL.md paths through resources_discover. The model may see skill names/descriptions first; the full body lives at skillPath and is loaded by Pi's skill system when activated.",
	];
	for (const skill of skills) {
		lines.push(
			`- ${skill.name}`,
			`  sourceKind: ${skill.sourceKind}`,
			`  tags: ${skill.tags.join(", ") || "(none)"}`,
			`  description: ${truncateStatusLine(skill.description, 240)}`,
			`  skillPath: ${skill.skillPath}`,
		);
	}
	return lines;
}

function truncateStatusLine(value: string, maxLength: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length <= maxLength
		? normalized
		: `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
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
