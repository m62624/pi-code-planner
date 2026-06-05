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
	isPlanActive,
	markPlannerToolVisibilityActive,
	persistPlannerToolVisibilityActiveToSession,
	registerPlannerToolVisibility,
	resetPlanActiveCache,
} from "./index.tool-visibility";
import { syncBundledInstructionFiles } from "./instructions/defaults";
import { createInstructionPaths } from "./instructions/paths";
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
} from "./runtime/refactor-tools";
import {
	buildPlannerStuckCompactInstructions,
	executePlannerStuckTool,
	PLANNER_STUCK_TOOL_NAMES,
	type PlannerStuckToolName,
} from "./runtime/stuck-tools";
import {
	executePlannerTaskTool,
	PLANNER_TASK_TOOL_NAMES,
	type PlannerTaskToolName,
} from "./runtime/task-tools";
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
} from "./storage/project-store";
import { PLANNER_STAGE_VALUES, PLANNER_STEP_VALUES } from "./storage/schema";
import { readPlanStateIfExists, updatePlanState } from "./storage/state-store";
import {
	bindWorktreeOriginalSession,
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
				"Short proposed plan title. Prefer a concise English phrase unless the user requested another language. The user reviews this title together with goal.md.",
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
	},
	required: ["taskId", "title", "objective", "scope", "acceptanceCriteria"],
	additionalProperties: false,
} as const;

const STUCK_REPORT_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		reason: {
			type: "string",
			description: "Concise reason the current execution attempt is stuck.",
		},
		observedError: {
			type: "string",
			description:
				"Exact command error, test failure, panic, or blocker if known.",
		},
		lastAttempt: {
			type: "string",
			description:
				"What you tried in this attempt. Include commands and files at a high level.",
		},
		nextDebugPlan: {
			type: "string",
			description:
				"Different focused debug plan for the next attempt after compact.",
		},
	},
	required: ["reason", "lastAttempt", "nextDebugPlan"],
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
		"decision",
	],
	additionalProperties: false,
} as const;

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
	registerPlannerCommands(pi);
	registerPlannerTools(pi, compactRuntime);
	registerPlannerIdleWatchdog(pi, idleRuntime);
	registerPlannerBuiltinToolGuard(pi);
	registerPlannerCompactEvents(pi, compactRuntime);
	registerInstructionDefaultsSync(pi);
	registerPlannerToolVisibility(pi);
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

function registerPlannerCommands(pi: ExtensionAPI): void {
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
							metadata?: { descriptionLanguage?: string };
						};
					};
				};
				const worktreePath = details.state?.worktreePath;
				const createdPlanId = details.plan?.planId ?? planId;
				const descriptionLanguage =
					details.settings?.effective?.metadata?.descriptionLanguage ??
					"English";
				if (!worktreePath) {
					ctx.ui.notify(
						"Planner plan was created without worktreePath.",
						"error",
					);
					return;
				}

				const originalSessionFile = ctx.sessionManager.getSessionFile();
				await bindWorktreeOriginalSession({
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
			};
			if (!details.worktreePath) {
				ctx.ui.notify("Planner resume did not return worktreePath.", "error");
				return;
			}
			const worktreePath = details.worktreePath;
			const parentSession = ctx.sessionManager.getSessionFile();
			await bindWorktreeOriginalSession({
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
