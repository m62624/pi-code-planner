import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
	isToolCallEventType,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_LANGUAGE, MS_PER_MINUTE } from "./constants";
import { errorMessage } from "./errors";
import { NodeGitRunner } from "./git/node-runner";
import { PLANNER_STATUS_TOOL_NAME } from "./guard/git-watcher";
import {
	checkPlannerBuiltinToolAllowed,
	type PlannerBuiltinGuardState,
	type PlannerBuiltinToolCall,
} from "./guard/project-mutation";
import {
	activatePlannerToolVisibility,
	isContractGateActive,
	isPlanActive,
	markPlannerToolVisibilityActive,
	persistPlannerToolVisibilityActiveToSession,
	registerPlannerToolVisibility,
	resetPlanActiveCache,
	setContractGateActive,
	setRecoveryReportUnlocked,
	updateToolVisibility,
} from "./index.tool-visibility";
import { syncBundledInstructionFiles } from "./instructions/defaults";
import { createInstructionPaths } from "./instructions/paths";
import { isPathInsideOrEqual } from "./path-utils";
import { buildPlannerAboutReport } from "./runtime/about";
import {
	buildAcceptedPlanCompletionPrompt,
	finalizeAcceptedPlan,
	inspectAcceptedPlan,
} from "./runtime/accepted-plan";
import { readActivePlanContext } from "./runtime/active-plan";
import {
	executePlannerArtifactReadTool,
	executePlannerArtifactTool,
	PLANNER_ARTIFACT_READ_TOOL_NAME,
	PLANNER_ARTIFACT_TOOL_NAMES,
	PLANNER_READABLE_ARTIFACTS,
	type PlannerArtifactToolName,
} from "./runtime/artifact-tools";
import {
	buildPlannerCompactInstructionBundle,
	buildPlannerPostCompactMessage,
	clearPlannerControlledCompact,
	collectAutoCompactInstructionSections,
	consumePlannerControlledCompact,
	createPlannerCompactRuntimeState,
	enqueuePlannerPostCompactMessage,
	formatPlannerCompactFailure,
	markPlannerControlledCompactStarted,
	type PlannerCompactRuntimeState,
} from "./runtime/compact";
import {
	applyPlannerContractFinishPolicy,
	executePlannerContractTool,
	hasPendingContractFinishDecision,
	isContractChainTraversalComplete,
	PLANNER_CONTRACT_TOOL_NAMES,
	type PlannerContractToolName,
} from "./runtime/contracts";
import {
	openPlannerWorkspace,
	registerPlannerDashboard,
} from "./runtime/dashboard";
import {
	DEBUG_INSTRUMENTATION_TYPES,
	DEBUG_PROBE_METHODS,
	DEBUG_RESULT_NEXT_ACTIONS,
	executePlannerDebugTool,
	PLANNER_DEBUG_TOOL_NAMES,
	type PlannerDebugToolName,
} from "./runtime/debug-tools";
import {
	evaluatePlannerStuck,
	type PlannerToolStatus,
	recordPlannerToolEvent,
} from "./runtime/diagnostics";
import {
	DOUBT_FINDING_STATUSES,
	DOUBT_NEXT_ACTIONS,
	DOUBT_PROOF_LEVELS,
	DOUBT_REVIEW_TOOL_NAMES,
	DOUBT_RISK_CATEGORIES,
	executePlannerDoubtTool,
	type PlannerDoubtReviewToolName,
} from "./runtime/doubt-tools";
import {
	executePlannerExecTool,
	PLANNER_EXEC_TOOL_NAME,
} from "./runtime/exec-tools";
import {
	executePlannerGitTool,
	PLANNER_GIT_TOOL_NAMES,
	type PlannerGitToolName,
} from "./runtime/git-tools";
import {
	executePlannerGoalTool,
	PLANNER_GOAL_TOOL_NAMES,
	type PlannerGoalToolName,
} from "./runtime/goal-tools";
import {
	evaluatePlannerIdleWake,
	initializePlannerToolActivity,
	markPlannerIdleWakeQueued,
	markPlannerToolActivity,
} from "./runtime/idle-watchdog";
import { runPlannerOrchestrator } from "./runtime/orchestrator";
import {
	parsePlannerCreateCommandArgs,
	parsePlannerImproveCommandArgs,
	resolvePlannerPlanId,
} from "./runtime/plan-naming";
import {
	executePlannerPlanTool,
	PLANNER_PLAN_TOOL_NAMES,
	type PlannerPlanToolName,
} from "./runtime/plan-tools";
import { runPlannerPreflight } from "./runtime/preflight";
import {
	executePlannerQuestionTool,
	PLANNER_QUESTION_TOOL_NAMES,
	type PlannerQuestionToolName,
} from "./runtime/question-tools";
import {
	executePlannerRecoveryReportTool,
	executePlannerRecoveryTool,
	PLANNER_RECOVERY_REPORT_TOOL_NAME,
	PLANNER_RECOVERY_TOOL_NAMES,
	type PlannerRecoveryToolName,
} from "./runtime/recovery-tools";
import {
	executePlannerRefactorTool,
	PLANNER_REFACTOR_TOOL_NAMES,
	type PlannerRefactorToolName,
	REFACTOR_REVIEW_CATEGORIES,
	REFACTOR_REVIEW_CATEGORY_STATUSES,
} from "./runtime/refactor-tools";
import {
	deletePlannerSkill,
	executePlannerSkillTool,
	executePlannerSkillUpdateTool,
	listPlannerSkillInventory,
	listPlannerSkillResourcePaths,
	PLANNER_SKILL_SOURCE_KINDS,
	type PlannerSkillSummary,
} from "./runtime/skill-library";
import {
	buildPlannerStuckCompactInstructions,
	executePlannerStuckTool,
	PLANNER_STUCK_TOOL_NAMES,
	PLANNER_STUCK_TYPES,
	type PlannerStuckToolName,
} from "./runtime/stuck-tools";
import {
	executePlannerTaskTool,
	PLANNER_TASK_TOOL_NAMES,
	type PlannerTaskToolName,
} from "./runtime/task-tools";
import {
	createPlannerTimerRuntimeState,
	registerPlannerRuntimeTimer,
} from "./runtime/timer";
import {
	confirmPlannerDelete,
	inputPlannerRenameTitle,
	selectPlannerPlanId,
	selectPlannerPlanIdFromList,
} from "./runtime/user-command-ui";
import {
	executePlannerUserCommand,
	readPlannerPlanList,
} from "./runtime/user-commands";
import {
	executePlannerWorkflowTool,
	PLANNER_WORKFLOW_TOOL_NAMES,
	type PlannerWorkflowToolName,
} from "./runtime/workflow-tools";
import {
	buildPlannerHandoffPrompt,
	buildPlannerImproveHandoffPrompt,
	buildPlannerResumePrompt,
	createPlannerHandoffSession,
	removePlannerHandoffBootstrapFile,
	selectPlannerResumeSessionFile,
} from "./session/handoff";
import { loadEffectivePlannerSettings } from "./settings/manager";
import { createNodeFs } from "./storage/fs";
import type { ProjectStoragePaths } from "./storage/paths";
import { createPlanStoragePaths } from "./storage/paths";
import { resolveProjectStoragePaths } from "./storage/project-resolver";
import {
	ensureProjectRecord,
	readProjectRecordIfExists,
	setActivePlan,
} from "./storage/project-store";
import { PLANNER_STAGE_VALUES, PLANNER_STEP_VALUES } from "./storage/schema";
import { readPlanStateIfExists, updatePlanState } from "./storage/state-store";
import {
	bindWorktreeRootSession,
	readWorktreeProjectIndexIfExists,
} from "./storage/worktree-index";

export * from "./public-api";

// NodeGitRunner is stateless (every method delegates to module-level git
// command helpers), so a single shared instance serves all tool handlers
// instead of allocating one per call.
const gitRunner = new NodeGitRunner();

const EMPTY_TOOL_PARAMETERS = {
	type: "object",
	properties: {},
	additionalProperties: false,
} as const;

const CREATE_PLAN_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		request: {
			type: "string",
			description:
				"The user's raw requested outcome. Do not replace it with a short title.",
		},
		title: { type: "string" },
		description: {
			type: "string",
			description:
				"Optional short user-facing summary shown in planner lists. Keep it concise.",
		},
		baseBranch: { type: "string" },
	},
	required: ["request"],
	additionalProperties: false,
} as const;

const FOLLOW_UP_MESSAGE_OPTIONS = {
	streamingBehavior: "followUp",
} as unknown as { deliverAs: "followUp" };

const IDLE_WATCHDOG_POLL_MS = 30_000;

const GOAL_SUBMIT_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		content: {
			type: "string",
			description:
				"Full goal.md markdown in your own words: outcome, assumptions, non-goals, and constraints. Evidence-based clarification questions are collected after discovery.",
		},
		title: {
			type: "string",
			description:
				"Short proposed plan title. Use the metadata.titleLanguage reported by planner_status unless the user requested another language. The user reviews this title together with goal.md.",
		},
		description: {
			type: "string",
			description:
				"Very short planner-list description generated from the normalized goal. Use the metadata.descriptionLanguage reported by planner_status. One concise sentence, at most 90 characters.",
		},
	},
	required: ["content", "title", "description"],
	additionalProperties: false,
} as const;

const GOAL_DECIDE_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		decision: {
			type: "string",
			enum: ["approve", "revise"],
			description:
				"Use approve only after the user explicitly approves goal.md. Use revise after explicit revision feedback.",
		},
		feedback: {
			type: "string",
			description: "User revision feedback when decision is revise.",
		},
	},
	required: ["decision"],
	additionalProperties: false,
} as const;

const QUESTIONS_SUBMIT_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		content: {
			type: "string",
			description:
				"Full questions.md markdown. Include evidence-based questions and explicit assumptions, or state explicitly that no unresolved questions remain.",
		},
		hasOpenQuestions: {
			type: "boolean",
			description:
				"True when the user must answer questions before discovery can continue.",
		},
	},
	required: ["content", "hasOpenQuestions"],
	additionalProperties: false,
} as const;

const QUESTIONS_RESOLVE_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		answers: {
			type: "string",
			description:
				"The user's answers in durable markdown form. Call only after the user explicitly answers.",
		},
	},
	required: ["answers"],
	additionalProperties: false,
} as const;

const TASK_UPSERT_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		taskId: {
			type: "string",
			description:
				"Stable lowercase ASCII id for one behavioral task, for example parse-config.",
		},
		title: { type: "string" },
		objective: { type: "string" },
		scope: { type: "array", items: { type: "string" } },
		acceptanceCriteria: { type: "array", items: { type: "string" } },
		contractChain: {
			type: "array",
			items: { type: "string" },
			description:
				"Optional AGENTS.md canonical or read-only context chain paths this task should reload before execution.",
		},
		relevantContracts: {
			type: "array",
			items: { type: "string" },
			description: "Optional durable contract facts this task depends on.",
		},
		forbiddenAreas: {
			type: "array",
			items: { type: "string" },
			description:
				"Optional paths/domains the task must not touch without replanning.",
		},
		domainDetails: {
			type: "array",
			items: { type: "string" },
			description:
				"Optional domain-specific details from AGENTS.md useful after compact.",
		},
	},
	required: ["taskId", "title", "objective", "scope", "acceptanceCriteria"],
	additionalProperties: false,
} as const;

const CONTRACT_SCAN_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		batchSize: {
			type: "number",
			description:
				"Optional positive batch size for directory scanning. Defaults to contracts.scanBatchSize.",
		},
	},
	additionalProperties: false,
} as const;

const CONTRACT_ROUTE_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		targetPaths: {
			type: "array",
			items: { type: "string" },
			description:
				"Files or directories the model expects to read/edit. The tool maps them to relevant AGENTS.md canonical and read-only context chains.",
		},
		declaredScope: {
			type: "array",
			items: { type: "string" },
			description:
				"Fallback task scope/domain hints when exact targetPaths are not known yet.",
		},
		reason: {
			type: "string",
			description: "Why this contract route is needed now.",
		},
	},
	additionalProperties: false,
} as const;

const CONTRACT_READ_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		path: {
			type: "string",
			description:
				"AGENTS.md or supported read-only context path to read. Omit to continue pendingRead from planner_status.",
		},
		cursor: {
			type: "number",
			description:
				"Optional read cursor. Omit unless continuing an explicit cursor.",
		},
		reason: {
			type: "string",
			description: "Why this contract content is needed now.",
		},
	},
	additionalProperties: false,
} as const;

const CONTRACT_CHECK_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		taskId: {
			type: "string",
			description:
				"Active task id. Omit only if planner_status reports no active task.",
		},
		action: {
			type: "string",
			enum: ["no_update", "upsert_existing", "create_new"],
			description:
				"Whether AGENTS.md needs no change, an existing contract update, or a new meaningful domain contract.",
		},
		outcomeSummary: {
			type: "string",
			description:
				"What changed and why this does or does not alter durable local contracts.",
		},
		domainImpact: {
			type: "string",
			description:
				"Which architecture/domain rule was affected. Say none with evidence for no_update.",
		},
		changedFiles: { type: "array", items: { type: "string" } },
		evidence: {
			type: "array",
			items: { type: "string" },
			description:
				"Concrete proof from diff/tests/artifacts that supports the action.",
		},
		recommendedPath: {
			type: "string",
			description:
				"Nearest meaningful AGENTS.md path when action is upsert_existing or create_new.",
		},
	},
	required: [
		"action",
		"outcomeSummary",
		"domainImpact",
		"changedFiles",
		"evidence",
	],
	additionalProperties: false,
} as const;

const CONTRACT_UPSERT_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		path: {
			type: "string",
			description:
				"AGENTS.md/AGENTS.MD path to create/update. Omit only when planner_status reports pendingUpsert.",
		},
		purpose: { type: "string" },
		parent: {
			type: "string",
			description:
				"Relative parent AGENTS.md backlink. Use `(root)` or omit for the worktree root.",
		},
		childIndex: {
			type: "array",
			items: {
				type: "object",
				properties: {
					path: { type: "string" },
					description: { type: "string" },
				},
				required: ["path", "description"],
				additionalProperties: false,
			},
		},
		stableContracts: { type: "array", items: { type: "string" } },
		readFirst: { type: "array", items: { type: "string" } },
		doNotTouchUnless: { type: "array", items: { type: "string" } },
		domainDetails: { type: "array", items: { type: "string" } },
	},
	required: ["purpose", "stableContracts"],
	additionalProperties: false,
} as const;

const CONTRACT_DECIDE_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		decision: {
			type: "string",
			enum: ["keep", "remove"],
			description:
				"Keep AGENTS.md contract changes in the accepted result or remove/restore them before finish.",
		},
	},
	required: ["decision"],
	additionalProperties: false,
} as const;

