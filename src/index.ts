import { isAbsolute, relative, resolve } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
	isToolCallEventType,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
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
	updateToolVisibility,
} from "./index.tool-visibility";
import { syncBundledInstructionFiles } from "./instructions/defaults";
import { createInstructionPaths } from "./instructions/paths";
import { buildPlannerAboutReport } from "./runtime/about";
import {
	buildAcceptedPlanCompletionPrompt,
	finalizeAcceptedPlan,
	inspectAcceptedPlan,
} from "./runtime/accepted-plan";
import { readActivePlanContext } from "./runtime/active-plan";
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
	DEBUG_INSTRUMENTATION_TYPES,
	DEBUG_PROBE_METHODS,
	DEBUG_RESULT_NEXT_ACTIONS,
	executePlannerDebugTool,
	PLANNER_DEBUG_TOOL_NAMES,
	type PlannerDebugToolName,
} from "./runtime/debug-tools";
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
	executePlannerRecoveryTool,
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
	listPlannerSkillInventory,
	listPlannerSkillResourcePaths,
	PLANNER_SKILL_SOURCE_KINDS,
	PLANNER_SKILL_TOOL_NAMES,
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
			enum: ["inspect", "task_diff"],
			description:
				"inspect: git reality (branch, HEAD, dirty, conflicts). task_diff: diff stat between plan branch and task branch.",
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
	registerPlannerCommands(pi);
	registerPlannerTools(pi, compactRuntime);
	registerPlannerIdleWatchdog(pi, idleRuntime);
	registerPlannerRuntimeTimer(pi, timerRuntime);
	registerPlannerBuiltinToolGuard(pi);
	registerPlannerCompactEvents(pi, compactRuntime);
	registerPlannerSkillResources(pi);
	registerInstructionDefaultsSync(pi);
	registerPlannerToolVisibility(pi);
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
	const compatibility =
		input.compatibilityMode === "breaking"
			? [
					"Compatibility mode: breaking.",
					"Breaking changes may be proposed only when discovery evidence proves they are needed.",
					"Ask the user for explicit approval before implementing any breaking change.",
				]
			: [
					"Compatibility mode: additive.",
					"Keep public commands, tool schemas, settings, persisted artifact fields, package metadata, and documented behavior backward compatible.",
					"If a breaking change looks better, record it as a future proposal unless the user explicitly approves breaking work.",
				];
	return [
		"# Planner Improve Request",
		"",
		"Create a discovery-first self-improvement plan for this repository.",
		...(input.request ? ["", "User focus:", input.request] : []),
		"",
		...compatibility,
		"",
		"Run discovery before writing goal.md. Use repository evidence to choose one bounded, high-value improvement for planner reliability, tests, documentation, local-model guidance, or developer workflow.",
		"After discovery, write goal.md from your findings and ask the user for explicit approval before planning implementation.",
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

				const fs = createNodeFs();
				const agentDir = getAgentDir();
				const projectPaths = await resolveProjectStoragePaths({
					fs,
					agentDir,
					cwd: ctx.cwd,
				});
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
					git: new NodeGitRunner(),
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

				const details = result.details as {
					state?: { worktreePath?: string | null };
					plan?: { planId?: string };
					settings?: {
						effective?: {
							metadata?: {
								titleLanguage?: string;
								descriptionLanguage?: string;
							};
						};
					};
				};
				const worktreePath = details.state?.worktreePath;
				const createdPlanId = details.plan?.planId ?? planId;
				const descriptionLanguage =
					details.settings?.effective?.metadata?.descriptionLanguage ??
					"English";
				const titleLanguage =
					details.settings?.effective?.metadata?.titleLanguage ??
					descriptionLanguage;
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
			"Create a discovery-first self-improvement plan for this repository.",
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

				const fs = createNodeFs();
				const agentDir = getAgentDir();
				const projectPaths = await resolveProjectStoragePaths({
					fs,
					agentDir,
					cwd: ctx.cwd,
				});
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
					git: new NodeGitRunner(),
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

				const details = result.details as {
					state?: { worktreePath?: string | null };
					plan?: { planId?: string };
					settings?: {
						effective?: {
							metadata?: {
								titleLanguage?: string;
								descriptionLanguage?: string;
							};
						};
					};
				};
				const worktreePath = details.state?.worktreePath;
				const createdPlanId = details.plan?.planId ?? planId;
				const descriptionLanguage =
					details.settings?.effective?.metadata?.descriptionLanguage ??
					"English";
				const titleLanguage =
					details.settings?.effective?.metadata?.titleLanguage ??
					descriptionLanguage;
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
			const fs = createNodeFs();
			const agentDir = getAgentDir();
			const projectPaths = await resolveProjectStoragePaths({
				fs,
				agentDir,
				cwd: ctx.cwd,
			});
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
			const fs = createNodeFs();
			const projectPaths = await createRuntimeProjectPaths(ctx.cwd);
			const parsed = await resolveRenameCommandArgs({
				args,
				ctx,
				fs,
				projectPaths,
			});
			if (!parsed) return;
			const result = await executePlannerUserCommand({
				fs,
				git: new NodeGitRunner(),
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
			const fs = createNodeFs();
			const agentDir = getAgentDir();
			const projectPaths = await resolveProjectStoragePaths({
				fs,
				agentDir,
				cwd: ctx.cwd,
			});
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
				git: new NodeGitRunner(),
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
			const fs = createNodeFs();
			const agentDir = getAgentDir();
			const projectPaths = await resolveProjectStoragePaths({
				fs,
				agentDir,
				cwd: ctx.cwd,
			});
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
							git: new NodeGitRunner(),
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
				git: new NodeGitRunner(),
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
			const fs = createNodeFs();
			const agentDir = getAgentDir();
			const projectPaths = await resolveProjectStoragePaths({
				fs,
				agentDir,
				cwd: ctx.cwd,
			});
			const git = new NodeGitRunner();
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
			const fs = createNodeFs();
			const projectPaths = await createRuntimeProjectPaths(ctx.cwd);
			await recordPlannerToolActivityForProject({
				fs,
				projectPaths,
				now: Date.now(),
			});
			const orchestration = await runPlannerOrchestrator({
				fs,
				git: new NodeGitRunner(),
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
			const fs = createNodeFs();
			const projectPaths = await resolveProjectStoragePaths({
				fs,
				agentDir: getAgentDir(),
				cwd: ctx.cwd,
			});
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
			label: planToolLabel(toolName),
			description: planToolDescription(toolName),
			promptSnippet:
				"Use planner_create_plan before project reads when the user asks to start a planner-controlled task.",
			parameters: CREATE_PLAN_TOOL_PARAMETERS as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const fs = createNodeFs();
				const projectPaths = await createRuntimeProjectPaths(ctx.cwd);
				const result = await executePlannerPlanTool({
					fs,
					git: new NodeGitRunner(),
					projectPaths,
					toolName,
					params,
				});

				if (result.status === "applied") {
					await recordPlannerToolActivityForProject({
						fs,
						projectPaths,
						now: Date.now(),
					});
					activatePlannerToolVisibility(pi);
				}

				return {
					content: [{ type: "text", text: result.text }],
					details: result,
				};
			},
		});
	}

	for (const toolName of PLANNER_GOAL_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: goalToolLabel(toolName),
			description: goalToolDescription(toolName),
			promptSnippet:
				"Use planner goal tools during intake only. Draft goal.md before source reads and enter discovery only after explicit user approval.",
			parameters: goalToolParameters(toolName) as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const fs = createNodeFs();
				const projectPaths = await createRuntimeProjectPaths(ctx.cwd);
				await recordPlannerToolActivityForProject({
					fs,
					projectPaths,
					now: Date.now(),
				});
				const result = await executePlannerGoalTool({
					fs,
					git: new NodeGitRunner(),
					projectPaths,
					toolName,
					params,
				});
				return {
					content: [{ type: "text", text: result.text }],
					details: result,
				};
			},
		});
	}

	for (const toolName of PLANNER_QUESTION_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: questionToolLabel(toolName),
			description: questionToolDescription(toolName),
			promptSnippet:
				"Use planner question tools during discovery/write_questions. Save evidence-based questions, show open questions to the user verbatim, wait for answers, then resolve them before continuing.",
			parameters: questionToolParameters(toolName) as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const fs = createNodeFs();
				const projectPaths = await createRuntimeProjectPaths(ctx.cwd);
				await recordPlannerToolActivityForProject({
					fs,
					projectPaths,
					now: Date.now(),
				});
				const result = await executePlannerQuestionTool({
					fs,
					git: new NodeGitRunner(),
					projectPaths,
					toolName,
					params,
				});
				return {
					content: [{ type: "text", text: result.text }],
					details: result,
				};
			},
		});
	}

	for (const toolName of PLANNER_TASK_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: taskToolLabel(toolName),
			description: taskToolDescription(toolName),
			promptSnippet:
				"Use planner_task_upsert during planning/write_task_files. Pass semantic task fields only; the wrapper writes task.json, task.md, and empty TDD lifecycle artifacts.",
			parameters: TASK_UPSERT_TOOL_PARAMETERS as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const fs = createNodeFs();
				const projectPaths = await createRuntimeProjectPaths(ctx.cwd);
				await recordPlannerToolActivityForProject({
					fs,
					projectPaths,
					now: Date.now(),
				});
				const result = await executePlannerTaskTool({
					fs,
					git: new NodeGitRunner(),
					projectPaths,
					toolName,
					params,
				});
				return {
					content: [{ type: "text", text: result.text }],
					details: result,
				};
			},
		});
	}

	for (const toolName of PLANNER_CONTRACT_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: contractToolLabel(toolName),
			description: contractToolDescription(toolName),
			promptSnippet:
				"Use planner contract tools for AGENTS.md local contracts. Scan/route/read before broad source reads; check/update contracts after each green TDD task before refactor.",
			parameters: contractToolParameters(toolName) as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const fs = createNodeFs();
				const projectPaths = await createRuntimeProjectPaths(ctx.cwd);
				await recordPlannerToolActivityForProject({
					fs,
					projectPaths,
					now: Date.now(),
				});
				const result = await executePlannerContractTool({
					fs,
					git: new NodeGitRunner(),
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
				return {
					content: [{ type: "text", text: result.text }],
					details: result,
				};
			},
		});
	}

	for (const toolName of PLANNER_STUCK_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: stuckToolLabel(toolName),
			description: stuckToolDescription(toolName),
			promptSnippet:
				"Use planner_report_stuck only when an execution attempt is actually stuck. Save evidence, diff, and next debug plan before planner-controlled compact.",
			parameters: STUCK_REPORT_TOOL_PARAMETERS as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const fs = createNodeFs();
				const git = new NodeGitRunner();
				const projectPaths = await createRuntimeProjectPaths(ctx.cwd);
				await recordPlannerToolActivityForProject({
					fs,
					projectPaths,
					now: Date.now(),
				});
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
				return {
					content: [{ type: "text", text: result.text }],
					details: result,
				};
			},
		});
	}

	for (const toolName of PLANNER_REFACTOR_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: refactorToolLabel(toolName),
			description: refactorToolDescription(toolName),
			promptSnippet:
				"Use planner_refactor_review during execution/refactor_task after inspecting the task diff. Pass semantic review fields; the wrapper writes refactor.md.",
			parameters: REFACTOR_REVIEW_TOOL_PARAMETERS as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const fs = createNodeFs();
				const projectPaths = await createRuntimeProjectPaths(ctx.cwd);
				await recordPlannerToolActivityForProject({
					fs,
					projectPaths,
					now: Date.now(),
				});
				const result = await executePlannerRefactorTool({
					fs,
					git: new NodeGitRunner(),
					projectPaths,
					toolName,
					params,
				});
				return {
					content: [{ type: "text", text: result.text }],
					details: result,
				};
			},
		});
	}

	for (const toolName of DOUBT_REVIEW_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: doubtToolLabel(toolName),
			description: doubtToolDescription(toolName),
			promptSnippet:
				"Use planner_doubt_review during finalize/doubt_review. List possible errors first, then prove or dismiss each one before calling anything a real bug.",
			parameters: doubtToolParameters(toolName) as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const fs = createNodeFs();
				const projectPaths = await createRuntimeProjectPaths(ctx.cwd);
				await recordPlannerToolActivityForProject({
					fs,
					projectPaths,
					now: Date.now(),
				});
				const result = await executePlannerDoubtTool({
					fs,
					git: new NodeGitRunner(),
					projectPaths,
					toolName,
					params,
				});
				return {
					content: [{ type: "text", text: result.text }],
					details: result,
				};
			},
		});
	}

	for (const toolName of PLANNER_SKILL_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: "Planner Skill Create",
			description:
				"Create a validated Pi skill from a proven reusable planner lesson for future planner sessions.",
			promptSnippet:
				"Use planner_skill_create only after a reusable lesson is proven by stuck/debug/refactor/doubt/final evidence. The wrapper writes YAML frontmatter and stores the skill for future planner sessions.",
			parameters: SKILL_CREATE_TOOL_PARAMETERS as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const fs = createNodeFs();
				const projectPaths = await createRuntimeProjectPaths(ctx.cwd);
				await recordPlannerToolActivityForProject({
					fs,
					projectPaths,
					now: Date.now(),
				});
				const result = await executePlannerSkillTool({
					fs,
					git: new NodeGitRunner(),
					projectPaths,
					params,
				});
				return {
					content: [{ type: "text", text: result.text }],
					details: result,
				};
			},
		});
	}

	for (const toolName of PLANNER_DEBUG_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: debugToolLabel(toolName),
			description: debugToolDescription(toolName),
			promptSnippet:
				"Use planner debug tools only after planner_report_stuck. Record strategy, one focused probe, and result before patching. Use cleanup before planner_git_commit.",
			parameters: debugToolParameters(toolName) as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const fs = createNodeFs();
				const projectPaths = await createRuntimeProjectPaths(ctx.cwd);
				await recordPlannerToolActivityForProject({
					fs,
					projectPaths,
					now: Date.now(),
				});
				const result = await executePlannerDebugTool({
					fs,
					git: new NodeGitRunner(),
					projectPaths,
					toolName,
					params,
				});
				return {
					content: [{ type: "text", text: result.text }],
					details: result,
				};
			},
		});
	}

	for (const toolName of PLANNER_WORKFLOW_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: workflowToolLabel(toolName),
			description: workflowToolDescription(toolName),
			promptSnippet:
				"Use planner_status first, then call only the workflow transition listed as allowed for the current stage/step.",
			parameters: workflowToolParameters(toolName) as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const fs = createNodeFs();
				const git = new NodeGitRunner();
				const projectPaths = await createRuntimeProjectPaths(ctx.cwd);
				await recordPlannerToolActivityForProject({
					fs,
					projectPaths,
					now: Date.now(),
				});
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
			label: recoveryToolLabel(toolName),
			description: recoveryToolDescription(toolName),
			promptSnippet:
				"Use planner_recovery_inspect when planner_status reports recovery or user-decision gating. Use planner_recovery_resume only after inspection shows no blocking git or worktree issues. Recovery tools never reset or delete git state.",
			parameters: recoveryToolParameters(toolName) as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const fs = createNodeFs();
				const projectPaths = await createRuntimeProjectPaths(ctx.cwd);
				await recordPlannerToolActivityForProject({
					fs,
					projectPaths,
					now: Date.now(),
				});
				const result = await executePlannerRecoveryTool({
					fs,
					git: new NodeGitRunner(),
					projectPaths,
					toolName,
					params,
				});

				return {
					content: [{ type: "text", text: result.text }],
					details: result,
				};
			},
		});
	}

	for (const toolName of PLANNER_GIT_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: gitToolLabel(toolName),
			description: gitToolDescription(toolName),
			promptSnippet:
				"Use planner git tools instead of raw git while a planner plan is active. Call planner_status first and only use allowed git wrappers.",
			parameters: gitToolParameters(toolName) as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const fs = createNodeFs();
				const projectPaths = await createRuntimeProjectPaths(ctx.cwd);
				await recordPlannerToolActivityForProject({
					fs,
					projectPaths,
					now: Date.now(),
				});
				const result = await executePlannerGitTool({
					fs,
					git: new NodeGitRunner(),
					projectPaths,
					toolName,
					params,
				});

				return {
					content: [{ type: "text", text: result.text }],
					details: result,
				};
			},
		});
	}
}

