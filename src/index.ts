import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	getAgentDir,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { SCHEMA_VERSION } from "./constants";
import { NodeGitRunner } from "./git/node-runner";
import {
	checkRawGitAllowed,
	PLANNER_STATUS_TOOL_NAME,
} from "./guard/git-watcher";
import {
	executePlannerGitTool,
	PLANNER_GIT_TOOL_NAMES,
	type PlannerGitToolName,
} from "./runtime/git-tools";
import {
	executePlannerMemoryTool,
	PLANNER_MEMORY_TOOL_NAMES,
	type PlannerMemoryToolName,
} from "./runtime/memory-tools";
import {
	parsePlannerCreateCommandArgs,
	resolvePlannerPlanId,
} from "./runtime/plan-naming";
import {
	executePlannerPlanTool,
	PLANNER_PLAN_TOOL_NAMES,
	type PlannerPlanToolName,
} from "./runtime/plan-tools";
import {
	formatPlannerPreflightStatus,
	runPlannerPreflight,
} from "./runtime/preflight";
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
} from "./session/handoff";
import { createNodeFs } from "./storage/fs";
import { resolveProjectStoragePaths } from "./storage/project-resolver";
import {
	ensureProjectRecord,
	readProjectRecordIfExists,
} from "./storage/project-store";
import { saveWorktreeProjectIndex } from "./storage/worktree-index";

export * from "./public-api";

const EMPTY_TOOL_PARAMETERS = {
	type: "object",
	properties: {},
	additionalProperties: false,
} as const;

type PlannerSwitchSessionOptionsWithCwdOverride = NonNullable<
	Parameters<ExtensionCommandContext["switchSession"]>[1]
> & { cwdOverride: string };

const CREATE_PLAN_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		planId: { type: "string" },
		title: { type: "string" },
		baseBranch: { type: "string" },
	},
	required: ["planId", "title"],
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

const MEMORY_BATCH_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		files: { type: "array", items: { type: "object" } },
		symbols: { type: "array", items: { type: "object" } },
		relations: { type: "array", items: { type: "object" } },
	},
	additionalProperties: false,
} as const;

const MEMORY_APPLY_FRESHNESS_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		detectedAt: { type: "string" },
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

const GIT_FORCE_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		force: { type: "boolean" },
	},
	additionalProperties: false,
} as const;

export default function piCodePlannerExtension(pi: ExtensionAPI): void {
	registerPlannerCommands(pi);
	registerPlannerTools(pi);
	registerRawGitGuard(pi);
}

function registerPlannerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("planner-create", {
		description:
			"Create a planner plan, create its worktree, and switch Pi into the worktree session.",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const parsed = parsePlannerCreateCommandArgs(args);
			if (!parsed) {
				ctx.ui.notify(
					"Usage: /planner-create [--id <plan-id>] <title>",
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
			const project = await ensureProjectRecord(fs, projectPaths);
			let planId: string;
			try {
				planId = resolvePlannerPlanId({
					requestedPlanId: parsed.planId,
					title: parsed.title,
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
					title: parsed.title,
				},
			});

			if (result.status !== "applied") {
				ctx.ui.notify(result.text, "error");
				return;
			}

			const details = result.details as {
				state?: { worktreePath?: string | null };
				plan?: { planId?: string };
			};
			const worktreePath = details.state?.worktreePath;
			const createdPlanId = details.plan?.planId ?? planId;
			if (!worktreePath) {
				ctx.ui.notify(
					"Planner plan was created without worktreePath.",
					"error",
				);
				return;
			}

			const originalSessionFile = ctx.sessionManager.getSessionFile();
			await saveWorktreeProjectIndex({
				fs,
				agentDir,
				record: {
					schemaVersion: SCHEMA_VERSION,
					worktreePath,
					projectRoot: projectPaths.projectRoot,
					projectId: projectPaths.projectId,
					planId: createdPlanId,
					originalSessionFile: originalSessionFile ?? null,
				},
			});

			const session = await createPlannerHandoffSession({
				fs,
				agentDir,
				worktreePath,
			});
			await ctx.switchSession(session.sessionFile, {
				cwdOverride: worktreePath,
				withSession: async (replacementCtx) => {
					await replacementCtx.sendUserMessage(
						buildPlannerHandoffPrompt({ planId: createdPlanId, worktreePath }),
					);
				},
			} as PlannerSwitchSessionOptionsWithCwdOverride);
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
			const session = await createPlannerHandoffSession({
				fs,
				agentDir,
				worktreePath,
			});
			await ctx.switchSession(session.sessionFile, {
				cwdOverride: worktreePath,
				withSession: async (replacementCtx) => {
					await replacementCtx.sendUserMessage(
						buildPlannerResumePrompt({
							planId,
							worktreePath,
						}),
					);
				},
			} as PlannerSwitchSessionOptionsWithCwdOverride);
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
				const session = await createPlannerHandoffSession({
					fs,
					agentDir,
					worktreePath: projectPaths.projectRoot,
				});
				await ctx.switchSession(session.sessionFile, {
					cwdOverride: projectPaths.projectRoot,
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
				} as PlannerSwitchSessionOptionsWithCwdOverride);
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
		},
	});
}

function registerPlannerTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: PLANNER_STATUS_TOOL_NAME,
		label: "Planner Status",
		description:
			"Show the current pi-code-planner stage, instruction files, and allowed planner tools.",
		promptSnippet:
			"Use planner_status when a planner action is blocked or when you are unsure which planner step/tool is allowed.",
		parameters: EMPTY_TOOL_PARAMETERS as never,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const preflight = await readPlannerPreflight(ctx.cwd);
			const text = formatPlannerPreflightStatus(preflight);

			return {
				content: [{ type: "text", text }],
				details: preflight,
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

	for (const toolName of PLANNER_WORKFLOW_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: workflowToolLabel(toolName),
			description: workflowToolDescription(toolName),
			promptSnippet:
				"Use planner_status first, then call only the workflow transition listed as allowed for the current stage/step.",
			parameters: workflowToolParameters(toolName) as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const result = await executePlannerWorkflowTool({
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

	for (const toolName of PLANNER_MEMORY_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: memoryToolLabel(toolName),
			description: memoryToolDescription(toolName),
			promptSnippet:
				"Use planner memory tools when planner_status reports require_memory_update or the current stage asks you to write/verify memory.",
			parameters: memoryToolParameters(toolName) as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const result = await executePlannerMemoryTool({
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

function registerRawGitGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) {
			return;
		}

		const state = await readActivePlannerState(ctx.cwd);
		const decision = checkRawGitAllowed({
			command: event.input.command,
			state,
		});

		if (!decision.allow) {
			return {
				block: true,
				reason:
					decision.reason ??
					"Raw git is blocked while pi-code-planner is active.",
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
			return "Create project storage, plan files, memory files, the plan branch/worktree, and activate discovery.";
	}
}

function gitToolLabel(toolName: PlannerGitToolName): string {
	switch (toolName) {
		case "planner_git_inspect":
			return "Planner Git Inspect";
		case "planner_git_init":
			return "Planner Git Init";
		case "planner_git_create_plan_worktree":
			return "Planner Git Create Plan Worktree";
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
		case "planner_git_export_plan_to_output":
			return "Planner Git Export Plan To Output";
		case "planner_git_remove_plan_worktree":
			return "Planner Git Remove Plan Worktree";
		case "planner_git_cleanup_managed_branches":
			return "Planner Git Cleanup Managed Branches";
	}
}

function gitToolDescription(toolName: PlannerGitToolName): string {
	switch (toolName) {
		case "planner_git_inspect":
			return "Inspect planner-controlled git reality without raw shell git.";
		case "planner_git_init":
			return "Initialize git for the project during the init/check_git step.";
		case "planner_git_create_plan_worktree":
			return "Create the planner worktree and plan branch at the dedicated init step.";
		case "planner_git_commit":
			return "Create a planner-controlled commit and mark memory update required.";
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
		case "planner_git_export_plan_to_output":
			return "Export the completed plan branch to an output branch in the original repository.";
		case "planner_git_remove_plan_worktree":
			return "Remove the planner worktree during accepted done cleanup.";
		case "planner_git_cleanup_managed_branches":
			return "Delete planner-managed task/experiment branches; plan branch is protected.";
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
		case "planner_git_export_plan_to_output":
			return GIT_OPTIONAL_MESSAGE_TOOL_PARAMETERS;
		case "planner_git_remove_plan_worktree":
		case "planner_git_cleanup_managed_branches":
			return GIT_FORCE_TOOL_PARAMETERS;
		case "planner_git_inspect":
		case "planner_git_init":
		case "planner_git_create_plan_worktree":
		case "planner_git_create_refactor_branch":
			return EMPTY_TOOL_PARAMETERS;
	}
}

function memoryToolLabel(toolName: PlannerMemoryToolName): string {
	switch (toolName) {
		case "planner_memory_inspect":
			return "Planner Memory Inspect";
		case "planner_memory_apply_freshness":
			return "Planner Memory Apply Freshness";
		case "planner_memory_write_batch":
			return "Planner Memory Write Batch";
		case "planner_memory_verify":
			return "Planner Memory Verify";
		case "planner_memory_sync_checkpoint":
			return "Planner Memory Sync Checkpoint";
	}
}

function memoryToolDescription(toolName: PlannerMemoryToolName): string {
	switch (toolName) {
		case "planner_memory_inspect":
			return "Inspect memory freshness and list affected files, symbols, relations, and required effect checks.";
		case "planner_memory_apply_freshness":
			return "Mark stale memory entries dirty or missing before the model rewrites affected memory.";
		case "planner_memory_write_batch":
			return "Write validated file, symbol, and relation memory entries.";
		case "planner_memory_verify":
			return "Verify whether memory matches the current project snapshot.";
		case "planner_memory_sync_checkpoint":
			return "Sync memory checkpoint to current HEAD after memory verifies clean.";
	}
}

function memoryToolParameters(toolName: PlannerMemoryToolName) {
	switch (toolName) {
		case "planner_memory_write_batch":
			return MEMORY_BATCH_TOOL_PARAMETERS;
		case "planner_memory_apply_freshness":
			return MEMORY_APPLY_FRESHNESS_TOOL_PARAMETERS;
		case "planner_memory_inspect":
		case "planner_memory_verify":
		case "planner_memory_sync_checkpoint":
			return EMPTY_TOOL_PARAMETERS;
	}
}

function workflowToolLabel(toolName: PlannerWorkflowToolName): string {
	switch (toolName) {
		case "planner_start_step":
			return "Planner Start Step";
		case "planner_complete_step":
			return "Planner Complete Step";
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
		case "planner_complete_step":
			return "Mark the current running planner step as completed and store its next step.";
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
		case "planner_complete_step":
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

async function readPlannerPreflight(projectRoot: string) {
	const fs = createNodeFs();
	const projectPaths = await resolveProjectStoragePaths({
		fs,
		agentDir: getAgentDir(),
		cwd: projectRoot,
	});
	return await runPlannerPreflight({
		fs,
		git: new NodeGitRunner(),
		projectPaths,
	});
}

async function createRuntimeProjectPaths(cwd: string) {
	const fs = createNodeFs();
	return await resolveProjectStoragePaths({
		fs,
		agentDir: getAgentDir(),
		cwd,
	});
}

async function readActivePlannerState(projectRoot: string): Promise<{
	activePlanId: string | null;
	active: boolean;
}> {
	try {
		const fs = createNodeFs();
		const paths = await resolveProjectStoragePaths({
			fs,
			agentDir: getAgentDir(),
			cwd: projectRoot,
		});
		const project = await readProjectRecordIfExists(fs, paths);
		const activePlanId = project?.activePlanId ?? null;
		return { activePlanId, active: activePlanId !== null };
	} catch {
		return { activePlanId: null, active: false };
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
	if (parsed) {
		return parsed;
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

	const isActive = project.activePlanId === selected;
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