const STUCK_REPORT_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		stuckType: {
			type: "string",
			enum: PLANNER_STUCK_TYPES,
			description:
				"Exact stuck classification. Pick the closest enum value; do not invent aliases.",
		},
		observedError: {
			type: "string",
			description:
				"Exact command error, test failure, panic, or blocker if known.",
		},
		evidence: {
			type: "array",
			items: { type: "string" },
			description:
				"Concrete evidence already checked: commands, files, logs, failing assertions, or inspected diff facts.",
		},
		hypotheses: {
			type: "array",
			items: { type: "string" },
			description:
				"Possible root causes still plausible. Include at least one concrete hypothesis.",
		},
		discardedHypotheses: {
			type: "array",
			items: { type: "string" },
			description:
				"Root causes already ruled out by evidence. Use an empty array only when nothing has been ruled out yet.",
		},
		stuckLoad: {
			type: "object",
			description:
				"Engineering stuck-load score. Rate each field 0-3 before compact; total is calculated by the planner.",
			properties: {
				failedAttempts: {
					type: "number",
					description:
						"0 none, 1 one failed attempt, 2 two failed attempts, 3 three or more repeated failed attempts.",
				},
				evidenceQuality: {
					type: "number",
					description:
						"0 exact error/repro known, 1 partial error known, 2 symptom known without repro, 3 vague failure only.",
				},
				hypothesisChurn: {
					type: "number",
					description:
						"0 one clear hypothesis, 1 two hypotheses, 2 many unranked hypotheses, 3 repeating guesses.",
				},
				contextDrift: {
					type: "number",
					description:
						"0 goal/task/diff recently reread, 1 one artifact stale, 2 multiple artifacts stale, 3 relying mostly on memory.",
				},
				verificationGap: {
					type: "number",
					description:
						"0 focused verification exists, 1 broad check exists, 2 unclear check, 3 no verification path.",
				},
			},
			required: [
				"failedAttempts",
				"evidenceQuality",
				"hypothesisChurn",
				"contextDrift",
				"verificationGap",
			],
			additionalProperties: false,
		},
		nextProbe: {
			type: "string",
			description:
				"One focused next diagnostic action after compact: command, file inspection, minimal repro, or log to collect.",
		},
		needsUserInput: {
			type: "boolean",
			description:
				"True only when progress requires a concrete user decision or missing requirement.",
		},
	},
	required: [
		"stuckType",
		"evidence",
		"hypotheses",
		"discardedHypotheses",
		"stuckLoad",
		"nextProbe",
		"needsUserInput",
	],
	additionalProperties: false,
} as const;

const REFACTOR_REVIEW_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		changedSurface: {
			type: "string",
			description:
				"Concrete summary of changed files, touched behavior, and public API surface from the active task diff.",
		},
		complexity: {
			type: "string",
			description:
				"Concrete complexity review: unnecessary abstraction, over-generalization, and simpler alternatives considered.",
		},
		duplication: {
			type: "string",
			description:
				"Concrete duplication review: new duplication, existing duplication touched, and extraction/keep decision.",
		},
		namingAndBoundaries: {
			type: "string",
			description:
				"Concrete naming, module/API boundary, and scope-leak review.",
		},
		edgeCases: {
			type: "string",
			description:
				"Concrete edge-case review: validation, error handling, state consistency, and regression risk.",
		},
		categoryReviews: {
			type: "array",
			description:
				"Mandatory category-by-category refactor doubt review. Include every category exactly once with concrete evidence and action.",
			items: {
				type: "object",
				properties: {
					category: {
						type: "string",
						enum: REFACTOR_REVIEW_CATEGORIES,
					},
					status: {
						type: "string",
						enum: REFACTOR_REVIEW_CATEGORY_STATUSES,
						description:
							"ok when reviewed and acceptable, issue when refactor action is needed, not_applicable when the category truly does not apply.",
					},
					evidence: {
						type: "string",
						description:
							"Concrete observation from the active task diff, tests, or project conventions.",
					},
					action: {
						type: "string",
						description:
							"Action taken, action planned, or concrete reason no action should be taken.",
					},
				},
				required: ["category", "status", "evidence", "action"],
				additionalProperties: false,
			},
		},
		decision: {
			type: "string",
			enum: ["changed", "kept"],
			description:
				"Use changed when behavior-preserving refactor edits were applied. Use kept only when the actual diff was reviewed and no safe simplification should be made.",
		},
		changesApplied: {
			type: "string",
			description:
				"Required when decision is changed. Describe behavior-preserving refactor edits.",
		},
		whyKept: {
			type: "string",
			description:
				"Required when decision is kept. Explain why changing the actual diff would add complexity or make code worse.",
		},
	},
	required: [
		"changedSurface",
		"complexity",
		"duplication",
		"namingAndBoundaries",
		"edgeCases",
		"categoryReviews",
		"decision",
	],
	additionalProperties: false,
} as const;

const PLAN_SUBMIT_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		content: {
			type: "string",
			description:
				"Full plan.md markdown: scope, constraints, risks, checks, and the intended task sequence. The wrapper writes the file atomically.",
		},
	},
	required: ["content"],
	additionalProperties: false,
} as const;

const DISCOVERY_SUBMIT_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		body: {
			type: "string",
			description:
				"Full discovery.md markdown WITHOUT the Verification Protocol section: system boundaries, findings, fundamental rules, and (for change requests) Post-Implementation Snapshot / Completed Work / Remaining Work.",
		},
		verificationProtocol: {
			type: "array",
			description:
				"Exact test/lint/build/format commands (with working directory and flags) that doubt_review must later evidence. Rendered as the ## Verification Protocol section.",
			items: { type: "string" },
		},
	},
	required: ["body", "verificationProtocol"],
	additionalProperties: false,
} as const;

const SUMMARY_SUBMIT_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		content: {
			type: "string",
			description:
				"Full final_summary.md markdown: what changed, verification evidence, and any follow-ups.",
		},
	},
	required: ["content"],
	additionalProperties: false,
} as const;

const ARTIFACT_READ_TOOL_PARAMETERS = {
	type: "object",
	description:
		"Read a planner-managed markdown artifact from the extension storage dir (outside the worktree). Use this instead of the built-in read tool for planner artifacts.",
	properties: {
		artifact: {
			type: "string",
			enum: [...PLANNER_READABLE_ARTIFACTS],
			description:
				"Which planner artifact to read: request, goal, discovery, plan, questions, decisions, verify, final_summary (plan-level), or task, tdd, refactor (task-level; uses the active task unless taskId is given).",
		},
		taskId: {
			type: "string",
			description:
				"Optional task id for task-level artifacts (task/tdd/refactor). Defaults to the active task.",
		},
	},
	required: ["artifact"],
	additionalProperties: false,
} as const;

const TDD_SECTION_FIELD = (description: string) =>
	({ type: "string", description }) as const;

const TDD_SUBMIT_TOOL_PARAMETERS = {
	type: "object",
	description:
		"Fill or update tdd.md for the active task. Provide each section as the lifecycle reaches it; the wrapper assembles the markdown and preserves sections you do not pass. Built-in edit/write cannot modify tdd.md.",
	properties: {
		preImplementation: {
			type: "object",
			description:
				"Pre-Implementation Proof Contract (write before run_failing_tests).",
			properties: {
				failingSignal: TDD_SECTION_FIELD(
					"The exact failing test/assertion signal proving the behavior is absent.",
				),
				productionPath: TDD_SECTION_FIELD(
					"The production file/symbol that will make the test pass.",
				),
				successSignal: TDD_SECTION_FIELD(
					"The exact signal that will prove success after implementation.",
				),
				outOfScopeFiles: TDD_SECTION_FIELD(
					"Files/areas explicitly out of scope for this task.",
				),
			},
			required: [
				"failingSignal",
				"productionPath",
				"successSignal",
				"outOfScopeFiles",
			],
			additionalProperties: false,
		},
		postImplementation: {
			type: "object",
			description:
				"Post-Implementation Counterexample Review (write before finishing implement_task).",
			properties: {
				counterexample: TDD_SECTION_FIELD(
					"A concrete counterexample considered against the implementation.",
				),
				boundaryValue: TDD_SECTION_FIELD("Boundary/edge value checked."),
				oppositeCase: TDD_SECTION_FIELD("The opposite/negative case checked."),
				regressionRisk: TDD_SECTION_FIELD(
					"Regression risk and how it was mitigated or verified.",
				),
				scopeCheck: TDD_SECTION_FIELD(
					"Confirmation that changes stayed within the task scope.",
				),
				action: TDD_SECTION_FIELD(
					"Action taken from this review, or why none.",
				),
			},
			required: [
				"counterexample",
				"boundaryValue",
				"oppositeCase",
				"regressionRisk",
				"scopeCheck",
				"action",
			],
			additionalProperties: false,
		},
		mergeScopeAudit: {
			type: "object",
			description: "Task Merge Scope Audit (write before merge_task_to_plan).",
			properties: {
				acceptanceCriteriaCovered: TDD_SECTION_FIELD(
					"Evidence each acceptance criterion is covered.",
				),
				changedFilesMatchScope: TDD_SECTION_FIELD(
					"Confirmation changed files match the task scope.",
				),
				testsRun: TDD_SECTION_FIELD("The tests run and their result."),
				debugRemoved: TDD_SECTION_FIELD(
					"Confirmation temporary debug/instrumentation was removed.",
				),
				commitMessageMatchesBehavior: TDD_SECTION_FIELD(
					"Confirmation the commit message matches the behavior change.",
				),
				branchDriftCheck: TDD_SECTION_FIELD(
					"Confirmation the task branch did not drift from the plan branch.",
				),
			},
			required: [
				"acceptanceCriteriaCovered",
				"changedFilesMatchScope",
				"testsRun",
				"debugRemoved",
				"commitMessageMatchesBehavior",
				"branchDriftCheck",
			],
			additionalProperties: false,
		},
	},
	additionalProperties: false,
} as const;

const DOUBT_REVIEW_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		summary: {
			type: "string",
			description:
				"Short final doubt-review summary. State whether proven bugs remain, probes are needed, or the result can proceed.",
		},
		possibleErrors: {
			type: "array",
			description:
				"Every suspected issue from final review. A finding may be called a proven bug only after a failing test/command, exact code path proof, or exact spec contradiction.",
			items: {
				type: "object",
				properties: {
					id: {
						type: "string",
						description: "Lowercase kebab-case finding id.",
					},
					riskCategory: {
						type: "string",
						enum: DOUBT_RISK_CATEGORIES,
						description:
							"Exact risk category this suspected issue belongs to. Choose the narrowest enum value before proving or dismissing it.",
					},
					status: {
						type: "string",
						enum: DOUBT_FINDING_STATUSES,
						description:
							"proven_bug only for verified problems; needs_probe for unproven suspicion; disproven/not_a_bug for dismissed findings.",
					},
					proofLevel: {
						type: "string",
						enum: DOUBT_PROOF_LEVELS,
						description:
							"How the finding was proven or dismissed. Use insufficient_evidence until a probe/test/code proof exists.",
					},
					claim: { type: "string" },
					specReference: {
						type: "string",
						description:
							"Spec, goal, plan, or task artifact section that makes this finding relevant.",
					},
					codePath: {
						type: "string",
						description:
							"Exact files/functions/commands inspected. Use concrete paths, not broad module names.",
					},
					verification: {
						type: "string",
						description:
							"The concrete test, command, reproduction, code-path trace, or spec comparison used to prove or dismiss the claim.",
					},
					evidence: {
						type: "array",
						items: { type: "string" },
						description: "Concrete evidence. Required for every finding.",
					},
					counterEvidence: {
						type: "array",
						items: { type: "string" },
						description:
							"Evidence against the claim. Use an empty array only when none was found.",
					},
					nextAction: {
						type: "string",
						enum: DOUBT_NEXT_ACTIONS,
						description:
							"create_revision_task for proven bugs, run_probe for unproven suspicions, no_action for disproven/not_a_bug.",
					},
				},
				required: [
					"id",
					"riskCategory",
					"status",
					"proofLevel",
					"claim",
					"specReference",
					"codePath",
					"verification",
					"evidence",
					"counterEvidence",
					"nextAction",
				],
				additionalProperties: false,
			},
		},
		verificationEvidence: {
			type: "array",
			description:
				"Every command/check required by discovery.md ## Verification Protocol. Do not claim the result is verified unless each required command has passed evidence or a proven_bug/needs_probe finding.",
			items: {
				type: "object",
				properties: {
					command: {
						type: "string",
						description:
							"Exact command or check from discovery.md ## Verification Protocol.",
					},
					status: {
						type: "string",
						enum: ["passed", "failed", "not_run", "unknown"],
					},
					evidence: {
						type: "string",
						description:
							"Concrete output summary, failing signal, or reason this check was not run.",
					},
				},
				required: ["command", "status", "evidence"],
				additionalProperties: false,
			},
		},
	},
	required: ["summary", "verificationEvidence", "possibleErrors"],
	additionalProperties: false,
} as const;

const SKILL_CREATE_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		nameHint: {
			type: "string",
			description:
				"Short ASCII-oriented semantic hint for the skill name. The wrapper normalizes it and appends a UUID suffix.",
		},
		description: {
			type: "string",
			description:
				"Pi skill trigger description, <=1024 chars. Include ACTIVATE/Use when conditions and avoid broad generic wording.",
		},
		bodyMarkdown: {
			type: "string",
			description:
				"Full SKILL.md body without YAML frontmatter. Must include a markdown H1 and concrete workflow/checks. Use metadata.skillLanguage for human-facing prose.",
		},
		tags: {
			type: "array",
			items: { type: "string" },
			description:
				"Short tags for future planner skill selection, for example pi-extension, ctx, session-switch.",
		},
		sourceKind: {
			type: "string",
			enum: PLANNER_SKILL_SOURCE_KINDS,
			description:
				"Exact source of the reusable lesson. Pick one enum value; do not invent aliases.",
		},
		sourcePlanId: {
			type: "string",
			description: "Current planner plan id when known.",
		},
		sourceTaskId: {
			type: "string",
			description: "Current planner task id when known.",
		},
	},
	required: ["nameHint", "description", "bodyMarkdown", "sourceKind"],
	additionalProperties: false,
} as const;

const SKILL_UPDATE_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		name: {
			type: "string",
			description:
				"Exact skill name from the index (pi-planner-xxx-uuid format). Must match an existing skill.",
		},
		description: {
			type: "string",
			description:
				"Revised Pi skill trigger description, <=1024 chars. Include ACTIVATE/Use when conditions.",
		},
		bodyMarkdown: {
			type: "string",
			description:
				"Revised SKILL.md body without YAML frontmatter. Must include a markdown H1 and concrete workflow/checks. Use metadata.skillLanguage for human-facing prose.",
		},
	},
	required: ["name", "description", "bodyMarkdown"],
	additionalProperties: false,
} as const;