function registerPlannerCompactEvents(
	pi: ExtensionAPI,
	compactRuntime: PlannerCompactRuntimeState,
): void {
	pi.on("session_compact", async (_event, ctx) => {
		consumePlannerControlledCompact(compactRuntime);

		const fs = createNodeFs();
		let projectPaths: Awaited<ReturnType<typeof resolveProjectStoragePaths>>;
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
			git: new NodeGitRunner(),
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
		await recordPlannerToolActivityForProject({
			fs,
			projectPaths,
			now: Date.now(),
		});
	} catch {
		// Activity timestamps are advisory; planner state remains authoritative.
	}
}

async function recordPlannerToolActivityForProject(input: {
	fs: ReturnType<typeof createNodeFs>;
	projectPaths: Awaited<ReturnType<typeof createRuntimeProjectPaths>>;
	now: number;
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
			markPlannerToolActivity(state, input.now),
		);
	} catch {
		// Activity timestamps must never block the actual planner tool result.
	}
}

async function maybeStartPlannerControlledCompact(input: {
	ctx: ExtensionContext;
	fs: ReturnType<typeof createNodeFs>;
	git: NodeGitRunner;
	projectPaths: Awaited<ReturnType<typeof createRuntimeProjectPaths>>;
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
	projectPaths: Awaited<ReturnType<typeof createRuntimeProjectPaths>>;
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

function planToolLabel(toolName: PlannerPlanToolName): string {
	switch (toolName) {
		case "planner_create_plan":
			return "Planner Create Plan";
	}
}

function planToolDescription(toolName: PlannerPlanToolName): string {
	switch (toolName) {
		case "planner_create_plan":
			return "Create project storage, plan files, and the plan branch/worktree. Starts intake so the model can draft goal.md before discovery.";
	}
}

function goalToolLabel(toolName: PlannerGoalToolName): string {
	switch (toolName) {
		case "planner_goal_submit":
			return "Planner Goal Submit";
		case "planner_goal_decide":
			return "Planner Goal Decide";
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

function questionToolLabel(toolName: PlannerQuestionToolName): string {
	switch (toolName) {
		case "planner_questions_submit":
			return "Planner Questions Submit";
		case "planner_questions_resolve":
			return "Planner Questions Resolve";
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

function taskToolLabel(toolName: PlannerTaskToolName): string {
	switch (toolName) {
		case "planner_task_upsert":
			return "Planner Task Upsert";
	}
}

function taskToolDescription(toolName: PlannerTaskToolName): string {
	switch (toolName) {
		case "planner_task_upsert":
			return "Create or replace one behavioral task from semantic fields. The wrapper writes task.json, task.md, and empty TDD lifecycle artifacts.";
	}
}

function contractToolLabel(toolName: PlannerContractToolName): string {
	switch (toolName) {
		case "planner_contract_scan":
			return "Planner Contract Scan";
		case "planner_contract_route":
			return "Planner Contract Route";
		case "planner_contract_read":
			return "Planner Contract Read";
		case "planner_contract_check":
			return "Planner Contract Check";
		case "planner_contract_upsert":
			return "Planner Contract Upsert";
		case "planner_contract_decide":
			return "Planner Contract Decide";
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

function stuckToolLabel(toolName: PlannerStuckToolName): string {
	switch (toolName) {
		case "planner_report_stuck":
			return "Planner Report Stuck";
	}
}

function stuckToolDescription(toolName: PlannerStuckToolName): string {
	switch (toolName) {
		case "planner_report_stuck":
			return "Record a stuck execution attempt with full git diff artifacts and start a planner compact for a different debug attempt.";
	}
}

function refactorToolLabel(toolName: PlannerRefactorToolName): string {
	switch (toolName) {
		case "planner_refactor_review":
			return "Planner Refactor Review";
	}
}

function refactorToolDescription(toolName: PlannerRefactorToolName): string {
	switch (toolName) {
		case "planner_refactor_review":
			return "Write the structured refactor.md review from semantic fields during execution/refactor_task.";
	}
}

function doubtToolLabel(toolName: PlannerDoubtReviewToolName): string {
	switch (toolName) {
		case "planner_doubt_review":
			return "Planner Doubt Review";
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

function debugToolLabel(toolName: PlannerDebugToolName): string {
	switch (toolName) {
		case "planner_debug_strategy":
			return "Planner Debug Strategy";
		case "planner_debug_probe":
			return "Planner Debug Probe";
		case "planner_debug_result":
			return "Planner Debug Result";
		case "planner_debug_cleanup":
			return "Planner Debug Cleanup";
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

function gitToolLabel(toolName: PlannerGitToolName): string {
	switch (toolName) {
		case "planner_git_inspect":
			return "Planner Git Inspect";
		case "planner_git_init":
			return "Planner Git Init";
		case "planner_git_commit":
			return "Planner Git Commit";
		case "planner_git_create_task_branch":
			return "Planner Git Create Task Branch";
		case "planner_git_create_refactor_branch":
			return "Planner Git Create Refactor Branch";
		case "planner_git_merge_refactor_to_task":
			return "Planner Git Merge Refactor To Task";
		case "planner_git_merge_task_to_plan":
			return "Planner Git Merge Task To Plan";
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
			return EMPTY_TOOL_PARAMETERS;
	}
}

function recoveryToolLabel(toolName: PlannerRecoveryToolName): string {
	switch (toolName) {
		case "planner_recovery_inspect":
			return "Planner Recovery Inspect";
		case "planner_recovery_resume":
			return "Planner Recovery Resume";
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

function workflowToolLabel(toolName: PlannerWorkflowToolName): string {
	switch (toolName) {
		case "planner_start_step":
			return "Planner Start Step";
		case "planner_finish_step":
			return "Planner Finish Step";
		case "planner_advance_step":
			return "Planner Advance Step";
		case "planner_fail_step":
			return "Planner Fail Step";
		case "planner_block_step":
			return "Planner Block Step";
		case "planner_retry_step":
			return "Planner Retry Step";
		case "planner_request_compact":
			return "Planner Request Compact";
		case "planner_complete_compact":
			return "Planner Complete Compact";
		case "planner_enter_recovery":
			return "Planner Enter Recovery";
		case "planner_resume_after_recovery":
			return "Planner Resume After Recovery";
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

async function createRuntimeProjectPaths(cwd: string) {
	const fs = createNodeFs();
	return await resolveProjectStoragePaths({
		fs,
		agentDir: getAgentDir(),
		cwd,
	});
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
	projectPaths: Awaited<ReturnType<typeof createRuntimeProjectPaths>>;
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
	projectPaths: Awaited<ReturnType<typeof createRuntimeProjectPaths>>;
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

function isPathInsideOrEqual(path: string, root: string): boolean {
	const resolvedPath = resolve(path);
	const resolvedRoot = resolve(root);
	const rel = relative(resolvedRoot, resolvedPath);
	return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
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
