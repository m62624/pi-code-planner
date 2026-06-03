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
	refreshPlanActiveCache,
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
import { createNodeFs } from "./storage/fs";
import { resolveProjectStoragePaths } from "./storage/project-resolver";
import { ensureProjectRecord } from "./storage/project-store";
import { bindWorktreeOriginalSession } from "./storage/worktree-index";

export * from "./public-api";

const EMPTY_TOOL_PARAMETERS = {
	type: "object",
	properties: {},
	additionalProperties: false,
} as const;

const CREATE_PLAN_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		planId: { type: "string" },
		request: {
			type: "string",
			description:
				"The user's raw requested outcome. Do not replace it with a short title.",
		},
		title: { type: "string" },
		baseBranch: { type: "string" },
	},
	required: ["request"],
	additionalProperties: false,
} as const;

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
	},
	required: ["content", "title"],
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

const COMPLETE_STEP_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		nextStage: { type: "string" },
		nextStep: { type: "string" },
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
		targetStage: { type: "string" },
		targetStep: { type: "string" },
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

const GIT_EXPERIMENT_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		attemptId: { type: "string" },
		taskId: { type: "string" },
	},
	required: ["attemptId"],
	additionalProperties: false,
} as const;

const GIT_OPTIONAL_MESSAGE_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		message: { type: "string" },
	},
	additionalProperties: false,
} as const;