const DEBUG_STRATEGY_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		runtimeTarget: {
			type: "string",
			description:
				"Platform/runtime being debugged, for example native Rust, Tokio async, Gear WASM, browser, CLI, test runner, or unknown.",
		},
		availableSignals: {
			type: "array",
			items: { type: "string" },
			description:
				"Signals that can be observed in this project: test output, stdout/stderr, framework logger, temp file, backtrace, diff, etc.",
		},
		safeInstrumentation: {
			type: "array",
			items: { type: "string" },
			description:
				"Safe temporary instrumentation options for this project/runtime.",
		},
		forbiddenInstrumentation: {
			type: "array",
			items: { type: "string" },
			description:
				"Instrumentation that must not be used or committed for this project/runtime.",
		},
		cleanupPlan: {
			type: "string",
			description:
				"How temporary logs/assertions/files will be removed before planner_git_commit.",
		},
	},
	required: [
		"runtimeTarget",
		"availableSignals",
		"safeInstrumentation",
		"forbiddenInstrumentation",
		"cleanupPlan",
	],
	additionalProperties: false,
} as const;

const DEBUG_PROBE_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		question: {
			type: "string",
			description: "One concrete question this probe must answer.",
		},
		hypothesis: {
			type: "string",
			description: "One hypothesis being tested by this probe.",
		},
		method: {
			type: "string",
			enum: DEBUG_PROBE_METHODS,
			description:
				"Exact debug probe method. Pick the smallest method that can produce a signal.",
		},
		instrumentation: {
			type: "string",
			enum: DEBUG_INSTRUMENTATION_TYPES,
			description:
				"Exact instrumentation channel. Use temp_file only as a last resort when normal output/logging is unavailable.",
		},
		target: {
			type: "string",
			description:
				"Command, file path, function, test, runtime logger, or temp output target for this probe.",
		},
		expectedSignal: {
			type: "string",
			description: "What result would confirm or reject the hypothesis.",
		},
		cleanupRequired: {
			type: "boolean",
			description:
				"True if this probe adds logs, temp files, assertions, test scaffolding, or any artifact that must be removed before commit.",
		},
	},
	required: [
		"question",
		"hypothesis",
		"method",
		"instrumentation",
		"target",
		"expectedSignal",
		"cleanupRequired",
	],
	additionalProperties: false,
} as const;

const DEBUG_RESULT_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		probeId: {
			type: "string",
			description:
				"Optional probe id. Omit when reporting the currently active debug probe.",
		},
		observedSignal: {
			type: "string",
			description: "Concrete output/log/assertion/diff signal observed.",
		},
		signalMatched: {
			type: "boolean",
			description:
				"Whether observedSignal matched expectedSignal for the active probe.",
		},
		conclusion: {
			type: "string",
			description:
				"What this signal proves or rules out. Do not patch without a concrete conclusion.",
		},
		cleanupDone: {
			type: "boolean",
			description:
				"True only if temporary project instrumentation was removed. Debug artifacts are removed separately by planner_debug_cleanup.",
		},
		nextAction: {
			type: "string",
			enum: DEBUG_RESULT_NEXT_ACTIONS,
			description:
				"patch only after a concrete signal. probe_again for another focused signal. ask_user/block when evidence requires it.",
		},
	},
	required: [
		"observedSignal",
		"signalMatched",
		"conclusion",
		"cleanupDone",
		"nextAction",
	],
	additionalProperties: false,
} as const;

const DEBUG_CLEANUP_TOOL_PARAMETERS = EMPTY_TOOL_PARAMETERS;

const COMPLETE_STEP_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		nextStage: {
			type: "string",
			enum: PLANNER_STAGE_VALUES,
			description:
				"Exact planner stage id. Use only the enum value reported by planner_status, for example finalize, not finalization.",
		},
		nextStep: {
			type: "string",
			enum: PLANNER_STEP_VALUES,
			description:
				"Exact planner step id. Must belong to nextStage and be one of the allowed next targets reported by planner_status.",
		},
	},
	additionalProperties: false,
} as const;

const REASON_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		reason: { type: "string" },
	},
	required: ["reason"],
	additionalProperties: false,
} as const;

const BLOCK_STEP_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		reason: { type: "string" },
		requiresUserDecision: { type: "boolean" },
	},
	required: ["reason"],
	additionalProperties: false,
} as const;

const RESUME_RECOVERY_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		targetStage: {
			type: "string",
			enum: PLANNER_STAGE_VALUES,
			description:
				"Exact recovery target stage id. Use only persisted stage ids from planner_status.",
		},
		targetStep: {
			type: "string",
			enum: PLANNER_STEP_VALUES,
			description: "Exact recovery target step id. Must belong to targetStage.",
		},
	},
	required: ["targetStage", "targetStep"],
	additionalProperties: false,
} as const;

const OPTIONAL_REASON_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		reason: { type: "string" },
	},
	additionalProperties: false,
} as const;

const GIT_MESSAGE_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		message: { type: "string" },
	},
	required: ["message"],
	additionalProperties: false,
} as const;

const GIT_TASK_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		taskId: { type: "string" },
	},
	required: ["taskId"],
	additionalProperties: false,
} as const;

const GIT_OPTIONAL_MESSAGE_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		message: { type: "string" },
	},
	additionalProperties: false,
} as const;

const GIT_INSPECT_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		mode: {
			type: "string",
			enum: ["inspect", "plan_summary", "task_diff"],
			description:
				"inspect: git reality (branch, HEAD, dirty, conflicts). plan_summary: all commits and changed files from base to plan branch. task_diff: diff stat between plan branch and task branch.",
		},
		taskId: {
			type: "string",
			description:
				"Required when mode=task_diff. The task ID to diff against the plan branch.",
		},
	},
	additionalProperties: false,
} as const;

interface PlannerIdleRuntimeState {
	latestCwd: string | null;
	checking: boolean;
	timer: ReturnType<typeof setInterval> | null;
}

export default function piCodePlannerExtension(pi: ExtensionAPI): void {
	const compactRuntime = createPlannerCompactRuntimeState();
	const idleRuntime: PlannerIdleRuntimeState = {
		latestCwd: null,
		checking: false,
		timer: null,
	};
	const timerRuntime = createPlannerTimerRuntimeState();
	installPlannerToolErrorBoundary(pi);
	registerPlannerCommands(pi);
	registerPlannerTools(pi, compactRuntime);
	registerPlannerIdleWatchdog(pi, idleRuntime);
	registerPlannerRuntimeTimer(pi, timerRuntime);
	registerPlannerDashboard(pi);
	registerPlannerWorkspaceAutoOpen(pi);
	registerPlannerBuiltinToolGuard(pi);
	registerPlannerCompactEvents(pi, compactRuntime);
	registerPlannerSkillResources(pi);
	registerInstructionDefaultsSync(pi);
	registerPlannerToolVisibility(pi);
}

type RegisterToolFn = ExtensionAPI["registerTool"];
type PlannerToolDefinition = Parameters<RegisterToolFn>[0];

/**
 * Wrap pi.registerTool so every planner tool's execute() runs inside a shared
 * try/catch. Without this, a thrown error (e.g. an invalid/missing argument
 * from a small local model) escapes the tool boundary and no tool result is
 * ever returned — the call silently hangs and the model retries the same
 * broken call forever. Converting the throw into an explicit error result lets
 * the model see what went wrong and correct itself.
 *
 * Recoverable, expected conditions should still be returned as normal results
 * (see the blocked() pattern in the wrapper tools). This boundary is the
 * last-resort net for unexpected throws only.
 */
export function installPlannerToolErrorBoundary(pi: ExtensionAPI): void {
	const register = pi.registerTool.bind(pi) as (
		tool: PlannerToolDefinition,
	) => void;
	pi.registerTool = ((tool: PlannerToolDefinition) => {
		const execute = tool.execute.bind(tool);
		register({
			...tool,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				try {
					const result = await execute(
						toolCallId,
						params,
						signal,
						onUpdate,
						ctx,
					);
					void recordPlannerDiagnosticsEventForProject({
						pi,
						ctx,
						tool: tool.name,
						status: deriveToolEventStatus(result),
					});
					return result;
				} catch (error) {
					void recordPlannerDiagnosticsEventForProject({
						pi,
						ctx,
						tool: tool.name,
						status: "error",
					});
					const message =
						error instanceof Error ? error.message : String(error);
					return {
						content: [
							{
								type: "text",
								text: [
									`Tool ${tool.name} failed: ${message}`,
									"",
									"This is an internal error, not a normal block. Re-check the arguments you passed against the tool's parameter schema (a required field may be missing or the wrong type), then call the tool again. If unsure which planner step/tool is allowed, call planner_status.",
								].join("\n"),
							},
						],
						isError: true,
						details: { error: message, toolName: tool.name },
					};
				}
			},
		});
	}) as typeof pi.registerTool;
}

/**
 * Auto-open the planner workspace once per session when the active session is a
 * planner worktree session. This covers /planner-create, /planner-resume, and
 * /planner-improve (each hands off to a worktree session) without coupling to
 * the fragile session-switch flow. The user can reopen anytime with
 * /planner-dashboard, or close the workspace to fall back to the plain chat.
 */
function registerPlannerWorkspaceAutoOpen(pi: ExtensionAPI): void {
	const openedSessions = new Set<string>();
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			if (openedSessions.has(sessionId)) return;
			const { fs, projectPaths } = await resolveRuntimeContext(ctx.cwd);
			const context = await readActivePlanContext({ fs, projectPaths });
			if (context.status !== "ready") return;
			const worktreePath = context.state.worktreePath;
			if (!worktreePath || !isPathInsideOrEqual(ctx.cwd, worktreePath)) return;
			openedSessions.add(sessionId);
			void openPlannerWorkspace(pi, ctx, { auto: true });
		} catch {
			// Best-effort: never block session start on the workspace.
		}
	});
}

function registerPlannerSkillResources(pi: ExtensionAPI): void {
	pi.on("resources_discover", async (event) => {
		const fs = createNodeFs();
		try {
			const skillPaths = await listPlannerSkillResourcePaths({
				fs,
				agentDir: getAgentDir(),
				cwd: event.cwd,
				plannerActive: isPlanActive(),
			});
			return { skillPaths };
		} catch {
			return { skillPaths: [] };
		}
	});
}

function registerInstructionDefaultsSync(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const fs = createNodeFs();
		try {
			const projectPaths = await createRuntimeProjectPaths(ctx.cwd);
			await syncBundledInstructionFiles(
				fs,
				createInstructionPaths(projectPaths),
			);
		} catch (error) {
			ctx.ui.notify(
				`pi-code-planner instruction sync failed: ${errorMessage(error)}`,
				"warning",
			);
		}
	});
}

function buildPlannerImproveRequest(input: {
	request?: string;
	compatibilityMode: "additive" | "breaking";
}): string {
	const isBreaking = input.compatibilityMode === "breaking";
	const compatibilityBlock = isBreaking
		? [
				"## Compatibility Mode: BREAKING",
				"",
				"Breaking changes are permitted when discovery evidence proves they are needed.",
				"",
				"What this means for goal.md:",
				"- You may propose removing or renaming public APIs, commands, settings, or persisted fields IF evidence shows the current design is wrong.",
				"- Every breaking proposal must be explicitly listed in goal.md under a ## Breaking Changes section.",
				"- Breaking implementation still requires explicit user approval before planning starts.",
				"- If no breaking change is needed, treat this session as additive.",
			]
		: [
				"## Compatibility Mode: ADDITIVE",
				"",
				"This session must not break existing behavior.",
				"",
				"What this means for goal.md:",
				"- Do not propose removing or renaming public commands, tool schemas, settings keys, persisted JSON fields, package metadata, or documented behavior.",
				"- Additive: new features, new options, improved defaults, better instructions, more tests, documentation.",
				"- If a breaking change looks better, record it as a future proposal in a ## Future Proposals section but do not implement it.",
				"- If discovery reveals that the only real improvement requires breaking changes, state that clearly and let the user decide whether to restart with --breaking.",
			];
	const goalTemplate = [
		"## goal.md template for improve sessions",
		"",
		"After discovery, write goal.md through planner_goal_submit (not a file write tool) with this structure:",
		"",
		"```",
		"## Objective",
		"One sentence: what this improvement achieves and why it matters based on discovery evidence.",
		"",
		"## Discovery Evidence",
		"Bullet list: what you found in the repository that motivates this improvement.",
		"",
		"## Scope",
		"What is in scope. Be specific — name files, commands, or behaviors.",
		"",
		"## Non-Goals",
		"What you are NOT changing. Especially: list any public APIs / commands / settings you are explicitly preserving.",
		...(isBreaking
			? [
					"",
					"## Breaking Changes",
					"List every breaking change proposed. Each entry: what changes, why evidence requires it, what migration looks like.",
				]
			: []),
		"",
		"## Acceptance Criteria",
		"Concrete, testable conditions: tests pass, command works, behavior matches description.",
		"```",
	];
	return [
		"# Planner Improve Request",
		"",
		"This is a discovery-first self-improvement flow for this repository.",
		...(input.request ? ["", "## User Focus", input.request] : []),
		"",
		...compatibilityBlock,
		"",
		"## How This Flow Works",
		"",
		"1. Run discovery first. Do not write goal.md before reading repository evidence.",
		"   - Scan AGENTS.md contracts, read relevant source, find real gaps.",
		"   - Choose one bounded, high-value improvement (reliability, tests, documentation, local-model guidance, developer workflow).",
		"2. After discovery reaches enter_planning, return to intake/draft_goal.",
		"3. At intake/draft_goal: call planner_goal_submit with the drafted goal.",
		"   - planner_goal_submit is the ONLY way to write goal.md.",
		"   - Do NOT use file write/edit tools for goal.md. The tool does it.",
		"   - Writing goal.md by hand bypasses validation and will not advance the step.",
		"4. Show the full goal to the user and wait for explicit approval.",
		"5. Do not start planning without approval.",
		"",
		...goalTemplate,
	].join("\n");
}

function registerPlannerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("planner-helper", {
		description:
			"Show pi-code-planner settings, defaults, sources, and runtime behavior.",
		handler: async (_args, ctx) => {
			const fs = createNodeFs();
			try {
				const projectPaths = await resolveProjectStoragePaths({
					fs,
					agentDir: getAgentDir(),
					cwd: ctx.cwd,
				});
				const settings = await loadEffectivePlannerSettings({
					fs,
					projectPaths,
				});
				pi.sendMessage(
					{
						customType: "planner-helper",
						content: buildPlannerAboutReport({
							settings,
							projectPaths,
							audience: "human",
						}),
						display: true,
					},
					{ triggerTurn: false } as never,
				);
			} catch (error) {
				ctx.ui.notify(`Planner helper failed: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.registerCommand("planner-skills", {
		description:
			"Search, view, and delete planner-generated skills saved by pi-code-planner.",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const fs = createNodeFs();
			try {
				const projectPaths = await resolveProjectStoragePaths({
					fs,
					agentDir: getAgentDir(),
					cwd: ctx.cwd,
				});
				const inventory = await listPlannerSkillInventory({
					fs,
					projectPaths,
				});
				if (inventory.length === 0) {
					ctx.ui.notify("No planner-generated skills found.", "info");
					return;
				}

				const query = await ctx.ui.input(
					"Search planner skills",
					"Type keywords or leave empty",
				);
				if (query === undefined) {
					ctx.ui.notify("Planner skills cancelled.", "info");
					return;
				}
				const matches = filterPlannerSkillInventory(inventory, query.trim());
				if (matches.length === 0) {
					ctx.ui.notify("No planner skills matched that search.", "info");
					return;
				}

				const labels = matches.map(plannerSkillOptionLabel);
				const selectedLabel = await ctx.ui.select(
					`Planner skills (${matches.length})`,
					labels,
				);
				if (!selectedLabel) {
					ctx.ui.notify("Planner skills cancelled.", "info");
					return;
				}
				const selected = matches[labels.indexOf(selectedLabel)];
				if (!selected) {
					ctx.ui.notify("Planner skill selection failed.", "error");
					return;
				}

				const viewLabel = "View details";
				const deleteLabel = "Delete skill";
				const action = await ctx.ui.select("Planner skill action", [
					viewLabel,
					deleteLabel,
				]);
				if (!action) {
					ctx.ui.notify("Planner skills cancelled.", "info");
					return;
				}
				if (action === viewLabel) {
					pi.sendMessage(
						{
							customType: "planner-skills",
							content: buildPlannerSkillDetailsMarkdown(selected),
							display: true,
						},
						{ triggerTurn: false } as never,
					);
					return;
				}

				const confirmed = await ctx.ui.confirm(
					"Delete planner skill?",
					`Delete "${selected.name}" from the planner skill library? This removes its SKILL.md and index entry. Future planner sessions will not load it.`,
				);
				if (!confirmed) {
					ctx.ui.notify("Planner skill delete cancelled.", "info");
					return;
				}
				const deleted = await deletePlannerSkill({
					fs,
					projectPaths,
					name: selected.name,
				});
				if (!deleted) {
					ctx.ui.notify("Planner skill no longer exists.", "warning");
					return;
				}
				ctx.ui.notify(`Deleted planner skill: ${deleted.name}`, "info");
			} catch (error) {
				ctx.ui.notify(`Planner skills failed: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.registerCommand("planner-create", {
		description:
			"Open a multiline planner request editor, then create a worktree plan.",
		handler: async (args, ctx) => {
			try {
				await ctx.waitForIdle();
				const parsed = parsePlannerCreateCommandArgs(args);
				if (!parsed) {
					ctx.ui.notify(
						"Usage: /planner-create [initial request text]",
						"error",
					);
					return;
				}

				// ctx.ui.editor is async and may span a session replacement
				// (e.g. ESC → "Resumed session"). Keep editor and post-editor
				// work inside this guard so stale ctx errors cannot crash Pi.
				const request = await ctx.ui.editor(
					"Describe the requested outcome",
					parsed.request ?? "",
				);
				if (!request?.trim()) {
					await safeNotify(ctx, "Planner creation cancelled.", "info");
					return;
				}
				const normalizedRequest = request.trim();

				const { fs, agentDir, projectPaths } = await resolveRuntimeContext(
					ctx.cwd,
				);
				const project = await ensureProjectRecord(fs, projectPaths);
				let planId: string;
				try {
					planId = resolvePlannerPlanId({
						request: normalizedRequest,
						project,
					});
				} catch (error) {
					ctx.ui.notify(errorMessage(error), "error");
					return;
				}
				const result = await executePlannerPlanTool({
					fs,
					git: gitRunner,
					projectPaths,
					toolName: "planner_create_plan",
					params: {
						planId,
						request: normalizedRequest,
					},
				});

				if (result.status !== "applied") {
					ctx.ui.notify(result.text, "error");
					return;
				}
				markPlannerToolVisibilityActive();

				const {
					worktreePath,
					createdPlanId,
					descriptionLanguage,
					titleLanguage,
				} = readPlannerCreateOutcome(result.details, planId);
				if (!worktreePath) {
					ctx.ui.notify(
						"Planner plan was created without worktreePath.",
						"error",
					);
					return;
				}

				const originalSessionFile = ctx.sessionManager.getSessionFile();
				await bindWorktreeRootSession({
					fs,
					agentDir,
					worktreePath,
					projectRoot: projectPaths.projectRoot,
					projectId: projectPaths.projectId,
					planId: createdPlanId,
					createdFromSessionFile: originalSessionFile ?? null,
					lastRootSessionFile: originalSessionFile ?? null,
				});

				const session = await createPlannerHandoffSession({
					fs,
					agentDir,
					worktreePath,
					parentSession: originalSessionFile,
				});
				await persistPlannerToolVisibilityActiveToSession({
					fs,
					sessionFile: session.sessionFile,
				});
				await ctx.switchSession(session.sessionFile, {
					withSession: async (replacementCtx) => {
						try {
							await replacementCtx.sendUserMessage(
								buildPlannerHandoffPrompt({
									planId: createdPlanId,
									worktreePath,
									titleLanguage,
									descriptionLanguage,
								}),
								FOLLOW_UP_MESSAGE_OPTIONS,
							);
						} catch (error) {
							try {
								replacementCtx.ui.notify(
									`Planner handoff message failed: ${errorMessage(error)}. Call planner_status manually.`,
									"warning",
								);
							} catch {
								// Ignore stale replacement UI context.
							}
						}
					},
				});
			} catch (error) {
				// Stale ctx after session replacement (e.g. ESC during editor).
				// Treat as cancellation — the user already got feedback from
				// the editor UI.
				const msg = error instanceof Error ? error.message : String(error);
				if (msg.includes("stale")) {
					await safeNotify(ctx, "Planner creation cancelled.", "info");
				} else {
					await safeNotify(ctx, msg, "error");
				}
			}
		},
	});

	pi.registerCommand("planner-improve", {
		description:
			"Create a discovery-first self-improvement plan for this repository. Use --breaking to allow breaking proposals.",
		handler: async (args, ctx) => {
			try {
				await ctx.waitForIdle();
				const parsed = parsePlannerImproveCommandArgs(args);
				if (!parsed) {
					ctx.ui.notify(
						"Usage: /planner-improve [--additive|--breaking|--compat additive|breaking] [optional focus]",
						"error",
					);
					return;
				}

				const { fs, agentDir, projectPaths } = await resolveRuntimeContext(
					ctx.cwd,
				);
				const request = buildPlannerImproveRequest({
					request: parsed.request,
					compatibilityMode: parsed.compatibilityMode,
				});
				const project = await ensureProjectRecord(fs, projectPaths);
				let planId: string;
				try {
					planId = resolvePlannerPlanId({
						request,
						project,
					});
				} catch (error) {
					ctx.ui.notify(errorMessage(error), "error");
					return;
				}
				const result = await executePlannerPlanTool({
					fs,
					git: gitRunner,
					projectPaths,
					toolName: "planner_create_plan",
					params: {
						planId,
						request,
						title:
							parsed.compatibilityMode === "breaking"
								? "Improve planner with breaking proposals"
								: "Improve planner compatibility",
						description:
							parsed.compatibilityMode === "breaking"
								? "Discovery-first self-improvement plan that may propose approved breaking changes."
								: "Discovery-first additive self-improvement plan for this repository.",
					},
				});

				if (result.status !== "applied") {
					ctx.ui.notify(result.text, "error");
					return;
				}
				markPlannerToolVisibilityActive();

				const {
					worktreePath,
					createdPlanId,
					descriptionLanguage,
					titleLanguage,
				} = readPlannerCreateOutcome(result.details, planId);
				if (!worktreePath) {
					ctx.ui.notify(
						"Planner plan was created without worktreePath.",
						"error",
					);
					return;
				}

				const planPaths = createPlanStoragePaths(projectPaths, createdPlanId);
				await updatePlanState(fs, planPaths, (current) => ({
					...current,
					stage: "discovery",
					step: "scan_project_structure",
					stepStatus: "running",
					nextStep: null,
					creationMethod: "improve",
					compatibilityMode: parsed.compatibilityMode,
				}));

				const originalSessionFile = ctx.sessionManager.getSessionFile();
				await bindWorktreeRootSession({
					fs,
					agentDir,
					worktreePath,
					projectRoot: projectPaths.projectRoot,
					projectId: projectPaths.projectId,
					planId: createdPlanId,
					createdFromSessionFile: originalSessionFile ?? null,
					lastRootSessionFile: originalSessionFile ?? null,
				});

				const session = await createPlannerHandoffSession({
					fs,
					agentDir,
					worktreePath,
					parentSession: originalSessionFile,
				});
				await persistPlannerToolVisibilityActiveToSession({
					fs,
					sessionFile: session.sessionFile,
				});
				await ctx.switchSession(session.sessionFile, {
					withSession: async (replacementCtx) => {
						await replacementCtx.sendUserMessage(
							buildPlannerImproveHandoffPrompt({
								planId: createdPlanId,
								worktreePath,
								titleLanguage,
								descriptionLanguage,
								compatibilityMode: parsed.compatibilityMode,
							}),
							FOLLOW_UP_MESSAGE_OPTIONS,
						);
					},
				});
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				if (msg.includes("stale")) {
					await safeNotify(ctx, "Planner improve cancelled.", "info");
				} else {
					await safeNotify(ctx, msg, "error");
				}
			}
		},
	});

	pi.registerCommand("planner-exit", {
		description:
			"Return from the active planner worktree session to the original project chat without finishing or deleting the plan.",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const { fs, agentDir, projectPaths } = await resolveRuntimeContext(
				ctx.cwd,
			);
			try {
				const project = await readProjectRecordIfExists(fs, projectPaths);
				if (!project?.activePlanId) {
					ctx.ui.notify("No active planner plan to exit.", "info");
					resetPlanActiveCache(pi);
					return;
				}
				const activePlanId = project.activePlanId;
				const planPaths = createPlanStoragePaths(projectPaths, activePlanId);
				const state = await readPlanStateIfExists(fs, planPaths);
				const worktreePath = state?.worktreePath;
				if (!worktreePath) {
					ctx.ui.notify("Active planner plan has no worktree path.", "error");
					return;
				}
				const index = await readWorktreeProjectIndexIfExists({
					fs,
					agentDir,
					worktreePath,
				});
				const targetSessionFile = await resolveProjectSessionForHandoff({
					fs,
					agentDir,
					projectRoot: projectPaths.projectRoot,
					preferredSessionFiles: [
						index?.lastRootSessionFile ?? null,
						index?.createdFromSessionFile ?? null,
					],
					parentSession: ctx.sessionManager.getSessionFile(),
				});
				if (!targetSessionFile.sessionFile) {
					ctx.ui.notify(
						"Planner exit could not resolve a project session for handoff.",
						"error",
					);
					return;
				}
				await setActivePlan(fs, projectPaths, null);
				resetPlanActiveCache(pi);
				await ctx.switchSession(targetSessionFile.sessionFile, {
					withSession: async (replacementCtx) => {
						if (targetSessionFile.recovered) {
							replacementCtx.ui.notify(
								"Original Pi JSONL session path was missing or stale. Planner returned to an existing project-root session.",
								"warning",
							);
						}
						if (targetSessionFile.created) {
							replacementCtx.ui.notify(
								"Original Pi JSONL session was missing. Planner created a replacement project-root session.",
								"warning",
							);
						}
						await replacementCtx.sendUserMessage(
							buildPlannerExitPrompt({
								planId: activePlanId,
								worktreePath,
							}),
							FOLLOW_UP_MESSAGE_OPTIONS,
						);
					},
				});
			} catch (error) {
				await safeNotify(
					ctx,
					`Planner exit failed: ${errorMessage(error)}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("planner-rename", {
		description:
			"Rename a planner plan title without changing its stable plan id.",
		handler: async (args, ctx) => {
			const { fs, projectPaths } = await resolveRuntimeContext(ctx.cwd);
			const parsed = await resolveRenameCommandArgs({
				args,
				ctx,
				fs,
				projectPaths,
			});
			if (!parsed) return;
			const result = await executePlannerUserCommand({
				fs,
				git: gitRunner,
				projectPaths,
				commandName: "planner_rename",
				params: {
					planId: parsed.planId,
					title: parsed.title,
				},
			});
			notifyPlannerCommandResult(ctx, result);
		},
	});

	pi.registerCommand("planner-resume", {
		description: "Resume a planner plan in the current project.",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const { fs, agentDir, projectPaths } = await resolveRuntimeContext(
				ctx.cwd,
			);
			const planId =
				parseSinglePlanIdArg(args) ??
				(await selectPlannerPlanId({
					ui: ctx.ui,
					fs,
					projectPaths,
					title: "Resume planner plan",
				}));
			if (!planId) {
				ctx.ui.notify("Planner resume cancelled.", "info");
				return;
			}
			const result = await executePlannerUserCommand({
				fs,
				git: gitRunner,
				projectPaths,
				commandName: "planner_resume",
				params: { planId },
			});
			if (result.status !== "applied") {
				ctx.ui.notify(result.text, "error");
				return;
			}
			markPlannerToolVisibilityActive();
			const details = result.details as {
				worktreePath?: string | null;
				creationMethod?: "create" | "improve";
				compatibilityMode?: "additive" | "breaking";
			};
			if (!details.worktreePath) {
				ctx.ui.notify("Planner resume did not return worktreePath.", "error");
				return;
			}
			const worktreePath = details.worktreePath;
			const parentSession = ctx.sessionManager.getSessionFile();
			await bindWorktreeRootSession({
				fs,
				agentDir,
				worktreePath,
				projectRoot: projectPaths.projectRoot,
				projectId: projectPaths.projectId,
				planId,
				lastRootSessionFile: isPathInsideOrEqual(
					ctx.cwd,
					projectPaths.projectRoot,
				)
					? parentSession
					: null,
			});
			const existingSessionFile = selectPlannerResumeSessionFile(
				await SessionManager.list(worktreePath),
			);
			const targetSessionFile =
				existingSessionFile ??
				(
					await createPlannerHandoffSession({
						fs,
						agentDir,
						worktreePath,
						parentSession,
					})
				).sessionFile;
			await persistPlannerToolVisibilityActiveToSession({
				fs,
				sessionFile: targetSessionFile,
			});
			await ctx.switchSession(targetSessionFile, {
				withSession: async (replacementCtx) => {
					await replacementCtx.sendUserMessage(
						buildPlannerResumePrompt({
							planId,
							worktreePath,
							creationMethod: details.creationMethod,
							compatibilityMode: details.compatibilityMode,
						}),
						FOLLOW_UP_MESSAGE_OPTIONS,
					);
				},
			});
		},
	});

	pi.registerCommand("planner-delete", {
		description: "Delete a planner plan after confirmation.",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const { fs, agentDir, projectPaths } = await resolveRuntimeContext(
				ctx.cwd,
			);
			const parsed = await resolveDeleteCommandArgs({
				args,
				ctx,
				fs,
				projectPaths,
			});
			if (!parsed) return;
			if (parsed.deleteActive) {
				const handoffCwd = (await fs.exists(projectPaths.projectRoot))
					? projectPaths.projectRoot
					: agentDir;
				if (handoffCwd !== projectPaths.projectRoot) {
					ctx.ui.notify(
						"Original project directory is missing. Planner will switch to agent dir and delete planner storage best-effort.",
						"warning",
					);
				}
				const session = await createPlannerHandoffSession({
					fs,
					agentDir,
					worktreePath: handoffCwd,
					parentSession: ctx.sessionManager.getSessionFile(),
				});
				resetPlanActiveCache(pi);
				await ctx.switchSession(session.sessionFile, {
					withSession: async (replacementCtx) => {
						const result = await executePlannerUserCommand({
							fs,
							git: gitRunner,
							projectPaths,
							commandName: "planner_delete",
							params: {
								planId: parsed.planId,
								deleteSessions: true,
							},
						});
						notifyPlannerCommandResult(replacementCtx, result);
					},
				});
				return;
			}

			const result = await executePlannerUserCommand({
				fs,
				git: gitRunner,
				projectPaths,
				commandName: "planner_delete",
				params: {
					planId: parsed.planId,
					deleteSessions: true,
				},
			});
			notifyPlannerCommandResult(ctx, result);
			resetPlanActiveCache(pi);
		},
	});

	pi.registerCommand("planner-finish", {
		description:
			"Finish the completed planner result, keep one output branch, clean temporary planner state, and return to the original project session.",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const { fs, agentDir, projectPaths } = await resolveRuntimeContext(
				ctx.cwd,
			);
			const git = gitRunner;
			let fallbackSession: Awaited<
				ReturnType<typeof createPlannerHandoffSession>
			> | null = null;
			let acceptedPlanFinalized = false;

			try {
				const preview = await inspectAcceptedPlan({
					fs,
					git,
					projectPaths,
				});
				const confirmed = await ctx.ui.confirm(
					"Finish planner result?",
					`Export ${preview.state.activeBranches.plan} to ${preview.outputBranch}, remove temporary planner files and worktree, and return to the original project session?`,
				);
				if (!confirmed) {
					ctx.ui.notify("Planner finish cancelled.", "info");
					return;
				}
				if (
					preview.state.contracts.dirty &&
					preview.state.contracts.touchedFiles.length > 0
				) {
					let contractDecision: "keep" | "remove" | undefined;
					if (hasPendingContractFinishDecision(preview.state)) {
						const keepLabel =
							"Keep AGENTS.md contracts - recommended durable project memory";
						const removeLabel =
							"Remove planner AGENTS.md changes - future plans may rediscover them";
						const choice = await ctx.ui.select(
							"Planner AGENTS.md contract changes",
							[keepLabel, removeLabel],
						);
						if (!choice) {
							ctx.ui.notify("Planner finish cancelled.", "info");
							return;
						}
						contractDecision = choice === keepLabel ? "keep" : "remove";
					}
					const contractPolicy = await applyPlannerContractFinishPolicy({
						fs,
						planPaths: createPlanStoragePaths(projectPaths, preview.planId),
						state: preview.state,
						decision: contractDecision,
					});
					if (contractPolicy.decision === "remove") {
						const status = await git.statusPorcelain({
							repoRoot: preview.worktreePath,
						});
						if (status.trim()) {
							await git.stageAll({ repoRoot: preview.worktreePath });
							await git.commit({
								repoRoot: preview.worktreePath,
								message: [
									"docs: remove planner contract updates",
									"",
									"Restore AGENTS.md files according to the user's /planner-finish decision.",
								].join("\n"),
							});
						}
					}
					ctx.ui.notify(contractPolicy.message, "info");
				}

				let deleteWorktreeSessions = true;
				const projectSession = await resolveProjectSessionForHandoff({
					fs,
					agentDir,
					projectRoot: projectPaths.projectRoot,
					preferredSessionFiles: [
						preview.lastRootSessionFile,
						preview.createdFromSessionFile,
					],
					parentSession: ctx.sessionManager.getSessionFile(),
					createIfMissing: false,
				});
				if (!projectSession.sessionFile) {
					ctx.ui.notify(
						"Original Pi JSONL session is missing. Planner will create a replacement project-root session before cleanup.",
						"warning",
					);
					deleteWorktreeSessions = await ctx.ui.confirm(
						"Delete completed worktree chat?",
						"The original Pi JSONL session is missing. Delete the completed planner worktree chat history after resuming a replacement project-root session?",
					);
					fallbackSession = await createPlannerHandoffSession({
						fs,
						agentDir,
						worktreePath: projectPaths.projectRoot,
						parentSession: ctx.sessionManager.getSessionFile(),
					});
				} else if (projectSession.recovered) {
					ctx.ui.notify(
						"Saved original Pi JSONL session path is missing or stale. Planner found another project-root session and will return there.",
						"warning",
					);
				}

				const finalized = await finalizeAcceptedPlan({
					fs,
					git,
					projectPaths,
				});
				acceptedPlanFinalized = true;
				const targetSessionFile = projectSession.sessionFile
					? projectSession.sessionFile
					: fallbackSession?.sessionFile;
				if (!targetSessionFile) {
					throw new Error(
						"Planner finished the result but could not resolve a project session for handoff.",
					);
				}
				resetPlanActiveCache(pi);
				await ctx.switchSession(targetSessionFile, {
					withSession: async (replacementCtx) => {
						if (fallbackSession) {
							replacementCtx.ui.notify(
								"Original Pi JSONL session was missing. Planner resumed in a replacement project-root session.",
								"warning",
							);
						}
						if (deleteWorktreeSessions) {
							await fs.removeDir(finalized.worktreeSessionDir);
						}
						await replacementCtx.sendUserMessage(
							buildAcceptedPlanCompletionPrompt({
								planId: finalized.planId,
								outputBranch: finalized.outputBranch,
								originalSessionMissing: !projectSession.sessionFile,
								preservedWorktreeChatDir: deleteWorktreeSessions
									? null
									: finalized.worktreeSessionDir,
							}),
							FOLLOW_UP_MESSAGE_OPTIONS,
						);
					},
				});
			} catch (error) {
				if (fallbackSession && !acceptedPlanFinalized) {
					await removePlannerHandoffBootstrapFile(
						fs,
						fallbackSession.sessionFile,
					);
				}
				ctx.ui.notify(`Planner finish failed: ${errorMessage(error)}`, "error");
			}
		},
	});
}

function registerPlannerTools(
	pi: ExtensionAPI,
	compactRuntime: PlannerCompactRuntimeState,
): void {
	pi.registerTool({
		name: PLANNER_STATUS_TOOL_NAME,
		label: "Planner Status",
		description:
			"Show the current pi-code-planner stage, instruction files, and allowed planner tools.",
		promptSnippet:
			"Use planner_status when a planner action is blocked or when you are unsure which planner step/tool is allowed.",
		parameters: EMPTY_TOOL_PARAMETERS as never,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const { fs, projectPaths } = await resolveRuntimeContext(ctx.cwd);
			await recordPlannerToolActivityForProject({ fs, projectPaths });
			const orchestration = await runPlannerOrchestrator({
				fs,
				git: gitRunner,
				projectPaths,
			});

			return {
				content: [{ type: "text", text: orchestration.statusText }],
				details: orchestration,
			};
		},
	});

	pi.registerTool({
		name: "planner_about",
		label: "Planner About",
		description:
			"Explain pi-code-planner behavior, current effective settings, default settings, and setting sources.",
		promptSnippet:
			"Use planner_about when the user asks what pi-code-planner is doing, what a planner setting means, or why a planner behavior is enabled. This tool is read-only.",
		parameters: EMPTY_TOOL_PARAMETERS as never,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const { fs, projectPaths } = await resolveRuntimeContext(ctx.cwd);
			const settings = await loadEffectivePlannerSettings({
				fs,
				projectPaths,
			});
			const text = buildPlannerAboutReport({
				settings,
				projectPaths,
				audience: "agent",
			});
			return {
				content: [{ type: "text", text }],
				details: {
					projectRoot: projectPaths.projectRoot,
					settings: settings.effective,
				},
			};
		},
	});

	for (const toolName of PLANNER_PLAN_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: plannerToolLabel(toolName),
			description: planToolDescription(toolName),
			promptSnippet:
				"Use planner_create_plan before project reads when the user asks to start a planner-controlled task.",
			parameters: CREATE_PLAN_TOOL_PARAMETERS as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { fs, projectPaths } = await resolveRuntimeContext(ctx.cwd);
				const result = await executePlannerPlanTool({
					fs,
					git: gitRunner,
					projectPaths,
					toolName,
					params,
				});

				if (result.status === "applied") {
					await recordPlannerToolActivityForProject({ fs, projectPaths });
					activatePlannerToolVisibility(pi);
				}

				return plannerToolResponse(result);
			},
		});
	}

	for (const toolName of PLANNER_GOAL_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: plannerToolLabel(toolName),
			description: goalToolDescription(toolName),
			promptSnippet:
				"Use planner goal tools during intake only. Draft goal.md before source reads and enter discovery only after explicit user approval.",
			parameters: goalToolParameters(toolName) as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { fs, projectPaths } = await resolveRuntimeContext(ctx.cwd);
				await recordPlannerToolActivityForProject({ fs, projectPaths });
				const result = await executePlannerGoalTool({
					fs,
					git: gitRunner,
					projectPaths,
					toolName,
					params,
				});
				return plannerToolResponse(result);
			},
		});
	}

	for (const toolName of PLANNER_QUESTION_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: plannerToolLabel(toolName),
			description: questionToolDescription(toolName),
			promptSnippet:
				"Use planner question tools during discovery/write_questions. Save evidence-based questions, show open questions to the user verbatim, wait for answers, then resolve them before continuing.",
			parameters: questionToolParameters(toolName) as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { fs, projectPaths } = await resolveRuntimeContext(ctx.cwd);
				await recordPlannerToolActivityForProject({ fs, projectPaths });
				const result = await executePlannerQuestionTool({
					fs,
					git: gitRunner,
					projectPaths,
					toolName,
					params,
				});
				return plannerToolResponse(result);
			},
		});
	}

	for (const toolName of PLANNER_TASK_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: plannerToolLabel(toolName),
			description: taskToolDescription(toolName),
			promptSnippet:
				"Use planner_task_upsert during planning/write_task_files. Pass semantic task fields only; the wrapper writes task.json, task.md, and empty TDD lifecycle artifacts.",
			parameters: TASK_UPSERT_TOOL_PARAMETERS as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { fs, projectPaths } = await resolveRuntimeContext(ctx.cwd);
				await recordPlannerToolActivityForProject({ fs, projectPaths });
				const result = await executePlannerTaskTool({
					fs,
					git: gitRunner,
					projectPaths,
					toolName,
					params,
				});
				return plannerToolResponse(result);
			},
		});
	}

	for (const toolName of PLANNER_CONTRACT_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: plannerToolLabel(toolName),
			description: contractToolDescription(toolName),
			promptSnippet:
				"Use planner contract tools for AGENTS.md local contracts. Scan/route/read before broad source reads; check/update contracts after each green TDD task before refactor.",
			parameters: contractToolParameters(toolName) as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { fs, projectPaths } = await resolveRuntimeContext(ctx.cwd);
				await recordPlannerToolActivityForProject({ fs, projectPaths });
				const result = await executePlannerContractTool({
					fs,
					git: gitRunner,
					projectPaths,
					toolName,
					params,
				});
				const freshCtx = await readActivePlanContext({ fs, projectPaths });
				if (freshCtx.status === "ready") {
					const inDiscoveryScan =
						freshCtx.state.stage === "discovery" &&
						freshCtx.state.step === "scan_project_structure";
					const complete = isContractChainTraversalComplete(freshCtx.state);
					const shouldGate = inDiscoveryScan && !complete;
					if (shouldGate !== isContractGateActive()) {
						setContractGateActive(shouldGate);
						updateToolVisibility(pi);
					}
				}
				return plannerToolResponse(result);
			},
		});
	}

	for (const toolName of PLANNER_STUCK_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: plannerToolLabel(toolName),
			description: stuckToolDescription(toolName),
			promptSnippet:
				"Use planner_report_stuck only when an execution attempt is actually stuck. Save evidence, diff, and next debug plan before planner-controlled compact.",
			parameters: STUCK_REPORT_TOOL_PARAMETERS as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const fs = createNodeFs();
				const git = gitRunner;
				const projectPaths = await createRuntimeProjectPaths(ctx.cwd);
				await recordPlannerToolActivityForProject({ fs, projectPaths });
				const result = await executePlannerStuckTool({
					fs,
					git,
					projectPaths,
					toolName,
					params,
				});
				if (result.status === "applied") {
					await maybeStartPlannerStuckCompact({
						ctx,
						fs,
						projectPaths,
					});
				}
				return plannerToolResponse(result);
			},
		});
	}

	for (const toolName of PLANNER_REFACTOR_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: plannerToolLabel(toolName),
			description: refactorToolDescription(toolName),
			promptSnippet:
				"Use planner_refactor_review during execution/refactor_task after inspecting the task diff. Pass semantic review fields; the wrapper writes refactor.md.",
			parameters: REFACTOR_REVIEW_TOOL_PARAMETERS as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { fs, projectPaths } = await resolveRuntimeContext(ctx.cwd);
				await recordPlannerToolActivityForProject({ fs, projectPaths });
				const result = await executePlannerRefactorTool({
					fs,
					git: gitRunner,
					projectPaths,
					toolName,
					params,
				});
				return plannerToolResponse(result);
			},
		});
	}

	for (const toolName of DOUBT_REVIEW_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: plannerToolLabel(toolName),
			description: doubtToolDescription(toolName),
			promptSnippet:
				"Use planner_doubt_review during finalize/doubt_review. List possible errors first, then prove or dismiss each one before calling anything a real bug.",
			parameters: doubtToolParameters(toolName) as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { fs, projectPaths } = await resolveRuntimeContext(ctx.cwd);
				await recordPlannerToolActivityForProject({ fs, projectPaths });
				const result = await executePlannerDoubtTool({
					fs,
					git: gitRunner,
					projectPaths,
					toolName,
					params,
				});
				return plannerToolResponse(result);
			},
		});
	}

	for (const toolName of PLANNER_ARTIFACT_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: plannerToolLabel(toolName),
			description: artifactToolDescription(toolName),
			promptSnippet: artifactToolPromptSnippet(toolName),
			parameters: artifactToolParameters(toolName) as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { fs, projectPaths } = await resolveRuntimeContext(ctx.cwd);
				await recordPlannerToolActivityForProject({ fs, projectPaths });
				const result = await executePlannerArtifactTool({
					fs,
					git: gitRunner,
					projectPaths,
					toolName,
					params,
				});
				return plannerToolResponse(result);
			},
		});
	}

	pi.registerTool({
		name: PLANNER_ARTIFACT_READ_TOOL_NAME,
		label: "Planner Artifact Read",
		description:
			"Read a planner-managed markdown artifact (request/goal/discovery/plan/questions/decisions/verify/final_summary, or a task's task/tdd/refactor) from the extension storage dir. Built-in read cannot reach these files.",
		promptSnippet:
			"Use planner_artifact_read to re-read any planner artifact (request, goal, discovery, plan, questions, decisions, verify, final_summary, task, tdd, refactor). They live outside the worktree, so the built-in read tool cannot reach them and security extensions that restrict the worktree will block it. Never guess a worktree path for these files.",
		parameters: ARTIFACT_READ_TOOL_PARAMETERS as never,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { fs, projectPaths } = await resolveRuntimeContext(ctx.cwd);
			await recordPlannerToolActivityForProject({ fs, projectPaths });
			const result = await executePlannerArtifactReadTool({
				fs,
				projectPaths,
				params,
			});
			return plannerToolResponse(result);
		},
	});

	pi.registerTool({
		name: "planner_skill_create",
		label: "Planner Skill Create",
		description:
			"Create a validated Pi skill from a proven reusable planner lesson for future planner sessions.",
		promptSnippet:
			"Use planner_skill_create only after a reusable lesson is proven by stuck/debug/refactor/doubt/final evidence. The wrapper writes YAML frontmatter and stores the skill for future planner sessions. At capture_skill step you MUST decide: create, update an existing skill, or explicitly record in decisions.md why no skill is needed.",
		parameters: SKILL_CREATE_TOOL_PARAMETERS as never,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { fs, projectPaths } = await resolveRuntimeContext(ctx.cwd);
			await recordPlannerToolActivityForProject({ fs, projectPaths });
			const result = await executePlannerSkillTool({
				fs,
				git: gitRunner,
				projectPaths,
				params,
			});
			return plannerToolResponse(result);
		},
	});

	pi.registerTool({
		name: "planner_skill_update",
		label: "Planner Skill Update",
		description:
			"Update an existing Pi skill by name with revised description and body.",
		promptSnippet:
			"Use planner_skill_update when an existing skill is outdated or wrong. Provide the exact name from the skill index. If no existing skill matches by meaning, use planner_skill_create instead. After updating, run the skill probe if applicable and call planner_git_discard_changes if it dirtied the worktree.",
		parameters: SKILL_UPDATE_TOOL_PARAMETERS as never,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { fs, projectPaths } = await resolveRuntimeContext(ctx.cwd);
			await recordPlannerToolActivityForProject({ fs, projectPaths });
			const result = await executePlannerSkillUpdateTool({
				fs,
				git: gitRunner,
				projectPaths,
				params,
			});
			return plannerToolResponse(result);
		},
	});

	for (const toolName of PLANNER_DEBUG_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: plannerToolLabel(toolName),
			description: debugToolDescription(toolName),
			promptSnippet:
				"Use planner debug tools only after planner_report_stuck. Record strategy, one focused probe, and result before patching. Use cleanup before planner_git_commit.",
			parameters: debugToolParameters(toolName) as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { fs, projectPaths } = await resolveRuntimeContext(ctx.cwd);
				await recordPlannerToolActivityForProject({ fs, projectPaths });
				const result = await executePlannerDebugTool({
					fs,
					git: gitRunner,
					projectPaths,
					toolName,
					params,
				});
				return plannerToolResponse(result);
			},
		});
	}

	for (const toolName of PLANNER_WORKFLOW_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: plannerToolLabel(toolName),
			description: workflowToolDescription(toolName),
			promptSnippet:
				"Use planner_status first, then call only the workflow transition listed as allowed for the current stage/step.",
			parameters: workflowToolParameters(toolName) as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const fs = createNodeFs();
				const git = gitRunner;
				const projectPaths = await createRuntimeProjectPaths(ctx.cwd);
				await recordPlannerToolActivityForProject({ fs, projectPaths });
				const result = await executePlannerWorkflowTool({
					fs,
					git,
					projectPaths,
					toolName,
					params,
				});
				const compact = await maybeStartPlannerControlledCompact({
					ctx,
					fs,
					git,
					projectPaths,
					compactRuntime,
					toolName,
					transitionStatus: result.result.status,
				});

				return {
					content: [
						{
							type: "text",
							text: [result.text, compact?.text].filter(Boolean).join("\n\n"),
						},
					],
					details: compact ? { ...result, compact } : result,
				};
			},
		});
	}

	for (const toolName of PLANNER_RECOVERY_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: plannerToolLabel(toolName),
			description: recoveryToolDescription(toolName),
			promptSnippet:
				"Use planner_recovery_inspect when planner_status reports recovery or user-decision gating. Use planner_recovery_resume only after inspection shows no blocking git or worktree issues. Recovery tools never reset or delete git state.",
			parameters: recoveryToolParameters(toolName) as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { fs, projectPaths } = await resolveRuntimeContext(ctx.cwd);
				await recordPlannerToolActivityForProject({ fs, projectPaths });
				const result = await executePlannerRecoveryTool({
					fs,
					git: gitRunner,
					projectPaths,
					toolName,
					params,
				});

				return plannerToolResponse(result);
			},
		});
	}

	pi.registerTool({
		name: PLANNER_RECOVERY_REPORT_TOOL_NAME,
		label: "Planner Recovery Report",
		description:
			"Prepare a sanitized diagnostics report when the planner is detected stuck, for the user to review and optionally file as a GitHub issue. The report contains only planner tool names, applied/blocked status, and a generalized state snapshot with pseudonymized task ids — no arguments, code, paths, titles, or descriptions. It writes a local file and never sends anything itself.",
		promptSnippet:
			"Call planner_recovery_report only when the planner is genuinely stuck (repeated blocked transitions, a long stall, or after a recovery call). It unlocks only once stuck-detection fires; otherwise it returns blocked. After it writes the report, relay its instructions to the user and continue with planner_recovery_inspect / planner_recovery_resume to get unstuck.",
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: false,
		} as never,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const { fs, projectPaths } = await resolveRuntimeContext(ctx.cwd);
			const settings = await loadEffectivePlannerSettings({ fs, projectPaths });
			const diag = settings.effective.diagnostics;
			const result = await executePlannerRecoveryReportTool({
				fs,
				git: gitRunner,
				projectPaths,
				thresholds: {
					blockedTransitions: diag.blockedTransitions,
					stuckMs: diag.stuckMinutes * MS_PER_MINUTE,
				},
				modelId: resolveSessionModelId(ctx),
			});
			return plannerToolResponse(result);
		},
	});

	for (const toolName of PLANNER_GIT_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: plannerToolLabel(toolName),
			description: gitToolDescription(toolName),
			promptSnippet:
				"Use planner git tools instead of raw git while a planner plan is active. Call planner_status first and only use allowed git wrappers.",
			parameters: gitToolParameters(toolName) as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { fs, projectPaths } = await resolveRuntimeContext(ctx.cwd);
				await recordPlannerToolActivityForProject({ fs, projectPaths });
				const result = await executePlannerGitTool({
					fs,
					git: gitRunner,
					projectPaths,
					toolName,
					params,
				});

				return plannerToolResponse(result);
			},
		});
	}

	pi.registerTool({
		name: PLANNER_EXEC_TOOL_NAME,
		label: "Planner Exec",
		description:
			"Run a shell command in the planner worktree with a configurable timeout. The idle watchdog is suspended for the entire duration so a long-running command does not trigger a spurious wake-up.",
		promptSnippet:
			"Use planner_exec for any command that may take more than a few seconds (builds, test suites, installs, codegen). While planner_exec is running the idle watchdog is paused, so you will not receive an idle wake-up mid-execution. Omit timeoutSeconds to use the default (240 s); set it explicitly only when the command is expected to take longer, up to the configured maximum.",
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description:
						"Shell command to run. Executed by the system shell (sh on POSIX, cmd on Windows).",
				},
				timeoutSeconds: {
					type: "number",
					description:
						"Optional timeout in seconds. Defaults to exec.defaultTimeoutSeconds (240). Capped at exec.maxTimeoutSeconds (1800). The process is killed on timeout.",
				},
				cwd: {
					type: "string",
					description:
						"Optional working directory for the command. Defaults to the planner worktree root.",
				},
			},
			required: ["command"],
			additionalProperties: false,
		} as never,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { fs, projectPaths } = await resolveRuntimeContext(ctx.cwd);
			const settings = await loadEffectivePlannerSettings({ fs, projectPaths });
			await recordPlannerToolActivityForProject({ fs, projectPaths });
			const context = await readActivePlanContext({ fs, projectPaths });
			if (context.status !== "ready") {
				return {
					content: [
						{ type: "text", text: "planner_exec: no active plan found." },
					],
					details: { text: "planner_exec: no active plan found." },
				};
			}
			const result = await executePlannerExecTool({
				params: params as {
					command: string;
					timeoutSeconds?: number;
					cwd?: string;
				},
				fs,
				planPaths: context.planPaths,
				settings: settings.effective.exec,
				worktreePath: ctx.cwd,
			});
			return plannerToolResponse(result);
		},
	});
}

function registerPlannerCompactEvents(
	pi: ExtensionAPI,
	compactRuntime: PlannerCompactRuntimeState,
): void {
	pi.on("session_compact", async (_event, ctx) => {
		consumePlannerControlledCompact(compactRuntime);

		const fs = createNodeFs();
		let projectPaths: ProjectStoragePaths;
		try {
			projectPaths = await resolveProjectStoragePaths({
				fs,
				agentDir: getAgentDir(),
				cwd: ctx.cwd,
			});
		} catch {
			return;
		}

		const preflight = await runPlannerPreflight({
			fs,
			git: gitRunner,
			projectPaths,
		});
		if (preflight.context.status !== "ready") {
			return;
		}

		const sections = await collectAutoCompactInstructionSections({
			fs,
			projectPaths,
			preflight,
		});
		const message = buildPlannerPostCompactMessage({ preflight, sections });
		enqueuePlannerPostCompactMessage({
			message,
			isIdle: ctx.isIdle(),
			hasPendingMessages: ctx.hasPendingMessages(),
			sendUserMessage: (content, options) =>
				pi.sendUserMessage(content, options as never),
		});
	});
}

function registerPlannerIdleWatchdog(
	pi: ExtensionAPI,
	runtime: PlannerIdleRuntimeState,
): void {
	pi.on("session_start", async (_event, ctx) => {
		runtime.latestCwd = ctx.cwd;
	});
	pi.on("tool_call", async (_event, ctx) => {
		runtime.latestCwd = ctx.cwd;
	});

	if (runtime.timer) {
		return;
	}
	runtime.timer = setInterval(() => {
		void runPlannerIdleWatchdogTick(pi, runtime);
	}, IDLE_WATCHDOG_POLL_MS);
	runtime.timer.unref?.();
}

async function runPlannerIdleWatchdogTick(
	pi: ExtensionAPI,
	runtime: PlannerIdleRuntimeState,
): Promise<void> {
	if (!runtime.latestCwd || runtime.checking) {
		return;
	}
	if (!isPlanActive()) {
		return;
	}
	runtime.checking = true;
	try {
		const fs = createNodeFs();
		const projectPaths = await createRuntimeProjectPaths(runtime.latestCwd);
		const settings = await loadEffectivePlannerSettings({ fs, projectPaths });
		const context = await readActivePlanContext({ fs, projectPaths });
		if (context.status !== "ready") {
			return;
		}
		const now = Date.now();
		const decision = evaluatePlannerIdleWake({
			state: context.state,
			settings: settings.effective.idle,
			now,
		});
		if (decision.action === "initialize") {
			await updatePlanState(fs, context.planPaths, (state) =>
				initializePlannerToolActivity(state, decision.timestamp),
			);
			return;
		}
		if (decision.action !== "wake") {
			return;
		}
		await updatePlanState(fs, context.planPaths, (state) =>
			markPlannerIdleWakeQueued(state, decision.timestamp),
		);
		try {
			pi.sendUserMessage(decision.message, FOLLOW_UP_MESSAGE_OPTIONS as never);
		} catch (error) {
			await updatePlanState(fs, context.planPaths, (state) => ({
				...state,
				lastIdleWakeAt: null,
				idleWakeInFlight: false,
			}));
			throw error;
		}
	} catch {
		// Idle wake is best-effort. Explicit planner tools remain the source of truth.
	} finally {
		runtime.checking = false;
	}
}

async function recordPlannerToolActivityForCwd(cwd: string): Promise<void> {
	try {
		const fs = createNodeFs();
		const projectPaths = await createRuntimeProjectPaths(cwd);
		await recordPlannerToolActivityForProject({ fs, projectPaths });
	} catch {
		// Activity timestamps are advisory; planner state remains authoritative.
	}
}

async function recordPlannerToolActivityForProject(input: {
	fs: ReturnType<typeof createNodeFs>;
	projectPaths: ProjectStoragePaths;
	now?: number;
}): Promise<void> {
	try {
		const context = await readActivePlanContext({
			fs: input.fs,
			projectPaths: input.projectPaths,
		});
		if (context.status !== "ready") {
			return;
		}
		await updatePlanState(input.fs, context.planPaths, (state) =>
			markPlannerToolActivity(state, input.now ?? Date.now()),
		);
	} catch {
		// Activity timestamps must never block the actual planner tool result.
	}
}

/** Map a tool result to a diagnostics status without throwing on odd shapes. */
function deriveToolEventStatus(result: unknown): PlannerToolStatus {
	if (!result || typeof result !== "object") return "applied";
	const record = result as { isError?: unknown; details?: unknown };
	if (record.isError === true) return "error";
	const details = record.details;
	if (details && typeof details === "object") {
		const status = (details as { status?: unknown }).status;
		if (status === "blocked") return "blocked";
	}
	return "applied";
}

/**
 * Append one planner tool outcome to the plan diagnostics sidecar. Best-effort
 * and fully isolated: it must never affect the tool result. Only planner_* tools
 * are recorded, and only their names/status — never arguments.
 */
async function recordPlannerDiagnosticsEventForProject(input: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	tool: string;
	status: PlannerToolStatus;
}): Promise<void> {
	if (!input.tool.startsWith("planner_")) return;
	try {
		const fs = createNodeFs();
		const projectPaths = await createRuntimeProjectPaths(input.ctx.cwd);
		const context = await readActivePlanContext({ fs, projectPaths });
		if (context.status !== "ready") return;
		const record = await recordPlannerToolEvent(fs, context.planPaths, {
			ts: Date.now(),
			tool: input.tool,
			status: input.status,
			stage: context.state.stage,
			step: context.state.step,
			task: context.state.activeTaskId,
		});

		// Re-evaluate stuck-detection and unlock the (otherwise hidden) recovery
		// report tool the moment the planner looks stuck.
		const settings = await loadEffectivePlannerSettings({ fs, projectPaths });
		const diag = settings.effective.diagnostics;
		const unlocked =
			diag.enabled &&
			evaluatePlannerStuck(record, Date.now(), {
				blockedTransitions: diag.blockedTransitions,
				stuckMs: diag.stuckMinutes * MS_PER_MINUTE,
			}).stuck;
		if (setRecoveryReportUnlocked(unlocked)) {
			updateToolVisibility(input.pi);
		}
	} catch {
		// Diagnostics must never break the actual planner tool result.
	}
}

/** Best-effort current model id (provider/modelId) from the session entries. */
function resolveSessionModelId(ctx: ExtensionContext): string | null {
	try {
		const entries = ctx.sessionManager.getEntries() as unknown[];
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const modelId = extractModelId(entries[index]);
			if (modelId) return modelId;
		}
	} catch {
		// The model id is a convenience field; never block the report on it.
	}
	return null;
}

function extractModelId(entry: unknown): string | null {
	if (!entry || typeof entry !== "object") return null;
	const candidates: unknown[] = [
		entry,
		(entry as { message?: unknown }).message,
	];
	for (const candidate of candidates) {
		if (!candidate || typeof candidate !== "object") continue;
		const record = candidate as { provider?: unknown; modelId?: unknown };
		if (typeof record.modelId === "string" && record.modelId.length > 0) {
			return typeof record.provider === "string" && record.provider.length > 0
				? `${record.provider}/${record.modelId}`
				: record.modelId;
		}
	}
	return null;
}

async function maybeStartPlannerControlledCompact(input: {
	ctx: ExtensionContext;
	fs: ReturnType<typeof createNodeFs>;
	git: NodeGitRunner;
	projectPaths: ProjectStoragePaths;
	compactRuntime: PlannerCompactRuntimeState;
	toolName: PlannerWorkflowToolName;
	transitionStatus: "applied" | "blocked";
}): Promise<{ text: string; customInstructions: string } | null> {
	if (
		input.toolName !== "planner_request_compact" ||
		input.transitionStatus !== "applied"
	) {
		return null;
	}

	const preflight = await runPlannerPreflight({
		fs: input.fs,
		git: input.git,
		projectPaths: input.projectPaths,
	});
	const bundle = await buildPlannerCompactInstructionBundle({
		fs: input.fs,
		projectPaths: input.projectPaths,
		preflight,
		sectionName: "manual-compact",
	});

	markPlannerControlledCompactStarted(input.compactRuntime);
	setTimeout(() => {
		input.ctx.compact({
			customInstructions: bundle.text,
			onComplete: () => {
				input.ctx.ui.notify("Planner compact completed.", "info");
			},
			onError: (error) => {
				clearPlannerControlledCompact(input.compactRuntime);
				input.ctx.ui.notify(formatPlannerCompactFailure(error), "error");
			},
		});
	}, 0);

	return {
		text: "Planner-controlled compact was requested through the Pi compact API. Do not continue until compaction finishes; then call planner_complete_compact followed by planner_status.",
		customInstructions: bundle.text,
	};
}

async function maybeStartPlannerStuckCompact(input: {
	ctx: ExtensionContext;
	fs: ReturnType<typeof createNodeFs>;
	projectPaths: ProjectStoragePaths;
}): Promise<void> {
	const instructions = await buildPlannerStuckCompactInstructions({
		fs: input.fs,
		projectPaths: input.projectPaths,
	});
	if (!instructions) {
		return;
	}
	setTimeout(() => {
		input.ctx.compact({
			customInstructions: instructions,
			onComplete: () => {
				input.ctx.ui.notify("Planner stuck compact completed.", "info");
			},
			onError: (error) => {
				input.ctx.ui.notify(formatPlannerCompactFailure(error), "error");
			},
		});
	}, 0);
}

function registerPlannerBuiltinToolGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		void recordPlannerToolActivityForCwd(ctx.cwd);

		let tool: PlannerBuiltinToolCall;
		if (isToolCallEventType("bash", event)) {
			tool = { toolName: "bash", command: event.input.command };
		} else if (isToolCallEventType("write", event)) {
			tool = { toolName: "write", path: event.input.path };
		} else if (isToolCallEventType("edit", event)) {
			tool = { toolName: "edit", path: event.input.path };
		} else {
			return;
		}

		const state = await readPlannerBuiltinGuardState(ctx.cwd);
		const decision = checkPlannerBuiltinToolAllowed({
			cwd: ctx.cwd,
			tool,
			state,
		});

		if (!decision.allow) {
			return {
				block: true,
				reason:
					decision.reason ??
					"Built-in Pi tool is blocked while pi-code-planner is active.",
			};
		}
	});
}

// Words that should render uppercase rather than title-cased in tool labels.
const TOOL_LABEL_ACRONYMS: Record<string, string> = { tdd: "TDD" };

/**
 * Derive a tool's display label from its name: `planner_create_plan` ->
 * `Planner Create Plan`. Replaces a dozen per-tool switch functions that all
 * encoded this same title-casing, with an acronym override for words like TDD.
 */
function plannerToolLabel(toolName: string): string {
	return toolName
		.split("_")
		.map(
			(word) =>
				TOOL_LABEL_ACRONYMS[word] ??
				word.charAt(0).toUpperCase() + word.slice(1),
		)
		.join(" ");
}

function planToolDescription(toolName: PlannerPlanToolName): string {
	switch (toolName) {
		case "planner_create_plan":
			return "Create project storage, plan files, and the plan branch/worktree. Starts intake so the model can draft goal.md before discovery.";
	}
}

function goalToolDescription(toolName: PlannerGoalToolName): string {
	switch (toolName) {
		case "planner_goal_submit":
			return "Write the normalized goal.md draft, short title, and short planner-list description. Waits for explicit user review and does not allow discovery.";
		case "planner_goal_decide":
			return "Record explicit user approval or revision feedback for goal.md. Approval opens discovery; revision returns to goal drafting.";
	}
}

function goalToolParameters(toolName: PlannerGoalToolName) {
	switch (toolName) {
		case "planner_goal_submit":
			return GOAL_SUBMIT_TOOL_PARAMETERS;
		case "planner_goal_decide":
			return GOAL_DECIDE_TOOL_PARAMETERS;
	}
}

function questionToolDescription(toolName: PlannerQuestionToolName): string {
	switch (toolName) {
		case "planner_questions_submit":
			return "Write evidence-based discovery questions or explicitly record that none remain. Open questions must be shown to the user.";
		case "planner_questions_resolve":
			return "Persist explicit user answers for discovery questions before planning can continue.";
	}
}

function questionToolParameters(toolName: PlannerQuestionToolName) {
	switch (toolName) {
		case "planner_questions_submit":
			return QUESTIONS_SUBMIT_TOOL_PARAMETERS;
		case "planner_questions_resolve":
			return QUESTIONS_RESOLVE_TOOL_PARAMETERS;
	}
}

function taskToolDescription(toolName: PlannerTaskToolName): string {
	switch (toolName) {
		case "planner_task_upsert":
			return "Create or replace one behavioral task from semantic fields. The wrapper writes task.json, task.md, and empty TDD lifecycle artifacts.";
	}
}

function contractToolDescription(toolName: PlannerContractToolName): string {
	switch (toolName) {
		case "planner_contract_scan":
			return "Discover AGENTS.md canonical contracts and read-only context files in bounded batches without reading every file body.";
		case "planner_contract_route":
			return "Choose the relevant AGENTS.md/read-only context chain for target files or declared task scope.";
		case "planner_contract_read":
			return "Read an AGENTS.md or read-only context file in chunks and preserve pendingRead state across compact.";
		case "planner_contract_check":
			return "Record the mandatory post-implementation check that decides whether AGENTS.md local contracts need an update.";
		case "planner_contract_upsert":
			return "Create or update a validated pi-code-planner managed AGENTS.md block with parent links and child routing.";
		case "planner_contract_decide":
			return "Keep or remove planner-created AGENTS.md contract changes before accepted finish.";
	}
}

function contractToolParameters(toolName: PlannerContractToolName) {
	switch (toolName) {
		case "planner_contract_scan":
			return CONTRACT_SCAN_TOOL_PARAMETERS;
		case "planner_contract_route":
			return CONTRACT_ROUTE_TOOL_PARAMETERS;
		case "planner_contract_read":
			return CONTRACT_READ_TOOL_PARAMETERS;
		case "planner_contract_check":
			return CONTRACT_CHECK_TOOL_PARAMETERS;
		case "planner_contract_upsert":
			return CONTRACT_UPSERT_TOOL_PARAMETERS;
		case "planner_contract_decide":
			return CONTRACT_DECIDE_TOOL_PARAMETERS;
	}
}

function stuckToolDescription(toolName: PlannerStuckToolName): string {
	switch (toolName) {
		case "planner_report_stuck":
			return "Record a stuck execution attempt with full git diff artifacts and start a planner compact for a different debug attempt.";
	}
}

function refactorToolDescription(toolName: PlannerRefactorToolName): string {
	switch (toolName) {
		case "planner_refactor_review":
			return "Write the structured refactor.md review from semantic fields during execution/refactor_task.";
	}
}

function doubtToolDescription(toolName: PlannerDoubtReviewToolName): string {
	switch (toolName) {
		case "planner_doubt_review":
			return "Write the structured final doubt review. Suspected bugs must be proven or classified as probes/non-bugs before user acceptance.";
	}
}

function doubtToolParameters(toolName: PlannerDoubtReviewToolName) {
	switch (toolName) {
		case "planner_doubt_review":
			return DOUBT_REVIEW_TOOL_PARAMETERS;
	}
}

function artifactToolDescription(toolName: PlannerArtifactToolName): string {
	switch (toolName) {
		case "planner_plan_submit":
			return "Write plan.md from a single content argument during planning/draft_plan (and change-request replans).";
		case "planner_discovery_submit":
			return "Write discovery.md from a body argument plus a verificationProtocol list that becomes the ## Verification Protocol section.";
		case "planner_tdd_submit":
			return "Fill or update tdd.md for the active task from structured section fields. Built-in edit/write cannot modify tdd.md.";
		case "planner_summary_submit":
			return "Write final_summary.md from a single content argument during finalize/write_final_summary.";
	}
}

function artifactToolPromptSnippet(toolName: PlannerArtifactToolName): string {
	switch (toolName) {
		case "planner_plan_submit":
			return "Use planner_plan_submit to save plan.md instead of hand-formatting the file.";
		case "planner_discovery_submit":
			return "Use planner_discovery_submit so the ## Verification Protocol section is always well-formed.";
		case "planner_tdd_submit":
			return "Use planner_tdd_submit to fill tdd.md section by section; it validates the required fields immediately.";
		case "planner_summary_submit":
			return "Use planner_summary_submit to save final_summary.md.";
	}
}

function artifactToolParameters(toolName: PlannerArtifactToolName) {
	switch (toolName) {
		case "planner_plan_submit":
			return PLAN_SUBMIT_TOOL_PARAMETERS;
		case "planner_discovery_submit":
			return DISCOVERY_SUBMIT_TOOL_PARAMETERS;
		case "planner_tdd_submit":
			return TDD_SUBMIT_TOOL_PARAMETERS;
		case "planner_summary_submit":
			return SUMMARY_SUBMIT_TOOL_PARAMETERS;
	}
}

function debugToolDescription(toolName: PlannerDebugToolName): string {
	switch (toolName) {
		case "planner_debug_strategy":
			return "Record platform-independent debug channels and cleanup plan after a stuck attempt.";
		case "planner_debug_probe":
			return "Record exactly one focused debug probe before patching from a stuck state.";
		case "planner_debug_result":
			return "Record the observed probe signal and the next action before patching or asking the user.";
		case "planner_debug_cleanup":
			return "Remove planner debug artifacts from the worktree and clear the commit guard.";
	}
}

function debugToolParameters(toolName: PlannerDebugToolName) {
	switch (toolName) {
		case "planner_debug_strategy":
			return DEBUG_STRATEGY_TOOL_PARAMETERS;
		case "planner_debug_probe":
			return DEBUG_PROBE_TOOL_PARAMETERS;
		case "planner_debug_result":
			return DEBUG_RESULT_TOOL_PARAMETERS;
		case "planner_debug_cleanup":
			return DEBUG_CLEANUP_TOOL_PARAMETERS;
	}
}

function gitToolDescription(toolName: PlannerGitToolName): string {
	switch (toolName) {
		case "planner_git_inspect":
			return "Inspect planner-controlled git reality without raw shell git.";
		case "planner_git_init":
			return "Initialize git for the project during the init/check_git step.";
		case "planner_git_commit":
			return "Create a planner-controlled commit.";
		case "planner_git_discard_changes":
			return "Discard all uncommitted worktree changes (git restore .). Use only at capture_skill after a skill probe to clean up side effects.";
		case "planner_git_create_task_branch":
			return "Create and switch to the current task branch from the plan branch.";
		case "planner_git_create_refactor_branch":
			return "Create and switch to a refactor branch for the active task.";
		case "planner_git_merge_refactor_to_task":
			return "Merge the refactor branch back into the current task branch.";
		case "planner_git_merge_task_to_plan":
			return "Merge the current task branch into the plan branch.";
	}
}

function gitToolParameters(toolName: PlannerGitToolName) {
	switch (toolName) {
		case "planner_git_commit":
			return GIT_MESSAGE_TOOL_PARAMETERS;
		case "planner_git_create_task_branch":
			return GIT_TASK_TOOL_PARAMETERS;
		case "planner_git_merge_refactor_to_task":
		case "planner_git_merge_task_to_plan":
			return GIT_OPTIONAL_MESSAGE_TOOL_PARAMETERS;
		case "planner_git_inspect":
			return GIT_INSPECT_TOOL_PARAMETERS;
		case "planner_git_init":
		case "planner_git_create_refactor_branch":
		case "planner_git_discard_changes":
			return EMPTY_TOOL_PARAMETERS;
	}
}

function recoveryToolDescription(toolName: PlannerRecoveryToolName): string {
	switch (toolName) {
		case "planner_recovery_inspect":
			return "Read-only recovery report: expected planner state, actual git/worktree reality, issue classification, and safe/destructive options.";
		case "planner_recovery_resume":
			return "Resume from recovery to an explicit stage/step only when blocking git or worktree issues are gone.";
	}
}

function recoveryToolParameters(toolName: PlannerRecoveryToolName) {
	switch (toolName) {
		case "planner_recovery_inspect":
			return EMPTY_TOOL_PARAMETERS;
		case "planner_recovery_resume":
			return RESUME_RECOVERY_TOOL_PARAMETERS;
	}
}

function workflowToolDescription(toolName: PlannerWorkflowToolName): string {
	switch (toolName) {
		case "planner_start_step":
			return "Start the current pending planner step after planner_status says start_step is allowed.";
		case "planner_finish_step":
			return "Finish the current running planner step and atomically open its recorded next step.";
		case "planner_advance_step":
			return "Move from a completed planner step to its recorded next step.";
		case "planner_fail_step":
			return "Mark the current planner step as failed so the model can retry through planner_status.";
		case "planner_block_step":
			return "Mark the current planner step as blocked, optionally requiring a user decision.";
		case "planner_retry_step":
			return "Return a failed or non-user-blocked planner step to pending.";
		case "planner_request_compact":
			return "Request planner-controlled compaction for a compact step.";
		case "planner_complete_compact":
			return "Complete a planner compact gate after Pi compaction has finished.";
		case "planner_enter_recovery":
			return "Enter planner recovery when planner_status or a workflow transition requires recovery.";
		case "planner_resume_after_recovery":
			return "Resume the planner from recovery into an explicit valid stage and step.";
	}
}

function workflowToolParameters(toolName: PlannerWorkflowToolName) {
	switch (toolName) {
		case "planner_finish_step":
			return COMPLETE_STEP_TOOL_PARAMETERS;
		case "planner_fail_step":
			return REASON_TOOL_PARAMETERS;
		case "planner_block_step":
		case "planner_enter_recovery":
			return BLOCK_STEP_TOOL_PARAMETERS;
		case "planner_resume_after_recovery":
			return RESUME_RECOVERY_TOOL_PARAMETERS;
		case "planner_request_compact":
			return OPTIONAL_REASON_TOOL_PARAMETERS;
		case "planner_start_step":
		case "planner_advance_step":
		case "planner_retry_step":
		case "planner_complete_compact":
			return EMPTY_TOOL_PARAMETERS;
	}
}

/**
 * Resolve the per-invocation runtime context: a fresh node fs handle, the
 * agent dir, and the project storage paths for `cwd`. Command and tool
 * handlers need all three together, so returning them as a unit avoids the
 * repeated three-line `createNodeFs()` / `getAgentDir()` /
 * `resolveProjectStoragePaths(...)` preamble (and the bug of creating two fs
 * handles when only paths were wanted).
 */
async function resolveRuntimeContext(cwd: string) {
	const fs = createNodeFs();
	const agentDir = getAgentDir();
	const projectPaths = await resolveProjectStoragePaths({
		fs,
		agentDir,
		cwd,
	});
	return { fs, agentDir, projectPaths };
}

/**
 * Paths-only view of {@link resolveRuntimeContext} for callers that do not
 * need the fs handle.
 */
async function createRuntimeProjectPaths(cwd: string) {
	return (await resolveRuntimeContext(cwd)).projectPaths;
}

/**
 * Wrap a planner tool-execution result in the Pi tool-response envelope. Nearly
 * every wrapper tool returns the result's `text` as the single content block
 * and the whole result as `details`; this hoists that repeated literal.
 */
function plannerToolResponse<T extends { text: string }>(result: T) {
	return {
		content: [{ type: "text" as const, text: result.text }],
		details: result,
	};
}

interface PlannerCreatePlanToolDetails {
	state?: { worktreePath?: string | null };
	plan?: { planId?: string };
	settings?: {
		effective?: {
			metadata?: { titleLanguage?: string; descriptionLanguage?: string };
		};
	};
}

/**
 * Extract the worktree path, resolved plan id, and content languages from a
 * planner_create_plan result. The /planner-create and /planner-improve
 * handoffs read the same fields out of the same loosely-typed `details`
 * payload. `fallbackPlanId` is used when the result omits the plan id.
 */
function readPlannerCreateOutcome(details: unknown, fallbackPlanId: string) {
	const typed = details as PlannerCreatePlanToolDetails;
	const metadata = typed.settings?.effective?.metadata;
	const descriptionLanguage = metadata?.descriptionLanguage ?? DEFAULT_LANGUAGE;
	return {
		worktreePath: typed.state?.worktreePath ?? null,
		createdPlanId: typed.plan?.planId ?? fallbackPlanId,
		descriptionLanguage,
		titleLanguage: metadata?.titleLanguage ?? descriptionLanguage,
	};
}

async function readPlannerBuiltinGuardState(
	cwd: string,
): Promise<PlannerBuiltinGuardState> {
	try {
		const fs = createNodeFs();
		const projectPaths = await resolveProjectStoragePaths({
			fs,
			agentDir: getAgentDir(),
			cwd,
		});
		const context = await readActivePlanContext({ fs, projectPaths });
		// Use isPlanActive() instead of activePlanId to determine if plan is active.
		// This ensures the guard is only active when /planner-create or /planner-resume
		// explicitly activates the plan. On fresh session start (project root),
		// isPlanActive() returns false and the guard stays inactive.
		const active = isPlanActive();
		if (context.status === "ready" && active) {
			return {
				activePlanId: context.activePlanId,
				active: true,
				projectPaths,
				planPaths: context.planPaths,
				planState: context.state,
			};
		}
		return {
			activePlanId: active ? context.activePlanId : null,
			active: active,
			projectPaths,
			planPaths: null,
			planState: null,
		};
	} catch {
		return {
			activePlanId: null,
			active: false,
			projectPaths: null,
			planPaths: null,
			planState: null,
		};
	}
}

function filterPlannerSkillInventory(
	skills: readonly PlannerSkillSummary[],
	query: string,
): PlannerSkillSummary[] {
	if (!query) {
		return [...skills];
	}
	const needles = query.toLowerCase().split(/\s+/).filter(Boolean);
	return skills.filter((skill) => {
		const haystack = [
			skill.name,
			skill.description,
			skill.sourceKind,
			skill.skillPath,
			...skill.tags,
		]
			.join("\n")
			.toLowerCase();
		return needles.every((needle) => haystack.includes(needle));
	});
}

function plannerSkillOptionLabel(skill: PlannerSkillSummary): string {
	const tags = skill.tags.length > 0 ? skill.tags.join(", ") : "no tags";
	return [
		`${skill.name} [${skill.sourceKind}]`,
		`  ${skill.description}`,
		`  tags: ${tags}`,
	].join("\n");
}

function buildPlannerSkillDetailsMarkdown(skill: PlannerSkillSummary): string {
	const tags =
		skill.tags.length > 0
			? skill.tags.map((tag) => `\`${tag}\``).join(", ")
			: "(none)";
	return [
		"# Planner Skill",
		"",
		`- name: \`${skill.name}\``,
		`- sourceKind: \`${skill.sourceKind}\``,
		`- tags: ${tags}`,
		`- updatedAt: ${new Date(skill.updatedAt).toISOString()}`,
		`- skillPath: \`${skill.skillPath}\``,
		"",
		"## Description",
		"",
		skill.description,
		"",
		"Use `/planner-skills` again to delete this skill if it is too narrow, stale, or noisy.",
	].join("\n");
}

function parseSinglePlanIdArg(args: string): string | null {
	const trimmed = args.trim();
	return trimmed.length > 0 && !/\s/.test(trimmed) ? trimmed : null;
}

function parsePlannerDeleteCommandArgs(
	args: string,
): { planId: string } | null {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		return null;
	}
	const planIds: string[] = [];
	for (const token of tokens) {
		if (token.startsWith("--")) {
			return null;
		}
		planIds.push(token);
	}
	return planIds.length === 1 ? { planId: planIds[0] } : null;
}

function parsePlannerRenameCommandArgs(
	args: string,
): { planId?: string; title?: string } | null {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return {};
	let planId: string | undefined;
	const titleParts: string[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--id") {
			const value = tokens[index + 1];
			if (!value || value.startsWith("--")) return null;
			planId = value;
			index += 1;
			continue;
		}
		if (token.startsWith("--id=")) {
			const value = token.slice("--id=".length);
			if (!value) return null;
			planId = value;
			continue;
		}
		if (token.startsWith("--")) return null;
		titleParts.push(token);
	}
	const title = titleParts.join(" ").trim();
	return {
		...(planId ? { planId } : {}),
		...(title ? { title } : {}),
	};
}

async function resolveRenameCommandArgs(input: {
	args: string;
	ctx: ExtensionCommandContext;
	fs: ReturnType<typeof createNodeFs>;
	projectPaths: ProjectStoragePaths;
}): Promise<{ planId?: string; title: string } | null> {
	const parsed = parsePlannerRenameCommandArgs(input.args);
	if (!parsed) {
		input.ctx.ui.notify(
			"Usage: /planner-rename [--id <plan-id>] [title]",
			"error",
		);
		return null;
	}
	if (parsed.title) {
		return { planId: parsed.planId, title: parsed.title };
	}

	const planId = await selectPlannerPlanId({
		ui: input.ctx.ui,
		fs: input.fs,
		projectPaths: input.projectPaths,
		title: "Rename planner plan",
	});
	if (!planId) {
		input.ctx.ui.notify("Planner rename cancelled.", "info");
		return null;
	}
	const title = await inputPlannerRenameTitle({ ui: input.ctx.ui });
	if (!title) {
		return null;
	}
	return { planId, title };
}

async function resolveDeleteCommandArgs(input: {
	args: string;
	ctx: ExtensionCommandContext;
	fs: ReturnType<typeof createNodeFs>;
	projectPaths: ProjectStoragePaths;
}): Promise<{ planId: string; deleteActive: boolean } | null> {
	const direct = parsePlannerDeleteCommandArgs(input.args);
	if (direct) {
		const { project, plans } = await readPlannerPlanList({
			fs: input.fs,
			projectPaths: input.projectPaths,
		});
		const plan = plans.find((entry) => entry.planId === direct.planId);
		if (plan) {
			const confirmed = await confirmPlannerDelete({
				ui: input.ctx.ui,
				planId: direct.planId,
				active: plan.active,
			});
			if (!confirmed) {
				input.ctx.ui.notify("Planner delete cancelled.", "info");
				return null;
			}
		}
		return {
			planId: direct.planId,
			deleteActive: project?.activePlanId === direct.planId,
		};
	}
	if (input.args.trim().length > 0) {
		input.ctx.ui.notify("Usage: /planner-delete [plan-id]", "error");
		return null;
	}

	const { project, plans } = await readPlannerPlanList({
		fs: input.fs,
		projectPaths: input.projectPaths,
	});
	const selected = await selectPlannerPlanIdFromList({
		ui: input.ctx.ui,
		plans,
		title: "Delete planner plan",
	});
	if (!selected) {
		input.ctx.ui.notify("Planner delete cancelled.", "info");
		return null;
	}

	const isActive = project?.activePlanId === selected;
	const confirmed = await confirmPlannerDelete({
		ui: input.ctx.ui,
		planId: selected,
		active: isActive,
	});
	if (!confirmed) {
		input.ctx.ui.notify("Planner delete cancelled.", "info");
		return null;
	}
	return { planId: selected, deleteActive: isActive };
}

async function resolveProjectSessionForHandoff(input: {
	fs: ReturnType<typeof createNodeFs>;
	agentDir: string;
	projectRoot: string;
	preferredSessionFiles?: readonly (string | null | undefined)[];
	parentSession?: string | null;
	createIfMissing?: boolean;
}): Promise<{
	sessionFile: string | null;
	recovered: boolean;
	created: boolean;
}> {
	const preferred = uniqueSessionFiles(input.preferredSessionFiles ?? []);
	for (const sessionFile of preferred) {
		if (await input.fs.exists(sessionFile)) {
			return {
				sessionFile,
				recovered: false,
				created: false,
			};
		}
	}

	const existingProjectSession = selectPlannerResumeSessionFile(
		await listProjectSessionsSafely(input.projectRoot),
	);
	if (existingProjectSession) {
		return {
			sessionFile: existingProjectSession,
			recovered: preferred.length > 0,
			created: false,
		};
	}

	if (input.createIfMissing === false) {
		return {
			sessionFile: null,
			recovered: false,
			created: false,
		};
	}

	const replacement = await createPlannerHandoffSession({
		fs: input.fs,
		agentDir: input.agentDir,
		worktreePath: input.projectRoot,
		parentSession: input.parentSession,
	});
	return {
		sessionFile: replacement.sessionFile,
		recovered: false,
		created: true,
	};
}

function uniqueSessionFiles(
	values: readonly (string | null | undefined)[],
): string[] {
	return Array.from(
		new Set(values.filter((value): value is string => Boolean(value))),
	);
}

async function listProjectSessionsSafely(
	projectRoot: string,
): Promise<Awaited<ReturnType<typeof SessionManager.list>>> {
	try {
		return await SessionManager.list(projectRoot);
	} catch {
		return [];
	}
}

function buildPlannerExitPrompt(input: {
	planId: string;
	worktreePath: string;
}): string {
	return [
		"[SYSTEM_INSTRUCTIONS]",
		"",
		`Planner plan ${input.planId} is still active but this chat has returned to the original project session.`,
		`Planner worktree: ${input.worktreePath}`,
		"",
		"Do not continue planner work in this original checkout.",
		"Use /planner-resume to return to the planner worktree session.",
		"Use /planner-finish only after the plan is complete and ready for export/cleanup.",
	].join("\n");
}

async function safeNotify(
	ctx: ExtensionCommandContext,
	message: string,
	type?: "info" | "warning" | "error",
): Promise<void> {
	try {
		ctx.ui.notify(message, type);
	} catch {
		// Stale command contexts may reject UI calls after editor/session changes.
	}
}

function notifyPlannerCommandResult(
	ctx: ExtensionCommandContext,
	result: { status: "applied" | "blocked"; text: string },
): void {
	ctx.ui.notify(result.text, result.status === "applied" ? "info" : "error");
}