export default function piCodePlannerExtension(pi: ExtensionAPI): void {
	const compactRuntime = createPlannerCompactRuntimeState();
	registerPlannerCommands(pi);
	registerPlannerTools(pi, compactRuntime);
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
			"Open a multiline planner request editor, then create a worktree plan. Optional: --id <plan-id>.",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const parsed = parsePlannerCreateCommandArgs(args);
			if (!parsed) {
				ctx.ui.notify(
					"Usage: /planner-create [--id <plan-id>] [initial request text]",
					"error",
				);
				return;
			}

			// Save parsed args before entering withSession.
			// ctx.ui.editor is async and may span a session replacement
			// (e.g. ESC → "Resumed session"). All post-editor work must
			// use ctx.withSession to avoid stale-cx errors.
			const initialArgs = parsed;

			await ctx.newSession({
				withSession: async (sessionCtx) => {
					const request = await sessionCtx.ui.editor(
						"Describe the requested outcome",
						initialArgs.request ?? "",
					);
					if (!request?.trim()) {
						sessionCtx.ui.notify("Planner creation cancelled.", "info");
						return;
					}
					const normalizedRequest = request.trim();

					const fs = createNodeFs();
					const agentDir = getAgentDir();
					const projectPaths = await resolveProjectStoragePaths({
						fs,
						agentDir,
						cwd: sessionCtx.cwd,
					});
					const project = await ensureProjectRecord(fs, projectPaths);
					let planId: string;
					try {
						planId = resolvePlannerPlanId({
							requestedPlanId: initialArgs.planId,
							request: normalizedRequest,
							project,
						});
					} catch (error) {
						sessionCtx.ui.notify(errorMessage(error), "error");
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
						sessionCtx.ui.notify(result.text, "error");
						return;
					}

					const details = result.details as {
						state?: { worktreePath?: string | null };
						plan?: { planId?: string };
					};
					const worktreePath = details.state?.worktreePath;
					const createdPlanId = details.plan?.planId ?? planId;
					if (!worktreePath) {
						sessionCtx.ui.notify(
							"Planner plan was created without worktreePath.",
							"error",
						);
						return;
					}

					const originalSessionFile =
						sessionCtx.sessionManager.getSessionFile();
					await bindWorktreeOriginalSession({
						fs,
						agentDir,
						worktreePath,
						projectRoot: projectPaths.projectRoot,
						projectId: projectPaths.projectId,
						planId: createdPlanId,
						originalSessionFile: originalSessionFile ?? null,
					});

					const session = await createPlannerHandoffSession({
						fs,
						agentDir,
						worktreePath,
						parentSession: originalSessionFile,
					});
					await sessionCtx.switchSession(session.sessionFile, {
						withSession: async (replacementCtx) => {
							await replacementCtx.sendUserMessage(
								buildPlannerHandoffPrompt({
									planId: createdPlanId,
									worktreePath,
								}),
							);
						},
					});
					await refreshPlanActiveCache(pi, sessionCtx.cwd);
				},
			});
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

	pi.registerCommand("planner-switch", {
		description: "Switch to another planner plan in the current project.",
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
					title: "Switch planner plan",
				}));
			if (!planId) {
				ctx.ui.notify("Planner switch cancelled.", "info");
				return;
			}
			const result = await executePlannerUserCommand({
				fs,
				git: new NodeGitRunner(),
				projectPaths,
				commandName: "planner_switch",
				params: { planId },
			});
			if (result.status !== "applied") {
				ctx.ui.notify(result.text, "error");
				return;
			}
			const details = result.details as {
				worktreePath?: string | null;
			};
			if (!details.worktreePath) {
				ctx.ui.notify("Planner switch did not return worktreePath.", "error");
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
				originalSessionFile:
					ctx.cwd === projectPaths.projectRoot ? parentSession : null,
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
			await ctx.switchSession(targetSessionFile, {
				withSession: async (replacementCtx) => {
					await replacementCtx.sendUserMessage(
						buildPlannerResumePrompt({
							planId,
							worktreePath,
						}),
					);
				},
			});
			await refreshPlanActiveCache(pi, ctx.cwd);
		},
	});

	pi.registerCommand("planner-delete", {
		description: "Delete a planner plan. Active plans require --force-active.",
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
			if (parsed.forceActive) {
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
				await ctx.switchSession(session.sessionFile, {
					withSession: async (replacementCtx) => {
						const result = await executePlannerUserCommand({
							fs,
							git: new NodeGitRunner(),
							projectPaths,
							commandName: "planner_delete",
							params: {
								planId: parsed.planId,
								forceActive: true,
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

	pi.registerCommand("planner-accept", {
		description:
			"Accept the completed planner result, keep one output branch, clean temporary planner state, and return to the original project session.",
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
					"Accept planner result?",
					`Export ${preview.state.activeBranches.plan} to ${preview.outputBranch}, remove temporary planner files and worktree, and return to the original project session?`,
				);
				if (!confirmed) {
					ctx.ui.notify("Planner acceptance cancelled.", "info");
					return;
				}

				let deleteWorktreeSessions = true;
				if (!preview.originalSessionExists) {
					ctx.ui.notify(
						"Original Pi JSONL session is missing. Planner will create a replacement project-root session before cleanup.",
						"warning",
					);
					deleteWorktreeSessions = await ctx.ui.confirm(
						"Delete completed worktree chat?",
						"The original Pi JSONL session is missing. Delete the completed planner worktree chat history after switching to a replacement project-root session?",
					);
					fallbackSession = await createPlannerHandoffSession({
						fs,
						agentDir,
						worktreePath: projectPaths.projectRoot,
						parentSession: ctx.sessionManager.getSessionFile(),
					});
				}

				const finalized = await finalizeAcceptedPlan({
					fs,
					git,
					projectPaths,
				});
				acceptedPlanFinalized = true;
				const targetSessionFile =
					preview.originalSessionExists && preview.originalSessionFile
						? preview.originalSessionFile
						: fallbackSession?.sessionFile;
				if (!targetSessionFile) {
					throw new Error(
						"Planner accepted the result but could not resolve a project session for handoff.",
					);
				}
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
								originalSessionMissing: !preview.originalSessionExists,
								preservedWorktreeChatDir: deleteWorktreeSessions
									? null
									: finalized.worktreeSessionDir,
							}),
						);
					},
				});
				resetPlanActiveCache(pi);
			} catch (error) {
				if (fallbackSession && !acceptedPlanFinalized) {
					await removePlannerHandoffBootstrapFile(
						fs,
						fallbackSession.sessionFile,
					);
				}
				ctx.ui.notify(`Planner accept failed: ${errorMessage(error)}`, "error");
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
			const orchestration = await runPlannerOrchestrator({
				fs,
				git: new NodeGitRunner(),
				projectPaths: await createRuntimeProjectPaths(ctx.cwd),
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
				const result = await executePlannerPlanTool({
					fs: createNodeFs(),
					git: new NodeGitRunner(),
					projectPaths: await createRuntimeProjectPaths(ctx.cwd),
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

	for (const toolName of PLANNER_GOAL_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: goalToolLabel(toolName),
			description: goalToolDescription(toolName),
			promptSnippet:
				"Use planner goal tools during intake only. Draft goal.md before source reads and enter discovery only after explicit user approval.",
			parameters: goalToolParameters(toolName) as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const result = await executePlannerGoalTool({
					fs: createNodeFs(),
					git: new NodeGitRunner(),
					projectPaths: await createRuntimeProjectPaths(ctx.cwd),
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
				const result = await executePlannerQuestionTool({
					fs: createNodeFs(),
					git: new NodeGitRunner(),
					projectPaths: await createRuntimeProjectPaths(ctx.cwd),
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
				const result = await executePlannerTaskTool({
					fs: createNodeFs(),
					git: new NodeGitRunner(),
					projectPaths: await createRuntimeProjectPaths(ctx.cwd),
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
				const result = await executePlannerRecoveryTool({
					fs: createNodeFs(),
					git: new NodeGitRunner(),
					projectPaths: await createRuntimeProjectPaths(ctx.cwd),
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
				const result = await executePlannerGitTool({
					fs: createNodeFs(),
					git: new NodeGitRunner(),
					projectPaths: await createRuntimeProjectPaths(ctx.cwd),
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
				pi.sendUserMessage(content, options),
		});
	});
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

function registerPlannerBuiltinToolGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
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
			return "Write the normalized goal.md draft and wait for explicit user review. Does not allow discovery.";
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
		case "planner_git_create_experiment_branch":
			return "Planner Git Create Experiment Branch";
		case "planner_git_select_experiment":
			return "Planner Git Select Experiment";
		case "planner_git_merge_selected_experiment":
			return "Planner Git Merge Selected Experiment";
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
		case "planner_git_create_experiment_branch":
			return "Create and switch to an experiment branch for the active task.";
		case "planner_git_select_experiment":
			return "Select the best experiment by attempt id; merge target stays state-controlled.";
		case "planner_git_merge_selected_experiment":
			return "Merge the state-selected experiment branch into the current task branch.";
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
		case "planner_git_create_experiment_branch":
		case "planner_git_select_experiment":
			return GIT_EXPERIMENT_TOOL_PARAMETERS;
		case "planner_git_merge_selected_experiment":
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
		if (context.status === "ready") {
			return {
				activePlanId: context.activePlanId,
				active: true,
				projectPaths,
				planPaths: context.planPaths,
				planState: context.state,
			};
		}
		return {
			activePlanId: context.activePlanId,
			active: context.activePlanId !== null,
			projectPaths,
			planPaths: null,
			planState: null,
		};
	} catch {
		return {
			activePlanId: null,
			active: true,
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
): { planId: string; forceActive: boolean } | null {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		return null;
	}
	let forceActive = false;
	const planIds: string[] = [];
	for (const token of tokens) {
		if (token === "--force-active") {
			forceActive = true;
			continue;
		}
		if (token.startsWith("--")) {
			return null;
		}
		planIds.push(token);
	}
	return planIds.length === 1 ? { planId: planIds[0], forceActive } : null;
}

async function resolveRenameCommandArgs(input: {
	args: string;
	ctx: ExtensionCommandContext;
	fs: ReturnType<typeof createNodeFs>;
	projectPaths: Awaited<ReturnType<typeof createRuntimeProjectPaths>>;
}): Promise<{ planId?: string; title: string } | null> {
	const parsed = parsePlannerCreateCommandArgs(input.args);
	if (parsed?.request) {
		return { planId: parsed.planId, title: parsed.request };
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
}): Promise<{ planId: string; forceActive: boolean } | null> {
	const direct = parsePlannerDeleteCommandArgs(input.args);
	if (direct) {
		return direct;
	}
	if (input.args.trim().length > 0) {
		input.ctx.ui.notify(
			"Usage: /planner-delete [--force-active] <plan-id>",
			"error",
		);
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
	return { planId: selected, forceActive: isActive };
}

function notifyPlannerCommandResult(
	ctx: ExtensionCommandContext,
	result: { status: "applied" | "blocked"; text: string },
): void {
	ctx.ui.notify(result.text, result.status === "applied" ? "info" : "error");
}
